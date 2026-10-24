// SPDX-License-Identifier: MIT
import * as vscode from 'vscode'
import { ext } from '../extension'
import { CommandNode, ExtensionComponent } from '../lib/libconfig'
import { isAnyVerilog } from '../utils'
import SlangLinter, { lintsProject } from './SlangLinter'

export default class LintManager extends ExtensionComponent {
  slang: SlangLinter = new SlangLinter()

  run: CommandNode = new CommandNode({ title: 'Lint' }, async () => {
    const doc = vscode.window.activeTextEditor?.document
    if (!this.slang.enabled.getValue()) {
      vscode.window.showInformationMessage('Linting is off: verilog.lint.slang.enabled')
    } else if (lintsProject() || (doc !== undefined && isAnyVerilog(doc.languageId))) {
      await this.slang.lint(doc)
    } else {
      vscode.window.showInformationMessage('Open a Verilog file to lint it')
    }
  })

  /// pending project check, which checks the whole project at once
  private projectLint: NodeJS.Timeout | undefined

  async activate(context: vscode.ExtensionContext): Promise<void> {
    this.logger.info('activating lint manager')
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        // a project check does not depend on the active file, so only the first editor starts one
        if (editor && (!lintsProject() || this.projectLint === undefined)) {
          this.lint(editor.document)
        }
      })
    )
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(this.lint, this))
    context.subscriptions.push(
      vscode.workspace.onDidCloseTextDocument((doc) => {
        // project diagnostics cover files that are not open, and the index opens and closes many
        if (!lintsProject()) {
          this.slang.clear(doc)
        }
      })
    )
    context.subscriptions.push(this.onConfigUpdated(() => this.restart()))
  }

  /// Drops the results of old settings or an old filelist and checks again, as for a newly
  /// opened file
  restart() {
    clearTimeout(this.projectLint)
    this.projectLint = undefined
    this.slang.stop()
    const editor = vscode.window.activeTextEditor
    if (editor !== undefined) {
      this.lint(editor.document)
    }
  }

  async lint(doc: vscode.TextDocument) {
    // vscode-slang reports diagnostics itself
    if (
      !isAnyVerilog(doc.languageId) ||
      ext.slangExtensionActive() ||
      !this.slang.runOnSave.getValue()
    ) {
      return
    }
    if (lintsProject()) {
      // one check after a burst of saves, such as Save All
      clearTimeout(this.projectLint)
      this.projectLint = setTimeout(() => this.slang.lint(doc), 300)
      return
    }
    await this.slang.lint(doc)
  }
}
