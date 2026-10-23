// SPDX-License-Identifier: MIT
import * as child_process from 'child_process'
import * as vscode from 'vscode'
import { Symbol } from './analysis/Symbol'
import { VerilogDoc } from './analysis/VerilogDoc'
import { ext } from './extension'
import { ConfigObject, ExtensionComponent } from './lib/libconfig'
import { getParentText, getPrevChar, isAnyVerilog } from './utils'
import fs = require('fs')
import path = require('path')

export class IndexComponent extends ExtensionComponent {
  public readonly moduleMap: Map<string, vscode.Uri> = new Map()

  enableSymlinks: ConfigObject<boolean> = new ConfigObject({
    default: true,
    description:
      'Enable creating file symlinks in .sv_cache/files for the -y flag that most tools have. Created in a per-workspace exteneral directory that vscode provides',
  })

  indexAllIncludes: ConfigObject<boolean> = new ConfigObject({
    default: false,
    description: 'Whether to index all .svh files',
  })

  // <workspace-specific-dir>/.sv_cache/files
  cacheDir: vscode.Uri | undefined

  // file -> verilogDoc
  private filemap: Map<vscode.TextDocument, VerilogDoc> = new Map()

  /// symbol name -> global symbols loaded from includes/*.svh
  readonly symbolMap: Map<string, Symbol[]> = new Map()

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
      vscode.workspace.onDidSaveTextDocument((doc: vscode.TextDocument) => {
        this.indexFile(doc.uri)
        this.getVerilogDoc(doc).clearSymbols()
        if (isAnyVerilog(doc.languageId)) {
          this.indexNames([doc.uri])
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

    // index files if we change the index config
    this.onConfigUpdated(() => {
      this.indexFiles()
    })

    // index includes if they change
    ext.includes.onConfigUpdated(() => {
      if (!(ext.ctags.indexAllIncludes.getValue() || this.indexAllIncludes.getValue())) {
        this.indexIncludes(true)
      }
    })

    // shell find ctags on path change
    ext.ctags.path.onConfigUpdated(async () => {
      await ext.ctags.path.checkPathNotify()
    })
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
    if (this.enableSymlinks.getValue() && this.cacheDir !== undefined) {
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
      this.unitKinds.clear()
      this.macroFiles.clear()
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: 'Indexing Verilog files',
        cancellable: true,
      },
      async () => {
        for (let file of files) {
          this.indexMem(file)
        }
        // after indexMem, so real unit names win over file names
        await this.indexNames(files.concat(await ext.findIncludes()))
        if (this.enableSymlinks.getValue() && dir !== undefined) {
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
    const command = await ext.ctags.path.getValueAsync()
    const args =
      '-f - --fields=+K --sort=no --excmd=n --kinds-SystemVerilog=mIKCPd --kinds-Verilog=md -L -'
    const stdout = await new Promise<string>((resolve) => {
      const proc = child_process.execFile(
        command,
        args.split(' '),
        { encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 },
        (error, out) => {
          if (error !== null) {
            this.logger.error(`ctags name index failed: ${error}`)
          }
          resolve(out)
        }
      )
      proc.stdin?.end(files.map((file) => file.fsPath).join('\n') + '\n')
    })
    const updated = new Set(files.map((file) => file.fsPath))
    for (const [name, uris] of this.macroFiles) {
      this.macroFiles.set(
        name,
        uris.filter((uri) => !updated.has(uri.fsPath))
      )
    }
    let count = 0
    for (const line of stdout.split(/\r?\n/)) {
      const [name, file, , kind] = line.split('\t')
      if (kind === undefined) {
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
    const found: Symbol[] = []
    for (const uri of this.macroFiles.get(name) ?? []) {
      const doc = await vscode.workspace.openTextDocument(uri)
      const syms = await this.getVerilogDoc(doc).getSymbols({ name }, false)
      found.push(...syms.filter((sym) => sym.isMacro()))
    }
    return found
  }

  async indexIncludes(reset: boolean = false): Promise<void> {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: 'Indexing Verilog Includes',
        cancellable: false,
      },
      async () => {
        let files: vscode.Uri[] = await ext.findIncludes()

        this.logger.info(`indexing ${files.length} .svh files`)
        if (reset) {
          this.symbolMap.clear()
        }

        files.forEach(async (file: vscode.Uri) => {
          let doc: vscode.TextDocument | undefined = undefined
          let retryCount = 0
          while (retryCount < 3) {
            try {
              doc = await vscode.workspace.openTextDocument(file)
              break
            } catch (e) {
              retryCount++
              await new Promise((resolve) => setTimeout(resolve, 10))
            }
          }

          if (doc === undefined) {
            this.logger.error('Failed to index file: ' + file.fsPath)
            return
          }

          let syms = await this.getVerilogDoc(doc).getSymbols()
          syms.forEach((element: Symbol) => {
            // only want to index top level symbols, i.e. macros
            if (element.parentScope !== '') {
              return
            }
            if (this.symbolMap.has(element.name)) {
              this.symbolMap.get(element.name)?.push(element)
            } else {
              this.symbolMap.set(element.name, [element])
            }
          })
          // close doc
        })

        this.logger.info(`indexed ${files.length} .svh files`)
      }
    )
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
    return await doc.getSymbols({ name: targetText })
  }

  /// Finds a symbols definition, but also looks in targetText.sv to get module/interface defs
  async findSymbol(document: vscode.TextDocument, position: vscode.Position): Promise<Symbol[]> {
    let textRange = document.getWordRangeAtPosition(position)
    if (!textRange || textRange.isEmpty) {
      return []
    }
    let verilogDoc = this.getVerilogDoc(document)
    let targetText = document.getText(textRange)
    // symbol tree first, unitAt needs it
    let symPromise = verilogDoc
      .getSymbolTree()
      .then(() => verilogDoc.findVisible(targetText, verilogDoc.unitAt(position)))

    let parentScope = getParentText(document, textRange)
    // let modulePromise = this.findDefinitionByName(parentScope, targetText);
    // If we're at a port, .<text> plus no parent
    if (getPrevChar(document, textRange.start) === '.') {
      if (parentScope === targetText) {
        // param or port on instance
        let insts = await verilogDoc.getInstances()
        insts = insts.filter((inst) => inst.getFullRange().contains(position))
        if (insts.length > 0 && insts[0].typeRef !== null) {
          verilogDoc.hoverSet.add(insts[0].name)
          ext.ctags.onDidChangeInlayHintsEmitter.fire()
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

    if (this.symbolMap.has(targetText)) {
      return this.symbolMap.get(targetText) ?? []
    }

    if (getPrevChar(document, textRange.start) === '`') {
      return await this.findMacro(document, targetText)
    }

    if (this.moduleMap.has(targetText) || this.moduleMap.has(parentScope)) {
      // find parentScope.sv of parentScope::targetText
      let sym = (await this.findDefinitionByName(parentScope, targetText)).at(0)
      // Sometimes package::x is found multiple times, return just the top level package
      if (sym !== undefined) {
        return [sym]
      }
    }
    return await symPromise
  }
}
