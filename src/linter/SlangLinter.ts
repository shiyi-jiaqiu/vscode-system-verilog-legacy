// SPDX-License-Identifier: MIT
import * as child_process from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as vscode from 'vscode'
import { ext } from '../extension'
import { ConfigObject, ExtensionComponent } from '../lib/libconfig'
import { ToolConfig } from '../lib/runner'
import { getWorkspaceFolder, isAnyVerilog } from '../utils'
import { SourceDependencies } from './SourceDependencies'
import { SavedInputs } from './SavedInputs'

/// One entry of `slang --diag-json`; lines and columns count from 1, range ends are exclusive
export interface SlangDiagnostic {
  severity: string
  message: string
  code: string
  optionName?: string
  location?: string
  ranges?: { start: SlangPosition; end: SlangPosition }[]
  notes?: SlangDiagnostic[]
}
interface SlangPosition {
  file: string
  line: number
  column: number
}

/// Codes of the errors that a missing definition causes at each of its uses
const MISSING_CODES = new Set([
  'UnknownDirective',
  'CouldNotOpenIncludeFile',
  'UnknownModule',
  'UnknownInterface',
  'UnknownPackage',
  'UnknownClassOrPackage',
])

/// Whether checks cover the whole project (a filelist or a selected top module) rather than
/// the current file
export function lintsProject(): boolean {
  return (
    ext.lint.slang.scope.getValue() === 'project' &&
    (ext.projectFilelist !== undefined || ext.project.top !== undefined)
  )
}

class SlangWarnings extends ExtensionComponent {
  widthTruncation = new ConfigObject<boolean>({
    default: true,
    description: 'Report expression/port width truncation and lossy constant conversions.',
  })
  widthExpansion = new ConfigObject<boolean>({
    default: false,
    description: 'Report implicit expression/port width expansion.',
  })
  signedness = new ConfigObject<boolean>({
    default: false,
    description:
      'Report implicit signedness conversions and comparisons of differently signed values.',
  })
  portConnections = new ConfigObject<boolean>({
    default: true,
    description: 'Report unconnected ports and explicitly empty input/inout connections.',
  })
  implicitNets = new ConfigObject<boolean>({
    default: true,
    description: 'Report implicitly declared wires, which can indicate misspelled signal names.',
  })
  caseStatements = new ConfigObject<boolean>({
    default: true,
    description:
      'Report missing case defaults, duplicate/overlapping items and incomplete coverage.',
  })
  unused = new ConfigObject<boolean>({
    default: false,
    description: 'Report unused or undriven signals, ports, parameters and other declarations.',
  })

  arguments(): string[] {
    const groups: [ConfigObject<boolean>, string[]][] = [
      [this.widthTruncation, ['width-trunc', 'port-width-trunc', 'constant-conversion']],
      [this.widthExpansion, ['width-expand', 'port-width-expand']],
      [this.signedness, ['sign-conversion', 'sign-compare']],
      [
        this.portConnections,
        [
          'unconnected-port',
          'unconnected-unnamed-port',
          'empty-input-connection',
          'empty-inout-connection',
        ],
      ],
      [this.implicitNets, ['implicit-net']],
      [this.caseStatements, ['case-default', 'case-dup', 'case-overlap', 'case-incomplete']],
      [this.unused, ['unused']],
    ]
    return groups.flatMap(([setting, names]) =>
      names.map((name) => `-W${setting.getValue() ? '' : 'no-'}${name}`)
    )
  }
}

/// Consolidates missing dependency diagnostics without altering compiler input.
export function toDiagnostics(
  entries: SlangDiagnostic[],
  root: string,
  unlocated: string,
  sources: SourceDependencies,
  readingMode: boolean,
  project: boolean,
  inputs: SavedInputs
): Map<string, vscode.Diagnostic[]> {
  const files = new Map<string, vscode.Diagnostic[]>()
  const seen = new Set<string>()
  const firstUse = new Map<string, vscode.Diagnostic>()
  const repeats = new Map<vscode.Diagnostic, number>()
  // end of an unknown macro -> its diagnostic
  const macroEnds = new Map<string, vscode.Diagnostic>()
  const unmapped = new Set<SlangDiagnostic>()
  const filePath = (file: string) => path.resolve(root, file)
  const parse = (entry: SlangDiagnostic): [string, vscode.Range] | undefined => {
    const match = /^(.*):(\d+):(\d+)$/.exec(entry.location ?? '')
    if (match === null) {
      return undefined
    }
    const line = Number(match[2]) - 1
    const file = filePath(match[1])
    const column = inputs.column(file, line, Number(match[3]) - 1)
    if (column === undefined) {
      unmapped.add(entry)
    }

    const ranges = (entry.ranges ?? [])
      .filter((r) => filePath(r.start.file) === file && filePath(r.end.file) === file)
      .flatMap((r) => {
        const start = inputs.column(file, r.start.line - 1, r.start.column - 1)
        const end = inputs.column(file, r.end.line - 1, r.end.column - 1)
        return start === undefined || end === undefined
          ? []
          : [new vscode.Range(r.start.line - 1, start, r.end.line - 1, end)]
      })
    const range = ranges.reduce(
      (all, r) => all.union(r),
      ranges.at(0) ??
        new vscode.Range(line, column ?? 0, line, column === undefined ? 0 : column + 1)
    )
    return [file, range]
  }

  const missingCodes = new Set([
    'CouldNotOpenIncludeFile',
    'UnknownDirective',
    'UnknownPackage',
    'UnknownClassOrPackage',
  ])
  const missingFiles = new Set<string>()
  const missingMacroEnds = new Set<string>()
  if (readingMode) {
    for (const entry of entries) {
      const at = parse(entry)
      if (at !== undefined && missingCodes.has(entry.code)) {
        missingFiles.add(at[0])
        if (entry.code === 'UnknownDirective') {
          missingMacroEnds.add(`${at[0]}:${at[1].end.line}:${at[1].end.character}`)
        }
      }
    }
  }
  const affected = missingFiles.size === 0 ? missingFiles : sources.affectedBy(missingFiles)
  if (!project && missingFiles.size > 0) {
    affected.add(unlocated)
  }
  const incomplete = new Map<
    string,
    {
      range: vscode.Range
      missing: number
      hidden: number
      causes: vscode.DiagnosticRelatedInformation[]
    }
  >()

  for (const entry of entries) {
    const at = parse(entry)
    const [file, range] = at ?? [unlocated, new vscode.Range(0, 0, 0, 0)]
    const missing = readingMode && missingCodes.has(entry.code)
    const dependent =
      affected.has(file) &&
      (entry.code === 'UndeclaredIdentifier' ||
        entry.optionName === 'implicit-net' ||
        (entry.code.startsWith('Expected') &&
          missingMacroEnds.has(`${file}:${range.start.line}:${range.start.character}`)))
    if (missing || dependent) {
      const target = project ? file : unlocated
      let summary = incomplete.get(target)
      if (summary === undefined) {
        summary = {
          range: target === file ? range : new vscode.Range(0, 0, 0, 0),
          missing: 0,
          hidden: 0,
          causes: [],
        }
        incomplete.set(target, summary)
      }
      if (missing) {
        summary.missing++
        if (summary.causes.length < 20) {
          summary.causes.push(
            new vscode.DiagnosticRelatedInformation(
              new vscode.Location(vscode.Uri.file(file), range),
              entry.message
            )
          )
        }
      } else {
        summary.hidden++
      }
      continue
    }
    const key = `${file}:${range.start.line}:${range.start.character}:${entry.code}:${entry.message}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)

    const cascade = macroEnds.get(`${file}:${range.start.line}:${range.start.character}`)
    if (cascade !== undefined && entry.code.startsWith('Expected')) {
      cascade.relatedInformation = (cascade.relatedInformation ?? []).concat(
        new vscode.DiagnosticRelatedInformation(
          new vscode.Location(vscode.Uri.file(file), range),
          entry.message
        )
      )
      continue
    }

    const missingKey = `${file}:${entry.code}:${entry.message}`
    const first = MISSING_CODES.has(entry.code) ? firstUse.get(missingKey) : undefined
    if (first !== undefined) {
      repeats.set(first, (repeats.get(first) ?? 0) + 1)
      first.relatedInformation = (first.relatedInformation ?? []).concat(
        new vscode.DiagnosticRelatedInformation(
          new vscode.Location(vscode.Uri.file(file), range),
          'same error'
        )
      )
      if (entry.code === 'UnknownDirective') {
        macroEnds.set(`${file}:${range.end.line}:${range.end.character}`, first)
      }
      continue
    }

    let message = entry.message
    if (at && unmapped.has(entry)) {
      message += ` [${entry.location}; saved source unavailable, UTF-16 column unknown]`
    }
    if (at === undefined && entry.code === 'TooManyErrors') {
      message =
        'slang stopped at its error limit, so files after this point were not checked. Fix the repeated error, or raise the limit with --error-limit in verilog.lint.slang.args.'
    }
    const severity =
      entry.severity === 'warning'
        ? vscode.DiagnosticSeverity.Warning
        : entry.severity === 'note'
          ? vscode.DiagnosticSeverity.Information
          : vscode.DiagnosticSeverity.Error
    const diag = new vscode.Diagnostic(range, message, severity)
    diag.source = 'slang'
    diag.code = entry.optionName ?? entry.code
    const option = entry.optionName ?? ''
    if (
      option.startsWith('unused-') &&
      !option.startsWith('unused-config') &&
      !option.startsWith('unused-but')
    ) {
      diag.tags = [vscode.DiagnosticTag.Unnecessary]
      if (severity === vscode.DiagnosticSeverity.Warning) {
        diag.severity = vscode.DiagnosticSeverity.Hint
      }
    }
    const notes = (entry.notes ?? []).flatMap((note) => {
      const noteAt = parse(note)
      return noteAt === undefined
        ? []
        : [
            new vscode.DiagnosticRelatedInformation(
              new vscode.Location(vscode.Uri.file(noteAt[0]), noteAt[1]),
              unmapped.has(note)
                ? `${note.message} [${note.location}; UTF-16 column unknown]`
                : note.message
            ),
          ]
    })
    if (notes.length > 0) {
      diag.relatedInformation = notes
    }

    if (MISSING_CODES.has(entry.code)) {
      firstUse.set(missingKey, diag)
    }
    if (entry.code === 'UnknownDirective') {
      macroEnds.set(`${file}:${range.end.line}:${range.end.character}`, diag)
    }
    files.set(file, (files.get(file) ?? []).concat(diag))
  }
  for (const [diag, count] of repeats) {
    diag.message += ` (+${count} more in this file)`
  }
  for (const [file, summary] of incomplete) {
    const diag = new vscode.Diagnostic(
      summary.range,
      `Incomplete dependencies: ${summary.missing + summary.hidden} diagnostic(s) hidden because includes, macros or packages are unavailable. Supply include paths and defines, or turn off verilog.lint.slang.readingMode for strict diagnostics.`,
      vscode.DiagnosticSeverity.Information
    )
    diag.source = 'slang'
    diag.code = 'MissingDependencies'
    diag.relatedInformation = summary.causes
    files.set(file, (files.get(file) ?? []).concat(diag))
  }
  return files
}

export default class SlangLinter extends ToolConfig {
  enabled: ConfigObject<boolean> = new ConfigObject({
    default: true,
    description: 'Enable slang lint diagnostics.',
  })
  scope = new ConfigObject<'openFiles' | 'project'>({
    default: 'openFiles',
    enum: ['openFiles', 'project'],
    enumItemLabels: ['Open files', 'Entire project'],
    description:
      'CLI fallback scope. Open files checks .sv/.v editor tabs with filelist include paths and macros. Entire project checks the filelist or top; without either, checks open files. Built-in slang-server always displays diagnostics only for open source tabs.',
  })
  runOnSave: ConfigObject<boolean> = new ConfigObject({
    default: true,
    description:
      'Check when files open and after saves. When off, only the Verilog: Lint command checks.',
  })
  analysis = new ConfigObject<'local' | 'syntax' | 'full'>({
    default: 'local',
    enum: ['local', 'syntax', 'full'],
    enumItemLabels: ['Local lint', 'Syntax only', 'Full elaboration'],
    description:
      'CLI fallback only. Local lint skips full hierarchy elaboration; syntax skips type checking and most warnings; full checks instance-dependent behavior. Built-in slang-server uses native shallow analysis regardless of this setting.',
  })
  readingMode = new ConfigObject<boolean>({
    default: true,
    description:
      'Group missing includes/macros/packages into an information message and hide dependent undeclared-name errors. Turn off for strict diagnostics, including missing modules. Real name mistakes may also be hidden in files with incomplete dependencies.',
  })
  ignoredDiagnostics = new ConfigObject<string[]>({
    default: [],
    items: { type: 'string' },
    description:
      'Diagnostic codes to hide from Problems in both the built-in server and CLI fallback, such as ExpectedMember, ExpectedDeclarator, NotAllowedInCU, ExpectedExpression, ExpectedIdentifier or unknown-sys-name. Exact, case-sensitive matches. Raw Diagnostics retains the original results; parsing and the compiler error limit are unchanged.',
  })
  threads = new ConfigObject<number>({
    default: 1,
    minimum: 1,
    type: 'integer',
    description:
      'Threads per slang process. One reduces peak resource use. Checks run one process at a time; additional arguments can override this with -j.',
  })
  reportMissingModules = new ConfigObject<boolean>({
    default: false,
    description:
      'Also report unknown modules, interfaces and programs in reading mode. Strict mode always reports them. Local lint does not check the full instance hierarchy.',
  })
  warnings = new SlangWarnings()
  args: ConfigObject<string> = new ConfigObject({
    default: '',
    description:
      'CLI fallback arguments only; native server options belong in .slang/server.json. Examples: `-j 2`, `-Wextra`, `--suppress-warnings ip/**`, `--lint-only`, `--error-limit 100` or `--top name`. Appended after the checkbox options; individual warning flags override warning groups. Do not pass `--diag-json`, which the extension uses to read diagnostics.',
  })

  private diagnostics = vscode.languages.createDiagnosticCollection('slang')
  private raw = new Map<
    string,
    {
      input: 'saved files'
      diagnostics: SlangDiagnostic[]
      status?: string
      version?: number
      completedAt?: string
    }
  >()

  rawDiagnostics(uri: vscode.Uri): unknown {
    return this.raw.get(uri.fsPath) ?? this.raw.get('') ?? { status: 'No CLI result received yet' }
  }

  filterDiagnostics(diagnostics: vscode.Diagnostic[]): vscode.Diagnostic[] {
    const ignored = new Set(this.ignoredDiagnostics.getValue())
    return diagnostics.filter((diagnostic) => {
      const code = typeof diagnostic.code === 'object' ? diagnostic.code.value : diagnostic.code
      return !ignored.has(String(code))
    })
  }
  /// The empty key is the project; other keys are individually checked file paths.
  private runs = new Map<
    string,
    { process?: child_process.ChildProcess; inputs: Set<string>; edited: Set<string> }
  >()
  private checkedInputs = new Map<string, Set<string>>()
  statusMessage: string | undefined
  private queue: Promise<void> = Promise.resolve()

  constructor() {
    super('slang')
  }

  async activate(context: vscode.ExtensionContext): Promise<void> {
    context.subscriptions.push(
      this.diagnostics,
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.contentChanges.length && isAnyVerilog(event.document.languageId)) {
          this.invalidate(event.document.uri.fsPath)
        }
      })
    )
    if (this.enabled.getValue() && !ext.server.enabled.getValue()) {
      await this.path.checkPathNotify()
    }
  }

  private invalidate(file: string) {
    const affected = ext.server.dependencies.affectedBy(new Set([file]))
    affected.add(file)
    for (const [key, run] of this.runs) {
      run.edited.add(file)
      if ([...affected].some((input) => run.inputs.has(input))) {
        run.process?.kill()
        this.runs.delete(key)
      }
    }
    if (this.checkedInputs.get('')?.has(file)) {
      this.diagnostics.clear()
      this.raw.delete('')
    }
    for (const [key, inputs] of this.checkedInputs) {
      if (key && inputs.has(file)) {
        affected.add(key)
      }
    }
    for (const changed of affected) {
      this.diagnostics.delete(vscode.Uri.file(changed))
      this.raw.delete(changed)
    }
    const project = this.raw.get('')
    if (project) {
      const root = getWorkspaceFolder() ?? ''
      const touches = (entry: SlangDiagnostic): boolean => {
        const at = /^(.*):\d+:\d+$/.exec(entry.location ?? '')
        return (
          !!(at && affected.has(path.resolve(root, at[1]))) || (entry.notes ?? []).some(touches)
        )
      }
      project.diagnostics = project.diagnostics.filter((entry) => !touches(entry))
      project.status = 'Changed-file results cleared; other results describe saved inputs'
    }
    this.statusMessage = 'Save changed inputs to refresh CLI diagnostics'
    ext.server.refreshRawDiagnostics()
  }

  /// Stops a running check and drops all diagnostics
  stop() {
    for (const run of this.runs.values()) {
      run.process?.kill()
    }
    this.runs.clear()
    this.checkedInputs.clear()
    this.statusMessage = undefined
    this.diagnostics.clear()
    this.raw.clear()
    ext.server.refreshRawDiagnostics()
  }

  clear(uri: vscode.Uri) {
    this.runs.get(uri.fsPath)?.process?.kill()
    this.runs.delete(uri.fsPath)
    this.diagnostics.delete(uri)
    this.raw.delete(uri.fsPath)
    ext.server.refreshRawDiagnostics(uri)
  }

  async lint(doc: vscode.TextDocument | undefined): Promise<void> {
    const root = getWorkspaceFolder()
    if (
      !this.enabled.getValue() ||
      root === undefined ||
      ext.server.active ||
      ext.server.pending ||
      ext.slangExtensionActive()
    ) {
      return
    }
    const project = lintsProject()
    const filelist = ext.projectFilelist
    const target =
      (project ? ext.project.top?.definition?.doc.uri.fsPath : undefined) ?? doc?.uri.fsPath
    if (!(project && filelist !== undefined) && target === undefined) {
      return
    }
    const key = project ? '' : target!
    this.runs.get(key)?.process?.kill()
    const run: { process?: child_process.ChildProcess; inputs: Set<string>; edited: Set<string> } =
      {
        inputs: new Set(target ? [target] : []),
        edited: new Set(),
      }
    const fail = (reason: string) => this.reportFailure(reason, key)
    let temporary: string | undefined
    this.runs.set(key, run)
    const current = () => this.runs.get(key) === run && this.enabled.getValue()

    const previous = this.queue
    let release!: () => void
    this.queue = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous

    try {
      if (!current()) {
        return
      }
      const sources = ext.server.dependencies
      const cacheDir = ext.index.cacheDir?.fsPath
      const inputFiles = project ? (filelist?.files ?? [target!]) : [target!]
      for (const file of inputFiles) {
        run.inputs.add(file)
      }
      await sources.update(inputFiles, filelist?.incdirs ?? [])
      if (!current()) {
        return
      }
      const paths = new Set(inputFiles.flatMap((file) => [file, ...sources.dependenciesOf(file)]))
      run.inputs = paths
      if (
        vscode.workspace.textDocuments.some((open) => open.isDirty && paths.has(open.uri.fsPath))
      ) {
        this.statusMessage = 'Save changed sources and headers before CLI lint'
        ext.server.refreshRawDiagnostics(project ? undefined : doc?.uri)
        return
      }
      const inputs = new SavedInputs(
        (file) =>
          vscode.workspace.getConfiguration('files', vscode.Uri.file(file)).get('encoding', 'utf8'),
        (file) =>
          vscode.workspace.textDocuments
            .find((doc) => doc.uri.fsPath === file && !doc.isDirty)
            ?.getText()
      )
      await inputs.capture(paths)
      const version = doc?.version
      const extraArgs = this.args.getValue().split(/\s+/).filter(Boolean)
      const analysis = extraArgs.includes('--parse-only')
        ? 'syntax'
        : extraArgs.includes('--lint-only')
          ? 'local'
          : this.analysis.getValue()
      let args =
        analysis === 'syntax'
          ? [
              '--parse-only',
              '--diag-source=false',
              '--diag-column',
              '--diag-location',
              '--color-diagnostics=false',
            ]
          : ['--diag-json', '-', ...(analysis === 'local' ? ['--lint-only'] : [])]
      args.push('-j', String(this.threads.getValue()))
      if (!project) {
        for (const dir of new Set([path.dirname(target!), ...(filelist?.incdirs ?? [])])) {
          args.push('-I', dir)
        }
        for (const [name, value] of filelist?.defines ?? []) {
          args.push(`-D${name}${value === '' ? '' : '=' + value}`)
        }
        args.push(target!)
      } else if (filelist === undefined) {
        args.push('+incdir+' + path.dirname(target!))
        if (cacheDir !== undefined) {
          // links to all module files, so slang finds the modules the target uses
          args.push('-y', cacheDir)
        }
        args.push(target!)
      } else {
        args.push('-f', filelist.path)
      }
      args.push(...this.warnings.arguments())
      if (this.readingMode.getValue() && !this.reportMissingModules.getValue()) {
        args.push('--ignore-unknown-modules')
      }
      args = args.concat(extraArgs.filter((arg) => arg !== '--parse-only' && arg !== '--lint-only'))
      // This protocol option is owned by the extension. Do not let extra args silently
      // change the coordinate unit; unsupported old CLIs fail visibly instead of mislocating.
      args = args.filter(
        (arg, index) =>
          !arg.startsWith('--diag-column-unit=') &&
          arg !== '--diag-column-unit' &&
          args[index - 1] !== '--diag-column-unit'
      )
      temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'verilog-cli-'))
      const dependenciesFile = path.join(temporary, 'dependencies.txt')
      args.push('--diag-column-unit=byte', '--all-deps', dependenciesFile)
      // the check that diagnostics without a place in the code are shown on
      const unlocated = project ? (filelist?.path ?? target!) : target!
      const command = this.path.getValue()
      if (!current()) {
        return
      }
      this.logger.info(`running ${command} ${args.join(' ')}`)
      const stdout = await new Promise<string | undefined>((resolve) => {
        const proc = child_process.execFile(
          command,
          args,
          // a project with many warnings exceeds the default 1 MB, which kills the tool
          { cwd: root, encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 },
          (error, out, err) => {
            if (!current()) {
              resolve(undefined)
              return
            }
            // the array of diagnostics, between the design units and the build summary
            const json = /^\[$[\s\S]*^\]$/m.exec(out)
            // slang exits with 1 when it reports errors; anything else means it did not finish
            if (error !== null && typeof error.code !== 'number') {
              fail(error.signal ? `stopped by ${error.signal}` : error.message.split('\n')[0])
              resolve(undefined)
            } else if (analysis === 'syntax') {
              const parsed: SlangDiagnostic[] = Array.from(
                err.matchAll(/^(.*):(\d+):(\d+): (error|warning|note): (.*)$/gm),
                (match) => {
                  const message = match[5]
                  const macro = /unknown macro or compiler directive '(`\w+)'/.exec(message)
                  const code = macro
                    ? 'UnknownDirective'
                    : /^'.*': No such file or directory$/.test(message)
                      ? 'CouldNotOpenIncludeFile'
                      : message.startsWith('expected ')
                        ? 'ExpectedSyntax'
                        : 'SyntaxDiagnostic'
                  return {
                    location: `${match[1]}:${match[2]}:${match[3]}`,
                    severity: match[4],
                    message,
                    code,
                    ranges: macro
                      ? [
                          {
                            start: {
                              file: match[1],
                              line: Number(match[2]),
                              column: Number(match[3]),
                            },
                            end: {
                              file: match[1],
                              line: Number(match[2]),
                              column: Number(match[3]) + macro[1].length,
                            },
                          },
                        ]
                      : undefined,
                  }
                }
              )
              if (/too many errors emitted/.test(err)) {
                parsed.push({
                  severity: 'error',
                  code: 'TooManyErrors',
                  message: 'slang stopped at its error limit',
                })
              }
              if (error !== null && parsed.length === 0) {
                fail(err.trim().split('\n')[0] || `exit code ${error.code}`)
                resolve(undefined)
              } else {
                resolve(JSON.stringify(parsed))
              }
            } else if (json === null) {
              // such as for an unknown argument
              fail(err.trim().split('\n')[0] || `exit code ${error?.code}`)
              resolve(undefined)
            } else {
              resolve(json[0])
            }
          }
        )
        run.process = proc
      })
      if (stdout === undefined) {
        return
      }
      let entries: SlangDiagnostic[]
      try {
        entries = JSON.parse(stdout)
      } catch (e) {
        fail(`unreadable diagnostics: ${e}`)
        return
      }
      const located = new Set<string>()
      const collect = (entry: SlangDiagnostic) => {
        const at = /^(.*):\d+:\d+$/.exec(entry.location ?? '')
        if (at) {
          located.add(path.resolve(root, at[1]))
        }
        for (const range of entry.ranges ?? []) {
          located.add(path.resolve(root, range.start.file))
          located.add(path.resolve(root, range.end.file))
        }
        for (const note of entry.notes ?? []) {
          collect(note)
        }
      }
      entries.forEach(collect)
      const discovered = (await fs.promises.readFile(dependenciesFile, 'utf8').catch(() => ''))
        .split(/\r?\n/)
        .filter(Boolean)
        .map((file) => path.resolve(root, file))
      // Retain actual compiler inputs for later edits; no source text is loaded here.
      for (const file of [...discovered, ...located]) {
        run.inputs.add(file)
      }
      await inputs.discover(discovered)
      await inputs.load(located)
      const dirty = vscode.workspace.textDocuments.some(
        (open) => open.isDirty && run.inputs.has(open.uri.fsPath)
      )
      const edited = [...run.edited].some((file) => run.inputs.has(file))
      if (!current() || dirty || edited || !(await inputs.unchanged())) {
        if (current()) {
          this.raw.set(key, {
            input: 'saved files',
            diagnostics: [],
            status: 'Input changed during CLI lint; save and run again',
          })
          this.statusMessage = 'Input changed during CLI lint; save and run again'
          for (const open of vscode.workspace.textDocuments) {
            if (open.isDirty && run.inputs.has(open.uri.fsPath)) {
              this.diagnostics.delete(open.uri)
            }
          }
          ext.server.refreshRawDiagnostics(project ? undefined : doc?.uri)
        }
        return
      }
      const files = toDiagnostics(
        entries,
        root,
        unlocated,
        sources,
        this.readingMode.getValue(),
        project,
        inputs
      )
      if (project && filelist === undefined && ext.index.cacheDir !== undefined) {
        // modules found through -y are reported at their links
        for (const [file, diags] of Array.from(files)) {
          if (file.startsWith(ext.index.cacheDir.fsPath)) {
            files.delete(file)
            const real = await fs.promises.realpath(file).catch(() => file)
            files.set(real, (files.get(real) ?? []).concat(diags))
          }
        }
      }
      if (!current()) {
        return
      }
      this.checkedInputs.set(key, new Set(run.inputs))
      this.statusMessage = undefined
      this.raw.set(key, {
        input: 'saved files',
        diagnostics: entries,
        version,
        completedAt: new Date().toISOString(),
      })
      ext.server.refreshRawDiagnostics(project ? undefined : doc?.uri)
      if (project) {
        this.diagnostics.clear()
        for (const [file, diags] of files) {
          this.diagnostics.set(vscode.Uri.file(file), this.filterDiagnostics(diags))
        }
        this.logger.info(`${entries.length} diagnostics in ${files.size} files`)
      } else if (doc !== undefined) {
        const diagnostics = files.get(doc.uri.fsPath) ?? []
        for (const [file, included] of files) {
          if (file !== doc.uri.fsPath) {
            for (const diagnostic of included) {
              const forwarded = new vscode.Diagnostic(
                new vscode.Range(0, 0, 0, 0),
                `${path.relative(root, file)}: ${diagnostic.message}`,
                diagnostic.severity
              )
              forwarded.source = 'slang'
              forwarded.code = diagnostic.code
              forwarded.relatedInformation = [
                new vscode.DiagnosticRelatedInformation(
                  new vscode.Location(vscode.Uri.file(file), diagnostic.range),
                  diagnostic.message
                ),
                ...(diagnostic.relatedInformation ?? []),
              ]
              diagnostics.push(forwarded)
            }
          }
        }
        this.diagnostics.set(doc.uri, this.filterDiagnostics(diagnostics))
      }
    } catch (error) {
      if (current()) {
        fail(String(error))
      }
    } finally {
      if (this.runs.get(key) === run) {
        this.runs.delete(key)
      }
      if (temporary) {
        await fs.promises.rm(temporary, { recursive: true, force: true })
      }
      release()
    }
  }

  /// Clear stale results and make the failed check visible in Raw diagnostics.
  private reportFailure(reason: string, key: string) {
    if (key) {
      this.diagnostics.delete(vscode.Uri.file(key))
    }
    this.statusMessage = `CLI check failed: ${reason}`
    this.raw.set(key, {
      input: 'saved files',
      diagnostics: [],
      status: `CLI check failed: ${reason}`,
    })
    ext.server.refreshRawDiagnostics()
    this.logger.error(`slang did not finish: ${reason}`)
    vscode.window.showErrorMessage(`slang did not finish: ${reason}`)
  }
}
