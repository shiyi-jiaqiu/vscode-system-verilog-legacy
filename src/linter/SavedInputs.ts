// SPDX-License-Identifier: MIT
import * as fs from 'fs'
import { Buffer } from 'buffer'

/// CLI positions refer to saved UTF-8 input. Keep those bytes until the run finishes;
/// never translate a compiler column through a subsequently edited TextDocument.
export class SavedInputs {
  private files = new Map<string, { text: string; lines: string[]; stamp: string }>()

  private static stamp(stat: fs.Stats): string {
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
  }

  async capture(paths: Iterable<string>): Promise<void> {
    for (const file of new Set(paths)) {
      const before = await fs.promises.stat(file)
      const text = await fs.promises.readFile(file, 'utf8')
      const after = await fs.promises.stat(file)
      if (SavedInputs.stamp(before) !== SavedInputs.stamp(after)) {
        throw new Error(`Input changed while reading ${file}; save and run Lint again`)
      }
      const snapshot = {
        text,
        lines: text.split(/\r\n|\n|\r/),
        stamp: SavedInputs.stamp(after),
      }
      this.files.set(file, snapshot)
      this.files.set(await fs.promises.realpath(file), snapshot)
    }
  }

  has(file: string): boolean {
    return this.files.has(file)
  }

  column(file: string, line: number, byteColumn: number): number | undefined {
    const text = this.files.get(file)?.lines[line]
    if (text === undefined || byteColumn < 0) {
      return undefined
    }
    let bytes = 0,
      utf16 = 0
    for (const char of text) {
      const width = Buffer.byteLength(char, 'utf8')
      if (bytes + width > byteColumn) {
        break
      }
      bytes += width
      utf16 += char.length
    }
    return utf16
  }

  async unchanged(): Promise<boolean> {
    for (const [file, snapshot] of this.files) {
      const stat = await fs.promises.stat(file).catch(() => undefined)
      if (!stat || SavedInputs.stamp(stat) !== snapshot.stamp) {
        return false
      }
    }
    return true
  }
}
