// SPDX-License-Identifier: MIT
import * as vscode from 'vscode'
import { ext } from '../extension'
import { resolveInclude } from '../Filelist'
import { ExtensionComponent, PathConfigObject } from '../lib/libconfig'
import { anyVerilogSelector, getParentText, getPrev2Char, getPrevChar } from '../utils'
import builtins from './builtins.json'
import { getConstValue, getMacroBody, ValueStep } from './ConstValue'
import { Symbol, SymbolCompletionItem } from './Symbol'

/// Completion of the `define of `name` on line `ln`, with a placeholder for each argument
function macroCompletionItem(name: string, kind: string, ln: string): vscode.CompletionItem {
  const item = new vscode.CompletionItem('`' + name, vscode.CompletionItemKind.Snippet)
  item.detail = kind
  item.filterText = name
  item.documentation = ln.trim()
  // arguments come right after the name, as in `define NAME(a, b)
  const args = new RegExp('`define\\s+' + name + '\\(([^)]*)\\)').exec(ln)
  if (args === null) {
    item.insertText = name
    return item
  }
  const snip = new vscode.SnippetString(name + '(')
  args[1].split(',').forEach((arg, i) => {
    if (i > 0) {
      snip.appendText(', ')
    }
    snip.appendPlaceholder(arg.trim())
  })
  item.insertText = snip.appendText(')')
  return item
}

/// A markdown list item for a parameter or macro that a value goes through
function stepText(step: ValueStep): string {
  const code = (s: string) => (s.includes('`') ? '`` ' + s + ' ``' : '`' + s + '`')
  let text = '  '.repeat(step.depth) + '- ' + code(step.name)
  if (step.text === undefined || step.text === '') {
    if (step.sym !== undefined) {
      text += ' has no value'
    } else {
      text += step.text === '' ? ' is defined without a value' : ' is not defined'
    }
  } else {
    text += ' = ' + code(step.text)
    if (step.value !== undefined && step.value.toString() !== step.text) {
      text += ' = ' + code(step.value.toString())
    }
  }
  if (step.sym !== undefined) {
    const uri = step.sym.doc.uri.with({ fragment: `L${step.sym.line + 1}` })
    text += ` · [${vscode.workspace.asRelativePath(step.sym.doc.uri)}:${step.sym.line + 1}](${uri})`
  } else if (step.text !== undefined) {
    text += ' · from `verilog.filelist`'
  }
  return text
}

/// right hand side of `name = value` hover text, to skip repeating a literal value
function getValueText(hover: string): string {
  return hover.replace(/;\s*$/, '').split('=').slice(1).join('=').trim()
}

// comments, strings, based numbers, system tasks and escaped identifiers are skipped;
// group 1: identifier or `macro
const TOKEN_RE =
  /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\\n])*"|'[sS]?[bodhBODH]\s*[\w?]+|\$\w+|\\\S+|(`?[A-Za-z_][\w$]*)/g
const MACRO_DIRECTIVES = new Set(['`define', '`undef', '`ifdef', '`ifndef', '`elsif'])
/// what comes just before the target of an assignment
const STATEMENT_START = new Set([';', ')', ':', 'begin', 'else', 'assign', 'force', 'release'])
/// `name[i].f <=` or `name =`, but not `name ==`
const ASSIGNED_RE = /^(?:\s*(?:\[[^\]]*\]|\.\w+))*\s*<?=(?!=)/

export class CtagsServerComponent
  extends ExtensionComponent
  implements
    vscode.CompletionItemProvider,
    vscode.DocumentSymbolProvider,
    vscode.DefinitionProvider,
    vscode.DocumentHighlightProvider,
    vscode.HoverProvider,
    vscode.InlayHintsProvider
{
  path: PathConfigObject = new PathConfigObject(
    {
      description: 'Path to ctags universal executable',
    },
    {
      windows: 'ctags.exe',
      linux: 'ctags-universal',
      mac: 'ctags',
    }
  )

  builtinsPath: string | undefined
  builtinCompletions: Map<string, vscode.CompletionItem> = new Map()
  builtinHovers: Map<string, vscode.Hover> = new Map()

  async activate(context: vscode.ExtensionContext) {
    this.loadBuiltins()
    context.subscriptions.push(
      vscode.languages.registerDocumentSymbolProvider(anyVerilogSelector, this)
    )

    context.subscriptions.push(
      vscode.languages.registerCompletionItemProvider(
        anyVerilogSelector,
        this,
        '.', // params, ports, hierarchical references
        '(', // query normal completion
        ':', // pkg scope (::), wire width
        '`', // macros
        '[', // wire width, filter for params
        '#', // module inst
        '$' // builtins
      )
    )

    context.subscriptions.push(vscode.languages.registerHoverProvider(anyVerilogSelector, this))

    context.subscriptions.push(
      vscode.languages.registerDefinitionProvider(anyVerilogSelector, this)
    )

    context.subscriptions.push(
      vscode.languages.registerDocumentHighlightProvider(anyVerilogSelector, this)
    )

    context.subscriptions.push(
      vscode.languages.registerInlayHintsProvider(anyVerilogSelector, this)
    )
  }

  async loadBuiltins() {
    // load builtins from json

    for (let key in builtins) {
      // builtin completion
      let item = new vscode.CompletionItem('$' + key, vscode.CompletionItemKind.Function)
      let builtin = builtins[key as keyof typeof builtins]
      item.documentation = builtin.description
      let s = new vscode.SnippetString()
      s = s.appendText(key + '(')
      let args = builtin.args
      // append placeholders and correct commas
      for (let i = 0; i < args.length; i++) {
        s = s.appendPlaceholder(args[i].name)
        if (i < args.length - 1) {
          s = s.appendText(', ')
        }
      }
      s = s.appendText(')')
      item.insertText = s
      this.builtinCompletions.set(key, item)

      // builtin hover
      let md = new vscode.MarkdownString()
      let desc = builtin.description.split('. ').join('.\n')
      md.appendText(desc)
      let arglist = []
      for (let arg of args) {
        arglist.push(arg.type + ' ' + arg.name)
      }
      md.appendCodeblock(`$${key}(${arglist.join(', ')})`, 'systemverilog')
      this.builtinHovers.set(key, new vscode.Hover(md))
    }
  }

  ////////////////////////////////////////////////
  // Completion Providers
  ////////////////////////////////////////////////

  async provideModuleCompletion(
    document: vscode.TextDocument,
    position: vscode.Position, // module_name #(
    _token: vscode.CancellationToken,
    _context: vscode.CompletionContext
  ): Promise<vscode.CompletionItem[]> {
    this.logger.info('Module Completion requested')
    let items: vscode.CompletionItem[] = []

    let moduleRange = document.getWordRangeAtPosition(position.translate(0, -2))
    let moduleName = document.getText(moduleRange)

    let module = await ext.index.findModuleSymbol(moduleName)
    if (module === undefined) {
      return []
    }
    let newItem: vscode.CompletionItem = new vscode.CompletionItem(
      module.getHoverText(),
      vscode.CompletionItemKind.Module
    )
    newItem.insertText = module.getModuleSnippet(false)
    items.push(newItem)

    return items
  }

  async providePortParamCompletion(
    document: vscode.TextDocument,
    position: vscode.Position, // module_name #(
    _token: vscode.CancellationToken,
    _context: vscode.CompletionContext
  ): Promise<vscode.CompletionItem[]> {
    this.logger.info(`Finding completions for ports/params`)
    const instances = await ext.index.getVerilogDoc(document).getSymbols({ type: 'instance' })
    // TODO: binary search instead
    const inst = instances.reverse().find((inst) => {
      return inst.getFullRange().start.compareTo(position) < 0
    })
    if (inst === undefined || inst.typeRef === null) {
      this.logger.info("Couldn't find suitable instance for port/param completion")
      return []
    }
    let mod = await ext.index.findModule(inst.typeRef)
    if (mod === undefined) {
      this.logger.info(`Couldn't find module ${inst.typeRef} for completions`)
      return []
    }

    let ports = (await mod.getSymbols()).filter(
      (sym) => (sym.type === 'port' || sym.type === 'parameter') && sym.parentScope === inst.typeRef
    )
    return ports.map((sym) => sym.getCompletionItem())
  }

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    context: vscode.CompletionContext
  ): Promise<vscode.CompletionItem[]> {
    if (ext.server.pending || ext.server.owns(document) || ext.slangExtensionActive()) {
      return []
    }

    let prevChar = getPrevChar(document, position)
    let prev2Char = getPrev2Char(document, position)
    this.logger.info(
      'providing completion on ' + context.triggerCharacter + ' ' + prevChar + ' ' + prev2Char
    )

    // Module inst Completion
    if (context.triggerCharacter === '#') {
      const moduleCompletions = await this.provideModuleCompletion(
        document,
        position,
        token,
        context
      )
      this.logger.info(`Returning ${moduleCompletions.length} module completions`)
      return moduleCompletions
    }

    // Macro Completion
    if (context.triggerCharacter === '`') {
      const docs = [document, ...(await ext.index.dependencyDocuments(document))]
      const symbols = (
        await Promise.all(docs.map((doc) => ext.index.getVerilogDoc(doc).getSymbols({}, false)))
      ).flat()
      const items = new Map<string, vscode.CompletionItem>()
      for (const symbol of symbols.filter((symbol) => symbol.isMacro())) {
        if (!items.has(symbol.name)) {
          items.set(
            symbol.name,
            macroCompletionItem(symbol.name, symbol.type, symbol.doc.lineAt(symbol.line).text)
          )
        }
      }
      // Global candidates remain useful when the project's compile order or include
      // paths are incomplete; resolved local definitions keep priority.
      for (const name of new Set([
        ...ext.index.macroFiles.keys(),
        ...ext.index.headerMacros.keys(),
      ])) {
        if (!items.has(name)) {
          const cached = ext.index.headerMacros.get(name)
          items.set(name, macroCompletionItem(name, cached?.[0] ?? 'define', cached?.[1] ?? ''))
        }
      }
      return [...items.values()]
    }

    // Builtin Completion
    if (context.triggerCharacter === '$') {
      return Array.from(this.builtinCompletions.values())
    }

    let symbols: Symbol[] = []
    let additionalCompletions: vscode.CompletionItem[] = []

    // Find which file to source symbols from
    if (prevChar === ':' && prev2Char === ':') {
      // package file
      let pkgRange = document.getWordRangeAtPosition(position.translate(0, -2))
      let pkgName = document.getText(pkgRange)
      let ctags = await ext.index.findModule(pkgName)
      if (ctags === undefined) {
        this.logger.info('Package not found')
        return []
      }
      symbols = (await ctags.getPackageSymbols()).filter(
        (sym) => ctags.memberScope(sym) === pkgName
      )
      this.logger.info(`Found ${symbols.length} completions in package ${pkgName}`)
    } else if (context.triggerCharacter === '.') {
      let parentScope = getParentText(document, new vscode.Range(position, position))

      if (parentScope === '') {
        const portCompletions = await this.providePortParamCompletion(
          document,
          position,
          token,
          context
        )
        this.logger.info(`Returning ${portCompletions.length} port/param completions`)
        return portCompletions
      } else {
        // hierarchial reference completion
        let insts = await ext.index.getVerilogDoc(document).getSymbols({ name: parentScope })
        this.logger.info(`Fetching hierarchical completion`)
        if (insts.length > 0 && insts[0].typeRef !== null) {
          let mod = await ext.index.findModule(insts[0].typeRef)
          if (mod) {
            symbols = (await mod.getSymbols()).filter((sym) => sym.isData())
          }
        }
      }
    } else {
      // this file
      this.logger.info('Fetching completions from current file')
      const doc = ext.index.getVerilogDoc(document)
      await doc.getSymbols()
      symbols = await doc.visibleSymbols(doc.scopeAt(position))

      // wire width, ex: logic[some_param-1:0]
      // TODO: detect if we're in a functional block or not to restrict to params
      if (context.triggerCharacter === ':') {
        symbols = symbols.filter((sym) => sym.isConstant())
      } else if (context.triggerCharacter === '[') {
        symbols = symbols.filter((sym) => sym.isData())
      } else if (context.triggerCharacter === undefined) {
        for (let name of ext.index.moduleMap.keys()) {
          additionalCompletions.push(
            new vscode.CompletionItem(
              {
                label: name,
                detail: ' Component', // would need to open files to determin module/interface/package
              },
              vscode.CompletionItemKind.Module
            )
          )
        }
      }
      symbols = symbols.filter((sym) => !(sym.type === 'block' && sym.children.length === 0))
    }

    const word = document.getWordRangeAtPosition(position)
    const prefix = word ? document.getText(new vscode.Range(word.start, position)) : ''
    symbols = symbols.filter((sym) => !prefix || sym.name.startsWith(prefix))
    additionalCompletions = additionalCompletions.filter(
      (item) =>
        !prefix ||
        (typeof item.label === 'string' ? item.label : item.label.label).startsWith(prefix)
    )

    let items = symbols.map((symbol: Symbol) => {
      return symbol.getCompletionItem()
    })

    items.push(...additionalCompletions)

    this.logger.info(`Returning ${items.length} completion items`)
    return items
  }

  resolveCompletionItem(item: vscode.CompletionItem): vscode.CompletionItem {
    if (item instanceof SymbolCompletionItem) {
      item.resolve()
    }
    return item
  }

  ////////////////////////////////////////////////
  // Hover Provider
  ////////////////////////////////////////////////

  public async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken
  ): Promise<vscode.Hover | undefined> {
    if (ext.server.pending || ext.server.owns(document) || ext.slangExtensionActive()) {
      return undefined
    }

    this.logger.info('Hover requested')

    // TODO: reuse this range, pass to findSymbol
    let range = document.getWordRangeAtPosition(position)
    if (range === undefined) {
      return undefined
    }

    // handle builtin
    let pchar = getPrevChar(document, range.start)
    if (pchar === '$') {
      return this.builtinHovers.get(document.getText(range))
    }

    let syms: Symbol[] = await ext.index.findSymbol(document, position)
    if (syms.length === 0) {
      const define =
        pchar === '`' ? ext.projectFilelist?.defines.get(document.getText(range)) : undefined
      if (define !== undefined) {
        let md = new vscode.MarkdownString()
        md.appendCodeblock(`\`define ${document.getText(range)} ${define}`, document.languageId)
        md.appendMarkdown('from `verilog.filelist`')
        return new vscode.Hover(md)
      }
      this.logger.warn('Hover object not found')
      return undefined
    }

    let sym = syms[0]
    let ctags = ext.index.getVerilogDoc(sym.doc)

    let [hover, ...related] = await ctags.getNestedHoverText(sym)
    let md = new vscode.MarkdownString()
    if (sym.type === 'instance' && sym.typeRef !== null) {
      md.appendCodeblock(`${sym.typeRef} ${sym.name}`, document.languageId)
    } else {
      md.appendCodeblock(hover, document.languageId)
    }
    // a macro used here is read here: names in it are looked up from this module
    const here = ext.index.getVerilogDoc(document)
    const site =
      sym.isMacro() && pchar === '`' ? { doc: here, unit: here.scopeAt(position) } : undefined
    const steps: ValueStep[] = []
    const value = syms.length === 1 ? await getConstValue(sym, site, steps) : undefined
    const written = sym.isMacro() ? getMacroBody(sym) : getValueText(hover)
    if (value !== undefined && value.toString() !== written) {
      md.appendMarkdown(
        `= \`${value}\`` + (value >= 16n ? ` (\`0x${value.toString(16)}\`)` : '') + '\n\n'
      )
    }
    // the macros a value goes through, down to its number or to the name that is not defined;
    // related parameters are shown below
    if (sym.isMacro() || steps.some((step) => step.name.startsWith('`'))) {
      const lines = steps.slice(0, 20).map(stepText)
      if (steps.length > 20) {
        lines.push(`- ${steps.length - 20} more`)
      }
      if (lines.length > 0) {
        md.appendMarkdown(lines.join('\n') + '\n\n')
      }
    }
    const comment = sym.getDocComment()
    if (comment !== '') {
      // appendText would turn spaces into &nbsp;, which stops long comments from wrapping
      md.appendMarkdown(
        comment.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, '\\$&').replace(/\n/g, '  \n') + '\n\n'
      )
    }
    let location = sym
    if (sym.type === 'instance' && sym.typeRef !== null) {
      location = (await ext.index.findModuleSymbol(sym.typeRef)) ?? sym
    }
    const target = location.doc.uri.with({ fragment: `L${location.line + 1}` })
    md.appendMarkdown(
      `[${vscode.workspace.asRelativePath(location.doc.uri)}:${location.line + 1}](${target})`
    )
    let mds = related.map((text) => {
      let rmd = new vscode.MarkdownString()
      rmd.appendCodeblock(text, document.languageId)
      return rmd
    })
    this.logger.info('Hover object returned')
    return new vscode.Hover([md, ...mds])
  }

  ////////////////////////////////////////////////
  // Inlay Hints Provider
  ////////////////////////////////////////////////
  async provideInlayHints(
    document: vscode.TextDocument,
    range: vscode.Range,
    _token: vscode.CancellationToken
  ): Promise<vscode.InlayHint[]> {
    if (ext.server.pending || ext.server.owns(document) || ext.slangExtensionActive()) {
      return []
    }

    const verilogDoc = ext.index.getVerilogDoc(document)
    const insts = (await verilogDoc.getSymbols({ type: 'instance' })).filter(
      (inst) => inst.typeRef !== null && inst.getFullRange().intersection(range) !== undefined
    )
    // one at a time: each may open and index the file of its module
    const hints: vscode.InlayHint[] = []
    for (const inst of insts) {
      hints.push(...(await verilogDoc.getPortHints(inst)))
    }
    return hints
  }

  async findIncludes(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.DefinitionLink[]> {
    let match
    const line = document.lineAt(position.line).text
    const stringRegex = /("([^"]*)")/g
    while ((match = stringRegex.exec(line)) !== null) {
      // check bounds
      if (!(
        match.index <= position.character && position.character < match.index + match[1].length
      )) {
        continue
      }

      let resolvedPath = await resolveInclude(document.fileName, match[2], ext.projectFilelist)
      if (!resolvedPath) {
        continue
      }
      return [
        {
          targetUri: vscode.Uri.file(resolvedPath),
          originSelectionRange: new vscode.Range(
            position.line,
            match.index,
            position.line,
            match.index + match[0].length
          ),
          targetRange: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0)),
        },
      ]
    }
    return []
  }

  ////////////////////////////////////////////////
  // Definition Provider
  ////////////////////////////////////////////////

  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken
  ): Promise<vscode.DefinitionLink[] | undefined> {
    if (ext.server.pending || ext.server.owns(document) || ext.slangExtensionActive()) {
      return undefined
    }

    this.logger.info('Definitions Requested: ' + document.uri)
    const symPromise = ext.index.findSymbol(document, position)
    const includePromise = this.findIncludes(document, position)
    // find all matching symbols
    let syms: Symbol[] = await symPromise
    this.logger.info(syms.length + ' definitions returned from ctags')
    let ret: vscode.LocationLink[] = []
    if (syms.length > 0) {
      ret = syms.map((sym) => sym.getDefinitionLink())
    }
    const includes = await includePromise
    if (includes.length > 0) {
      return includes
    }
    return ret
  }
  ////////////////////////////////////////////////
  // Document Symbol Provider
  ////////////////////////////////////////////////

  async provideDocumentSymbols(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken
  ): Promise<vscode.DocumentSymbol[]> {
    if (ext.server.pending || ext.server.owns(document) || ext.slangExtensionActive()) {
      return []
    }

    this.logger.info(`provideDocumentSymbols(${document.uri}) => ...`)
    const tree = await ext.index.getVerilogDoc(document).getSymbolTree()
    try {
      const docSymbols = tree.map((sym) => sym.getDocumentSymbol())
      this.logger.info(`provideDocumentSymbols(${document.uri}) => ${docSymbols.length} symbols`)
      return docSymbols
    } catch (e) {
      this.logger.error(`provideDocumentSymbols(${document.uri}) => ${e}`)
      return []
    }
  }

  ////////////////////////////////////////////////
  // Document Highlight Provider
  ////////////////////////////////////////////////

  /// Uses of the identifier at `position` in its module (in the whole file for a `macro or
  /// outside modules), without those in comments and strings. Declarations and assignments are
  /// writes. F7 and Shift+F7 move between them.
  async provideDocumentHighlights(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken
  ): Promise<vscode.DocumentHighlight[]> {
    if (ext.server.pending || ext.server.owns(document) || ext.slangExtensionActive()) {
      return []
    }

    const range = document.getWordRangeAtPosition(position)
    if (range === undefined) {
      return []
    }
    const name = document.getText(range)
    const macro = getPrevChar(document, range.start) === '`'
    const target = (macro ? '`' : '') + name
    const vdoc = ext.index.getVerilogDoc(document)
    const declared = new Set((await vdoc.getSymbols({ name }, false)).map((sym) => sym.line))
    const unit = macro
      ? undefined
      : vdoc.topSymbols.find((sym) => sym.isValid && sym.getFullRange().contains(position))
    const text = document.getText()
    const end = unit === undefined ? text.length : document.offsetAt(unit.getFullRange().end)

    const highlights: vscode.DocumentHighlight[] = []
    let last = unit === undefined ? 0 : document.offsetAt(unit.getFullRange().start)
    let prev = ''
    let match: RegExpExecArray | null
    TOKEN_RE.lastIndex = last
    while ((match = TOKEN_RE.exec(text)) !== null && match.index < end) {
      const gap = text.slice(last, match.index).trim()
      last = TOKEN_RE.lastIndex
      if (gap !== '') {
        prev = gap.endsWith('::') ? '::' : gap[gap.length - 1]
      }
      const word = match[1]
      if (word === undefined) {
        continue
      }
      const used =
        word === target
          ? macro || (prev !== '.' && prev !== '::')
          : macro && word === name && MACRO_DIRECTIVES.has(prev)
      if (used) {
        const start = document.positionAt(match.index)
        const write =
          declared.has(start.line) ||
          (STATEMENT_START.has(prev) && ASSIGNED_RE.test(text.slice(last, last + 200)))
        highlights.push(
          new vscode.DocumentHighlight(
            new vscode.Range(start, document.positionAt(last)),
            write ? vscode.DocumentHighlightKind.Write : vscode.DocumentHighlightKind.Read
          )
        )
      }
      prev = word
    }
    // nothing for a word in a comment or string
    return highlights.some((h) => h.range.contains(position)) ? highlights : []
  }
}
