// SPDX-License-Identifier: MIT
import * as fs from 'fs'
import { includeCandidates } from '../Filelist'
import { hasTemplate } from '../Template'

interface Entry {
  stamp: string
  includes: string[]
  dependencies: string[]
  template: boolean
}

/// Metadata only: never invent compiler input for unexpanded templates.
export class SourceDependencies {
  private entries = new Map<string, Entry>()
  private queue: Promise<unknown> = Promise.resolve()

  update(
    sources: string[],
    incdirs: string[],
    buffers: ReadonlyMap<string, string> = new Map()
  ): Promise<Set<string>> {
    const result = this.queue.catch(() => {}).then(() => this.scan(sources, incdirs, buffers))
    this.queue = result
    return result
  }

  private async scan(
    sources: string[],
    incdirs: string[],
    buffers: ReadonlyMap<string, string>
  ): Promise<Set<string>> {
    const seen = new Set(sources)
    const queue = [...seen]
    const templates = new Set<string>()
    // Shared headers and missing include candidates need at most one stat per scan.
    const stats = new Map<string, Promise<fs.Stats | undefined>>()
    const stat = (file: string) => {
      let result = stats.get(file)
      if (!result) {
        result = fs.promises.stat(file).catch(() => undefined)
        stats.set(file, result)
      }
      return result
    }
    for (let i = 0; i < queue.length; i++) {
      const file = queue[i]
      const info = await stat(file)
      if (!info?.isFile()) {
        this.entries.delete(file)
        continue
      }
      const stamp = `${info.mtimeMs}:${info.ctimeMs}:${info.size}`
      let entry = this.entries.get(file)
      if (buffers.has(file) || entry?.stamp !== stamp) {
        const text = buffers.get(file) ?? (await fs.promises.readFile(file, 'utf8'))
        entry = {
          stamp: buffers.has(file) ? '' : stamp,
          includes: Array.from(text.matchAll(/^[ \t]*`include[ \t]+"([^"]+)"/gm), (m) => m[1]),
          dependencies: [],
          template: hasTemplate(text),
        }
        this.entries.set(file, entry)
      }
      if (entry.template) {
        templates.add(file)
      }
      entry.dependencies = []
      for (const name of entry.includes) {
        for (const candidate of includeCandidates(file, name, incdirs)) {
          if ((await stat(candidate))?.isFile()) {
            entry.dependencies.push(candidate)
            if (!seen.has(candidate)) {
              seen.add(candidate)
              queue.push(candidate)
            }
            break
          }
        }
      }
    }
    return this.affectedBy(templates)
  }

  affectedBy(files: Set<string>): Set<string> {
    const parents = new Map<string, string[]>()
    for (const [file, entry] of this.entries) {
      for (const dependency of entry.dependencies) {
        const dependents = parents.get(dependency) ?? []
        dependents.push(file)
        parents.set(dependency, dependents)
      }
    }
    const affected = new Set(files)
    const queue = [...files]
    for (let i = 0; i < queue.length; i++) {
      for (const parent of parents.get(queue[i]) ?? []) {
        if (!affected.has(parent)) {
          affected.add(parent)
          queue.push(parent)
        }
      }
    }
    return affected
  }

  dependenciesOf(file: string): Set<string> {
    const seen = new Set([file])
    const queue = [file]
    for (let i = 0; i < queue.length; i++) {
      for (const dependency of this.entries.get(queue[i])?.dependencies ?? []) {
        if (!seen.has(dependency)) {
          seen.add(dependency)
          queue.push(dependency)
        }
      }
    }
    seen.delete(file)
    return seen
  }
}
