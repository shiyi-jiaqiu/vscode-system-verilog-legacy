import * as child_process from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as vscode from 'vscode'
import { ext } from '../extension'
import { Logger } from '../lib/logger'
import { maskTemplate } from '../Template'
import { Symbol } from './Symbol'
// select one
interface SymbolFilter {
  name?: string
  type?: string
}

function filterSymbols(symbols: Symbol[], filter: SymbolFilter): Symbol[] {
  if (filter.type !== undefined) {
    symbols = symbols.filter((sym) => sym.type === filter.type)
  }
  if (filter.name !== undefined) {
    symbols = symbols.filter((sym) => sym.name === filter.name)
  }
  return symbols
}

const DIRECTIVES = new Set([
  'define', 'undef', 'undefineall', 'ifdef', 'ifndef', 'elsif', 'else', 'endif', 'include',
  'timescale', 'default_nettype', 'resetall', 'celldefine', 'endcelldefine', 'pragma', 'line',
  'begin_keywords', 'end_keywords', 'unconnected_drive', 'nounconnected_drive',
]) // prettier-ignore

/// ctags does not expand macros, and a macro call inside a parameter or port list makes it
/// drop the rest of that list. Blank out macro calls (keeping newlines, so line numbers
/// still match). A call used as a declared name, `` `NAME(x) = 0 ``, becomes `_` so the
/// declaration keeps its own name instead of taking the type's.
export function maskMacroCalls(text: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, ' ')
  const callRe = /`([A-Za-z_]\w*)/g
  let out = ''
  let last = 0
  let match: RegExpExecArray | null
  while ((match = callRe.exec(text)) !== null) {
    if (DIRECTIVES.has(match[1])) {
      continue
    }
    let end = callRe.lastIndex
    if (text[end] === '(') {
      // arguments up to the matching ')'; an unclosed call masks only the name
      for (let i = end, depth = 0; i < text.length; i++) {
        if (text[i] === '(') {
          depth++
        } else if (text[i] === ')' && --depth === 0) {
          end = i + 1
          break
        }
      }
    }
    const call = text.slice(match.index, end)
    const declared = /^\s*=(?!=)/.test(text.slice(end, end + 80))
    out += text.slice(last, match.index) + (declared ? '_' + blank(call.slice(1)) : blank(call))
    last = callRe.lastIndex = end
  }
  return out + text.slice(last)
}

let ctagsInputCount = 0

/// Universal Ctags releases up to 6.2.1 map only *.v to Verilog, so .vh headers were not parsed
export const CTAGS_MAPS = ['--map-Verilog=+.vh', '--map-Verilog=+.vl']

// TODO: add a user setting to enable/disable all ctags based operations
export class VerilogDoc {
  /// Symbol definitions (no rhs)
  doc: vscode.TextDocument
  isDirty: boolean
  symbols: Symbol[]
  importSymbols: Symbol[] | undefined
  topSymbols: Symbol[]
  private logger: Logger
  private parsing: Promise<void> | undefined
  private parsedVersion = -1

  constructor(logger: Logger, document: vscode.TextDocument) {
    this.symbols = []
    this.importSymbols = undefined
    this.topSymbols = []
    this.isDirty = true
    this.logger = logger
    this.doc = document
  }

  clearSymbols() {
    this.isDirty = true
  }

  async getSymbols(filter: SymbolFilter = {}, addImports = true): Promise<Symbol[]> {
    while (this.isDirty || this.parsedVersion !== this.doc.version) {
      if (this.parsing === undefined) {
        this.parsing = (async () => {
          const version = this.doc.version
          this.isDirty = true
          this.logger.info('indexing ', this.doc.uri.fsPath)
          const output = await this.execCtags(this.doc.getText())
          if (version !== this.doc.version) {
            return
          }
          await this.buildSymbolsList(output)
          this.parsedVersion = version
          this.importSymbols = undefined
        })().finally(() => {
          this.parsing = undefined
        })
      }
      await this.parsing
    }
    if (addImports) {
      if (this.importSymbols === undefined) {
        this.importSymbols = await this.parseImports()
      }
      return filterSymbols(this.symbols.concat(this.importSymbols), filter)
    }
    return filterSymbols(this.symbols, filter)
  }

  async parseImports(): Promise<Symbol[]> {
    // search for import pkg::*;
    let importedFiles: vscode.Uri[] = []
    const importRe = /[^\w]import ([^:]+)::\*;/g
    const text = this.doc.getText()
    let match
    while ((match = importRe.exec(text)) !== null) {
      const uri = ext.index.moduleMap.get(match[1])
      if (uri !== undefined) {
        importedFiles.push(uri)
      }
    }

    // TODO: maybe do includes? The thing is includes are recommended to be preindexed (svh),
    // so the parsing here would not really be needed
    // const includeRe = new RegExp(/^\s*`include "([^"]+)"/g)

    // parse each import in parallel
    const symbols: Promise<Symbol[]>[] = importedFiles.map(async (uri) => {
      let doc = await vscode.workspace.openTextDocument(uri)
      const ctags = ext.index.getVerilogDoc(doc)
      return ctags.getSymbols()
    })

    return (await Promise.all(symbols)).reduce((acc, curr) => acc.concat(curr), [])
  }

  async getModules(): Promise<Symbol[]> {
    let syms = await this.getSymbols()
    return syms.filter((tag) => tag.type === 'module' || tag.type === 'interface')
  }

  async getInstances(): Promise<Symbol[]> {
    return await this.getSymbols({ type: 'instance' })
  }

  // valid package members
  NON_PKG_TYPES = new Set(['member', 'register', 'port', 'define', 'package'])

  async getPackageSymbols(): Promise<Symbol[]> {
    let syms = await this.getSymbols({}, false)
    syms = syms.filter((sym) => !this.NON_PKG_TYPES.has(sym.type))
    syms = syms.filter((sym) => !sym.name.startsWith('`'))
    return syms
  }

  async execCtags(text: string = this.doc.getText()): Promise<string> {
    let command: string = await ext.ctags.path.getValueAsync()
    // Index the editor text, so unsaved edits are seen. The temp file keeps the
    // extension, which selects the ctags parser.
    const input = path.join(
      os.tmpdir(),
      `vscode-verilog-${process.pid}-${++ctagsInputCount}${path.extname(this.doc.fileName)}`
    )
    await fs.promises.writeFile(input, maskMacroCalls(maskTemplate(text).text))
    let args: string[] =
      '-f - --fields=+K --sort=no --excmd=n --fields-SystemVerilog=+{parameter}'.split(' ')
    args.push(...CTAGS_MAPS)
    args.push(input)
    // this.logger.info('executing ctags: ' + command + ' ' + args.join(' '))
    return new Promise<string>((resolve, reject) => {
      child_process.execFile(
        command,
        args,
        { encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 },
        (error, stdout: string) => {
          fs.promises.unlink(input).catch(() => {})
          if (error !== null) {
            this.logger.error(`ctags failed: ${error.message.split('\n')[0]}`)
            reject(error)
          } else {
            resolve(stdout)
          }
        }
      )
    })
  }

  parseTagLine(line: string): Symbol | undefined {
    try {
      let name, type, pattern, lineNoStr, parentScope, parentType: string
      let typeref: string | null = null
      let scope: string[]
      let lineNo: number
      let parts: string[] = line.split('\t')
      name = parts[0]
      if (name === '_') {
        // placeholder from maskMacroCalls
        return undefined
      }
      type = parts[3]
      // override "type" for parameters (See #102)
      if (parts.length === 6) {
        if (parts[5] === 'parameter:') {
          type = 'parameter'
        }

        if (parts[5].startsWith('typeref')) {
          typeref = parts[5].split(':')[2]
        }
      }
      if (parts.length >= 5) {
        scope = parts[4].split(':')
        parentType = scope[0]
        parentScope = scope[1]
      } else {
        parentScope = ''
        parentType = ''
      }
      lineNoStr = parts[2]
      lineNo = Number(lineNoStr.slice(0, -2)) - 1
      // pretty print symbol
      return new Symbol(this.doc, this, name, type, lineNo, parentScope, parentType, typeref, false)
    } catch (e) {
      this.logger.error('Line Parser: ' + e)
      this.logger.error('Line: ' + line)
    }
    return undefined
  }

  async buildSymbolsList(tags: string): Promise<void> {
    try {
      if (this.isDirty) {
        this.logger.info('building symbols for ' + this.doc.uri.fsPath)
        // Parse ctags output into symbols

        {
          this.symbols = []
          let lines: string[] = tags.split(/\r?\n/)
          lines.forEach((line) => {
            if (line !== '') {
              let sym = this.parseTagLine(line)
              if (sym !== undefined) {
                this.symbols.push(sym)
              }
            }
          })
        }

        {
          // end tags are not supported yet in ctags. So, using regex
          let match: RegExpExecArray | null = null
          let endPosition: vscode.Position
          let text = this.doc.getText()
          const starts = this.symbols.slice().sort((a, b) => a.line - b.line)
          const open = new Map<string, Symbol[]>()
          let next = 0
          let eRegex: RegExp = /^(?![\r\n])\s*end(\w*)*[\s:]?/gm
          while ((match = eRegex.exec(text))) {
            if (match === null) {
              break
            }
            if (typeof match[1] === 'undefined') {
              continue
            }

            endPosition = this.doc.positionAt(match.index + match[0].length - 1)
            // symbols that start before this end tag are waiting for theirs, by type
            while (next < starts.length && starts[next].startPosition.isBefore(endPosition)) {
              const sym = starts[next++]
              const waiting = open.get(sym.type)
              if (waiting === undefined) {
                open.set(sym.type, [sym])
              } else {
                waiting.push(sym)
              }
            }
            // the nearest unclosed symbol of the same type; doesn't check for begin...end blocks
            open.get(match[1])?.pop()?.setEndPosition(endPosition.line)
          }
        }

        {
          // Build symbol tree
          this.logger.info('Building symbol tree for ', this.doc.uri.fsPath)
          this.topSymbols = []
          let symMap = new Map<string, Symbol>()
          for (let sym of this.symbols) {
            if (sym.parentScope !== '') {
              if (sym.name.startsWith('`')) {
                // macro calls sometimes get counted as being in a hierarchy
                continue
              }
              symMap.set(sym.parentScope + '.' + sym.name, sym)
              let parent = symMap.get(sym.parentScope)
              if (parent !== undefined) {
                parent.children.push(sym)
              } else {
                this.logger.warn('Parent not found for ' + sym.name + ' ' + sym.parentScope)
              }
            } else {
              symMap.set(sym.name, sym)
              this.topSymbols.push(sym)
            }
          }
        }

        this.isDirty = false
      }
    } catch (e) {
      this.logger.error((e as Error).toString())
      throw e
    }
    // print all syms
    // this.symbols.forEach((sym) => {
    //   this.logger.info(sym.prettyPrint())
    // })
  }

  async getSymbolTree(): Promise<Symbol[]> {
    await this.getSymbols({}, false)
    return this.topSymbols
  }

  async getNestedHoverText(sym: Symbol): Promise<Array<string>> {
    let ret: string[] = []
    ret.push(sym.getHoverText())
    if (!['port', 'parameter', 'constant', 'net', 'register'].includes(sym.type)) {
      return ret
    }
    // find other words with definitions in the hover text, and add them
    let words = new Set(sym.getHoverText().match(/\b[a-zA-Z_]\w*\b/g) || [])
    words.delete(sym.name)

    const unit = sym.parentScope.split('.')[0]
    let syms: Symbol[] = []
    for (const word of words) {
      syms.push(...(await this.findVisible(word, unit)))
    }
    let defs = await Promise.all(
      syms.map(async (s: Symbol) => {
        return s.getHoverText()
      })
    )

    if (defs.length > 0) {
      ret.push(defs.join('\n'))
    }

    return ret
  }

  /// Symbols named `name` as seen from top level unit `unit` (a module, interface or package
  /// of this file): those in the unit first, then the rest of the file, then imported packages.
  async findVisible(name: string, unit: string | undefined): Promise<Symbol[]> {
    const all = await this.getSymbols({ name })
    const own = all.filter((sym) => sym.doc === this.doc)
    const inUnit = own.filter(
      (sym) =>
        unit !== undefined &&
        (sym.parentScope === unit || sym.parentScope.startsWith(unit + '.') || sym.name === unit)
    )
    if (inUnit.length > 0) {
      return inUnit
    }
    if (own.length > 0) {
      return own
    }
    // imports of imports can bring a package in twice
    const seen = new Set<string>()
    return all.filter((sym) => {
      const key = sym.doc.uri.toString() + ':' + sym.line
      if (seen.has(key)) {
        return false
      }
      seen.add(key)
      return true
    })
  }

  /// name of the top level unit of this file containing `position`
  unitAt(position: vscode.Position): string | undefined {
    return this.topSymbols.find((sym) => sym.isValid && sym.getFullRange().contains(position))?.name
  }

  /// For an instance connected with `.*`, a hint after it listing the ports of its module
  async getPortHints(inst: Symbol): Promise<vscode.InlayHint[]> {
    if (inst.type !== 'instance' || inst.typeRef === null) {
      return []
    }
    const fullRange = inst.getFullRange()
    const instText = this.doc.getText(fullRange)
    const dotStar = instText.indexOf('.*', instText.indexOf(inst.name))
    if (dotStar === -1) {
      return []
    }
    const module = await ext.index.findModule(inst.typeRef)
    if (module === undefined) {
      return []
    }
    const ports = (await module.getSymbols({ type: 'port' }, false)).filter(
      (port) => port.parentScope === inst.typeRef
    )
    if (ports.length === 0) {
      return []
    }
    return [
      new vscode.InlayHint(
        this.doc.positionAt(this.doc.offsetAt(fullRange.start) + dotStar + 2),
        ': ' + ports.map((port) => port.name).join(', '),
        vscode.InlayHintKind.Type
      ),
    ]
  }
}
