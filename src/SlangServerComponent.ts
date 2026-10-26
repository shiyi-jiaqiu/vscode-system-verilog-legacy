// SPDX-License-Identifier: MIT
import * as fs from 'fs'
import { ChildProcess, spawn } from 'child_process'
import * as path from 'path'
import { applyEdits, modify, parse, ParseError } from 'jsonc-parser'
import { platform } from 'process'
import { clearTimeout, setTimeout } from 'timers'
import * as vscode from 'vscode'
import which from 'which'
import {
  CloseAction,
  ErrorAction,
  LanguageClient,
  Middleware,
  PublishDiagnosticsNotification,
  PublishDiagnosticsParams,
  State,
} from 'vscode-languageclient/node'
import { ext } from './extension'
import { CommandNode, ConfigObject, ExtensionComponent } from './lib/libconfig'
import { SourceDependencies } from './linter/SourceDependencies'
import { anyVerilogSelector, getWorkspaceFolder, isAnyVerilog } from './utils'

// LanguageClient 9 calls stop() after initialize rejects, even though LSP shutdown
// is only legal once running. The component owns and kills a cancelled transport.
class ManagedLanguageClient extends LanguageClient {
  override stop(timeout?: number): Promise<void> {
    return this.isRunning() ? super.stop(timeout) : Promise.resolve()
  }
}

export class SlangServerComponent extends ExtensionComponent {
  configureIndex = new CommandNode({ title: 'Configure Native Index' }, async () => {
    await this.openIndexConfig()
  })
  autoConfigure = new CommandNode(
    { title: 'Auto-configure Native Index and Includes' },
    async () => {
      if (!this.client || !this.active) {
        vscode.window.showInformationMessage(
          'Start slang-server before using automatic configuration.'
        )
        return
      }
      await this.client.sendRequest('workspace/executeCommand', { command: 'slang.autoConfigure' })
      await this.openIndexConfig()
    }
  )
  showDiagnostics = new CommandNode({ title: 'Show Raw Diagnostics' }, async () => {
    const doc = vscode.window.activeTextEditor?.document
    if (!doc) {
      return
    }
    const uri = vscode.Uri.from({
      scheme: 'verilog-diagnostics',
      path: '/diagnostics.json',
      query: doc.uri.toString(),
    })
    this.diagnosticsChanged.fire(uri)
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), {
      preview: true,
    })
  })
  enabled = new ConfigObject<boolean>({
    default: true,
    description:
      'Use slang-server for standard Verilog navigation and diagnostics when available. Falls back to ctags and slang CLI if unavailable.',
  })
  path = new ConfigObject<string>({
    default: '',
    description:
      'Path to slang-server. Empty searches PATH and the directory containing the configured slang executable. Requires a binary compatible with this operating system.',
  })
  startupTimeout = new ConfigObject<number>({
    default: 15,
    minimum: 1,
    maximum: 600,
    type: 'integer',
    description:
      'Seconds allowed for the native protocol initialization and include-configuration handshake. Workspace indexing follows the handshake and is not part of this timeout.',
  })
  private restartTimer: ReturnType<typeof setTimeout> | undefined
  private fallbackNeedsIndex = false
  readonly dependencies = new SourceDependencies()
  private client: LanguageClient | undefined
  private sent = new Set<string>()
  private opening = new Map<string, Promise<void>>()
  private diagnostics = new Map<string, vscode.Diagnostic[]>()
  private diagnosticVersions = new Map<string, number | undefined>()
  private rawDiagnostics = new Map<string, PublishDiagnosticsParams>()
  private diagnosticsChanged = new vscode.EventEmitter<vscode.Uri>()
  private manualVersions = new Map<string, number>()
  private status: vscode.LanguageStatusItem | undefined
  private restarting: Promise<void> = Promise.resolve()
  private state = 'initializing'
  private initialized = false
  private stopping = false
  private configChange: ReturnType<typeof setTimeout> | undefined
  private process: ChildProcess | undefined
  private cancelStart: (() => void) | undefined
  private serverOutput: vscode.OutputChannel | undefined
  private includeReady: Promise<void> | undefined
  private resolveIncludes: (() => void) | undefined
  private generation = 0
  private nativeIncludes:
    | {
        directories: string[]
        disableLocalIncludes: boolean
        incDirFirst: boolean
      }
    | undefined

  get includeDirectories(): string[] {
    return this.nativeIncludes?.directories ?? ext.projectFilelist?.incdirs ?? []
  }

  get includePolicy() {
    return this.nativeIncludes ?? {}
  }

  get active(): boolean {
    return this.state === 'running'
  }
  get pending(): boolean {
    return this.state === 'initializing' || this.state === 'starting'
  }
  owns(doc: vscode.TextDocument): boolean {
    return this.active && this.sent.has(doc.uri.toString())
  }
  async findUnit(name: string): Promise<vscode.Uri | undefined> {
    if (!this.client || !this.active || !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) {
      return undefined
    }
    const symbols = await this.client.sendRequest<{ name: string; location: { uri: string } }[]>(
      'workspace/symbol',
      { query: name }
    )
    const symbol = symbols.find((symbol) => symbol.name === name)
    return symbol && vscode.Uri.parse(symbol.location.uri)
  }

  private async openIndexConfig() {
    const root = getWorkspaceFolder()
    if (!root) {
      return
    }
    const configPath = path.join(root, '.slang', 'server.json')
    if (!(await fs.promises.stat(configPath).catch(() => undefined))) {
      const dirs = [
        ...new Set((ext.projectFilelist?.files ?? []).map((file) => path.dirname(file))),
      ].map((dir) => path.relative(root, dir) || '.')
      const content =
        '// Directory indexing also covers sources absent from the filelist.\n' +
        '// Existing workspace, user and local index entries are additive.\n' +
        '// Use excludeDirs for directory names or ./relative/paths; no wildcard patterns.\n' +
        JSON.stringify(
          { index: [{ dirs: dirs.length ? dirs : ['.'], excludeDirs: [] }] },
          null,
          2
        ) +
        '\n'
      await fs.promises.mkdir(path.dirname(configPath), { recursive: true })
      await fs.promises.writeFile(configPath, content, { flag: 'wx' })
    }
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(configPath))
  }

  async activate(context: vscode.ExtensionContext) {
    this.serverOutput = vscode.window.createOutputChannel('Verilog slang-server')
    context.subscriptions.push(this.serverOutput)
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{sv,v,svh,vh}')
    const changed = () => {
      ext.index.revision++
    }
    context.subscriptions.push(
      watcher,
      watcher.onDidCreate(changed),
      watcher.onDidDelete(changed),
      watcher.onDidChange(changed)
    )
    this.status = vscode.languages.createLanguageStatusItem('verilog.backend', anyVerilogSelector)
    this.status.name = 'Verilog analysis'
    this.status.command = {
      title: 'Show raw diagnostics',
      command: 'verilog.server.showDiagnostics',
    }
    context.subscriptions.push(
      this.status,
      this.diagnosticsChanged,
      vscode.workspace.registerTextDocumentContentProvider('verilog-diagnostics', {
        onDidChange: this.diagnosticsChanged.event,
        provideTextDocumentContent: (uri) =>
          JSON.stringify(
            this.active
              ? (this.rawDiagnostics.get(uri.query) ?? {
                  uri: uri.query,
                  status: 'No server result received yet',
                })
              : ext.lint.slang.rawDiagnostics(vscode.Uri.parse(uri.query)),
            null,
            2
          ),
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateStatus()),
      vscode.window.tabGroups.onDidChangeTabs(() => this.publishAll()),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (
          this.active &&
          isAnyVerilog(event.document.languageId) &&
          !this.sent.has(event.document.uri.toString())
        ) {
          void this.openDocument(event.document)
        }
        this.publish(event.document.uri)
        this.updateStatus()
        if (this.active && isAnyVerilog(event.document.languageId)) {
          ext.index.revision++
        }
      }),
      vscode.workspace.onDidSaveTextDocument(() => this.publishAll()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (this.initialized && event.affectsConfiguration('verilog.server')) {
          clearTimeout(this.restartTimer)
          if (!this.enabled.getValue()) {
            void this.restart()
          } else {
            ++this.generation
            this.cancelStart?.()
            this.restartTimer = setTimeout(() => void this.restart(), 250)
          }
        } else if (
          this.initialized &&
          (event.affectsConfiguration('verilog.lint.slang.warnings') ||
            event.affectsConfiguration('verilog.lint.slang.threads') ||
            event.affectsConfiguration('verilog.lint.slang.readingMode') ||
            event.affectsConfiguration('verilog.lint.slang.reportMissingModules'))
        ) {
          clearTimeout(this.configChange)
          this.configChange = setTimeout(() => void this.updateConfiguration(), 200)
        } else if (event.affectsConfiguration('verilog.lint')) {
          this.publishAll()
        }
      })
    )
    if (!ext.slangExtensionActive()) {
      context.subscriptions.push(
        vscode.commands.registerCommand(
          'slang.quickPick',
          async (params: {
            placeholder: string
            items: (vscode.QuickPickItem & { value: unknown })[]
            onSelectCommand: string
          }) => {
            const selected = await vscode.window.showQuickPick(params.items, {
              placeHolder: params.placeholder,
            })
            if (selected) {
              await vscode.commands.executeCommand(params.onSelectCommand, selected.value)
            }
          }
        )
      )
    }
    this.updateStatus()
  }

  async start() {
    this.initialized = true
    await this.restart()
  }

  restart(): Promise<void> {
    clearTimeout(this.restartTimer)
    const generation = ++this.generation
    // Cancellation must run now, before entering the serialized lifecycle queue.
    this.cancelStart?.()
    this.restarting = this.restarting
      .catch(() => {})
      .then(async () => {
        if (generation !== this.generation) {
          return
        }
        this.fallbackNeedsIndex ||= this.active
        await this.stop()
        if (generation !== this.generation) {
          return
        }
        this.state = 'starting'
        this.updateStatus()
        try {
          if (ext.slangExtensionActive()) {
            this.state = 'external'
            return
          }
          const root = getWorkspaceFolder()
          if (!this.enabled.getValue() || root === undefined) {
            this.state = 'off'
            return
          }
          if ((vscode.workspace.workspaceFolders?.length ?? 0) > 1) {
            throw new Error(
              'Built-in slang-server supports one workspace folder; open this folder separately'
            )
          }
          let command = this.path.getValue()
          if (command === '') {
            const sibling = path.join(
              path.dirname(ext.lint.slang.path.getValue()),
              platform === 'win32' ? 'slang-server.exe' : 'slang-server'
            )
            command =
              (await which('slang-server', { nothrow: true })) ??
              ((await fs.promises.stat(sibling).catch(() => undefined))?.isFile() ? sibling : '')
          }
          if (command === '') {
            this.state = 'unavailable'
            return
          }
          await this.writeConfig(root)
          if (generation !== this.generation) {
            return
          }
          const includeReady = new Promise<void>((resolve) => {
            this.resolveIncludes = resolve
          })
          this.includeReady = includeReady
          const client = new ManagedLanguageClient(
            'verilog-slang-server',
            'Verilog slang-server',
            async () => {
              if (generation !== this.generation) {
                throw new Error('Server start cancelled')
              }
              const child = spawn(command, [], { cwd: root, stdio: 'pipe' })
              this.process = child
              return child
            },
            {
              documentSelector: anyVerilogSelector,
              workspaceFolder: vscode.workspace.workspaceFolders![0],
              middleware: this.middleware(),
              outputChannel: this.serverOutput,
              errorHandler: {
                error: () => ({ action: ErrorAction.Continue }),
                closed: () => ({ action: CloseAction.DoNotRestart }),
              },
            }
          )
          this.client = client
          client.onNotification('slang/includeConfiguration', (config) => {
            if (this.client === client) {
              this.nativeIncludes = config
              this.resolveIncludes?.()
            }
          })
          client.registerFeature({
            fillClientCapabilities: (capabilities) => {
              capabilities.experimental = {
                ...capabilities.experimental,
                inactiveRegions: { inactiveRegions: true },
              }
            },
            initialize: () => {},
            clear: () => {},
            getState: () => ({ kind: 'static' }),
          })
          // LanguageClient 9's diagnostic middleware discards the protocol version.
          // Register through its public notification API to retain that freshness check.
          client.onNotification(PublishDiagnosticsNotification.type, (params) =>
            this.receiveDiagnostics(client, params)
          )
          client.onNotification(
            'textDocument/inactiveRegions',
            (params: {
              uri: string
              version?: number
              regions: {
                start: { line: number; character: number }
                end: { line: number; character: number }
              }[]
            }) => {
              if (this.client === client) {
                ext.inactiveRegions.setNative(
                  params.uri,
                  params.version,
                  params.regions.map((range) => client.protocol2CodeConverter.asRange(range))
                )
              }
            }
          )
          client.onDidChangeState((event) => {
            if (
              event.newState === State.Stopped &&
              this.client === client &&
              !this.stopping &&
              this.active
            ) {
              this.state = 'failed'
              this.client = undefined
              this.sent.clear()
              this.diagnostics.clear()
              this.diagnosticVersions.clear()
              this.rawDiagnostics.clear()
              this.manualVersions.clear()
              this.updateBackend()
              void ext
                .indexFiles()
                .then(() => ext.lint.restart())
                .catch((error) => this.logger.error(String(error)))
            }
          })
          let timer: ReturnType<typeof setTimeout> | undefined
          const cancelled = new Promise<never>((_, reject) => {
            this.cancelStart = () => {
              this.process?.kill('SIGKILL')
              reject(new Error('Server start cancelled'))
            }
            timer = setTimeout(() => {
              this.process?.kill('SIGKILL')
              reject(
                new Error(
                  `slang-server protocol handshake timed out after ${this.startupTimeout.getValue()} seconds; check the server output or increase verilog.server.startupTimeout`
                )
              )
            }, this.startupTimeout.getValue() * 1000)
          })
          try {
            const starting = client.start()
            // A second public start() observes LC9's shared startup promise. LC9 can
            // drop that promise on transport close before the first call returns it.
            void client.start().catch(() => {})
            await Promise.race([starting.then(() => includeReady), cancelled])
          } finally {
            clearTimeout(timer)
            this.cancelStart = undefined
          }
          if (generation !== this.generation) {
            return
          }
          this.state = 'running'
          this.fallbackNeedsIndex = false
          ext.index.releaseGlobalIndex()
          ext.lint.slang.stop()
        } catch (error) {
          if (generation !== this.generation) {
            await this.stop()
            return
          }
          this.state = 'failed'
          this.logger.error(String(error))
          if (generation === this.generation) {
            vscode.window.showWarningMessage(
              `slang-server unavailable; using ctags / slang CLI. ${error}`
            )
          }
          await this.stop()
        } finally {
          if (generation === this.generation) {
            this.updateBackend()
            if (!this.active) {
              if (this.fallbackNeedsIndex) {
                this.fallbackNeedsIndex = false
                await ext.indexFiles()
              }
              ext.lint.restart()
            }
          }
        }
      })
    return this.restarting
  }

  async stop() {
    this.cancelStart?.()
    clearTimeout(this.configChange)
    this.stopping = true
    const client = this.client
    this.client = undefined
    const child = this.process
    this.process = undefined
    if (client) {
      if (!client.isRunning()) {
        child?.kill('SIGKILL')
      }
      await client.dispose(1000).catch(() => {})
    }
    if (child?.exitCode === null) {
      child.kill('SIGKILL')
    }
    this.nativeIncludes = undefined
    this.resolveIncludes?.()
    this.resolveIncludes = undefined
    this.includeReady = undefined
    this.opening.clear()
    this.sent.clear()
    this.diagnostics.clear()
    this.diagnosticVersions.clear()
    this.rawDiagnostics.clear()
    ext.inactiveRegions.clearNative()
    this.manualVersions.clear()
    this.stopping = false
    if (this.pending) {
      this.state = 'off'
    }
  }

  private updateBackend() {
    this.refreshRawDiagnostics()
    this.updateStatus()
    this.publishAll()
    ext.semanticTokens.refresh()
    ext.inactiveRegions.update()
    void vscode.commands.executeCommand(
      'setContext',
      'verilog.slangExtensionActive',
      this.active || ext.slangExtensionActive()
    )
  }

  /// The server watches its config and command files; keep the client and open buffers alive.
  updateConfiguration(): Promise<void> {
    this.restarting = this.restarting
      .catch(() => {})
      .then(async () => {
        const root = getWorkspaceFolder()
        if (this.active && root !== undefined) {
          await this.writeConfig(root)
          this.publishAll()
        }
      })
      .catch((error) => {
        this.logger.error(String(error))
        vscode.window.showWarningMessage(`Could not update slang-server configuration: ${error}`)
      })
    return this.restarting
  }

  /// The native server consumes its own config. Keep generated flags in one owned file and
  /// preserve every existing local setting. Never copy build commands from compiler arguments.
  private async writeConfig(root: string) {
    const dir = path.join(root, '.slang', 'local')
    const configPath = path.join(dir, 'server.json')
    const text = await fs.promises.readFile(configPath, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') {
        return '{}'
      }
      throw error
    })
    const errors: ParseError[] = []
    const config = parse(text, errors, { allowTrailingComma: true })
    if (
      errors.length > 0 ||
      !config ||
      Array.isArray(config) ||
      typeof config !== 'object' ||
      (config.flags !== undefined && typeof config.flags !== 'string')
    ) {
      throw new Error(`Invalid local slang config: ${configPath}`)
    }
    const flags: string[] = []
    // Values have already been expanded by the filelist reader. Single quotes prevent
    // the native command-file parser from expanding literal SV system functions again.
    const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'"
    config.diagnosticWarnings = ext.lint.slang.warnings.arguments().map((flag) => flag.slice(2))
    for (const dir of ext.projectFilelist?.incdirs ?? []) {
      flags.push(quote(`-I${dir}`))
    }
    for (const [name, value] of ext.projectFilelist?.defines ?? []) {
      flags.push(quote(`-D${name}${value === '' ? '' : '=' + value}`))
    }
    if (ext.lint.slang.readingMode.getValue() && !ext.lint.slang.reportMissingModules.getValue()) {
      flags.push('--ignore-unknown-modules')
    }
    const include = '-f .slang/local/verilog-editor.f'
    if (!(config.flags ?? '').includes(include)) {
      config.flags = `${config.flags ?? ''} ${include}`.trim()
    }
    config.indexingThreads = ext.lint.slang.threads.getValue()
    await fs.promises.mkdir(dir, { recursive: true })
    const flagsPath = path.join(dir, 'verilog-editor.f')
    const flagsText = flags.join('\n') + '\n'
    if ((await fs.promises.readFile(flagsPath, 'utf8').catch(() => undefined)) !== flagsText) {
      await fs.promises.writeFile(flagsPath, flagsText)
    }
    let configText = text
    for (const key of ['flags', 'indexingThreads', 'diagnosticWarnings']) {
      configText = applyEdits(
        configText,
        modify(configText, [key], config[key], {
          formattingOptions: { insertSpaces: true, tabSize: 2 },
        })
      )
    }
    if (text !== configText) {
      await fs.promises.writeFile(configPath, configText)
    }
  }

  private async openDocument(doc: vscode.TextDocument) {
    const uri = doc.uri.toString()
    if (this.opening.has(uri)) {
      return this.opening.get(uri)
    }
    const client = this.client
    if (!client || !this.active || this.sent.has(uri)) {
      return
    }
    const pending = client
      .getFeature('textDocument/didOpen')
      .getProvider(doc)!
      .send(doc)
      .finally(() => this.opening.delete(uri))
    this.opening.set(uri, pending)
    return pending
  }

  private middleware(): Middleware {
    return {
      didOpen: async (doc, next) => {
        const client = this.client
        await this.includeReady
        if (
          doc.uri.scheme === 'file' &&
          this.nativeIncludes &&
          this.client === client &&
          !this.stopping
        ) {
          this.sent.add(doc.uri.toString())
          await next(doc)
        }
      },
      didChange: async (event, next) => {
        const doc = event.document
        const uri = doc.uri.toString()
        if (this.sent.has(uri)) {
          await next(event)
        } else {
          await this.openDocument(doc)
        }
      },
      didClose: async (doc, next) => {
        if (this.sent.delete(doc.uri.toString())) {
          await next(doc)
        }
        this.diagnostics.delete(doc.uri.toString())
        this.diagnosticVersions.delete(doc.uri.toString())
        this.rawDiagnostics.delete(doc.uri.toString())
        this.manualVersions.delete(doc.uri.toString())
        ext.inactiveRegions.clearNative(doc.uri.toString())
      },
      didSave: async (doc, next) => {
        if (this.sent.has(doc.uri.toString())) {
          await next(doc)
        } else {
          await this.openDocument(doc)
        }
      },
      provideDocumentLinks: (d, t, n) => (this.owns(d) ? n(d, t) : null),
      provideHover: (d, p, t, n) => (this.owns(d) ? n(d, p, t) : null),
      provideDefinition: (d, p, t, n) => (this.owns(d) ? n(d, p, t) : null),
      provideTypeDefinition: (d, p, t, n) => (this.owns(d) ? n(d, p, t) : null),
      provideImplementation: (d, p, t, n) => (this.owns(d) ? n(d, p, t) : null),
      provideReferences: (d, p, c, t, n) => (this.owns(d) ? n(d, p, c, t) : null),
      provideDocumentHighlights: (d, p, t, n) => (this.owns(d) ? n(d, p, t) : null),
      provideCompletionItem: (d, p, c, t, n) => (this.owns(d) ? n(d, p, c, t) : null),
      provideDocumentSymbols: (d, t, n) => (this.owns(d) ? n(d, t) : null),
      provideCodeActions: (d, r, c, t, n) => (this.owns(d) ? n(d, r, c, t) : null),
      provideCodeLenses: (d, t, n) => (this.owns(d) ? n(d, t) : null),
      provideInlayHints: (d, r, t, n) => (this.owns(d) ? n(d, r, t) : null),
      provideRenameEdits: (d, p, s, t, n) => (this.owns(d) ? n(d, p, s, t) : null),
      prepareRename: (d, p, t, n) => (this.owns(d) ? n(d, p, t) : null),
      prepareCallHierarchy: (d, p, t, n) => (this.owns(d) ? n(d, p, t) : null),
    }
  }

  manualLint() {
    for (const doc of ext.lint.openDocuments()) {
      this.manualVersions.set(doc.uri.toString(), doc.version)
    }
    this.publishAll()
    this.updateStatus()
  }

  refreshRawDiagnostics(uri?: vscode.Uri) {
    this.updateStatus()
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme === 'verilog-diagnostics' && (!uri || doc.uri.query === uri.toString())) {
        this.diagnosticsChanged.fire(doc.uri)
      }
    }
  }

  private async receiveDiagnostics(client: LanguageClient, params: PublishDiagnosticsParams) {
    if (this.client !== client) {
      return
    }
    const doc = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === params.uri)
    if (params.version !== undefined && doc && params.version !== doc.version) {
      return
    }
    this.rawDiagnostics.set(params.uri, params)
    const diagnostics = await client.protocol2CodeConverter.asDiagnostics(params.diagnostics)
    if (
      this.client !== client ||
      this.rawDiagnostics.get(params.uri) !== params ||
      (params.version !== undefined && doc && params.version !== doc.version)
    ) {
      return
    }
    this.diagnostics.set(params.uri, diagnostics)
    this.diagnosticVersions.set(params.uri, params.version)
    this.publish(vscode.Uri.parse(params.uri))
    this.diagnosticsChanged.fire(
      vscode.Uri.from({
        scheme: 'verilog-diagnostics',
        path: '/diagnostics.json',
        query: params.uri,
      })
    )
    this.updateStatus()
  }
  private publishAll() {
    const open = new Map(ext.lint.openDocuments().map((doc) => [doc.uri.toString(), doc]))
    for (const uri of this.diagnostics.keys()) {
      this.publish(vscode.Uri.parse(uri), open.get(uri) ?? null)
    }
  }
  private publish(
    uri: vscode.Uri,
    doc: vscode.TextDocument | null = ext.lint
      .openDocuments()
      .find((doc) => doc.uri.toString() === uri.toString()) ?? null
  ) {
    if (!this.client) {
      return
    }
    const lint = ext.lint.slang
    const allowed =
      doc &&
      this.sent.has(uri.toString()) &&
      this.diagnosticVersions.get(uri.toString()) === doc.version &&
      lint.enabled.getValue() &&
      (this.manualVersions.get(uri.toString()) === doc.version ||
        (lint.runOnSave.getValue() && !doc.isDirty))
    let diagnostics = allowed ? (this.diagnostics.get(uri.toString()) ?? []) : []
    if (lint.readingMode.getValue()) {
      const code = (d: vscode.Diagnostic) => (typeof d.code === 'object' ? d.code.value : d.code)
      const missingCodes = new Set([
        'CouldNotOpenIncludeFile',
        'UnknownDirective',
        'UnknownPackage',
        'UnknownClassOrPackage',
      ])
      const missing = diagnostics.filter((d) => missingCodes.has(String(code(d))))
      if (missing.length > 0) {
        diagnostics = diagnostics.filter(
          (d) =>
            !missing.includes(d) &&
            !/undeclared identifier/i.test(d.message) &&
            (typeof d.code === 'object' ? d.code.value : d.code) !== 'implicit-net'
        )
        const summary = new vscode.Diagnostic(
          missing[0].range,
          'Incomplete dependencies: missing includes, macros or packages. Related undeclared-name diagnostics are hidden in reading mode.',
          vscode.DiagnosticSeverity.Information
        )
        summary.source = 'slang-server'
        summary.code = 'MissingDependencies'
        summary.relatedInformation = missing
          .slice(0, 20)
          .map(
            (d) =>
              new vscode.DiagnosticRelatedInformation(new vscode.Location(uri, d.range), d.message)
          )
        diagnostics.push(summary)
      }
    }
    this.client.diagnostics?.set(uri, lint.filterDiagnostics(diagnostics))
  }

  private updateStatus() {
    if (!this.status) {
      return
    }
    const doc = vscode.window.activeTextEditor?.document
    const unversioned =
      doc &&
      this.rawDiagnostics.has(doc.uri.toString()) &&
      this.diagnosticVersions.get(doc.uri.toString()) === undefined
    const waiting =
      doc &&
      this.owns(doc) &&
      this.manualVersions.get(doc.uri.toString()) === doc.version &&
      this.diagnosticVersions.get(doc.uri.toString()) !== doc.version &&
      !unversioned
    this.status.busy = this.pending || !!waiting
    this.status.severity = unversioned
      ? vscode.LanguageStatusSeverity.Warning
      : vscode.LanguageStatusSeverity.Information
    this.status.text = `Verilog: ${this.active ? (waiting ? 'checking current version' : 'slang-server') : this.state === 'external' ? 'external slang client' : this.pending ? this.state : 'ctags / slang CLI'}`
    this.status.detail = this.active
      ? unversioned
        ? 'This server does not supply diagnostic versions. Problems are hidden because freshness cannot be checked; use the bundled server or Show Raw Diagnostics.'
        : waiting
          ? `Waiting for diagnostics for document version ${doc!.version}.`
          : 'Native shallow analysis; diagnostics match current open .sv/.v versions. Show Raw Diagnostics includes results hidden by reading mode.'
      : this.state === 'external'
        ? 'Built-in server and CLI lint disabled while the external slang extension is installed.'
        : (ext.lint.slang.statusMessage ??
          `Server ${this.state}. Configure verilog.server.path to enable it.`)
  }
}
