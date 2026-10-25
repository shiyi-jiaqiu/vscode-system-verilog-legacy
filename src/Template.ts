// SPDX-License-Identifier: MIT

export function hasTemplate(text: string): boolean {
  return /<(?:perl|pl)>/.test(text)
}

export type Regions = [number, number][]

/// Browsing only: preserve offsets, hide markup and adjacent identifier fragments. Never
/// feed this to a semantic compiler or infer Perl control flow / generated declarations.
export function maskTemplate(
  text: string,
  placeholders = false
): { text: string; regions: Regions } {
  const regions: Regions = []
  const names = new Set<number>()
  const re = /<(perl|pl)>[\s\S]*?(?:<\/\1>|$)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    let start = match.index
    let end = re.lastIndex
    while (start > 0 && /[\w$]/.test(text[start - 1])) {
      start--
    }
    while (end < text.length && /[\w$]/.test(text[end])) {
      end++
    }
    regions.push([start, end])
    if (placeholders && match[1] === 'pl') {
      names.add(start)
    }
  }
  let out = ''
  let last = 0
  for (const [start, end] of regions) {
    const from = Math.max(last, start)
    let masked = text.slice(from, end).replace(/[^\n\r]/g, ' ')
    // A blank declarator makes ctags promote its type (e.g. int) to a false symbol.
    // The existing macro placeholder is explicitly excluded from every tag index.
    if (names.has(start) && from === start) {
      masked = '_' + masked.slice(1)
    }
    out += text.slice(last, start) + masked
    last = end
  }
  return { text: out + text.slice(last), regions }
}
