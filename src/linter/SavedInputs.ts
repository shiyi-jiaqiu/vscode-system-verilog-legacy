// SPDX-License-Identifier: MIT
import * as fs from 'fs'
import { Buffer } from 'buffer'
import { TextDecoder } from 'util'

/// Record input metadata before the compiler runs. Only files actually mentioned
/// in diagnostics need bytes; never read the whole project into the extension host.
export class SavedInputs {
  private stamps = new Map<string, string | undefined>()
  private files = new Map<string, Buffer[]>()
  private canonical = new Map<string, string>()
  private stale = false
  private readonly started = Date.now()
  constructor(
    private readonly encoding: (file: string) => string = () => 'utf8',
    private readonly editorText?: (file: string) => string | undefined
  ) {}

  private static stamp(stat: fs.Stats): string {
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
  }

  private async each(paths: Iterable<string>, work: (file: string) => Promise<void>) {
    const pending = [...new Set(paths)]
    let next = 0
    await Promise.all(
      Array.from({ length: Math.min(16, pending.length) }, async () => {
        while (next < pending.length) {
          await work(pending[next++])
        }
      })
    )
  }

  async capture(paths: Iterable<string>): Promise<void> {
    await this.each(paths, async (file) => {
      const stat = await fs.promises.stat(file).catch(() => undefined)
      this.stamps.set(file, stat ? SavedInputs.stamp(stat) : undefined)
    })
  }

  /// The compiler's dependency file discovers -y libraries and macro/angle includes.
  /// Files not known at start are accepted only if they predate this run.
  async discover(paths: Iterable<string>): Promise<void> {
    await this.each(paths, async (file) => {
      if (this.stamps.has(file)) {
        return
      }
      const stat = await fs.promises.stat(file).catch(() => undefined)
      if (stat && Math.max(stat.mtimeMs, stat.ctimeMs) > this.started) {
        this.stale = true
      }
      this.stamps.set(file, stat ? SavedInputs.stamp(stat) : undefined)
    })
  }

  async load(paths: Iterable<string>): Promise<void> {
    const unique = [...new Set(paths)]
    await this.discover(unique)
    await this.each(unique, async (file) => {
      try {
        const before = await fs.promises.stat(file)
        if (SavedInputs.stamp(before) !== this.stamps.get(file)) {
          this.stale = true
          return
        }
        const bytes = await fs.promises.readFile(file)
        const real = await fs.promises.realpath(file)
        this.canonical.set(file, real)
        const editor = this.editorText?.(real)
        if (editor !== undefined && this.decoder(file).decode(bytes) !== editor) {
          // A tab can be reopened with an encoding different from files.encoding.
          // Its exact encoding is not exposed by the VS Code TextDocument API.
          return
        }
        const after = await fs.promises.stat(file)
        if (SavedInputs.stamp(before) !== SavedInputs.stamp(after)) {
          this.stale = true
          return
        }
        const lines: Buffer[] = []
        let start = 0
        for (let i = 0; i < bytes.length; i++) {
          if (bytes[i] === 10 || bytes[i] === 13) {
            lines.push(bytes.subarray(start, i))
            if (bytes[i] === 13 && bytes[i + 1] === 10) {
              i++
            }
            start = i + 1
          }
        }
        lines.push(bytes.subarray(start))
        this.files.set(file, lines)
      } catch {
        // Preserve file/line and explain an unavailable column; let the compiler
        // diagnose missing inputs instead of aborting all diagnostics on ENOENT.
      }
    })
  }

  has(file: string): boolean {
    return this.files.has(file)
  }

  column(file: string, line: number, byteColumn: number): number | undefined {
    const bytes = this.files.get(file)?.[line]
    if (bytes === undefined || byteColumn < 0) {
      return undefined
    }
    // Decode the original prefix, not a re-encoded replacement character. Invalid
    // UTF-8 comment bytes count exactly as the editor's replacement characters.
    try {
      return this.decoder(file).decode(bytes.subarray(0, byteColumn)).length
    } catch {
      return undefined
    }
  }

  private decoder(file: string): TextDecoder {
    const requested = this.encoding(this.canonical.get(file) ?? file).toLowerCase()
    const aliases: Record<string, string> = {
      utf8: 'utf-8',
      utf8bom: 'utf-8',
      gb2312: 'gbk',
      cp936: 'gbk',
      windows1252: 'windows-1252',
      iso88591: 'iso-8859-1',
      shiftjis: 'shift_jis',
    }
    return new TextDecoder(aliases[requested] ?? requested)
  }

  async unchanged(): Promise<boolean> {
    await this.each(this.stamps.keys(), async (file) => {
      const stat = await fs.promises.stat(file).catch(() => undefined)
      if ((stat ? SavedInputs.stamp(stat) : undefined) !== this.stamps.get(file)) {
        this.stale = true
      }
    })
    return !this.stale
  }
}
