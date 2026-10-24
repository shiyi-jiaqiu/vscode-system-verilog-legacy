// SPDX-License-Identifier: MIT
import { TextEncoder } from 'util'
import * as vscode from 'vscode'

import { glob } from 'glob'
import path from 'path'
import { promisify } from 'util'
import { CtagsServerComponent } from './analysis/CtagsServerComponent'
import { Filelist, readFilelist } from './Filelist'
import { FormatProvider } from './FormatProvider'
import { InactiveRegionsComponent } from './InactiveRegionsComponent'
import { IndexComponent } from './IndexComponent'
import { ActivityBarComponent, CommandNode, ConfigObject, ViewContainerSpec } from './lib/libconfig'
import LintManager from './linter/LintManager'
import { SemanticTokensComponent } from './SemanticTokensComponent'
import { ProjectComponent } from './sidebar/ProjectComponent'
import { getWorkspaceFolder, pathFilename, zip } from './utils'
const asyncGlob = promisify(glob)

export var ext: VerilogExtension

export class VerilogExtension extends ActivityBarComponent {
  /// Important components to load first
  index: IndexComponent = new IndexComponent()
  ctags: CtagsServerComponent = new CtagsServerComponent()

  ////////////////////////////////////////////////
  /// top level configs
  ////////////////////////////////////////////////
  filelist: ConfigObject<string> = new ConfigObject({
    default: '',
    description:
      'Project filelist relative to the workspace root. Its source files are indexed, +incdir+/-I directories are searched for includes, +define+/-D macros select the active `ifdef branches, and linters get it with -f instead of the current file. Run Reindex after editing it.',
  })

  moduleGlobs: ConfigObject<string[]> = new ConfigObject({
    default: ['**/*.{sv,v}'],
    description:
      'Without `verilog.filelist`: globs of the module, interface and package files to index',
  })
  includeGlobs: ConfigObject<string[]> = new ConfigObject({
    default: ['**/*.{svh,vh}'],
    description: 'Without `verilog.filelist`: globs of the include files to index',
  })
  excludeGlob: ConfigObject<string> = new ConfigObject({
    default: '',
    description: 'Without `verilog.filelist`: glob of the files the other globs leave out',
  })
  ////////////////////////////////////////////////
  /// extension subcomponents
  ////////////////////////////////////////////////
  lint: LintManager = new LintManager()

  format: FormatProvider = new FormatProvider()

  project: ProjectComponent = new ProjectComponent()

  semanticTokens: SemanticTokensComponent = new SemanticTokensComponent()

  inactiveRegions: InactiveRegionsComponent = new InactiveRegionsComponent()

  ////////////////////////////////////////////////
  /// top level commands
  ////////////////////////////////////////////////
  reindex: CommandNode = new CommandNode(
    {
      title: 'Reindex',
    },
    async () => {
      this.loadFilelist()
      return this.indexFiles(true)
        .then(() => {
          vscode.window.showInformationMessage('Reindexing complete')
        })
        .catch((err) => {
          vscode.window.showErrorMessage('Reindexing failed')
          this.logger.error(err)
        })
    }
  )

  fixModules: CommandNode = new CommandNode(
    {
      title: 'Fix file names to match module names',
    },
    async () => {
      /// Fix module file names to match the module name
      /// If a file has multiple modules, split into mutliple files
      /// keep excess text before and after the module definitions

      for (let uri of await this.findModules()) {
        const doc = await vscode.workspace.openTextDocument(uri)
        const verilogDoc = this.index.getVerilogDoc(doc)
        if (verilogDoc === undefined) {
          continue
        }
        const modules = (await verilogDoc.getSymbolTree()).filter(
          (sym) => sym.isModuleType() && sym.type !== 'class'
        )
        if (modules.length === 0) {
          continue
        }

        // exclude common top level modules names and file names
        const COMMON_TOP_LEVEL_MODULES = ['top', 'tb', 'tb_top', 'dut']
        const fileName = pathFilename(uri)
        if (COMMON_TOP_LEVEL_MODULES.some((c) => fileName.endsWith(c))) {
          continue
        }
        if (modules.some((m) => COMMON_TOP_LEVEL_MODULES.some((c) => m.name.endsWith(c)))) {
          continue
        }

        if (modules.length === 1) {
          if (fileName === modules[0].name) {
            continue
          }
          // no ports => testbench
          if (modules[0].children.filter((c) => c.type === 'port').length === 0) {
            return
          }
          const canonUri = vscode.Uri.joinPath(
            uri.with({ path: path.dirname(uri.fsPath) }),
            modules[0].name + path.extname(uri.fsPath)
          )
          // Move the module to a new file named after the module
          vscode.window.showInformationMessage(`Moving ${modules[0].name} to ${canonUri.fsPath}`)
          try {
            await vscode.workspace.fs.rename(uri, canonUri, { overwrite: false })
          } catch (e) {
            vscode.window.showWarningMessage(
              'Failed to rename ' + uri.fsPath + ' to ' + canonUri.fsPath + ': ' + e
            )
          }
          continue
        }

        // multiple modules, split into multiple files
        this.logger.info(`Found ${modules.length} modules in ${uri.fsPath}`)
        vscode.window.showInformationMessage(`Splitting ${uri.fsPath} into ${modules.length} files`)
        // create new URIs for each module
        const newUris = modules.map((module) =>
          vscode.Uri.joinPath(
            uri.with({ path: path.dirname(uri.fsPath) }),
            module.name + path.extname(uri.fsPath)
          )
        )

        // zip modules and newUris together
        for (const [module, newUri] of zip(modules, newUris)) {
          const ignoreModules = modules
            .filter((m) => m.name !== module.name)
            .map((m) => m.getFullRange())
            .reverse()
          // read doc, don't write line in bad symbols
          let text = doc.getText()
          for (let range of ignoreModules) {
            text = text.slice(0, doc.offsetAt(range.start)) + text.slice(doc.offsetAt(range.end))
          }
          const encoder = new TextEncoder()
          await vscode.workspace.fs.writeFile(newUri, encoder.encode(text))
        }
        // delete the original file if not in newUris
        if (!newUris.find((u) => u.fsPath === uri.fsPath)) {
          await vscode.workspace.fs.delete(uri)
        }
      }
      vscode.window.showInformationMessage('File name fix complete')
    }
  )

  context: vscode.ExtensionContext
  /// parsed `verilog.filelist`, if one is configured
  projectFilelist: Filelist | undefined = undefined
  private filelistWatcher: vscode.FileSystemWatcher | undefined
  private filelistChange: NodeJS.Timeout | undefined

  constructor(context: vscode.ExtensionContext, obj: ViewContainerSpec) {
    super(obj)
    this.context = context
  }

  async activate(context: vscode.ExtensionContext) {
    // hides our views, vscode-slang has its own
    vscode.commands.executeCommand(
      'setContext',
      'verilog.slangExtensionActive',
      this.slangExtensionActive()
    )
    // also starts the first check
    this.loadFilelist()
    this.watchFilelist()
    context.subscriptions.push(
      this.filelist.onConfigUpdated(async () => {
        this.loadFilelist()
        this.watchFilelist()
        await this.indexFiles(true).catch((error) => this.logger.error(String(error)))
      }),
      { dispose: () => this.filelistWatcher?.dispose() }
    )

    /////////////////////////////////////////////
    // Slow async tasks
    /////////////////////////////////////////////

    // let ctags index include files

    let tasks = [this.indexFiles().catch((error) => this.logger.error(String(error)))]
    await Promise.all(tasks)

    this.logger.info(`${context.extension.id} activation finished.`)
  }

  private async indexFiles(reset: boolean = false) {
    if (!(await this.ctags.path.checkPathNotify())) {
      return
    }

    await Promise.all([this.index.indexIncludes(reset), this.index.indexFiles(reset)])
    this.semanticTokens.refresh()
    this.logger.info('index files and includes finished')
  }

  /// Reindexes and checks again after the filelist file changes, as Reindex does
  private watchFilelist() {
    this.filelistWatcher?.dispose()
    this.filelistWatcher = undefined
    const configured = this.filelist.getValue()
    const ws = getWorkspaceFolder()
    if (configured === '' || ws === undefined) {
      return
    }
    const file = path.resolve(ws, configured)
    this.filelistWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(path.dirname(file), path.basename(file))
    )
    const reload = () => {
      // an editor or a script may write it in several steps
      clearTimeout(this.filelistChange)
      this.filelistChange = setTimeout(() => {
        this.logger.info(`filelist ${file} changed`)
        this.loadFilelist()
        this.indexFiles(true).catch((error) => this.logger.error(String(error)))
      }, 500)
    }
    this.filelistWatcher.onDidChange(reload)
    this.filelistWatcher.onDidCreate(reload)
    this.filelistWatcher.onDidDelete(reload)
  }

  loadFilelist() {
    this.projectFilelist = undefined
    const configured = this.filelist.getValue()
    const ws = getWorkspaceFolder()
    if (configured !== '' && ws !== undefined) {
      const file = path.resolve(ws, configured)
      try {
        this.projectFilelist = readFilelist(file, ws)
        this.logger.info(
          `filelist ${file}: ${this.projectFilelist.files.length} files, ${this.projectFilelist.incdirs.length} include dirs`
        )
      } catch (e) {
        this.logger.error(`failed to read filelist ${file}: ${e}`)
        vscode.window.showErrorMessage(`verilog.filelist: cannot read ${file}`)
      }
    }
    this.inactiveRegions.update()
    this.lint.restart()
  }

  /// The Slang extension provides its own hovers, definitions, diagnostics and views,
  /// so ours only add semantic highlighting next to it.
  slangExtensionActive(): boolean {
    return vscode.extensions.getExtension('Hudson-River-Trading.vscode-slang') !== undefined
  }

  public async findFiles(globs: string[]): Promise<vscode.Uri[]> {
    let ws = getWorkspaceFolder()
    if (ws === undefined) {
      return []
    }
    const exclude: string = this.excludeGlob.getValue()

    const find = async (str: string): Promise<vscode.Uri[]> => {
      let ret: vscode.Uri[]
      if (path.isAbsolute(str)) {
        ret = (await asyncGlob(str)).map((p) => vscode.Uri.file(p))
      } else {
        ret = await vscode.workspace.findFiles(new vscode.RelativePattern(ws, str), exclude)
      }
      return ret
    }
    let uriList: vscode.Uri[][] = await Promise.all(globs.map(find))
    let uris = uriList.reduce((acc, curr) => acc.concat(curr), [])
    return uris
  }

  /// The headers in the include directories of the filelist, or those matching the globs
  public async findIncludes(): Promise<vscode.Uri[]> {
    if (this.projectFilelist === undefined) {
      return await this.findFiles(this.includeGlobs.getValue())
    }
    const globs = this.projectFilelist.incdirs.map((dir) => dir + '/**/*.{svh,vh}')
    // nested include directories find a header twice
    return Array.from(
      new Map((await this.findFiles(globs)).map((uri) => [uri.fsPath, uri])).values()
    )
  }

  /// The sources of the filelist, or those matching the globs
  public async findModules(): Promise<vscode.Uri[]> {
    if (this.projectFilelist === undefined) {
      return await this.findFiles(this.moduleGlobs.getValue())
    }
    return this.projectFilelist.files.map((file) => vscode.Uri.file(file))
  }
}

export async function deactivate(): Promise<void> {
  ext.logger.info('Deactivated')
}

export async function activate(context: vscode.ExtensionContext) {
  ext = new VerilogExtension(context, {
    id: 'verilog',
    title: 'Verilog',
    icon: '$(chip)',
  })
  await ext.activateExtension('verilog', 'Verilog', context, [
    'mshr-h.veriloghdl',
    'eirikpre.systemverilog',
    'IMCTradingBV.svlangserver',
  ])
}
