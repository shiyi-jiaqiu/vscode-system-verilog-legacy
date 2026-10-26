// SPDX-License-Identifier: MIT
import * as assert from 'assert'
import * as vscode from 'vscode'

suite('Extension activation', () => {
  test('loads the manifest bundle from the development extension', async () => {
    const extension = vscode.extensions.getExtension('local.verilog-systemverilog-legacy')!
    await extension.activate()
    assert.ok(extension.isActive)
    assert.strictEqual(vscode.version, '1.84.2')
    assert.strictEqual(
      vscode.workspace.getConfiguration('verilog').get('lint.slang.runOnSave'),
      true
    )
    assert.strictEqual(
      vscode.workspace.getConfiguration('verilog').get('lint.slang.readingMode'),
      true
    )
    assert.ok((await vscode.commands.getCommands()).includes('verilog.lint.run'))
    console.log(`Verified extension ${extension.extensionPath} @ ${extension.packageJSON.version}`)
  })
})
