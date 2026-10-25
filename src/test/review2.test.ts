// SPDX-License-Identifier: MIT
import * as assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'
import * as vscode from 'vscode'
import { SavedInputs } from '../linter/SavedInputs'
import { toDiagnostics } from '../linter/SlangLinter'
import { SourceDependencies } from '../linter/SourceDependencies'

suite('Follow-up review regressions', function () {
  this.timeout(60000)
  let ext: typeof import('../extension').ext
  let dir: string
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (condition: () => boolean, message: string) => {
    const start = Date.now()
    while (!condition()) {
      assert.ok(Date.now() - start < 10000, message)
      await pause(40)
    }
  }
  const setting = async (key: string, value: unknown) => {
    await vscode.workspace
      .getConfiguration('verilog')
      .update(key, value, vscode.ConfigurationTarget.Workspace)
    await pause(250)
  }
  async function open(name: string, text: string) {
    const file = path.join(dir, name)
    await fs.promises.mkdir(path.dirname(file), { recursive: true })
    await fs.promises.writeFile(file, text)
    return vscode.workspace.openTextDocument(file)
  }
  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension('local.verilog-systemverilog-legacy')!
    await extension.activate()
    ext = require(path.join(extension.extensionPath, 'dist/main.js')).ext
    dir = await fs.promises.mkdtemp(
      path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, 'followup-')
    )
    await setting('server.enabled', false)
    await setting('filelist', '')
    await setting('lint.slang.runOnSave', true)
    await setting('lint.slang.readingMode', true)
  })
  suiteTeardown(async () => {
    ext.lint.slang.stop()
    await vscode.workspace.saveAll(false)
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    await fs.promises.rm(dir, { recursive: true, force: true })
  })

  test('N1: block-rich symbol rebuilding remains bounded', async () => {
    const times: number[] = []
    for (const blocks of [5000, 20000]) {
      const doc = await open(
        `blocks-${blocks}.sv`,
        'module blocks;\n' +
          Array.from(
            { length: blocks },
            (_, n) => `always_comb begin : b${n}\nlogic x${n};\nx${n}=0;\nend\n`
          ).join('') +
          'endmodule\n'
      )
      const vdoc = ext.index.getVerilogDoc(doc)
      const tags = await vdoc.execCtags()
      const start = process.hrtime.bigint()
      await vdoc.buildSymbolsList(tags)
      const elapsed = Number(process.hrtime.bigint() - start) / 1e6
      times.push(elapsed)
      assert.ok(vdoc.symbols.length >= blocks)
      console.log(
        `PERF blocks=${blocks} buildSymbolsList=${elapsed.toFixed(1)}ms symbols=${vdoc.symbols.length}`
      )
    }
    assert.ok(times[1] < 2000, `80k-line symbol rebuilding blocked the host for ${times[1]} ms`)
    assert.ok(times[1] < times[0] * 7 + 100, `superlinear growth: ${times}`)
  })

  test('hover golden: declaration, evaluated value, link and related parameter', async () => {
    const doc = await open(
      'golden.sv',
      'module golden;\n// FIFO depth\nparameter int DEPTH=16;\nlocalparam int SIZE=DEPTH*2;\nendmodule\n'
    )
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      doc.uri,
      new vscode.Position(3, 16)
    )
    const actual = (hovers ?? []).flatMap((hover) =>
      hover.contents.map((content) =>
        (typeof content === 'string' ? content : 'value' in content ? content.value : '')
          .split(doc.uri.toString())
          .join('<uri>')
          .split(vscode.workspace.asRelativePath(doc.uri))
          .join('<source>')
      )
    )
    assert.ok(actual.length, 'hover must not be empty')
    const golden = path.resolve(__dirname, '../../../src/test/golden/review-hover.json')
    assert.deepStrictEqual(actual, JSON.parse(await fs.promises.readFile(golden, 'utf8')))
  })

  test('N5: enum literals are package members and multiline function ports remain visible', async () => {
    const pkg = await open(
      'enum.sv',
      'package p;\ntypedef enum {IDLE, BUSY} state_t;\nendpackage\n'
    )
    await ext.index.indexNames([pkg.uri])
    const doc = await open(
      'enum-user.sv',
      'module enum_user;\nimport p::*;\ninitial $display(IDLE, p::BUSY);\nfunction automatic\nint calc(int a);\nreturn a;\nendfunction\nendmodule\n'
    )
    const names = async (line: number, column: number) =>
      (await ext.index.findSymbol(doc, new vscode.Position(line, column))).map((sym) => sym.name)
    assert.deepStrictEqual(await names(2, 19), ['IDLE'])
    assert.deepStrictEqual(await names(2, 28), ['BUSY'])
    assert.deepStrictEqual(await names(5, 7), ['a'])
    const completion = await open(
      'enum-completion.sv',
      'module enum_completion;\ninitial $display(p::);\nendmodule\n'
    )
    const items = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      completion.uri,
      completion.positionAt(completion.getText().indexOf('p::') + 3),
      ':'
    )
    const labels =
      items?.items.map((item) =>
        typeof item.label === 'string' ? item.label : item.label.label
      ) ?? []
    assert.ok(labels.includes('IDLE') && labels.includes('BUSY'))
  })

  test('N4: include-local macros win and unrelated indexed macros remain discoverable', async () => {
    const global = await open('defines/shared.vh', '`define SHARED 7\n`define CHOICE 99\n')
    await ext.index.indexNames([global.uri])
    await open('defs.svh', '`define CHOICE 8\n')
    const doc = await open(
      'macros.sv',
      '`include "defs.svh"\nmodule macro_user; localparam A=`CHOICE, B=`SHARED; endmodule\n'
    )
    assert.deepStrictEqual(
      (await ext.index.findMacro(doc, 'CHOICE')).map((sym) => sym.doc.fileName),
      [path.join(dir, 'defs.svh')]
    )
    assert.deepStrictEqual(
      (await ext.index.findMacro(doc, 'SHARED')).map((sym) => sym.doc.fileName),
      [global.fileName]
    )
    const items = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      doc.uri,
      doc.positionAt(doc.getText().indexOf('`SHARED') + 1),
      '`'
    )
    assert.ok(items?.items.some((item) => item.label === '`SHARED'))
  })

  test('N3: editing an unrelated buffer preserves saved errors in other files', async () => {
    await setting('lint.slang.scope', 'openFiles')
    await setting('lint.slang.path', process.env.SLANG_PATH!)
    const bad = await open('errors.sv', 'module errors;\ninitial $display(missing);\nendmodule\n')
    await ext.lint.slang.lint(bad)
    const before = vscode.languages.getDiagnostics(bad.uri)
    assert.ok(before.some((diag) => diag.message.includes('missing')))
    const draft = await open('unrelated.sv', 'module draft; endmodule\n')
    const edit = new vscode.WorkspaceEdit()
    edit.insert(draft.uri, new vscode.Position(0, 0), '// typing\n')
    assert.ok(await vscode.workspace.applyEdit(edit))
    await pause(100)
    assert.deepStrictEqual(vscode.languages.getDiagnostics(bad.uri), before)
    const fix = new vscode.WorkspaceEdit()
    fix.replace(bad.uri, new vscode.Range(1, 17, 1, 24), '1')
    assert.ok(await vscode.workspace.applyEdit(fix))
    await pause(100)
    assert.deepStrictEqual(vscode.languages.getDiagnostics(bad.uri), [])
    await draft.save()
    await bad.save()
  })

  test('N6/N7: compiler-discovered includes keep their file and byte-derived range', async () => {
    const header = await open('extra/only-args.svh', '// header\nlocalparam int VALUE=missing;\n')
    const doc = await open(
      'extra-user.sv',
      'module extra_user;\n`include "only-args.svh"\nendmodule\n'
    )
    await setting('lint.slang.args', `-I ${path.dirname(header.fileName)}`)
    await ext.lint.slang.lint(doc)
    const notes = vscode.languages
      .getDiagnostics(doc.uri)
      .flatMap((diag) => diag.relatedInformation ?? [])
    const at = notes.find(
      (note) => note.location.uri.fsPath === header.fileName && note.message.includes('missing')
    )
    assert.ok(at, JSON.stringify(vscode.languages.getDiagnostics(doc.uri)))
    assert.strictEqual(at.location.range.start.line, 1)
    assert.strictEqual(header.getText(at.location.range), 'missing')
    await setting('lint.slang.args', '')
  })

  test('N6/N7/N12: lazy snapshots tolerate missing inputs and decode original invalid UTF-8 bytes', async () => {
    const file = path.join(dir, 'bytes.sv')
    const bytes = Buffer.from([47, 42, 233, 42, 47, 32, 109, 105, 115, 115, 105, 110, 103])
    await fs.promises.writeFile(file, bytes)
    const inputs = new SavedInputs()
    await inputs.capture([file, path.join(dir, 'missing.sv')])
    assert.strictEqual(inputs.has(file), false, 'metadata capture must not read source contents')
    await inputs.load([file])
    assert.strictEqual(inputs.column(file, 0, 6), 6)
    assert.strictEqual(await inputs.unchanged(), true)
    const absent = path.join(dir, 'unavailable-lib.v')
    const diagnostics = toDiagnostics(
      [
        {
          location: `${absent}:2:10`,
          severity: 'warning',
          code: 'Example',
          message: 'library error',
        },
      ],
      dir,
      file,
      new SourceDependencies(),
      false,
      true,
      inputs
    )
    assert.strictEqual(diagnostics.get(absent)![0].range.start.line, 1)
    assert.match(diagnostics.get(absent)![0].message, /unavailable-lib.v:2:10/)
    const gbk = path.join(dir, 'gbk.sv')
    await fs.promises.writeFile(gbk, Buffer.from([47, 42, 0xd6, 0xd0, 42, 47, 32, 120]))
    const encoded = new SavedInputs(() => 'gbk')
    await encoded.capture([gbk])
    await encoded.load([gbk])
    assert.strictEqual(encoded.column(gbk, 0, 7), 6)
  })

  test('N3/N6: project libraries and macro includes use compiler dependencies, not unrelated dirty drafts', async () => {
    const cell = await open(
      'lib/libcell.v',
      'module libcell;\ninitial $display(missing);\nendmodule\n'
    )
    const top = await open('library_top.sv', 'module library_top; libcell c(); endmodule\n')
    const list = path.join(dir, 'library.f')
    await fs.promises.writeFile(
      list,
      `${top.fileName}\n-y ${path.dirname(cell.fileName)}\n+libext+.v\n`
    )
    const draft = await open('dirty-draft.sv', 'module draft_unused; endmodule\n')
    const edit = new vscode.WorkspaceEdit()
    edit.insert(draft.uri, new vscode.Position(0, 0), '// draft\n')
    await vscode.workspace.applyEdit(edit)
    try {
      await setting('filelist', list)
      await setting('lint.slang.scope', 'project')
      await setting('lint.slang.analysis', 'full')
      await ext.lint.slang.lint(top)
      const found = vscode.languages
        .getDiagnostics(cell.uri)
        .find((diag) => diag.message.includes('missing'))
      assert.ok(found, JSON.stringify(ext.lint.slang.rawDiagnostics(top.uri)))
      assert.strictEqual(found.range.start.line, 1)
      assert.strictEqual(cell.getText(found.range), 'missing')
      await setting('filelist', '')
      await setting('lint.slang.scope', 'openFiles')
      await setting('lint.slang.analysis', 'local')
      const header = await open('macro-inc/hidden.svh', 'localparam int VALUE=missing;\n')
      const macro = await open(
        'macro-include.sv',
        '`define HEADER "hidden.svh"\nmodule macro_include;\n`include `HEADER\nendmodule\n'
      )
      await setting('lint.slang.args', `-I ${path.dirname(header.fileName)}`)
      await ext.lint.slang.lint(macro)
      const notes = vscode.languages
        .getDiagnostics(macro.uri)
        .flatMap((diag) => diag.relatedInformation ?? [])
      const location = notes.find(
        (note) => note.location.uri.fsPath === header.fileName && note.message.includes('missing')
      )
      assert.ok(location)
      assert.strictEqual(header.getText(location.location.range), 'missing')
    } finally {
      await setting('filelist', '')
      await setting('lint.slang.scope', 'openFiles')
      await setting('lint.slang.analysis', 'local')
      await setting('lint.slang.args', '')
      await draft.save()
    }
  })

  test('N16: concurrent import queries share resolution and unresolved imports retry on index changes', async () => {
    const pkg = await open(
      'not-yet-indexed.sv',
      'package absent_pkg; parameter int APPEARED=9; endpackage\n'
    )
    const doc = await open('imports.sv', 'module imports;\nimport absent_pkg::*;\nendmodule\n')
    await pause(350) // Settle fixture creation; the tested transition below is index publication.
    ext.index.moduleMap.delete('absent_pkg')
    const vdoc = ext.index.getVerilogDoc(doc)
    const find = ext.index.findFile.bind(ext.index)
    let calls = 0
    ext.index.findFile = async (name: string) => {
      if (name === 'absent_pkg') {
        calls++
        await pause(40)
      }
      return find(name)
    }
    try {
      await Promise.all(Array.from({ length: 8 }, () => vdoc.getSymbols()))
      await vdoc.getSymbols()
      assert.strictEqual(calls, 1)
      await ext.index.indexNames([pkg.uri])
      const results = await Promise.all(Array.from({ length: 8 }, () => vdoc.getSymbols()))
      assert.ok(results.every((symbols) => symbols.some((sym) => sym.name === 'APPEARED')))
      assert.strictEqual(calls, 2)
    } finally {
      ext.index.findFile = find
    }
  })

  test('N11/N17: superseded starts do not rebuild fallback and timeout is configurable', async () => {
    const fake = path.join(dir, 'handshake-server')
    const stuck = path.join(dir, 'stuck-server')
    await fs.promises.writeFile(
      fake,
      `#!/usr/bin/env node
let data=Buffer.alloc(0);
const send=m=>{const body=Buffer.from(JSON.stringify({jsonrpc:'2.0',...m}));process.stdout.write('Content-Length: '+body.length+'\\r\\n\\r\\n');process.stdout.write(body)};
process.stdin.on('data',chunk=>{data=Buffer.concat([data,chunk]);for(;;){const end=data.indexOf('\\r\\n\\r\\n');if(end<0)return;const n=Number(/Content-Length: (\\d+)/i.exec(data.subarray(0,end).toString())[1]);if(data.length<end+4+n)return;const m=JSON.parse(data.subarray(end+4,end+4+n));data=data.subarray(end+4+n);if(m.method==='initialize')send({id:m.id,result:{capabilities:{textDocumentSync:1}}});else if(m.method==='initialized')send({method:'slang/includeConfiguration',params:{directories:[],disableLocalIncludes:false,incDirFirst:false}});else if(m.method==='shutdown')send({id:m.id,result:null});else if(m.method==='exit')process.exit(0);else if(m.id!==undefined)send({id:m.id,result:[]});}});
`,
      { mode: 0o755 }
    )
    await fs.promises.writeFile(stuck, '#!/usr/bin/env node\nprocess.stdin.resume();\n', {
      mode: 0o755,
    })
    const index = ext.indexFiles.bind(ext)
    let scans = 0
    ext.indexFiles = async (...args: Parameters<typeof ext.indexFiles>) => {
      scans++
      return index(...args)
    }
    try {
      await setting('server.path', fake)
      await setting('server.enabled', true)
      await until(() => ext.server.active, 'fake native handshake completed')
      await setting('server.path', stuck)
      await until(() => ext.server.pending, 'replacement pending')
      // Supersede the unanswered initialize before its timeout.
      await setting('server.path', fake)
      await until(() => ext.server.active, 'latest generation started')
      assert.strictEqual(scans, 0, 'superseded start must not scan Ctags')
      await setting('server.startupTimeout', 1)
      await setting('server.path', stuck)
      const start = Date.now()
      await until(() => !ext.server.pending && !ext.server.active, 'bounded startup failure')
      assert.ok(Date.now() - start < 4000)
      assert.strictEqual(scans, 1, 'one actual fallback transition scans once')
    } finally {
      ext.indexFiles = index
      await setting('server.enabled', false)
      await setting('server.startupTimeout', 15)
      await setting('server.path', '')
    }
  })
})
