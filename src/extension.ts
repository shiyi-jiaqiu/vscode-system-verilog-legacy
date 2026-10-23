// SPDX-License-Identifier: MIT
import { TextEncoder } from 'util'
import * as vscode from 'vscode'

import * as child_process from 'child_process'
import { glob } from 'glob'
import path from 'path'
import { promisify } from 'util'
import { CtagsServerComponent } from './analysis/CtagsServerComponent'
import { Filelist, readFilelist } from './Filelist'
import { SystemVerilogFormatProvider, VerilogFormatProvider } from './FormatProvider'
import { IncludeConfig } from './IncludeConfig'
import { InactiveRegionsComponent } from './InactiveRegionsComponent'
import { IndexComponent } from './IndexComponent'
import { InlayHintsComponent } from './InlayHintsComponent'
import {
  ActivityBarComponent,
  CommandNode,
  ConfigObject,
  EditorButton,
  ViewContainerSpec,
} from './lib/libconfig'
import LintManager from './linter/LintManager'
import { LanguageServerComponent, LanguageServers } from './LSComponent'
import { SemanticTokensComponent } from './SemanticTokensComponent'
import { ProjectComponent } from './sidebar/ProjectComponent'
import { getWorkspaceFolder, pathFilename, zip } from './utils'
const asyncGlob = promisify(glob)

export var ext: VerilogExtension

export enum SvStandard {
  SV2005 = 'SystemVerilog-2005',
  SV2009 = 'SystemVerilog-2009',
  SV2012 = 'SystemVerilog-2012',
  SV2017 = 'SystemVerilog-2017',
  //   sv2023 = 'SystemVerilog2023',
}

// eslint-disable-next-line @typescript-eslint/naming-convention
export enum VerilogStandard {
  V1995 = 'Verilog-95',
  V2001 = 'Verilog-2001',
  V2005 = 'Verilog-2005',
}

export class VerilogExtension extends ActivityBarComponent {
  /// Important components to load first
  index: IndexComponent = new IndexComponent()
  ctags: CtagsServerComponent = new CtagsServerComponent()

  ////////////////////////////////////////////////
  /// top level configs
  ////////////////////////////////////////////////
  includes: IncludeConfig = new IncludeConfig({
    default: [],
    description: 'Include paths to pass as -I to tools',
  })

  filelist: ConfigObject<string> = new ConfigObject({
    default: '',
    description:
      'Project filelist relative to the workspace root. Its source files are indexed, +incdir+/-I directories are searched for includes, +define+/-D macros select the active `ifdef branches, and linters get it with -f instead of the current file. Run Reindex after editing it.',
  })

  moduleGlobs: ConfigObject<string[]> = new ConfigObject({
    default: ['**/*.{sv,v}'],
    description:
      'Globs for finding verilog modules, interfaces, and packages for use with the common -y flag',
  })
  includeGlobs: ConfigObject<string[]> = new ConfigObject({
    default: ['**/*.{svh,vh}'],
    description:
      'Globs for finding verilog include files (typically svh/vh), used for definition providing. If set to [], it will source from verilog.includes',
  })
  excludeGlob: ConfigObject<string> = new ConfigObject({
    default: '',
    description: 'Globs to exclude files',
  })
  svStandard: ConfigObject<SvStandard> = new ConfigObject({
    default: SvStandard.SV2017,
    description: 'System Verilog standard to use',
    enum: Object.values(SvStandard),
  })
  verilogStandard: ConfigObject<VerilogStandard> = new ConfigObject({
    default: VerilogStandard.V2005,
    description: 'System Verilog standard to use',
    enum: Object.values(VerilogStandard),
  })
  formatDirs: ConfigObject<string[]> = new ConfigObject({
    default: [],
    description: 'Directories to format',
  })

  expandMacroScript: ConfigObject<string> = new ConfigObject({
    default: '',
    description: 'Script to expand macros. Takes the file as an argument, expects output on stdout',
  })
  ////////////////////////////////////////////////
  /// extension subcomponents
  ////////////////////////////////////////////////
  lint: LintManager = new LintManager()

  svFormat: SystemVerilogFormatProvider = new SystemVerilogFormatProvider()
  verilogFormat: VerilogFormatProvider = new VerilogFormatProvider()

  project: ProjectComponent = new ProjectComponent()

  languageServer: LanguageServerComponent = new LanguageServerComponent()

  inlayHints: InlayHintsComponent = new InlayHintsComponent()

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
      this.indexFiles(true)
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

  expandMacros: EditorButton = new EditorButton(
    {
      title: 'Expand Macros',
      shortTitle: 'Expand macros',
      languages: ['verilog', 'systemverilog'],
      icon: '$(open-preview)',
    },
    async () => {
      if (ext.expandMacroScript.getValue() === '') {
        vscode.window.showErrorMessage('`verilog.expandMacroScript` not provided')
        return
      }
      let doc = vscode.window.activeTextEditor?.document
      if (doc === undefined) {
        vscode.window.showErrorMessage('Open a verilog document to expand macros')
        return
      }
      let expDir = this.expandDir
      if (expDir === undefined) {
        return
      }
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Expanding macros',
        },
        async (progress) => {
          progress.report({ increment: 0, message: 'Expanding macros' })
          let expanded = child_process.execSync(
            ext.expandMacroScript.getValue() + ' ' + doc.uri.fsPath,
            {
              cwd: getWorkspaceFolder(),
            }
          )

          let uri: vscode.Uri = vscode.Uri.joinPath(expDir, doc.uri.path.split('/').pop()!)
          await vscode.workspace.fs.writeFile(uri, expanded)
          await vscode.workspace.openTextDocument(uri)
          await vscode.commands.executeCommand('vscode.diff', uri, doc.uri)
        }
      )
    }
  )
  expandDir: vscode.Uri | undefined = undefined
  context: vscode.ExtensionContext
  /// parsed `verilog.filelist`, if one is configured
  projectFilelist: Filelist | undefined = undefined

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
    this.loadFilelist()
    // Lets do this quickly
    vscode.window.visibleTextEditors.forEach((editor) => {
      this.lint.lint(editor.document)
    })

    if (context.storageUri !== undefined) {
      this.expandDir = vscode.Uri.joinPath(context.storageUri, '.sv_cache', 'expanded')
    }

    /////////////////////////////////////////////
    // Configure Format on save
    /////////////////////////////////////////////

    this.onConfigUpdated(() => {
      this.loadFilelist()
      this.checkFormatDirs()
    })
    await this.checkFormatDirs()

    /////////////////////////////////////////////
    // Slow async tasks
    /////////////////////////////////////////////

    // let ctags index include files

    let tasks = [this.indexFiles()]
    await Promise.all(tasks)

    this.logger.info(`${context.extension.id} activation finished.`)
  }

  private async checkFormatDirs() {
    let dirs = this.formatDirs.getValue()
    this.svFormat.activateFormatter(dirs, ['sv', 'svh'], 'systemverilog')
    this.verilogFormat.activateFormatter(dirs, ['v', 'vh'], 'verilog')
  }

  private async indexFiles(reset: boolean = false) {
    if (!(await this.ctags.path.checkPathNotify())) {
      return
    }

    if (this.ctagsEnabled()) {
      this.index
        .indexIncludes(reset)
        .then(() => {
          this.logger.info('ctags index includes finished')
        })
        .catch((err) => {
          this.logger.error('ctags index includes failed:')
          this.logger.error(err)
        })
    } else {
      this.logger.info('ctags disabled, not indexing includes')
    }

    // index all files (symlinks in .sv_cache/files + in memory cache)
    this.index
      .indexFiles(reset)
      .then(() => {
        this.logger.info('index files finished')
        this.semanticTokens.refresh()
      })
      .catch((err) => {
        this.logger.error('index files failed:')
        this.logger.error(err)
      })
  }

  loadFilelist() {
    this.projectFilelist = undefined
    const configured = this.filelist.getValue()
    const ws = getWorkspaceFolder()
    if (configured === '' || ws === undefined) {
      return
    }
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
    this.inactiveRegions.update()
  }

  /// The Slang extension provides its own hovers, definitions, diagnostics and views,
  /// so ours only add semantic highlighting next to it.
  slangExtensionActive(): boolean {
    return vscode.extensions.getExtension('Hudson-River-Trading.vscode-slang') !== undefined
  }

  ctagsEnabled(): boolean {
    return this.languageServer.server.getValue() === LanguageServers.Ctags
  }

  // TODO: may need this to disable slang linting so we don't get double
  slangServerEnabled(): boolean {
    return this.languageServer.server.getValue() === LanguageServers.Slang
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

  public async findIncludes(): Promise<vscode.Uri[]> {
    let incGlobs = this.includeGlobs.getValue()
    if (incGlobs.length === 0) {
      incGlobs = this.includes.getValue().map((inc) => {
        return inc + '/*.svh'
      })
    }
    const incdirs = this.projectFilelist?.incdirs ?? []
    return uniqueUris(
      await this.findFiles(incGlobs.concat(incdirs.map((dir) => dir + '/**/*.{svh,vh}')))
    )
  }

  public async findModules(): Promise<vscode.Uri[]> {
    const listed = (this.projectFilelist?.files ?? []).map((file) => vscode.Uri.file(file))
    return uniqueUris((await this.findFiles(this.moduleGlobs.getValue())).concat(listed))
  }
}

// filelist entries and include directories may also match the workspace globs
function uniqueUris(uris: vscode.Uri[]): vscode.Uri[] {
  return Array.from(new Map(uris.map((uri) => [uri.fsPath, uri])).values())
}

export async function deactivate(): Promise<void> {
  ext.logger.info('Deactivated')
  await ext.languageServer.stop()
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
