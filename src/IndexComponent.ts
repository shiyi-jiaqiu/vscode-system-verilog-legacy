// SPDX-License-Identifier: MIT
import * as child_process from 'child_process'
import * as vscode from 'vscode'
import { Symbol } from './analysis/Symbol'
import { CTAGS_MAPS, maskMacroCalls, VerilogDoc } from './analysis/VerilogDoc'
import { ext } from './extension'
import { ExtensionComponent } from './lib/libconfig'
import { getParentText, getPrevChar, isAnyVerilog } from './utils'
import fs = require('fs')
import os = require('os')
import path = require('path')

export class IndexComponent extends ExtensionComponent {
  revision = 0

  public readonly moduleMap: Map<string, vscode.Uri> = new Map()

  // <workspace-specific-dir>/.sv_cache/files, links to the module files for the -y flag of
  // checks without a filelist
  cacheDir: vscode.Uri | undefined

  // file -> verilogDoc
  private filemap: Map<vscode.TextDocument, VerilogDoc> = new Map()

  /// name -> headers with a top level symbol of that name, which are opened when asked for
  readonly headerFiles: Map<string, vscode.Uri[]> = new Map()
  /// `define name -> [ctags kind, line of the `define], from the headers, for completion
  readonly headerMacros: Map<string, [string, string]> = new Map()
  private headers = new Map<
    string,
    {
      uri: vscode.Uri
      symbols: { name: string; kind: string; text: string; macro: boolean }[]
    }
  >()
  private headerIndex: Promise<void> = Promise.resolve()

  /// module/interface/package/class/program name -> ctags kind, from all indexed files
  readonly unitKinds: Map<string, string> = new Map()
  /// `define name -> files defining it, from all indexed files and headers
  readonly macroFiles: Map<string, vscode.Uri[]> = new Map()

  async activate(context: vscode.ExtensionContext): Promise<void> {
    this.logger.info('Index Activating')

    if (context.storageUri !== undefined) {
      this.cacheDir = vscode.Uri.joinPath(context.storageUri, '.sv_cache', 'files')
    }

    // file save, rename, delete mgmt
    context.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (isAnyVerilog(event.document.languageId)) {
          const affected = ext.server.dependencies.affectedBy(new Set([event.document.uri.fsPath]))
          for (const vdoc of this.filemap.values()) {
            if (
              affected.has(vdoc.doc.uri.fsPath) ||
              vdoc.importSymbols?.some((symbol) => symbol.doc === event.document)
            ) {
              vdoc.invalidateImports()
            }
          }
        }
      }),
      vscode.workspace.onDidSaveTextDocument(async (doc: vscode.TextDocument) => {
        if (!isAnyVerilog(doc.languageId)) {
          return
        }
        if (ext.server.active || ext.server.pending || ext.slangExtensionActive()) {
          return
        }
        for (const vdoc of this.filemap.values()) {
          vdoc.invalidateImports()
        }
        this.indexFile(doc.uri)
        this.getVerilogDoc(doc).clearSymbols()
        try {
          const tasks = [this.indexNames([doc.uri])]
          if (
            this.headers.has(doc.uri.fsPath) ||
            (/\.(svh|vh)$/i.test(doc.fileName) &&
              (await ext.findIncludes()).some((uri) => uri.fsPath === doc.uri.fsPath))
          ) {
            tasks.push(this.indexIncludes(false, [doc.uri]))
          }
          await Promise.all(tasks)
        } catch (error) {
          this.logger.error(String(error))
        }
      })
    )
    context.subscriptions.push(
      vscode.workspace.onDidRenameFiles((e) => {
        e.files.forEach((file) => {
          this.indexFile(file.newUri)
        })
      })
    )
    vscode.workspace.onDidCloseTextDocument((doc: vscode.TextDocument) => {
      this.filemap.delete(doc)
    })

    // shell find ctags on path change
    ext.ctags.path.onConfigUpdated(async () => {
      await ext.ctags.path.checkPathNotify()
    })
  }

  releaseGlobalIndex() {
    this.revision++
    this.moduleMap.clear()
    this.unitKinds.clear()
    this.macroFiles.clear()
    this.headerFiles.clear()
    this.headerMacros.clear()
    this.headers.clear()
    this.filemap.clear()
  }

  async getDir(reset: boolean = false): Promise<vscode.Uri | undefined> {
    if (this.cacheDir === undefined) {
      return undefined
    }
    if (!fs.existsSync(this.cacheDir.fsPath)) {
      fs.mkdirSync(this.cacheDir.fsPath, { recursive: true })
    } else if (reset) {
      await vscode.workspace.fs.delete(this.cacheDir, { recursive: true })
      fs.mkdirSync(this.cacheDir.fsPath, { recursive: true })
    }
    return this.cacheDir
  }
  indexMem(uri: vscode.Uri) {
    // modulemap
    let name = uri.path.split('/').pop()?.split('.').shift() ?? ''
    this.moduleMap.set(name, uri)
  }

  async indexSym(dir: vscode.Uri, uri: vscode.Uri) {
    // symlink
    let sym = path.join(dir.fsPath, path.basename(uri.fsPath))
    if (fs.existsSync(sym)) {
      return
    }
    try {
      await fs.promises.symlink(uri.fsPath, sym)
    } catch (e) {
      // sometimes existsSync doesn't catch it
      // this.logger.warn(`Failed to create symlink ${sym} -> ${uri.fsPath}`)
      // this.logger.warn(`Error message: ${e}`)
    }
  }

  indexFile(uri: vscode.Uri) {
    this.indexMem(uri)
    if (ext.projectFilelist === undefined && this.cacheDir !== undefined) {
      this.indexSym(this.cacheDir, uri)
    }
  }

  async indexFiles(reset: boolean = false): Promise<void> {
    let dir = await this.getDir(reset)
    if (dir === undefined) {
      return
    }

    let files: vscode.Uri[] = await ext.findModules()
    this.logger.info('indexing ' + files.length + ' files')
    if (reset) {
      this.moduleMap.clear()
      this.unitKinds.clear()
      this.macroFiles.clear()
      for (const doc of this.filemap.values()) {
        doc.clearSymbols()
      }
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: 'Indexing Verilog files',
      },
      async () => {
        for (let file of files) {
          this.indexMem(file)
        }
        // after indexMem, so real unit names win over file names
        await this.indexNames(files.concat(await ext.findIncludes()))
        if (ext.projectFilelist === undefined && dir !== undefined) {
          let promises = files.map((file) => {
            this.indexSym(dir, file)
          })
          await Promise.all(promises)
        }
      }
    )
  }

  /// One ctags pass over the files for design unit and macro names. Units are often not in a
  /// file of the same name, and macros are often defined in a .v/.vh file another file includes.
  async indexNames(files: vscode.Uri[]): Promise<void> {
    if (files.length === 0) {
      return
    }
    const stdout = await this.ctags(
      files.map((file) => file.fsPath),
      '--kinds-SystemVerilog=mIKCPd --kinds-Verilog=md'
    )
    if (ext.server.active || ext.server.pending || ext.slangExtensionActive()) {
      return
    }
    const updated = new Set(files.map((file) => file.fsPath))
    for (const [name, uri] of this.moduleMap) {
      if (updated.has(uri.fsPath)) {
        this.moduleMap.delete(name)
        this.unitKinds.delete(name)
      }
    }
    for (const [name, uris] of this.macroFiles) {
      this.macroFiles.set(
        name,
        uris.filter((uri) => !updated.has(uri.fsPath))
      )
    }
    let count = 0
    for (const line of stdout.split(/\r?\n/)) {
      const [name, file, , kind] = line.split('\t')
      if (kind === undefined || name === '_') {
        continue
      }
      const uri = vscode.Uri.file(file)
      if (kind === 'define') {
        const uris = this.macroFiles.get(name) ?? []
        if (!uris.some((u) => u.fsPath === uri.fsPath)) {
          uris.push(uri)
        }
        this.macroFiles.set(name, uris)
      } else {
        this.moduleMap.set(name, uri)
        this.unitKinds.set(name, kind)
      }
      count++
    }
    this.revision++
    this.logger.info(`indexed ${count} unit and macro names in ${files.length} files`)
  }

  /// `define symbols named `name`, searching the current file first
  async findMacro(document: vscode.TextDocument, name: string): Promise<Symbol[]> {
    const local = (await this.getVerilogDoc(document).getSymbols({ name }, false)).filter((sym) =>
      sym.isMacro()
    )
    if (local.length > 0) {
      return local
    }
    const closure = await this.dependencyDocuments(document)
    const search = async (uris: vscode.Uri[]) => {
      const found: Symbol[] = []
      for (const uri of uris) {
        const doc = await vscode.workspace.openTextDocument(uri).then(
          (doc) => doc,
          () => undefined
        )
        if (doc) {
          found.push(
            ...(await this.getVerilogDoc(doc).getSymbols({ name }, false)).filter((sym) =>
              sym.isMacro()
            )
          )
        }
      }
      return found
    }
    const found = await search(closure.map((doc) => doc.uri))
    return found.length
      ? found
      : search(this.macroFiles.get(name) ?? this.headerFiles.get(name) ?? [])
  }

  /// Tags of `files` from one ctags process, one per line
  private async ctags(files: string[], kinds: string = ''): Promise<string> {
    const command = await ext.ctags.path.getValueAsync()
    const args = ['-f', '-', '--fields=+K', '--sort=no', '--excmd=n', '-L', '-']
    return await new Promise<string>((resolve, reject) => {
      const proc = child_process.execFile(
        command,
        args.concat(kinds.split(' ').filter(Boolean), CTAGS_MAPS),
        { encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 },
        (error, out) => {
          if (error !== null) {
            this.logger.error(`ctags failed: ${error.message.split('\n')[0]}`)
            reject(error)
          } else {
            resolve(out)
          }
        }
      )
      proc.stdin?.end(files.join('\n') + '\n')
    })
  }

  /// Finds the top level symbols of the headers with one ctags process, run on copies with
  /// macro calls blanked out as for an open file. A header is opened only when one of its
  /// symbols is asked for.
  indexIncludes(reset: boolean = false, changed?: vscode.Uri[]): Promise<void> {
    this.headerIndex = this.headerIndex
      .catch(() => {})
      .then(async () => {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Window,
            title: 'Indexing Verilog Includes',
            cancellable: false,
          },
          async () => {
            const files = changed ?? (await ext.findIncludes())
            this.logger.info(`indexing ${files.length} .svh files`)
            const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vscode-verilog-'))
            try {
              const copies = files.map((file, i) => path.join(dir, i + path.extname(file.fsPath)))
              for (let i = 0; i < files.length; i += 16) {
                await Promise.all(
                  files.slice(i, i + 16).map(async (file, j) => {
                    const text = await fs.promises.readFile(file.fsPath, 'utf8').catch(() => '')
                    await fs.promises.writeFile(copies[i + j], maskMacroCalls(text))
                  })
                )
              }
              const lines = new Map<number, string[]>()
              const tags = await this.ctags(copies)
              if (ext.server.active || ext.server.pending || ext.slangExtensionActive()) {
                return
              }
              if (reset) {
                this.headers.clear()
              }
              for (const file of files) {
                this.headers.set(file.fsPath, { uri: file, symbols: [] })
              }
              for (const tag of tags.split(/\r?\n/)) {
                // top level tags have no scope field; `_` stands for a masked macro call
                const [name, copy, line, kind, scope] = tag.split('\t')
                if (kind === undefined || scope !== undefined || name === '_') {
                  continue
                }
                const i = Number(path.basename(copy, path.extname(copy)))
                if (!lines.has(i)) {
                  lines.clear()
                  lines.set(i, (await fs.promises.readFile(files[i].fsPath, 'utf8')).split(/\r?\n/))
                }
                const text = lines.get(i)![Number(line.slice(0, -2)) - 1] ?? ''
                // ctags before 6.1 calls a `define a constant
                const macro = kind === 'define' || text.trimStart().startsWith('`define')
                this.headers.get(files[i].fsPath)!.symbols.push({ name, kind, text, macro })
              }
              this.headerFiles.clear()
              this.headerMacros.clear()
              for (const { uri, symbols } of this.headers.values()) {
                for (const { name, kind, text, macro } of symbols) {
                  const uris = this.headerFiles.get(name) ?? []
                  if (!uris.includes(uri)) {
                    uris.push(uri)
                  }
                  this.headerFiles.set(name, uris)
                  if (macro && !this.headerMacros.has(name)) {
                    this.headerMacros.set(name, [kind, text])
                  }
                }
              }
            } finally {
              await fs.promises.rm(dir, { recursive: true, force: true })
            }
            this.logger.info(`indexed ${files.length} .svh files`)
          }
        )
      })
    return this.headerIndex
  }

  /// Top level symbols named `name` in the headers
  async findHeaderSymbols(name: string, document?: vscode.TextDocument): Promise<Symbol[]> {
    const found: Symbol[] = []
    const candidates = document
      ? (await this.dependencyDocuments(document)).map((doc) => doc.uri)
      : (this.headerFiles.get(name) ?? [])
    for (const uri of candidates) {
      let doc: vscode.TextDocument
      try {
        doc = await vscode.workspace.openTextDocument(uri)
      } catch (e) {
        // removed since indexing
        continue
      }
      const syms = await this.getVerilogDoc(doc).getSymbols({ name })
      found.push(...syms.filter((sym) => sym.parentScope === ''))
    }
    if (!found.length && document) {
      return this.findHeaderSymbols(name)
    }
    return found
  }

  /// Only the requested source's literal include closure is parsed by ctags in native mode.
  async dependencyDocuments(document: vscode.TextDocument): Promise<vscode.TextDocument[]> {
    await ext.server.dependencies.update(
      [document.uri.fsPath],
      ext.server.includeDirectories,
      new Map(
        vscode.workspace.textDocuments
          .filter((doc) => doc === document || doc.isDirty)
          .map((doc) => [doc.uri.fsPath, doc.getText()])
      ),
      ext.server.includePolicy
    )
    const docs: vscode.TextDocument[] = []
    for (const file of ext.server.dependencies.dependenciesOf(document.uri.fsPath)) {
      try {
        docs.push(await vscode.workspace.openTextDocument(file))
      } catch {
        /* removed meanwhile */
      }
    }
    return docs
  }

  getVerilogDoc(doc: vscode.TextDocument): VerilogDoc {
    let vdoc: VerilogDoc | undefined = this.filemap.get(doc)
    if (vdoc === undefined) {
      vdoc = new VerilogDoc(this.logger, doc)
      this.filemap.set(doc, vdoc)
    }
    return vdoc
  }

  async findFile(moduleName: string): Promise<vscode.TextDocument | undefined> {
    let file = this.moduleMap.get(moduleName)
    if (file === undefined && ext.server.active) {
      file = await ext.server.findUnit(moduleName)
    }
    if (file === undefined) {
      return undefined
    }
    return await vscode.workspace.openTextDocument(file)
  }

  findModuleUri(path: string): vscode.Uri | undefined {
    let name = path.split('/').pop()?.split('.').shift() ?? ''
    return this.moduleMap.get(name)
  }

  async findModule(moduleName: string): Promise<VerilogDoc | undefined> {
    let vscodeDoc = await this.findFile(moduleName)
    if (vscodeDoc === undefined) {
      return undefined
    }
    return this.getVerilogDoc(vscodeDoc)
  }

  async findModuleSymbol(moduleName: string): Promise<Symbol | undefined> {
    let doc = await this.findModule(moduleName)
    if (doc === undefined) {
      this.logger.error('Failed to find module ' + moduleName)
      return undefined
    }
    let syms = (await doc.getSymbolTree()).filter((sym) => sym.name === moduleName)
    return syms.at(0)
  }

  async findDefinitionByName(moduleName: string, targetText: string): Promise<Symbol[]> {
    let doc = await this.findModule(moduleName)
    if (doc === undefined) {
      return []
    }
    return (await doc.getSymbols({ name: targetText }, false)).filter(
      (sym) => doc.memberScope(sym) === moduleName || (sym.name === moduleName && !sym.parentScope)
    )
  }

  /// Finds a symbols definition, but also looks in targetText.sv to get module/interface defs
  async findSymbol(document: vscode.TextDocument, position: vscode.Position): Promise<Symbol[]> {
    let textRange = document.getWordRangeAtPosition(position)
    if (!textRange || textRange.isEmpty) {
      return []
    }
    let verilogDoc = this.getVerilogDoc(document)
    let targetText = document.getText(textRange)
    if (getPrevChar(document, textRange.start) === '`') {
      return await this.findMacro(document, targetText)
    }
    // symbol tree first, unitAt needs it
    let symPromise = verilogDoc
      .getSymbolTree()
      .then(() => verilogDoc.findVisible(targetText, verilogDoc.scopeAt(position)))

    let parentScope = getParentText(document, textRange)
    // let modulePromise = this.findDefinitionByName(parentScope, targetText);
    // If we're at a port, .<text> plus no parent
    if (getPrevChar(document, textRange.start) === '.') {
      if (parentScope === targetText) {
        // param or port on instance
        let insts = await verilogDoc.getInstances()
        insts = insts.filter((inst) => inst.getFullRange().contains(position))
        if (insts.length > 0 && insts[0].typeRef !== null) {
          return await this.findDefinitionByName(insts[0].typeRef, targetText)
        }
      } else if (parentScope !== undefined) {
        // hierarchcal reference to instance.wire
        let insts = await verilogDoc.getSymbols({ name: parentScope })
        if (insts.length > 0 && insts[0].typeRef !== null) {
          return await this.findDefinitionByName(insts[0].typeRef, targetText)
        }
      }
    }

    if (
      (ext.server.active && parentScope !== targetText) ||
      this.moduleMap.has(targetText) ||
      this.moduleMap.has(parentScope)
    ) {
      // find parentScope.sv of parentScope::targetText
      const symbols = await this.findDefinitionByName(parentScope, targetText)
      if (symbols.length > 0) {
        return symbols
      }
    }
    const local = (await symPromise).filter(
      (sym) => !sym.isMacro() || (sym.doc === document && sym.getIdRange().contains(position))
    )
    if (local.length > 0) {
      return local
    }
    if (ext.server.active) {
      const unit = await this.findModuleSymbol(targetText)
      if (unit) {
        return [unit]
      }
    }
    return (await this.findHeaderSymbols(targetText, document)).filter((sym) => !sym.isMacro())
  }
}
