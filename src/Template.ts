// SPDX-License-Identifier: MIT

export function hasTemplate(text: string): boolean {
  return /<(?:perl|pl)>/.test(text)
}

export type Regions = [number, number][]

/// Browsing only: preserve offsets, hide markup and adjacent identifier fragments. Never
/// feed this to a semantic compiler or infer Perl control flow / generated declarations.
export function maskTemplate(text: string): { text: string; regions: Regions } {
  const regions: Regions = []
  const re = /<(perl|pl)>[\s\S]*?(?:<\/\1>|$)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    let start = match.index
    let end = re.lastIndex
    while (start > 0 && /[\w$]/.test(text[start - 1])) {start--}
    while (end < text.length && /[\w$]/.test(text[end])) {end++}
    regions.push([start, end])
  }
  let out = ''
  let last = 0
  for (const [start, end] of regions) {
    out += text.slice(last, start) + text.slice(Math.max(last, start), end).replace(/[^\n\r]/g, ' ')
    last = end
  }
  return { text: out + text.slice(last), regions }
}
