// SPDX-License-Identifier: MIT
import * as fs from 'fs'
import * as path from 'path'
import { includeCandidates } from '../Filelist'
import { maskTemplate } from '../Template'

const INCLUDE_RE = /^[ \t]*`include[ \t]+"([^"]+)"/gm

interface Entry {
  mtimeMs: number
  ctimeMs: number
  size: number
  includes: string[]
  /// for a file with markup: offset of each line, and [start, end] of each masked part, where
  /// end is the first character after it that is not blank
  template: { lineStarts: number[]; parts: [number, number][] } | undefined
  /// the copy is up to date
  copied: boolean
}

/// Copies that slang can read of the checked sources and the headers they include, kept at their
/// paths under `dir`, with Perl template markup and the Verilog inside Perl blocks blanked out
/// (see maskTemplate), so lines and columns match the originals. Only changed files are copied
/// again.
export class TemplateMirror {
  private entries = new Map<string, Entry>()
  private updating: Promise<boolean> = Promise.resolve(false)
  private initialized = false

  constructor(readonly dir: string) {}

  /// Brings the copies of `sources` and the headers they include up to date. False when none of
  /// them has markup, and slang can read the files themselves.
  update(sources: string[], incdirs: string[]): Promise<boolean> {
    this.updating = this.updating
      .catch(() => false)
      .then(() => this.updateFiles(sources, incdirs))
    return this.updating
  }

  private async updateFiles(sources: string[], incdirs: string[]): Promise<boolean> {
    if (!this.initialized) {
      // Entries are in memory, so copies from an earlier extension session cannot be trusted.
      await fs.promises.rm(this.dir, { recursive: true, force: true })
      this.initialized = true
    }
    const queued = new Set(sources)
    const queue = Array.from(queued)
    const live = new Set<string>()
    const masked = new Map<string, string>()
    const stats = new Map<string, Promise<fs.Stats | undefined>>()
    const stat = (file: string) => {
      if (!stats.has(file)) {
        stats.set(
          file,
          fs.promises.stat(file).catch((error) => {
            if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
              return undefined
            }
            throw error
          })
        )
      }
      return stats.get(file)!
    }
    let markup = false
    const visit = async (file: string) => {
      const info = await stat(file)
      if (!info?.isFile()) {
        return
      }
      live.add(file)
      let entry = this.entries.get(file)
      if (
        entry === undefined ||
        entry.mtimeMs !== info.mtimeMs ||
        entry.ctimeMs !== info.ctimeMs ||
        entry.size !== info.size
      ) {
        const text = await fs.promises.readFile(file, 'utf-8')
        const result = maskTemplate(text, true)
        masked.set(file, result.text)
        entry = {
          mtimeMs: info.mtimeMs,
          ctimeMs: info.ctimeMs,
          size: info.size,
          includes: Array.from(text.matchAll(INCLUDE_RE), (m) => m[1]),
          template:
            result.regions.length === 0
              ? undefined
              : {
                  lineStarts: Array.from(text.matchAll(/^/gm), (m) => m.index!),
                  parts: result.regions.map(([start, end]) => {
                    const after = /\S/g
                    after.lastIndex = end
                    return [start, after.exec(text)?.index ?? text.length]
                  }),
                },
          copied: false,
        }
        this.entries.set(file, entry)
      }
      markup = markup || entry.template !== undefined
      for (const name of entry.includes) {
        for (const header of includeCandidates(file, name, incdirs)) {
          if ((await stat(header))?.isFile()) {
            if (!queued.has(header)) {
              queued.add(header)
              queue.push(header)
            }
            break
          }
        }
      }
    }
    for (let next = 0; next < queue.length;) {
      const batch = queue.slice(next, next + 32)
      next += batch.length
      const results = await Promise.allSettled(batch.map(visit))
      for (const result of results) {
        if (result.status === 'rejected') {
          throw result.reason
        }
      }
    }
    for (const [file] of this.entries) {
      if (!live.has(file)) {
        await fs.promises.rm(this.copyOf(file), { force: true })
        this.entries.delete(file)
      }
    }
    if (!markup) {
      return false
    }
    const changed = Array.from(live).filter((file) => !this.entries.get(file)!.copied)
    const dirs = new Set(
      incdirs
        .map((dir) => this.copyOf(dir))
        .concat(changed.map((file) => path.dirname(this.copyOf(file))))
    )
    await Promise.all(Array.from(dirs, (dir) => fs.promises.mkdir(dir, { recursive: true })))
    for (let next = 0; next < changed.length; next += 32) {
      const results = await Promise.allSettled(
        changed.slice(next, next + 32).map(async (file) => {
          const text =
            masked.get(file) ?? maskTemplate(await fs.promises.readFile(file, 'utf-8'), true).text
          await fs.promises.writeFile(this.copyOf(file), text)
          this.entries.get(file)!.copied = true
        })
      )
      for (const result of results) {
        if (result.status === 'rejected') {
          throw result.reason
        }
      }
    }
    return true
  }

  copyOf(file: string): string {
    return path.join(this.dir, file)
  }

  /// The file that `file` is a copy of, or `file` itself
  original(file: string): string {
    return file.startsWith(this.dir + path.sep) ? file.slice(this.dir.length) : file
  }

  hasMarkup(file: string): boolean {
    return this.entries.get(file)?.template !== undefined
  }

  /// Whether a position of `file` is in a masked part, or at the first character after one
  inTemplate(file: string, line: number, character: number): boolean {
    const template = this.entries.get(file)?.template
    if (template === undefined) {
      return false
    }
    const offset = (template.lineStarts[line] ?? Infinity) + character
    return template.parts.some(([start, end]) => start <= offset && offset <= end)
  }

  /// The line of the first masked part of `file`
  firstLine(file: string): number {
    const template = this.entries.get(file)?.template
    if (template === undefined) {
      return 0
    }
    const first = template.parts[0][0]
    return template.lineStarts.filter((start) => start <= first).length - 1
  }
}
