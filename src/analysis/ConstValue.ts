// SPDX-License-Identifier: MIT
import { ext } from '../extension'
import { Symbol } from './Symbol'

/// Default values of parameters and object-like macros, found lexically: identifiers are
/// replaced by their declared values (same scope, then imports, `pkg::`, macros and
/// filelist +define+), then evaluated as an integer expression. Parameter overrides at
/// instantiations are not considered.

const MAX_DEPTH = 12

/// Value text of a parameter/localparam declaration, from after its '=' to the end of the item.
export function getDeclValueText(sym: Symbol): string | undefined {
  const text = sym.doc.getText()
  let i = sym.doc.offsetAt(sym.getIdRange().end)
  // skip unpacked dimensions, e.g. `parameter int A [2] = '{1, 2}`
  while (i < text.length && text[i] !== '=') {
    if (';,)'.includes(text[i])) {
      return undefined
    }
    i++
  }
  if (text[i + 1] === '=') {
    return undefined
  }
  let depth = 0
  let out = ''
  for (i++; i < text.length; i++) {
    const c = text[i]
    if (c === '/' && text[i + 1] === '/') {
      i = text.indexOf('\n', i)
      if (i < 0) {
        break
      }
      out += ' '
      continue
    }
    if ('([{'.includes(c)) {
      depth++
    } else if (')]}'.includes(c)) {
      if (depth === 0) {
        break
      }
      depth--
    } else if ((c === ',' || c === ';') && depth === 0) {
      break
    }
    out += c
  }
  const value = out.replace(/\s+/g, ' ').trim()
  return value === '' ? undefined : value
}

/// Body of an object-like `define; undefined for macros with arguments.
export function getMacroBody(sym: Symbol): string | undefined {
  const text = sym.doc.getText(sym.getFullRange())
  const match = new RegExp('`define\\s+' + sym.name + '(\\(?)').exec(text)
  if (match === null || match[1] === '(') {
    return undefined
  }
  return text
    .slice(match.index + match[0].length)
    .replace(/\\\r?\n/g, ' ')
    .replace(/\/\/.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

async function findConstant(
  scope: Symbol,
  name: string,
  pkg?: string
): Promise<Symbol | undefined> {
  const syms =
    pkg !== undefined
      ? await ext.index.findDefinitionByName(pkg, name)
      : await ext.index.getVerilogDoc(scope.doc).getSymbols({ name })
  const consts = syms.filter((sym) => sym.isConstant())
  return consts.find((sym) => sym.parentScope === scope.parentScope) ?? consts[0]
}

/// Replaces names in `expr` (written in the context of `scope`) by their values, recursively.
async function substitute(expr: string, scope: Symbol, depth: number): Promise<string | undefined> {
  if (depth > MAX_DEPTH) {
    return undefined
  }
  const nameRe =
    /(`?)([A-Za-z_]\w*)(?:::([A-Za-z_]\w*))?|\$clog2|\d*'[sS]?[bodhBODH][0-9a-fA-F_xzXZ?]+/g
  let out = ''
  let last = 0
  let match: RegExpExecArray | null
  while ((match = nameRe.exec(expr)) !== null) {
    out += expr.slice(last, match.index)
    last = nameRe.lastIndex
    const [whole, tick, first, second] = match
    if (first === undefined) {
      // $clog2 or a based literal
      out += whole
      continue
    }
    let value: string | undefined
    if (tick === '`') {
      value = await macroValue(scope, first, depth + 1)
    } else {
      const sym = await findConstant(
        scope,
        second ?? first,
        second === undefined ? undefined : first
      )
      const text = sym && getDeclValueText(sym)
      value = text && (await substitute(text, sym, depth + 1))
    }
    if (value === undefined) {
      return undefined
    }
    out += '(' + value + ')'
  }
  return out + expr.slice(last)
}

async function macroValue(scope: Symbol, name: string, depth: number): Promise<string | undefined> {
  const macro = (await ext.index.findMacro(scope.doc, name))[0]
  const body = macro !== undefined ? getMacroBody(macro) : ext.projectFilelist?.defines.get(name)
  if (body === undefined || body === '') {
    return undefined
  }
  return await substitute(body, macro ?? scope, depth)
}

/// Default value of a parameter or object-like macro, if it is a constant integer expression.
export async function getConstValue(sym: Symbol): Promise<bigint | undefined> {
  let expr: string | undefined
  if (sym.isMacro()) {
    const body = getMacroBody(sym)
    expr = body && (await substitute(body, sym, 0))
  } else if (sym.isConstant()) {
    const text = getDeclValueText(sym)
    expr = text && (await substitute(text, sym, 0))
  }
  return expr === undefined ? undefined : evalConst(expr)
}

////////////////////////////////////////////////
// Integer expression evaluation
////////////////////////////////////////////////

type Token = bigint | string

function tokenize(expr: string): Token[] | undefined {
  const tokens: Token[] = []
  const re =
    /\s*(?:(\d[\d_]*)?\s*'[sS]?([bodhBODH])\s*([0-9a-fA-F_]+)|(\d[\d_]*)|(\$clog2|<<<|>>>|\*\*|<<|>>|<=|>=|==|!=|&&|\|\||~\^|\^~|[-+*/%()<>!~&|^?:]))/y
  let pos = 0
  while (pos < expr.length) {
    if (/^\s*$/.test(expr.slice(pos))) {
      break
    }
    re.lastIndex = pos
    const m = re.exec(expr)
    if (m === null) {
      return undefined
    }
    pos = re.lastIndex
    if (m[3] !== undefined) {
      const radix = { b: '0b', o: '0o', d: '', h: '0x' }[
        m[2].toLowerCase() as 'b' | 'o' | 'd' | 'h'
      ]
      const digits = m[3].replace(/_/g, '')
      if (radix === '' && !/^\d+$/.test(digits)) {
        return undefined
      }
      try {
        tokens.push(BigInt(radix + digits))
      } catch {
        return undefined
      }
    } else if (m[4] !== undefined) {
      tokens.push(BigInt(m[4].replace(/_/g, '')))
    } else {
      tokens.push(m[5])
    }
  }
  return tokens
}

// binary operators from lowest to highest precedence
const LEVELS = [
  ['||'],
  ['&&'],
  ['|'],
  ['^', '~^', '^~'],
  ['&'],
  ['==', '!='],
  ['<', '<=', '>', '>='],
  ['<<', '>>', '<<<', '>>>'],
  ['+', '-'],
  ['*', '/', '%'],
]

function binary(op: string, a: bigint, b: bigint): bigint {
  switch (op) {
    case '||':
      return BigInt(a !== 0n || b !== 0n)
    case '&&':
      return BigInt(a !== 0n && b !== 0n)
    case '|':
      return a | b
    case '^':
      return a ^ b
    case '~^':
    case '^~':
      return ~(a ^ b)
    case '&':
      return a & b
    case '==':
      return BigInt(a === b)
    case '!=':
      return BigInt(a !== b)
    case '<':
      return BigInt(a < b)
    case '<=':
      return BigInt(a <= b)
    case '>':
      return BigInt(a > b)
    case '>=':
      return BigInt(a >= b)
    case '<<':
    case '<<<':
      return a << b
    case '>>':
    case '>>>':
      return a >> b
    case '+':
      return a + b
    case '-':
      return a - b
    case '*':
      return a * b
    case '/':
      return a / b
    default:
      return a % b
  }
}

function clog2(v: bigint): bigint {
  let n = 0n
  while (1n << n < v) {
    n++
  }
  return n
}

/// Evaluates an integer constant expression; undefined if it uses anything else.
export function evalConst(expr: string): bigint | undefined {
  const tokens = tokenize(expr)
  if (tokens === undefined || tokens.length === 0) {
    return undefined
  }
  let pos = 0
  const peek = () => tokens[pos]
  const expect = (t: string) => {
    if (tokens[pos++] !== t) {
      throw new Error('expected ' + t)
    }
  }

  const primary = (): bigint => {
    const t = tokens[pos++]
    if (typeof t === 'bigint') {
      return t
    }
    if (t === '(') {
      const v = ternary()
      expect(')')
      return v
    }
    if (t === '$clog2') {
      expect('(')
      const v = ternary()
      expect(')')
      return clog2(v)
    }
    throw new Error('unexpected ' + t)
  }

  const unary = (): bigint => {
    const t = peek()
    if (t === '-' || t === '+' || t === '!' || t === '~') {
      pos++
      const v = unary()
      return t === '-' ? -v : t === '+' ? v : t === '!' ? BigInt(v === 0n) : ~v
    }
    return power()
  }

  const power = (): bigint => {
    const base = primary()
    if (peek() === '**') {
      pos++
      const exp = unary()
      if (exp < 0n) {
        throw new Error('negative exponent')
      }
      return base ** exp
    }
    return base
  }

  const level = (n: number): bigint => {
    if (n === LEVELS.length) {
      return unary()
    }
    let v = level(n + 1)
    while (typeof peek() === 'string' && LEVELS[n].includes(peek() as string)) {
      const op = tokens[pos++] as string
      const rhs = level(n + 1)
      if ((op === '/' || op === '%') && rhs === 0n) {
        throw new Error('division by zero')
      }
      v = binary(op, v, rhs)
    }
    return v
  }

  const ternary = (): bigint => {
    const cond = level(0)
    if (peek() === '?') {
      pos++
      const a = ternary()
      expect(':')
      const b = ternary()
      return cond !== 0n ? a : b
    }
    return cond
  }

  try {
    const v = ternary()
    return pos === tokens.length ? v : undefined
  } catch {
    return undefined
  }
}
