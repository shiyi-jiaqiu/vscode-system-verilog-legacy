// SPDX-License-Identifier: MIT
import * as fs from 'fs'
import * as path from 'path'
import { env } from 'process'

export interface Filelist {
  path: string
  files: string[]
  commandFiles: string[]
  incdirs: string[]
  /// macro name -> value ('' when defined without one)
  defines: Map<string, string>
  /// the arguments other than sources and include directories, such as the macros or `--top name`
  options: string[]
}

const HDL_FILE = /\.(v|vl|vh|sv|svh)$/i

/// Tokenization follows slang command files: quotes, escapes, comments, and environment
/// expansion. It never evaluates shell commands. Unset variables are configuration errors.
function tokenize(
  text: string,
  environment: Record<string, string | undefined>,
  expand = true
): string[] {
  const tokens: string[] = []
  let token = ''
  let pending = false
  const finish = () => {
    if (pending) {
      tokens.push(token)
    }
    token = ''
    pending = false
  }
  for (let i = 0; i < text.length;) {
    const c = text[i++]
    if (/\s/.test(c)) {
      finish()
      continue
    }
    if (c === '#' || (!pending && c === '/' && text[i] === '/')) {
      finish()
      while (i < text.length && text[i] !== '\n') {
        i++
      }
      continue
    }
    if (!pending && c === '/' && text[i] === '*') {
      const end = text.indexOf('*/', i + 1)
      if (end < 0) {
        throw new Error('Unclosed filelist comment')
      }
      i = end + 2
      continue
    }
    if (c === '\\') {
      if (i < text.length && !/[\r\n]/.test(text[i])) {
        token += text[i++]
        pending = true
      }
      continue
    }
    const variable = () => {
      const match =
        /^(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|\(([A-Za-z_][A-Za-z0-9_]*)\)|([A-Za-z_][A-Za-z0-9_]*))/.exec(
          text.slice(i)
        )
      if (!match) {
        return '$'
      }
      i += match[0].length
      const name = match[1] ?? match[2] ?? match[3]
      if (!environment[name]) {
        throw new Error(`Environment variable ${name} is unset or empty`)
      }
      return environment[name]!
    }
    if (c === '$' && expand) {
      // Outside quotes an environment value may contain several arguments.
      const value = tokenize(variable(), environment, false)
      if (value.length) {
        token += value[0]
        pending = true
        for (const part of value.slice(1)) {
          finish()
          token = part
          pending = true
        }
      }
      continue
    }
    pending = true
    if (c === "'" || c === '"') {
      let closed = false
      while (i < text.length) {
        let ch = text[i++]
        if (ch === c) {
          closed = true
          break
        }
        if (c === '"' && ch === '\\' && /[\\"]/.test(text[i] ?? '')) {
          ch = text[i++]
        }
        token += c === '"' && ch === '$' && expand ? variable() : ch
      }
      if (!closed) {
        throw new Error('Unclosed filelist quote')
      }
    } else {
      token += c
    }
  }
  finish()
  return tokens
}

/// -f retains the caller's working directory; -F changes it to the command file's
/// directory, including for nested -f files. This matches slang's Driver parser.
export function readFilelist(
  file: string,
  root: string,
  onCommandFile?: (file: string) => void
): Filelist {
  const result: Filelist = {
    path: file,
    files: [],
    incdirs: [],
    defines: new Map(),
    options: [],
    commandFiles: [],
  }
  const active = new Set<string>()
  const addDefine = (def: string) => {
    const eq = def.indexOf('=')
    result.defines.set(eq < 0 ? def : def.slice(0, eq), eq < 0 ? '' : def.slice(eq + 1))
  }
  const read = (file: string, base: string) => {
    onCommandFile?.(file)
    const canonical = fs.realpathSync(file)
    if (active.has(canonical)) {
      throw new Error(`Recursive filelist: ${file}`)
    }
    active.add(canonical)
    result.commandFiles.push(file)
    const tokens = tokenize(fs.readFileSync(file, 'utf8'), env)
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i]
      const argument = (prefix: string) => {
        const value = tok.length > prefix.length ? tok.slice(prefix.length) : tokens[++i]
        if (!value) {
          throw new Error(`Missing argument for ${prefix} in ${file}`)
        }
        return value
      }
      if (/^-[fF]/.test(tok)) {
        const relative = tok[1] === 'F'
        for (const name of argument(tok.slice(0, 2)).split(',')) {
          const child = path.resolve(base, name)
          read(child, relative ? path.dirname(child) : base)
        }
      } else if (tok.startsWith('+incdir+')) {
        result.incdirs.push(
          ...tok
            .slice(8)
            .split('+')
            .filter(Boolean)
            .map((dir) => path.resolve(base, dir))
        )
      } else if (tok.startsWith('+define+')) {
        tok.slice(8).split('+').filter(Boolean).forEach(addDefine)
        result.options.push(tok)
      } else if (tok.startsWith('-I')) {
        result.incdirs.push(path.resolve(base, argument('-I')))
      } else if (tok.startsWith('-D')) {
        const def = argument('-D')
        addDefine(def)
        result.options.push('-D', def)
      } else if (tok === '-y' || tok === '-v') {
        const value = path.resolve(base, argument(tok))
        result.options.push(tok, value)
        if (tok === '-v') {
          result.files.push(value)
        }
      } else if (!tok.startsWith('-') && !tok.startsWith('+') && HDL_FILE.test(tok)) {
        result.files.push(path.resolve(base, tok))
      } else {
        result.options.push(tok)
      }
    }
    active.delete(canonical)
  }
  read(path.resolve(root, file), root)
  result.files = [...new Set(result.files)]
  result.incdirs = [...new Set(result.incdirs)]
  result.commandFiles = [...new Set(result.commandFiles)]
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
