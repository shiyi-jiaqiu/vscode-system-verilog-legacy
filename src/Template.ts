// SPDX-License-Identifier: MIT

/// Perl template markup in Verilog source: `<perl>...</perl>` holds Perl code, such as a loop or
/// an if/elsif/else spread over several blocks with Verilog between them, and `<pl>...</pl>` a
/// Perl expression whose output becomes Verilog text, from part of a name to whole declarations.
const MARKUP_RE = /<(perl|pl)>([\s\S]*?)<\/\1>/g

export function hasTemplate(text: string): boolean {
  return text.includes('<perl>') || text.includes('<pl>')
}

/// [start, end) offsets in the text
export type Regions = [number, number][]

/// Follows the `{ }` of the Perl code of one block. `open` holds, for each brace still open from
/// this or earlier blocks, whether it is a hash subscript such as `$h{key}`.
function followBraces(code: string, open: boolean[]) {
  // `$#array` is the last index of an array, not a comment
  const re = /(?<!\$)#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[{}]/g
  let match: RegExpExecArray | null
  while ((match = re.exec(code)) !== null) {
    if (match[0] === '{') {
      open.push(/[\w}>]/.test(code[match.index - 1] ?? ''))
    } else if (match[0] === '}') {
      open.pop()
    }
  }
}

/// `text` with the template markup blanked out, so lines and columns stay the same and the
/// Verilog around it can be read. `forLint` makes it Verilog a compiler accepts: markup within a
/// line of Verilog becomes a name of underscores, and the Verilog inside a Perl loop or if is
/// blanked too, since only Perl knows how many times and which of it ends up in the code.
/// `regions` are the parts that changed.
export function maskTemplate(
  text: string,
  forLint: boolean = false
): { text: string; regions: Regions } {
  if (!hasTemplate(text)) {
    return { text, regions: [] }
  }
  const blank = (s: string) => s.replace(/[^\n]/g, ' ')
  const open: boolean[] = []
  const inBlock = () => forLint && open.some((subscript) => !subscript)
  const regions: Regions = []
  let out = ''
  let last = 0
  let match: RegExpExecArray | null
  MARKUP_RE.lastIndex = 0
  while ((match = MARKUP_RE.exec(text)) !== null) {
    const start = match.index
    const end = MARKUP_RE.lastIndex
    const lineStart = text.lastIndexOf('\n', start - 1) + 1
    const lineEnd = text.indexOf('\n', end)
    let alone =
      !forLint ||
      (text.slice(lineStart, start).trim() === '' &&
        text.slice(end, lineEnd < 0 ? text.length : lineEnd).trim() === '')
    if (inBlock()) {
      out += blank(text.slice(last, start))
      regions.push([last, start])
      alone = true
    } else {
      out += text.slice(last, start)
    }
    out += alone ? blank(match[0]) : match[0].replace(/[^\n]/g, '_')
    regions.push([start, end])
    followBraces(match[2], open)
    last = end
  }
  if (inBlock()) {
    out += blank(text.slice(last))
    regions.push([last, text.length])
  } else {
    out += text.slice(last)
  }
  return { text: out, regions }
}
