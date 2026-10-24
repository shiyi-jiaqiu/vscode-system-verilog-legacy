// SPDX-License-Identifier: MIT
import * as vscode from 'vscode'
import { ext } from '../extension'
import { CommandNode, ExtensionComponent } from '../lib/libconfig'
import { isAnyVerilog } from '../utils'
import SlangLinter, { lintsProject } from './SlangLinter'

export default class LintManager extends ExtensionComponent {
  slang: SlangLinter = new SlangLinter()

  run: CommandNode = new CommandNode({ title: 'Lint' }, async () => {
    if (!this.slang.enabled.getValue()) {
      vscode.window.showInformationMessage('Linting is off: verilog.lint.slang.enabled')
    } else if (ext.server.active) {
      ext.server.manualLint()
    } else if (ext.server.pending || ext.slangExtensionActive()) {
      return
    } else if (lintsProject()) {
      await this.slang.lint(vscode.window.activeTextEditor?.document)
    } else {
      const docs = this.openDocuments()
      if (docs.length === 0) {
        vscode.window.showInformationMessage('Open a .sv or .v file to lint it')
      }
      await Promise.all(docs.map((doc) => this.slang.lint(doc)))
    }
  })

  private projectLint: NodeJS.Timeout | undefined

  openDocuments(): vscode.TextDocument[] {
    const tabs = new Set(
      vscode.window.tabGroups.all.flatMap((group) =>
        group.tabs.flatMap((tab) =>
          tab.input instanceof vscode.TabInputText ? [tab.input.uri.toString()] : []
        )
      )
    )
    return vscode.workspace.textDocuments.filter(
      (doc) =>
        doc.uri.scheme === 'file' &&
        /\.(sv|v)$/i.test(doc.uri.fsPath) &&
        tabs.has(doc.uri.toString())
    )
  }

  async activate(context: vscode.ExtensionContext): Promise<void> {
    this.logger.info('activating lint manager')
    context.subscriptions.push(
      vscode.window.tabGroups.onDidChangeTabs(async (event) => {
        if (!lintsProject()) {
          const open = this.openDocuments()
          for (const tab of event.closed) {
            const input = tab.input
            if (
              input instanceof vscode.TabInputText &&
              !open.some((doc) => doc.uri.toString() === input.uri.toString())
            ) {
              this.slang.clear(input.uri)
            }
          }
          for (const tab of event.opened) {
            if (
              tab.input instanceof vscode.TabInputText &&
              tab.input.uri.scheme === 'file' &&
              /\.(sv|v)$/i.test(tab.input.uri.fsPath)
            ) {
              const doc = await vscode.workspace.openTextDocument(tab.input.uri)
              if (this.openDocuments().includes(doc)) {
                this.lint(doc)
              }
            }
          }
        }
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor && lintsProject() && this.projectLint === undefined) {
          this.lint(editor.document)
        }
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (lintsProject()) {
          this.lint(doc)
        } else if (isAnyVerilog(doc.languageId)) {
          // Include files may also use .sv/.v. Recheck the source and every open includer once.
          const affected = ext.server.dependencies.affectedBy(new Set([doc.uri.fsPath]))
          for (const source of this.openDocuments().filter((source) =>
            affected.has(source.uri.fsPath)
          )) {
            this.lint(source)
          }
        }
      }),
      this.onConfigUpdated(() => this.restart())
    )
    this.restart()
  }

  restart() {
    clearTimeout(this.projectLint)
    this.projectLint = undefined
    this.slang.stop()
    if (lintsProject()) {
      const doc = vscode.window.activeTextEditor?.document ?? this.openDocuments()[0]
      if (doc !== undefined) {
        this.lint(doc)
      }
    } else {
      for (const doc of this.openDocuments()) {
        this.lint(doc)
      }
    }
  }

  async lint(doc: vscode.TextDocument) {
    // vscode-slang reports diagnostics itself
    if (
      !isAnyVerilog(doc.languageId) ||
      ext.slangExtensionActive() ||
      ext.server.active ||
      ext.server.pending ||
      !this.slang.runOnSave.getValue()
    ) {
      return
    }
    if (lintsProject()) {
      clearTimeout(this.projectLint)
      this.projectLint = setTimeout(() => this.slang.lint(doc), 300)
      return
    }
    await this.slang.lint(doc)
  }
}
