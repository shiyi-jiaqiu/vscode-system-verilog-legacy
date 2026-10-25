import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { execFileSync } from 'child_process'

import { runTests } from '@vscode/test-electron'

async function main() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'verilog-test-host-'))
  try {
    // The folder containing the Extension Manifest package.json
    // Passed to `--extensionDevelopmentPath`
    const extensionDevelopmentPath =
      process.env.VERILOG_TEST_EXTENSION_PATH ?? path.resolve(__dirname, '../../..')

    // The path to the extension test script
    // Passed to --extensionTestsPath
    const extensionTestsPath = path.resolve(__dirname, './')

    // Download VS Code, unzip it and run the integration test
    const ctags = process.env.CTAGS_PATH ?? 'ctags'
    const slang = process.env.SLANG_PATH ?? 'slang'
    execFileSync(ctags, ['--version'])
    execFileSync(slang, ['--version'])
    const workspace = path.join(temporary, 'workspace')
    fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true })
    fs.writeFileSync(
      path.join(workspace, '.vscode/settings.json'),
      JSON.stringify({
        'verilog.server.enabled': false,
        'verilog.ctags.path': ctags,
        'verilog.lint.slang.path': slang,
        'verilog.lint.slang.runOnSave': false,
        'verilog.lint.slang.readingMode': false,
      })
    )
    await runTests({
      version: '1.84.2',
      vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH,
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        workspace,
        '--disable-extensions',
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-workspace-trust',
        '--no-sandbox',
        '--disable-gpu',
        '--user-data-dir',
        path.join(temporary, 'user'),
        '--extensions-dir',
        path.join(temporary, 'extensions'),
      ],
    })
  } catch (err) {
    console.error('Failed to run tests', err)
    process.exitCode = 1
  } finally {
    if (process.env.VERILOG_TEST_HOST_LOGS && fs.existsSync(path.join(temporary, 'user/logs'))) {
      fs.cpSync(path.join(temporary, 'user/logs'), process.env.VERILOG_TEST_HOST_LOGS, {
        recursive: true,
      })
    }
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}

main()
