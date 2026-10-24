// SPDX-License-Identifier: MIT
import * as child_process from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import * as vscode from 'vscode'
import { ext } from '../extension'
import { ConfigObject } from '../lib/libconfig'
import { ToolConfig } from '../lib/runner'
import { getWorkspaceFolder } from '../utils'

/// One entry of `slang --diag-json`; lines and columns count from 1, range ends are exclusive
interface SlangDiagnostic {
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
  return ext.projectFilelist !== undefined || ext.project.top !== undefined
}

/// Diagnostics by file path, from `slang --diag-json` output. Repeats at the same place (a
/// header read by each file that includes it) are dropped. Each missing definition is reported
/// at its first use in a file, with the other uses as related locations, and the parse error
/// right where the text of an unknown macro was expected goes with that macro.
function toDiagnostics(
  entries: SlangDiagnostic[],
  root: string,
  unlocated: string
): Map<string, vscode.Diagnostic[]> {
  const files = new Map<string, vscode.Diagnostic[]>()
  const seen = new Set<string>()
  const firstUse = new Map<string, vscode.Diagnostic>()
  const repeats = new Map<vscode.Diagnostic, number>()
  // end of an unknown macro -> its diagnostic
  const macroEnds = new Map<string, vscode.Diagnostic>()
  const filePath = (file: string) => path.resolve(root, file)
  const parse = (entry: SlangDiagnostic): [string, vscode.Range] | undefined => {
    const match = /^(.*):(\d+):(\d+)$/.exec(entry.location ?? '')
    if (match === null) {
      return undefined
    }
    const line = Number(match[2]) - 1
    const column = Number(match[3]) - 1
    const ranges = (entry.ranges ?? [])
      .filter((r) => r.start.file === match[1] && r.end.file === match[1])
      .map(
        (r) =>
          new vscode.Range(r.start.line - 1, r.start.column - 1, r.end.line - 1, r.end.column - 1)
      )
    const range = ranges.reduce(
      (all, r) => all.union(r),
      ranges.at(0) ?? new vscode.Range(line, column, line, column + 1)
    )
    return [filePath(match[1]), range]
  }

  for (const entry of entries) {
    const at = parse(entry)
    const [file, range] = at ?? [unlocated, new vscode.Range(0, 0, 0, 0)]
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
              note.message
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
  return files
}

export default class SlangLinter extends ToolConfig {
  enabled: ConfigObject<boolean> = new ConfigObject({
    default: true,
    description:
      'Check with slang: the whole project when `verilog.filelist` is set or a top module is selected, otherwise the current file',
  })
  runOnSave: ConfigObject<boolean> = new ConfigObject({
    default: true,
    description:
      'Check when the first Verilog file opens and after saves. When off, only the Verilog: Lint command checks.',
  })
  args: ConfigObject<string> = new ConfigObject({
    default: '',
    description:
      'slang arguments, such as `-j 2`, `-Wextra`, `-Wwidth-trunc -Wport-width-trunc`, `--suppress-warnings ip/**`, `--lint-only`, `--error-limit 100` or `--top name`. The extension reads the diagnostics with `--diag-json`, so do not pass that.',
  })

  private diagnostics = vscode.languages.createDiagnosticCollection('slang')
  /// the running project check; a newer check stops it
  private projectRun: child_process.ChildProcess | undefined
  /// counts project checks, so an older one never publishes over a newer one
  private generation = 0

  constructor() {
    super('slang')
  }

  async activate(context: vscode.ExtensionContext): Promise<void> {
    context.subscriptions.push(this.diagnostics)
    if (this.enabled.getValue()) {
      await this.path.checkPathNotify()
    }
  }

  /// Stops a running check and drops all diagnostics
  stop() {
    this.generation++
    this.projectRun?.kill()
    this.projectRun = undefined
    this.diagnostics.clear()
  }

  clear(doc: vscode.TextDocument) {
    this.diagnostics.delete(doc.uri)
  }

  async lint(doc: vscode.TextDocument | undefined): Promise<void> {
    const root = getWorkspaceFolder()
    if (!this.enabled.getValue() || root === undefined) {
      return
    }
    const project = lintsProject()
    const filelist = ext.projectFilelist
    const target = ext.project.top?.definition?.doc.uri ?? doc?.uri
    let args = ['--diag-json', '-']
    if (filelist !== undefined) {
      args.push('-f', filelist.path)
    } else if (target !== undefined) {
      args.push('+incdir+' + path.dirname(target.fsPath))
      if (ext.index.cacheDir !== undefined) {
        // links to all module files, so slang finds the modules the target uses
        args.push('-y', ext.index.cacheDir.fsPath)
      }
      args.push(target.fsPath)
    } else {
      return
    }
    args = args.concat(this.args.getValue().split(/\s+/).filter(Boolean))
    // the check that diagnostics without a place in the code are shown on
    const unlocated = filelist?.path ?? target!.fsPath

    let generation = 0
    if (project) {
      this.projectRun?.kill()
      generation = ++this.generation
    }
    const command = this.path.getValue()
    this.logger.info(`running ${command} ${args.join(' ')}`)
    const stdout = await new Promise<string | undefined>((resolve) => {
      const proc = child_process.execFile(
        command,
        args,
        // a project with many warnings exceeds the default 1 MB, which kills the tool
        { cwd: root, encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 },
        (error, out, err) => {
          if (project && generation !== this.generation) {
            resolve(undefined)
            return
          }
          // the array of diagnostics, between the design units and the build summary
          const json = /^\[$[\s\S]*^\]$/m.exec(out)
          // slang exits with 1 when it reports errors; anything else means it did not finish
          if (error !== null && typeof error.code !== 'number') {
            this.reportFailure(
              error.signal ? `stopped by ${error.signal}` : error.message.split('\n')[0]
            )
            resolve(undefined)
          } else if (json === null) {
            // such as for an unknown argument
            this.reportFailure(err.trim().split('\n')[0] || `exit code ${error?.code}`)
            resolve(undefined)
          } else {
            resolve(json[0])
          }
        }
      )
      if (project) {
        this.projectRun = proc
      }
    })
    if (stdout === undefined) {
      return
    }
    let entries: SlangDiagnostic[]
    try {
      entries = JSON.parse(stdout)
    } catch (e) {
      this.reportFailure(`unreadable diagnostics: ${e}`)
      return
    }
    const files = toDiagnostics(entries, root, unlocated)
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
    if (project) {
      if (generation !== this.generation || !this.enabled.getValue()) {
        return
      }
      this.diagnostics.clear()
      for (const [file, diags] of files) {
        this.diagnostics.set(vscode.Uri.file(file), diags)
      }
      this.logger.info(`${entries.length} diagnostics in ${files.size} files`)
    } else if (doc !== undefined) {
      // other files are reported as this file sees them, which may be wrong
      this.diagnostics.set(doc.uri, files.get(doc.uri.fsPath) ?? [])
    }
  }

  /// Keeps the diagnostics of the last finished check
  private reportFailure(reason: string) {
    this.logger.error(`slang did not finish: ${reason}`)
    vscode.window.showErrorMessage(`slang did not finish: ${reason}`)
  }
}
