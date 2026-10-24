// SPDX-License-Identifier: MIT
import { ext } from '../extension'
import { Symbol } from './Symbol'
import { VerilogDoc } from './VerilogDoc'

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

function getIntegerValueText(sym: Symbol): string | undefined {
  const before = sym.doc.lineAt(sym.line).text.slice(0, sym.getIdRange().start.character)
  // Packed dimensions, unsigned types and inherited declaration types need SV sizing rules.
  return /\b(?:localparam|parameter)\s+(?:(?:int|integer)\s+)?$/.test(before)
    ? getDeclValueText(sym)
    : undefined
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

/// A parameter or macro that a value is computed through
export interface ValueStep {
  /// with a leading ` for a macro
  name: string
  /// its written value; undefined when it is not defined
  text: string | undefined
  value: bigint | undefined
  /// 0 for the names in the hovered value, 1 for the names in theirs, ...
  depth: number
  /// the definition, undefined for a macro from the filelist
  sym: Symbol | undefined
}

/// Where a macro is used: the text of a macro is read there, so names in it are looked up as
/// seen from `unit` (a module, interface or package) of `doc`
export interface UseSite {
  doc: VerilogDoc
  unit: string | undefined
}

/// Replaces names in `expr` (written in the context of `scope`, or expanded at `site`) by their
/// values, recursively, and records each name in `steps` once.
async function substitute(
  expr: string,
  scope: Symbol,
  depth: number,
  site: UseSite | undefined,
  steps: ValueStep[]
): Promise<string | undefined> {
  if (depth > MAX_DEPTH) {
    return undefined
  }
  const nameRe =
    /(`?)([A-Za-z_]\w*)(?:::([A-Za-z_]\w*))?|\$clog2|\d*'[sS]?[bodhBODH][0-9a-fA-F_xzXZ?]+/g
  let out = ''
  let last = 0
  // the other names are still looked up, for the steps
  let failed = false
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
    const name = tick === '`' ? '`' + first : whole
    const step: ValueStep = { name, text: undefined, value: undefined, depth, sym: undefined }
    const recorded = steps.some((s) => s.name === name)
    if (!recorded) {
      steps.push(step)
    }
    let value: string | undefined
    if (tick === '`') {
      const macro = (await ext.index.findMacro(site?.doc.doc ?? scope.doc, first))[0]
      step.sym = macro
      step.text =
        macro !== undefined ? getMacroBody(macro) : ext.projectFilelist?.defines.get(first)
      if (step.text !== undefined && step.text !== '') {
        // a macro's text is read where it is used
        value = await substitute(step.text, macro ?? scope, depth + 1, site, recorded ? [] : steps)
      }
    } else {
      const visible =
        second === undefined && site !== undefined
          ? (await site.doc.findVisible(first, site.unit)).find((sym) => sym.isConstant())
          : undefined
      const sym =
        visible ??
        (await findConstant(scope, second ?? first, second === undefined ? undefined : first))
      step.sym = sym
      step.text = sym && getDeclValueText(sym)
      // a parameter's value is read where it is declared
      const text = sym && getIntegerValueText(sym)
      value = text && (await substitute(text, sym!, depth + 1, undefined, recorded ? [] : steps))
    }
    step.value = value === undefined ? undefined : evalConst(value)
    failed = failed || value === undefined
    out += '(' + value + ')'
  }
  return failed ? undefined : out + expr.slice(last)
}

/// Default value of a parameter or object-like macro, if it is a constant integer expression.
/// A macro used at `site` is read there. `steps` receives the names it was computed through.
export async function getConstValue(
  sym: Symbol,
  site: UseSite | undefined = undefined,
  steps: ValueStep[] = []
): Promise<bigint | undefined> {
  let expr: string | undefined
  if (sym.isMacro()) {
    const body = getMacroBody(sym)
    expr = body && (await substitute(body, sym, 0, site, steps))
  } else if (sym.isConstant()) {
    const text = getIntegerValueText(sym)
    expr = text && (await substitute(text, sym, 0, undefined, steps))
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

function integer(value: bigint): bigint {
  if (value < -2147483648n || value > 2147483647n) {
    throw new Error('integer sizing required')
  }
  return value
}

/// Evaluates integer expressions whose result does not depend on SV sizing or overflow.
export function evalConst(expr: string): bigint | undefined {
  // BigInt alone cannot preserve the width and signedness of based literals.
  if (expr.includes("'")) {
    return undefined
  }
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
      return integer(t)
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
      return integer(t === '-' ? -v : t === '+' ? v : t === '!' ? BigInt(v === 0n) : ~v)
    }
    return power()
  }

  const power = (): bigint => {
    const base = primary()
    if (peek() === '**') {
      pos++
      const exp = unary()
      if (exp < 0n || exp > 31n) {
        throw new Error('exponent requires sizing')
      }
      return integer(base ** exp)
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
      if (
        ['<<', '>>', '<<<', '>>>'].includes(op) &&
        (rhs < 0n || rhs > 31n || (op === '>>' && v < 0n))
      ) {
        throw new Error('shift requires sizing')
      }
      v = integer(binary(op, v, rhs))
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
