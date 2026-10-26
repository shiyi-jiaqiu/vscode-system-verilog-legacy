// SPDX-License-Identifier: MIT
import * as fs from 'fs'
import * as path from 'path'
import { includeCandidates } from '../Filelist'

interface Entry {
  stamp: string
  includes: string[]
  dependencies: string[]
}

export interface IncludePolicy {
  disableLocalIncludes?: boolean
  incDirFirst?: boolean
}

export class SourceDependencies {
  private entries = new Map<string, Entry>()
  private queue: Promise<unknown> = Promise.resolve()

  update(
    sources: string[],
    incdirs: string[],
    buffers: ReadonlyMap<string, string> = new Map(),
    policy: IncludePolicy = {}
  ): Promise<void> {
    const result = this.queue
      .catch(() => {})
      .then(() => this.scan(sources, incdirs, buffers, policy))
    this.queue = result
    return result
  }

  private async scan(
    sources: string[],
    incdirs: string[],
    buffers: ReadonlyMap<string, string>,
    policy: IncludePolicy
  ): Promise<void> {
    const seen = new Set(sources)
    const queue = [...seen]
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
      if (!buffers.has(file) && !info?.isFile()) {
        this.entries.delete(file)
        continue
      }
      const stamp = info ? `${info.mtimeMs}:${info.ctimeMs}:${info.size}` : ''
      let entry = this.entries.get(file)
      if (buffers.has(file) || entry?.stamp !== stamp) {
        const text = buffers.get(file) ?? (await fs.promises.readFile(file, 'utf8'))
        entry = {
          stamp: buffers.has(file) ? '' : stamp,
          includes: Array.from(text.matchAll(/^[ \t]*`include[ \t]+"([^"]+)"/gm), (m) => m[1]),
          dependencies: [],
        }
        this.entries.set(file, entry)
      }
      entry.dependencies = []
      for (const name of entry.includes) {
        let candidates = includeCandidates(file, name, incdirs)
        if (!path.isAbsolute(name)) {
          const local = candidates.shift()!
          if (!policy.disableLocalIncludes) {
            if (policy.incDirFirst) {
              candidates.push(local)
            } else {
              candidates.unshift(local)
            }
          }
        }
        for (const candidate of candidates) {
          if (buffers.has(candidate) || (await stat(candidate))?.isFile()) {
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
