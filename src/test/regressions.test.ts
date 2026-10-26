import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as vscode from 'vscode'
import { evalConst } from '../analysis/ConstValue'
import { readFilelist, resolveInclude } from '../Filelist'
import { SourceDependencies } from '../linter/SourceDependencies'

suite('Review regressions', function () {
  this.timeout(30000)
  let ext: typeof import('../extension').ext
  let dir: string
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension('local.verilog-systemverilog-legacy')!
    await extension.activate()
    ext = require(path.join(extension.extensionPath, 'dist/main.js')).ext
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'verilog-regressions-'))
    await vscode.workspace
      .getConfiguration('verilog')
      .update('lint.slang.runOnSave', false, vscode.ConfigurationTarget.Workspace)
    await vscode.workspace
      .getConfiguration('verilog')
      .update('lint.slang.readingMode', false, vscode.ConfigurationTarget.Workspace)
    await pause(1000)
  })

  suiteTeardown(async () => {
    ext.lint.slang.stop()
    await vscode.workspace.saveAll(false)
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    await fs.promises.rm(dir, { recursive: true, force: true })
  })

  test('large documents retain every module', async () => {
    const file = path.join(dir, 'large.sv')
    await fs.promises.writeFile(
      file,
      Array.from(
        { length: 600 },
        (_, i) =>
          `module m${i};\n${Array.from({ length: 60 }, (_, j) => `logic signal_${j};`).join('\n')}\nendmodule\n`
      ).join('\n')
    )
    const doc = await vscode.workspace.openTextDocument(file)
    const tree = await ext.index.getVerilogDoc(doc).getSymbolTree()
    assert.strictEqual(tree.length, 600)
    assert.strictEqual(tree[599].name, 'm599')
    assert.strictEqual(tree[599].children.length, 60)
  })

  test('nested filelists retain slang path, quote and environment semantics', async () => {
    const lists = path.join(dir, 'lists space')
    const deep = path.join(lists, 'inner')
    await fs.promises.mkdir(deep, { recursive: true })
    const main = path.join(dir, 'nested.f')
    const outer = path.join(lists, 'outer.f')
    const nested = path.join(lists, 'nested.f')
    const inner = path.join(deep, 'deep.f')
    const previous = process.env.VERILOG_TEST_INCLUDE_DIR
    process.env.VERILOG_TEST_INCLUDE_DIR = path.join(dir, 'include space')
    try {
      await fs.promises.writeFile(main, '-F "lists space/outer.f" // comment\n')
      await fs.promises.writeFile(outer, '-f nested.f\n-F inner/deep.f\n')
      await fs.promises.writeFile(
        nested,
        '-I"${VERILOG_TEST_INCLUDE_DIR}"\n+define+LABEL="text // # value"\n"../rtl one.sv"\n'
      )
      await fs.promises.writeFile(inner, '/* comment */ deep.sv\n')
      const result = readFilelist(main, dir)
      assert.deepStrictEqual(result.files, [
        path.join(dir, 'rtl one.sv'),
        path.join(deep, 'deep.sv'),
      ])
      assert.deepStrictEqual(result.incdirs, [process.env.VERILOG_TEST_INCLUDE_DIR])
      assert.strictEqual(result.defines.get('LABEL'), 'text // # value')
      assert.deepStrictEqual(result.commandFiles, [main, outer, nested, inner])
      await fs.promises.appendFile(inner, '-F ../outer.f\n')
      assert.throws(() => readFilelist(main, dir), /Recursive filelist/)
      delete process.env.VERILOG_TEST_INCLUDE_DIR
      assert.throws(() => readFilelist(main, dir), /unset or empty/)
    } finally {
      if (previous === undefined) delete process.env.VERILOG_TEST_INCLUDE_DIR
      else process.env.VERILOG_TEST_INCLUDE_DIR = previous
    }
  })

  test('concurrent semantic requests return the same tokens as serial requests', async () => {
    const pkg = path.join(dir, 'p.sv')
    await fs.promises.writeFile(pkg, 'package p;\nparameter int K=4;\nendpackage\n')
    await ext.index.indexNames([vscode.Uri.file(pkg)])
    const docs: vscode.TextDocument[] = []
    for (const name of ['a', 'b']) {
      const file = path.join(dir, `${name}.sv`)
      await fs.promises.writeFile(
        file,
        `module ${name};\nlocalparam int X=p::K;\nlogic sig;\nassign sig=1'b1;\nendmodule\n`
      )
      docs.push(await vscode.workspace.openTextDocument(file))
    }
    const cancel = new vscode.CancellationTokenSource()
    try {
      const tokens = async (doc: vscode.TextDocument) =>
        Array.from((await ext.semanticTokens.provideDocumentSemanticTokens(doc, cancel.token)).data)
      const serial = [await tokens(docs[0]), await tokens(docs[1])]
      const concurrent = await Promise.all(docs.map(tokens))
      assert.deepStrictEqual(concurrent, serial)
    } finally {
      cancel.dispose()
    }
  })

  test('ordinary names resolve locally even when a header defines a macro of the same name', async () => {
    const header = path.join(dir, 'names.vh')
    const file = path.join(dir, 'names.sv')
    await fs.promises.writeFile(header, '`define WIDTH 99\n')
    await fs.promises.writeFile(
      file,
      'module names;\nlocalparam int WIDTH=3;\nlocalparam int RESULT=WIDTH+1;\nendmodule\n'
    )
    const f = path.join(dir, 'names.f')
    await fs.promises.writeFile(f, `+incdir+${dir}\n${file}\n`)
    ext.projectFilelist = readFilelist(f, dir)
    await ext.index.indexIncludes(true)
    const doc = await vscode.workspace.openTextDocument(file)
    const symbols = await ext.index.findSymbol(doc, new vscode.Position(2, 23))
    assert.strictEqual(symbols[0]?.doc.uri.fsPath, file)
    assert.strictEqual(symbols[0]?.name, 'WIDTH')
    assert.strictEqual(symbols[0]?.isMacro(), false)
  })

  test('saved headers replace removed macro completions', async () => {
    const header = path.join(dir, 'names.vh')
    const editor = await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(header)
    )
    await editor.edit((edit) =>
      edit.replace(new vscode.Range(0, 0, editor.document.lineCount, 0), '`define NEW_WIDTH 3\n')
    )
    await editor.document.save()
    await pause(1000)
    assert.ok(ext.index.headerMacros.has('NEW_WIDTH'))
    assert.ok(!ext.index.headerMacros.has('WIDTH'))
  })

  test('changing the filelist setting replaces the indexed units', async () => {
    const file = path.join(dir, 'replacement.sv')
    const f = path.join(dir, 'replacement.f')
    await fs.promises.writeFile(file, 'module replacement_unit;\nendmodule\n')
    await fs.promises.writeFile(f, `${file}\n`)
    await vscode.workspace
      .getConfiguration('verilog')
      .update('filelist', f, vscode.ConfigurationTarget.Workspace)
    await pause(1500)
    assert.ok(ext.index.moduleMap.has('replacement_unit'))
    assert.ok(!ext.index.moduleMap.has('p'))
  })

  test('deleted and shadowed includes update the dependency graph', async () => {
    const root = path.join(dir, 'mirror-input')
    const include = path.join(root, 'inc')
    await fs.promises.mkdir(include, { recursive: true })
    const file = path.join(root, 'top.sv')
    const local = path.join(root, 'defs.svh')
    const other = path.join(include, 'defs.svh')
    await fs.promises.writeFile(file, '`include "defs.svh"\nmodule top; endmodule\n')
    await fs.promises.writeFile(local, '`define VALUE 1\n')
    await fs.promises.writeFile(other, '`define VALUE 2\n')
    const sources = new SourceDependencies()
    await sources.update([file], [include])
    assert.deepStrictEqual([...sources.dependenciesOf(file)], [local])
    await fs.promises.unlink(local)
    await sources.update([file], [include])
    assert.deepStrictEqual([...sources.dependenciesOf(file)], [other])
    assert.ok(!sources.affectedBy(new Set([local])).has(file))
    await fs.promises.unlink(other)
    await sources.update([file], [include])
    assert.strictEqual(sources.dependenciesOf(file).size, 0)
  })

  test('include navigation selects the includer directory before incdir', async () => {
    const root = path.join(dir, 'include-input')
    const include = path.join(root, 'inc')
    await fs.promises.mkdir(include, { recursive: true })
    await fs.promises.writeFile(path.join(root, 'defs.svh'), '`define WIDTH 1\n')
    await fs.promises.writeFile(path.join(include, 'defs.svh'), '`define WIDTH 2\n')
    const f = path.join(root, 'hdl.f')
    await fs.promises.writeFile(f, `+incdir+${include}\n`)
    assert.strictEqual(
      await resolveInclude(path.join(root, 'top.sv'), 'defs.svh', readFilelist(f, root)),
      path.join(root, 'defs.svh')
    )
  })

  test('width dependent expressions never display an unbounded integer result', () => {
    for (const expr of ["8'shff", "~8'h00", "4'h1f"]) {
      assert.strictEqual(evalConst(expr), undefined, expr)
    }
    assert.strictEqual(evalConst('(8 + 2) * 4'), 40n)
  })

  test('unexpanded markup receives ordinary CLI syntax diagnostics', async () => {
    await vscode.workspace
      .getConfiguration('verilog')
      .update('lint.slang.analysis', 'full', vscode.ConfigurationTarget.Workspace)
    await pause(100)
    ext.projectFilelist = undefined
    const file = path.join(dir, 'inline.sv')
    await fs.promises.writeFile(
      file,
      [
        'module child(input logic foo); endmodule',
        'module inline_template;',
        'logic a;',
        'child u(.foo_<pl>$i</pl>(a));',
        '<perl>if ($enabled) {</perl>',
        'wire generated_signal;',
        'generated code that is not Verilog',
        '<perl>}</perl>',
        'assign generated_signal = a;',
        'logic outside = ;',
        'endmodule',
      ].join('\n')
    )
    const doc = await vscode.workspace.openTextDocument(file)
    await ext.lint.slang.lint(doc)
    const diagnostics = vscode.languages.getDiagnostics(doc.uri)
    assert.ok(
      diagnostics.some((diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error)
    )
  })

  test('disabling single-file lint discards a running check', async () => {
    await vscode.workspace
      .getConfiguration('verilog')
      .update('filelist', '', vscode.ConfigurationTarget.Workspace)
    const file = path.join(dir, 'single.sv')
    await fs.promises.writeFile(file, 'module single;\nlocalparam int A=`MISSING;\nendmodule\n')
    const doc = await vscode.workspace.openTextDocument(file)
    const marker = path.join(dir, 'started')
    const tool = path.join(dir, 'slow-slang')
    await fs.promises.writeFile(
      tool,
      `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(marker)}, '');\nsetTimeout(() => process.stdout.write('[\\n{"severity":"error","code":"UnknownDirective","message":"missing macro","location":'+JSON.stringify(${JSON.stringify(file)}+':2:18')+'}\\n]\\n'), 700);\n`,
      { mode: 0o755 }
    )
    await vscode.workspace
      .getConfiguration('verilog')
      .update('lint.slang.path', tool, vscode.ConfigurationTarget.Workspace)
    await pause(100) // let configuration restart finish before starting the check under test
    const running = ext.lint.slang.lint(doc)
    for (let i = 0; i < 100 && !fs.existsSync(marker); i++) {
      await pause(20)
    }
    assert.ok(fs.existsSync(marker), 'the check must have started before it is disabled')
    await vscode.workspace
      .getConfiguration('verilog')
      .update('lint.slang.enabled', false, vscode.ConfigurationTarget.Workspace)
    await running
    assert.deepStrictEqual(vscode.languages.getDiagnostics(doc.uri), [])
  })

  test('saving an included .sv file rechecks its open source in CLI mode', async () => {
    await vscode.workspace
      .getConfiguration('verilog')
      .update('lint.slang.enabled', true, vscode.ConfigurationTarget.Workspace)
    await vscode.workspace
      .getConfiguration('verilog')
      .update('lint.slang.path', 'slang', vscode.ConfigurationTarget.Workspace)
    await vscode.workspace
      .getConfiguration('verilog')
      .update('lint.slang.runOnSave', true, vscode.ConfigurationTarget.Workspace)
    const include = path.join(dir, 'included.sv')
    const file = path.join(dir, 'includer.sv')
    await fs.promises.writeFile(include, '`define VALUE 1\n')
    await fs.promises.writeFile(
      file,
      '`include "included.sv"\nmodule includer; localparam int X=`VALUE; endmodule\n'
    )
    const source = await vscode.workspace.openTextDocument(file)
    await vscode.window.showTextDocument(source, { preview: false })
    await ext.lint.slang.lint(source)
    assert.deepStrictEqual(vscode.languages.getDiagnostics(source.uri), [])
    const header = await vscode.workspace.openTextDocument(include)
    const edit = new vscode.WorkspaceEdit()
    edit.replace(header.uri, new vscode.Range(0, 0, header.lineCount, 0), '`define VALUE MISSING\n')
    await vscode.workspace.applyEdit(edit)
    await header.save()
    for (let i = 0; i < 50 && vscode.languages.getDiagnostics(source.uri).length === 0; i++) {
      await pause(100)
    }
    assert.ok(
      vscode.languages
        .getDiagnostics(source.uri)
        .some((diagnostic) => diagnostic.message.includes('MISSING')),
      'the includer must be checked against the saved header'
    )
    await vscode.workspace
      .getConfiguration('verilog')
      .update('lint.slang.runOnSave', false, vscode.ConfigurationTarget.Workspace)
  })
})
