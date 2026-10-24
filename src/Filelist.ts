// SPDX-License-Identifier: MIT
import * as fs from 'fs'
import * as path from 'path'

export interface Filelist {
  path: string
  files: string[]
  incdirs: string[]
  /// macro name -> value ('' when defined without one)
  defines: Map<string, string>
  /// the arguments other than sources and include directories, such as the macros or `--top name`
  options: string[]
}

const HDL_FILE = /\.(v|vl|vh|sv|svh)$/i

/// Reads a tool filelist (the format passed with -f): source files, +incdir+/-I include
/// directories and +define+/-D macros. Relative paths resolve against the workspace root,
/// where the linters run.
export function readFilelist(file: string, root: string): Filelist {
  const result: Filelist = { path: file, files: [], incdirs: [], defines: new Map(), options: [] }
  const text = fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
  const tokens = (text.match(/"[^"]*"|\S+/g) ?? []).map((tok) => tok.replace(/^"(.*)"$/, '$1'))
  const addDefine = (def: string) => {
    const eq = def.indexOf('=')
    result.defines.set(eq < 0 ? def : def.slice(0, eq), eq < 0 ? '' : def.slice(eq + 1))
  }
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok.startsWith('+incdir+')) {
      for (const dir of tok.slice(8).split('+').filter(Boolean)) {
        result.incdirs.push(path.resolve(root, dir))
      }
    } else if (tok.startsWith('+define+')) {
      tok.slice(8).split('+').filter(Boolean).forEach(addDefine)
      result.options.push(tok)
    } else if (tok.startsWith('-I')) {
      const dir = tok.length > 2 ? tok.slice(2) : tokens[++i]
      if (dir !== undefined) {
        result.incdirs.push(path.resolve(root, dir))
      }
    } else if (tok.startsWith('-D')) {
      const def = tok.length > 2 ? tok.slice(2) : tokens[++i]
      if (def !== undefined) {
        addDefine(def)
        result.options.push('-D', def)
      }
    } else if (!tok.startsWith('-') && !tok.startsWith('+') && HDL_FILE.test(tok)) {
      result.files.push(path.resolve(root, tok))
    } else {
      result.options.push(tok)
    }
  }
  return result
}

/// The file that `` `include "name" `` in `includer` reads: its directory first, then the
/// include directories, as slang searches them.
export function includeCandidates(
  includer: string,
  name: string,
  incdirs: readonly string[]
): string[] {
  return path.isAbsolute(name)
    ? [name]
    : [path.dirname(includer)].concat(incdirs).map((dir) => path.resolve(dir, name))
}

export async function resolveInclude(
  includer: string,
  name: string,
  filelist: Filelist | undefined
): Promise<string | undefined> {
  for (const file of includeCandidates(includer, name, filelist?.incdirs ?? [])) {
    try {
      await fs.promises.access(file)
      return file
    } catch {
      // not in this directory
    }
  }
  return undefined
}
