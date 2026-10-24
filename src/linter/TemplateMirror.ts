// SPDX-License-Identifier: MIT
import * as fs from 'fs'
import * as path from 'path'
import { maskTemplate } from '../Template'

const INCLUDE_RE = /^[ \t]*`include[ \t]+"([^"]+)"/gm

interface Entry {
  mtimeMs: number
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

  constructor(readonly dir: string) {}

  /// Brings the copies of `sources` and the headers they include up to date. False when none of
  /// them has markup, and slang can read the files themselves.
  async update(sources: string[], incdirs: string[]): Promise<boolean> {
    const queue = sources.slice()
    const seen = new Set<string>()
    const masked = new Map<string, string>()
    let markup = false
    while (queue.length > 0) {
      const file = queue.shift()!
      if (seen.has(file)) {
        continue
      }
      seen.add(file)
      let stat: fs.Stats
      try {
        stat = await fs.promises.stat(file)
      } catch {
        continue
      }
      let entry = this.entries.get(file)
      if (entry === undefined || entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) {
        const text = await fs.promises.readFile(file, 'utf-8')
        const result = maskTemplate(text, true)
        masked.set(file, result.text)
        entry = {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
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
        for (const dir of [path.dirname(file)].concat(incdirs)) {
          const header = path.resolve(dir, name)
          if (fs.existsSync(header)) {
            queue.push(header)
            break
          }
        }
      }
    }
    if (!markup) {
      return false
    }
    for (const dir of incdirs) {
      await fs.promises.mkdir(this.copyOf(dir), { recursive: true })
    }
    for (const file of seen) {
      const entry = this.entries.get(file)
      if (entry === undefined || entry.copied) {
        continue
      }
      const text =
        masked.get(file) ?? maskTemplate(await fs.promises.readFile(file, 'utf-8'), true).text
      await fs.promises.mkdir(path.dirname(this.copyOf(file)), { recursive: true })
      await fs.promises.writeFile(this.copyOf(file), text)
      entry.copied = true
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
