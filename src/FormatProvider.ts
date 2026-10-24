// SPDX-License-Identifier: MIT
import * as child_process from 'child_process'
import * as vscode from 'vscode'
import { ext } from './extension'
import { ConfigObject } from './lib/libconfig'
import { hasTemplate } from './Template'
import { ToolConfig } from './lib/runner'
import { anyVerilogSelector, getWorkspaceFolder } from './utils'

/// Formats Verilog and SystemVerilog files with verible-verilog-format, which reads the
/// document from stdin. Format on save is VS Code's `editor.formatOnSave`.
export class FormatProvider extends ToolConfig implements vscode.DocumentFormattingEditProvider {
  args: ConfigObject<string> = new ConfigObject({
    default: '',
    description: 'verible-verilog-format arguments, such as `--indentation_spaces=4`',
  })

  constructor() {
    super('verible-verilog-format')
  }

  async activate(context: vscode.ExtensionContext): Promise<void> {
    context.subscriptions.push(
      vscode.languages.registerDocumentFormattingEditProvider(anyVerilogSelector, this)
    )
  }

  async provideDocumentFormattingEdits(
    document: vscode.TextDocument,
    _options: vscode.FormattingOptions,
    token: vscode.CancellationToken
  ): Promise<vscode.TextEdit[]> {
    if (hasTemplate(document.getText()) || ext.server.isSkipped(document)) {
      vscode.window.showInformationMessage('Formatting skipped for unexpanded Perl templates.')
      return []
    }
    const command = this.path.getValue()
    // an empty setting must not become an empty file argument
    const args = this.args.getValue().split(/\s+/).filter(Boolean).concat('-')
    this.logger.info('Executing command: ' + command + ' ' + args.join(' '))
    const formatted = await new Promise<string | undefined>((resolve) => {
      const proc = child_process.execFile(
        command,
        args,
        { cwd: getWorkspaceFolder(), encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (token.isCancellationRequested) {
            this.logger.info('formatting cancelled')
            resolve(undefined)
          } else if (error !== null || stdout.length === 0) {
            const reason = stderr.trim().split('\n')[0] || error?.message.split('\n')[0]
            this.logger.error(`formatting failed: ${reason ?? 'empty output'}`)
            vscode.window.showErrorMessage(`Verilog formatting failed: ${reason ?? 'empty output'}`)
            resolve(undefined)
          } else {
            resolve(stdout)
          }
        }
      )
      token.onCancellationRequested(() => proc.kill())
      proc.stdin?.end(document.getText())
    })
    if (formatted === undefined) {
      return []
    }
    const all = new vscode.Range(
      document.positionAt(0),
      document.lineAt(document.lineCount - 1).range.end
    )
    return [vscode.TextEdit.replace(all, formatted)]
  }
}
