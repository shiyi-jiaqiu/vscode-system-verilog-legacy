// SPDX-License-Identifier: MIT
import * as assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'
import * as vscode from 'vscode'
import { evalConst } from '../analysis/ConstValue'
import { SavedInputs } from '../linter/SavedInputs'
import { toDiagnostics } from '../linter/SlangLinter'
import { SourceDependencies } from '../linter/SourceDependencies'

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(test: () => boolean | Promise<boolean>, message: string, ms = 15000) {
  const start = Date.now()
  while (!(await test())) {
    if (Date.now() - start > ms) assert.fail(message)
    await pause(40)
  }
}

suite('Independent review regressions', function () {
  this.timeout(45000)
  let ext: typeof import('../extension').ext
  let dir: string
  const setting = async (name: string, value: unknown) => {
    await vscode.workspace
      .getConfiguration('verilog')
      .update(name, value, vscode.ConfigurationTarget.Workspace)
    await pause(220)
  }
  async function open(name: string, text: string) {
    const file = path.join(dir, name)
    await fs.promises.mkdir(path.dirname(file), { recursive: true })
    await fs.promises.writeFile(file, text)
    const doc = await vscode.workspace.openTextDocument(file)
    await vscode.window.showTextDocument(doc, { preview: false })
    return doc
  }
  async function replace(doc: vscode.TextDocument, text: string) {
    const edit = new vscode.WorkspaceEdit()
    edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), text)
    assert.ok(await vscode.workspace.applyEdit(edit))
  }
  async function hover(doc: vscode.TextDocument, name: string, last = false) {
    const offset = last ? doc.getText().lastIndexOf(name) : doc.getText().indexOf(name)
    const result = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      doc.uri,
      doc.positionAt(offset)
    )
    return (result ?? [])
      .flatMap((h) =>
        h.contents.map((c) => (typeof c === 'string' ? c : 'value' in c ? c.value : ''))
      )
      .join('\n')
  }
  async function definitions(doc: vscode.TextDocument, name: string) {
    return ext.index.findSymbol(doc, doc.positionAt(doc.getText().lastIndexOf(name) + 1))
  }

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension('local.verilog-systemverilog-legacy')!
    await extension.activate()
    ext = require(path.join(extension.extensionPath, 'dist/main.js')).ext
    dir = await fs.promises.mkdtemp(
      path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, 'review-')
    )
    await setting('server.enabled', false)
    await until(() => !ext.server.pending, 'fallback must be ready')
    await setting('filelist', '')
    await setting('lint.slang.path', process.env.SLANG_PATH ?? 'slang')
    await setting('lint.slang.runOnSave', false)
    await setting('lint.slang.readingMode', false)
    await setting('lint.slang.enabled', true)
    await setting('lint.slang.scope', 'openFiles')
    await setting('lint.slang.analysis', 'local')
  })
  suiteTeardown(async () => {
    await setting('lint.slang.runOnSave', false)
    await setting('server.enabled', false)
    await until(() => !ext.server.pending, 'server stopped')
    ext.lint.slang.stop()
    await vscode.workspace.saveAll(false)
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    await fs.promises.rm(dir, { recursive: true, force: true })
  })

  test('F09: qualified and imported package members retain their declaring package', async () => {
    const pkg = await open(
      'packages.sv',
      'package p;\nparameter int X=1;\nendpackage\npackage q;\nparameter int X=2;\nendpackage\n'
    )
    await ext.index.indexNames([pkg.uri])
    for (const imported of ['*', 'X']) {
      const doc = await open(
        `use-${imported === '*' ? 'wildcard' : 'explicit'}.sv`,
        `module use_pkg;\nimport q::${imported}; // import p::*;\nlocalparam int Y=q::X;\nlocalparam int Z=X;\nendmodule\n`
      )
      const qualified = await ext.index.findSymbol(doc, new vscode.Position(2, 20))
      assert.deepStrictEqual(
        qualified.map((sym) => [sym.parentScope, sym.line]),
        [['q', 4]]
      )
      const importedDefs = await definitions(doc, 'X')
      assert.deepStrictEqual(
        importedDefs.map((sym) => [sym.parentScope, sym.line]),
        [['q', 4]]
      )
      assert.match(await hover(doc, 'Z='), /= `2`/)
    }
    const comp = await open(
      'package-completion.sv',
      'module completions;\ninitial $display(q::);\nendmodule\n'
    )
    const result = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      comp.uri,
      new vscode.Position(1, 19),
      ':'
    )
    const names =
      result?.items.map((item) =>
        typeof item.label === 'string' ? item.label : item.label.label
      ) ?? []
    assert.strictEqual(names.filter((name) => name === 'X').length, 1)
    const ambiguous = await open(
      'ambiguous.sv',
      'module ambiguous;\nimport p::*;\nimport q::*;\nlocalparam int Z=X;\nendmodule\n'
    )
    assert.deepStrictEqual(
      (await definitions(ambiguous, 'X')).map((sym) => sym.parentScope).sort(),
      ['p', 'q']
    )
    assert.doesNotMatch(await hover(ambiguous, 'Z='), /= `[12]`/)
    const sameFile = await open(
      'same-file-completion.sv',
      'package first; parameter int X=1; endpackage\npackage second; parameter int X=2; endpackage\nmodule same_file; initial $display(second::); endmodule\n'
    )
    await ext.index.indexNames([sameFile.uri])
    const offset = sameFile.getText().indexOf('second::') + 'second::'.length
    const sameResult = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      sameFile.uri,
      sameFile.positionAt(offset),
      ':'
    )
    assert.strictEqual(
      sameResult!.items.filter(
        (item) => (typeof item.label === 'string' ? item.label : item.label.label) === 'X'
      ).length,
      1
    )
  })

  test('F09: function and named-block locals win over module declarations', async () => {
    const doc = await open(
      'locals.sv',
      'module locals;\nint value;\nfunction int f();\nint value;\nreturn value;\nendfunction\ninitial begin : block1\nint value;\n$display(value);\nend\nendmodule\n'
    )
    for (const [line, expected] of [
      [4, 3],
      [8, 7],
    ]) {
      const pos = new vscode.Position(line, doc.lineAt(line).text.indexOf('value') + 1)
      const symbols = await ext.index.findSymbol(doc, pos)
      assert.deepStrictEqual(
        symbols.map((symbol) => symbol.line),
        [expected]
      )
    }
  })

  test('F10: textual macro expansion and SV exponent rules agree with the reference values', async () => {
    assert.strictEqual(evalConst('-2**2'), 4n)
    assert.strictEqual(evalConst('2**3**2'), 64n)
    assert.strictEqual(evalConst('(8+2)*4'), 40n)
    for (const expression of ["8'shff", '2147483647+1'])
      assert.strictEqual(evalConst(expression), undefined)
    const doc = await open(
      'expressions.sv',
      '`define ADD 1+2\nmodule expressions;\nlocalparam int M=`ADD*3;\nlocalparam int P=-2**2;\nlocalparam int Q=2**3**2;\nendmodule\n'
    )
    for (const [name, value] of [
      ['M=', 7],
      ['P=', 4],
      ['Q=', 64],
    ] as const) {
      assert.ok((await hover(doc, name)).includes(`= \`${value}\``), name)
    }
  })

  test('F11: actual include closure wins over global macros, including .sv/.v headers', async () => {
    const inc = path.join(dir, 'inc')
    await fs.promises.mkdir(inc, { recursive: true })
    await fs.promises.writeFile(path.join(inc, 'defs.svh'), '`define SAME 2\n')
    await fs.promises.writeFile(path.join(dir, 'defs.svh'), '`define SAME 1\n')
    for (const extension of ['sv', 'v'])
      await fs.promises.writeFile(
        path.join(inc, `extra.${extension}`),
        `\`define EXTRA_${extension} 3\n`
      )
    const filelist = path.join(dir, 'macro.f')
    await fs.promises.writeFile(filelist, `+incdir+${inc}\n`)
    await setting('filelist', filelist)
    const doc = await open(
      'macro-user.sv',
      '`include "defs.svh"\n`include "extra.sv"\n`include "extra.v"\nmodule macro_user;\nlocalparam int A=`SAME;\nlocalparam int B=`EXTRA_sv;\nlocalparam int C=`EXTRA_v;\nendmodule\n'
    )
    const macros = await definitions(doc, 'SAME')
    assert.strictEqual(macros.length, 1)
    assert.strictEqual(macros[0].doc.uri.fsPath, path.join(dir, 'defs.svh'))
    assert.match(await hover(doc, 'A='), /= `1`/)
    for (const extension of ['sv', 'v'])
      assert.strictEqual((await definitions(doc, `EXTRA_${extension}`)).length, 1)
    const header = await vscode.workspace.openTextDocument(macros[0].doc.uri)
    await replace(header, '`define SAME 11\n')
    assert.match(await hover(doc, 'A='), /= `11`/)
    await header.save()
    await setting('filelist', '')
  })

  test('F05: syntax/local/full CLI columns and notes match Unicode text', async () => {
    for (const analysis of ['syntax', 'local', 'full']) {
      await setting('lint.slang.analysis', analysis)
      for (const [index, prefix] of [
        '/*中文*/',
        '/*🙂*/',
        '\t',
        '/*中文🙂*/',
        '/*e\u0301*/',
      ].entries()) {
        const name = analysis === 'syntax' ? '`missing' : 'missing'
        const doc = await open(
          `unicode-${analysis}-${index}.sv`,
          `module unicode_${index};\nlogic x;\n${prefix} assign x = ${name};\nendmodule\n`
        )
        await ext.lint.slang.lint(doc)
        const diagnostics = vscode.languages
          .getDiagnostics(doc.uri)
          .filter((d) => d.message.includes('missing'))
        assert.strictEqual(
          diagnostics.length,
          1,
          JSON.stringify(ext.lint.slang.rawDiagnostics(doc.uri))
        )
        assert.strictEqual(doc.getText(diagnostics[0].range), name)
      }
    }
    await setting('lint.slang.analysis', 'local')
    const notes = await open(
      'real-notes.sv',
      'module real_notes;\n/*中文🙂*/ logic name;\n/*中文🙂*/ logic name;\nendmodule\n'
    )
    await ext.lint.slang.lint(notes)
    const diagnostic = vscode.languages
      .getDiagnostics(notes.uri)
      .find((d) => d.message.includes('redefinition'))!
    assert.ok(diagnostic)
    assert.strictEqual(diagnostic.range.start.character, notes.lineAt(2).text.indexOf('name'))
    const previous = diagnostic.relatedInformation!.find((note) =>
      note.message.includes('previous')
    )!
    assert.ok(previous)
    assert.strictEqual(
      previous.location.range.start.character,
      notes.lineAt(1).text.indexOf('name')
    )
  })

  test('F05: both endpoints and notes convert from saved bytes, including multiline ranges', async () => {
    const doc = await open('range-notes.sv', '中🙂\tstart\n/*e\u0301*/ end\n')
    const inputs = new SavedInputs()
    await inputs.capture([doc.uri.fsPath])
    await inputs.load([doc.uri.fsPath])
    const diagnostics = toDiagnostics(
      [
        {
          severity: 'error',
          code: 'Test',
          message: 'range',
          location: `${doc.uri.fsPath}:1:9`,
          ranges: [
            {
              start: { file: doc.uri.fsPath, line: 1, column: 9 },
              end: { file: doc.uri.fsPath, line: 2, column: 12 },
            },
          ],
          notes: [
            { severity: 'note', code: 'Note', message: 'note', location: `${doc.uri.fsPath}:2:9` },
          ],
        },
      ],
      dir,
      doc.uri.fsPath,
      new SourceDependencies(),
      false,
      false,
      inputs
    ).get(doc.uri.fsPath)!
    assert.deepStrictEqual(
      [diagnostics[0].range.start.line, diagnostics[0].range.start.character],
      [0, 4]
    )
    assert.strictEqual(diagnostics[0].range.end.character, 10)
    assert.strictEqual(diagnostics[0].relatedInformation![0].location.range.start.character, 7)
  })

  test('F16/F17: editing during a CLI run discards the result and refreshes an open Raw view', async () => {
    const doc = await open('stale.sv', 'module stale;\nlocalparam int X=BAD;\nendmodule\n')
    await ext.lint.slang.lint(doc)
    await vscode.commands.executeCommand('verilog.server.showDiagnostics')
    const raw = vscode.window.activeTextEditor!.document
    assert.strictEqual(raw.uri.scheme, 'verilog-diagnostics')
    assert.ok(raw.getText().includes('BAD'))
    const marker = path.join(dir, 'cli-started')
    const fake = path.join(dir, 'slow-cli')
    await fs.promises.writeFile(
      fake,
      `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(marker)}, '');\nsetTimeout(() => console.log('[\\n'+JSON.stringify({severity:'error',code:'UndeclaredIdentifier',message:'BAD',location:${JSON.stringify(doc.uri.fsPath + ':2:18')}})+'\\n]'), 500);\n`,
      { mode: 0o755 }
    )
    await setting('lint.slang.path', fake)
    const running = ext.lint.slang.lint(doc)
    await until(() => fs.existsSync(marker), 'CLI started')
    await replace(doc, 'module stale;\nlocalparam int X=1;\nendmodule\n')
    await running
    assert.deepStrictEqual(vscode.languages.getDiagnostics(doc.uri), [])
    await until(() => !raw.getText().includes('BAD'), 'Raw clears after input changes')
    await doc.save()
    await setting('lint.slang.path', process.env.SLANG_PATH ?? 'slang')
    await ext.lint.slang.lint(doc)
    await until(
      () => raw.getText().includes('"diagnostics": []'),
      'Raw displays new clean CLI result'
    )
  })

  test('F15: disabling a server stuck in initialize cancels startup and terminates its process', async () => {
    const unhandled: unknown[] = []
    const rejected = (error: unknown) => unhandled.push(error)
    process.on('unhandledRejection', rejected)
    try {
      const marker = path.join(dir, 'native-pid')
      const fake = path.join(dir, 'stuck-native')
      await fs.promises.writeFile(
        fake,
        `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid));\nprocess.stdin.resume(); setInterval(() => {}, 1000);\n`,
        { mode: 0o755 }
      )
      await setting('server.path', fake)
      await setting('server.enabled', true)
      await until(() => fs.existsSync(marker) && ext.server.pending, 'initialize process started')
      const pid = Number(await fs.promises.readFile(marker, 'utf8'))
      await setting('server.enabled', false)
      await until(
        () => !ext.server.pending && !ext.server.active,
        'disable cancels initialize',
        5000
      )
      await until(
        () => {
          try {
            process.kill(pid, 0)
            return false
          } catch {
            return true
          }
        },
        'child process exited',
        5000
      )
      assert.strictEqual((ext.server as any).state, 'off')
      await fs.promises.unlink(marker)
      await setting('server.startupTimeout', 2)
      const timeoutStarted = Date.now()
      await setting('server.enabled', true)
      await until(() => fs.existsSync(marker) && ext.server.pending, 'timeout test started')
      const timeoutPid = Number(await fs.promises.readFile(marker, 'utf8'))
      await until(
        () => !ext.server.pending && !ext.server.active,
        'startup timeout restores fallback',
        20000
      )
      await until(() => {
        try {
          process.kill(timeoutPid, 0)
          return false
        } catch {
          return true
        }
      }, 'timed-out process exited')
      assert.strictEqual((ext.server as any).state, 'failed')
      assert.ok(Date.now() - timeoutStarted < 6000, 'configured handshake timeout is used')
      await setting('server.enabled', false)
      await pause(300)
      assert.deepStrictEqual(unhandled, [])
      await setting('server.startupTimeout', 15)
    } finally {
      process.removeListener('unhandledRejection', rejected)
    }
  })

  test('F03/F04/F18: native include routing, dirty manual lint and reading-mode diagnostics', async () => {
    assert.ok(
      process.env.SLANG_SERVER_PATH,
      'Set SLANG_SERVER_PATH to the patched native binary for the complete review suite'
    )
    const root = vscode.workspace.workspaceFolders![0].uri.fsPath
    const inc = path.join(dir, 'native-inc')
    await fs.promises.mkdir(inc, { recursive: true })
    await fs.promises.writeFile(path.join(inc, 'template.svh'), '<pl>$value</pl>\n')
    await fs.promises.writeFile(path.join(inc, 'shadow.svh'), '`define WIDTH 8\n')
    await fs.promises.mkdir(path.join(root, '.slang'), { recursive: true })
    await fs.promises.writeFile(
      path.join(root, '.slang/server.json'),
      JSON.stringify({
        index: [{ dirs: [dir] }],
        flags: `-I '${inc}'`,
        indexingThreads: 1,
      })
    )
    await setting('filelist', '')
    await setting('server.path', process.env.SLANG_SERVER_PATH)
    await setting('server.enabled', true)
    await until(
      () => ext.server.active && ext.server.includeDirectories.includes(inc),
      'native effective include configuration received'
    )

    const templateUser = await open(
      'native-template.sv',
      '`include "template.svh"\nmodule native_template; endmodule\n'
    )
    await until(() => ext.server.owns(templateUser), 'markup includer uses native analysis')
    await until(
      () =>
        ((ext.server as any).rawDiagnostics.get(
          vscode.Uri.file(path.join(inc, 'template.svh')).toString()
        )?.diagnostics.length ?? 0) > 0,
      'markup include receives ordinary syntax diagnostics'
    )
    const shadowUser = await open(
      'native-shadow.sv',
      '`include "shadow.svh"\nmodule native_shadow; localparam int W=`WIDTH; endmodule\n'
    )
    await until(() => ext.server.owns(shadowUser), 'ordinary include initially uses native')
    const local = await open('shadow.svh', '// <pl>$shadow</pl>\n`define WIDTH 12\n')
    // Trigger a real editor save. The includer is deliberately left untouched.
    await replace(local, '// <pl>$shadow2</pl>\n`define WIDTH 16\n')
    await local.save()
    assert.ok(ext.server.owns(shadowUser), 'markup in comments must not change native ownership')
    await until(
      async () => /\b16\b/.test(await hover(shadowUser, 'W=')),
      'saved local header updates the native value'
    )

    const dirty = await open(
      'native-dirty.sv',
      'module native_dirty; localparam int X=1; endmodule\n'
    )
    await until(() => ext.server.owns(dirty), 'dirty test opened in native')
    for (const runOnSave of [true, false]) {
      await setting('lint.slang.runOnSave', runOnSave)
      await replace(
        dirty,
        `module native_dirty; localparam int X=BAD_${Number(runOnSave)}; endmodule\n`
      )
      await until(
        () => (ext.server as any).diagnosticVersions.get(dirty.uri.toString()) === dirty.version,
        'native diagnostics reached current version'
      )
      assert.deepStrictEqual(vscode.languages.getDiagnostics(dirty.uri), [])
      await vscode.commands.executeCommand('verilog.lint.run')
      await until(
        () => vscode.languages.getDiagnostics(dirty.uri).some((d) => d.message.includes('BAD_')),
        'manual lint publishes current dirty error'
      )
      await replace(dirty, 'module native_dirty; localparam int X=1; endmodule\n')
      await until(
        () => vscode.languages.getDiagnostics(dirty.uri).length === 0,
        'editing invalidates manual lint version'
      )
    }
    await dirty.save()
    const missing = await open(
      'native-missing.sv',
      '`include "noexist.svh"\nmodule native_missing; endmodule\n'
    )
    await until(
      () => (ext.server as any).diagnosticVersions.get(missing.uri.toString()) === missing.version,
      'missing include diagnostics ready'
    )
    await setting('lint.slang.readingMode', true)
    await vscode.commands.executeCommand('verilog.lint.run')
    await until(
      () =>
        vscode.languages.getDiagnostics(missing.uri).some((d) => d.code === 'MissingDependencies'),
      'stable missing-include code classified in reading mode'
    )
    const summary = vscode.languages
      .getDiagnostics(missing.uri)
      .find((d) => d.code === 'MissingDependencies')!
    assert.strictEqual(summary.severity, vscode.DiagnosticSeverity.Information)
    assert.ok(summary.relatedInformation?.some((d) => d.message.includes('noexist.svh')))
    await setting('lint.slang.readingMode', false)
    await vscode.commands.executeCommand('verilog.lint.run')
    await until(
      () =>
        vscode.languages
          .getDiagnostics(missing.uri)
          .some(
            (d) =>
              d.code === 'CouldNotOpenIncludeFile' && d.severity === vscode.DiagnosticSeverity.Error
          ),
      'strict mode restores original include error'
    )
    await setting('server.enabled', false)
  })
})
