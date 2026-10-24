// SPDX-License-Identifier: MIT
import * as vscode from 'vscode'
import { Symbol } from './analysis/Symbol'
import { ext } from './extension'
import { ExtensionComponent } from './lib/libconfig'
import { anyVerilogSelector } from './utils'

// `port` and `instance` are declared in package.json with parameter/variable as super types
const legend = new vscode.SemanticTokensLegend(
  [
    'port',
    'variable',
    'enumMember',
    'instance',
    'type',
    'class',
    'interface',
    'namespace',
    'function',
  ],
  ['readonly']
)

type TokenKind = [type: number, modifiers: number]

function symbolToken(sym: Symbol): TokenKind | undefined {
  switch (sym.type) {
    case 'port':
      return [0, 0]
    case 'parameter':
    case 'constant':
      return sym.parentType === 'typedef' || sym.parentType === 'enum' ? [2, 0] : [1, 1]
    case 'net':
    case 'register':
      return [1, 0]
    case 'instance':
      return [3, 0]
    case 'typedef':
    case 'struct':
    case 'enum':
      return [4, 0]
    case 'function':
    case 'task':
      return [8, 0]
  }
  return unitToken(sym.type)
}

function unitToken(kind: string | undefined): TokenKind | undefined {
  switch (kind) {
    case 'module':
    case 'program':
    case 'class':
      return [5, 0]
    case 'interface':
      return [6, 0]
    case 'package':
      return [7, 0]
  }
  return undefined
}

// comments, strings, macros, system tasks and escaped identifiers are skipped;
// group 1: identifier, group 2: name after `::`
const WORD_RE =
  /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\\n])*"|`\w+|\$\w+|\\\S+|([A-Za-z_][\w$]*)(?:(\s*::\s*)([A-Za-z_][\w$]*))?/g

/// Colors identifiers by what the ctags index says they are, so parameters, ports, signals,
/// types and modules can be told apart.
export class SemanticTokensComponent
  extends ExtensionComponent
  implements vscode.DocumentSemanticTokensProvider
{
  private changed = new vscode.EventEmitter<void>()
  readonly onDidChangeSemanticTokens = this.changed.event

  async activate(context: vscode.ExtensionContext): Promise<void> {
    context.subscriptions.push(
      vscode.languages.registerDocumentSemanticTokensProvider(anyVerilogSelector, this, legend),
      // symbols are rebuilt on save
      vscode.workspace.onDidSaveTextDocument(() => this.refresh())
    )
  }

  refresh() {
    this.changed.fire()
  }

  async provideDocumentSemanticTokens(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): Promise<vscode.SemanticTokens> {
    const vdoc = ext.index.getVerilogDoc(document)
    const imported = await vdoc.getSymbols()
    const own = vdoc.symbols
    // file level and imported package symbols
    const global = new Map<string, Symbol>()
    for (const sym of imported
      .filter((s) => !own.includes(s))
      .concat(own.filter((s) => s.parentScope === ''))) {
      if (!global.has(sym.name)) {
        global.set(sym.name, sym)
      }
    }
    // symbols by the top level unit they are in
    const unitNames = new Map<string, Map<string, Symbol>>()
    for (const sym of own) {
      const unit = sym.parentScope.split('.')[0]
      const names = unitNames.get(unit) ?? new Map<string, Symbol>()
      unitNames.set(unit, names)
      if (!names.has(sym.name)) {
        names.set(sym.name, sym)
      }
    }
    // in text order, so the unit and instance around an identifier are found by moving forward
    const units = vdoc.topSymbols
      .filter((sym) => sym.isValid)
      .map((unit) => {
        const range = unit.getFullRange()
        const names = unitNames.get(unit.name) ?? new Map<string, Symbol>()
        return { start: document.offsetAt(range.start), end: document.offsetAt(range.end), names }
      })
      .sort((a, b) => a.start - b.start)
    const instances = own
      .filter((sym) => sym.type === 'instance' && sym.typeRef !== null)
      .map((inst) => {
        const range = inst.getFullRange()
        return { start: document.offsetAt(range.start), end: document.offsetAt(range.end), inst }
      })
      .sort((a, b) => a.start - b.start)
    let unitAt = 0
    let instAt = 0
    // direct members of another module or package
    const memberCache = new Map<string, Promise<Map<string, Symbol>>>()
    const members = (unit: string) => {
      if (!memberCache.has(unit)) {
        memberCache.set(
          unit,
          ext.index.findModule(unit).then(async (doc) => {
            const map = new Map<string, Symbol>()
            for (const sym of (await doc?.getSymbols({}, false)) ?? []) {
              if (sym.parentScope === unit && !map.has(sym.name)) {
                map.set(sym.name, sym)
              }
            }
            return map
          })
        )
      }
      return memberCache.get(unit)!
    }

    const builder = new vscode.SemanticTokensBuilder(legend)
    const text = document.getText()
    const push = (offset: number, length: number, kind: TokenKind | undefined) => {
      if (kind !== undefined) {
        const pos = document.positionAt(offset)
        builder.push(pos.line, pos.character, length, kind[0], kind[1])
      }
    }
    let match: RegExpExecArray | null
    WORD_RE.lastIndex = 0
    while ((match = WORD_RE.exec(text)) !== null) {
      if (token.isCancellationRequested) {
        break
      }
      const [, name, scopeOp, member] = match
      if (name === undefined) {
        continue
      }
      const offset = match.index
      if (member !== undefined) {
        // pkg::name
        const pkg = await members(name)
        push(offset, name.length, unitToken(ext.index.unitKinds.get(name)))
        const sym = pkg.get(member)
        push(offset + name.length + scopeOp.length, member.length, sym && symbolToken(sym))
        continue
      }
      if (text[offset - 1] === '.') {
        // named port or parameter connection of an instance
        while (instAt < instances.length && instances[instAt].end <= offset) {
          instAt++
        }
        const around = instances.at(instAt)
        const inst = around !== undefined && around.start <= offset ? around.inst : undefined
        if (inst !== undefined) {
          const ports = await members(inst.typeRef!)
          const sym = ports.get(name)
          push(offset, name.length, sym && symbolToken(sym))
        }
        continue
      }
      while (unitAt < units.length && units[unitAt].end < offset) {
        unitAt++
      }
      const nearUnit = units.at(unitAt)
      const unit = nearUnit !== undefined && nearUnit.start <= offset ? nearUnit : undefined
      const sym = unit?.names.get(name) ?? global.get(name)
      push(offset, name.length, sym ? symbolToken(sym) : unitToken(ext.index.unitKinds.get(name)))
    }
    const tokens = builder.build()
    this.logger.info(`semantic tokens: ${tokens.data.length / 5} in ${document.uri.fsPath}`)
    return tokens
  }
}
