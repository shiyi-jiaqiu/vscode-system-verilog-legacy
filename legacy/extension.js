'use strict';

// VS Code 1.18 entry point. The TextMate grammars and snippets come from the
// upstream extension; this runtime uses only APIs available in VS Code 1.18.
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const vscode = require('vscode');

const languages = ['verilog', 'verilogheader', 'systemverilog', 'systemverilogheader'];
const sourcePattern = '**/*.{v,vl,vh,sv,svh}';
const tagsByName = new Map();
const tagsByFile = new Map();
let output;
let diagnostics;
let lintProcess;
let lintTimer;
let indexGeneration = 0;

function config(key, fallback) {
  return vscode.workspace.getConfiguration('verilog.legacy').get(key, fallback);
}

function workspaceRoot(uri) {
  const folder = uri && vscode.workspace.getWorkspaceFolder(uri);
  const first = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  return (folder || first) && (folder || first).uri.fsPath;
}

function fileList(root) {
  const configured = config('filelist', '');
  if (!configured) return null;
  const filename = path.resolve(root, configured);
  if (!fs.existsSync(filename)) throw new Error('Filelist does not exist: ' + filename);
  return filename;
}

function projectFiles(root) {
  const filename = fileList(root);
  if (!filename) return [];
  const files = [];
  const lines = fs.readFileSync(filename, 'utf8').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line[0] === '#' || line.slice(0, 2) === '//' || line[0] === '+' || line[0] === '-') continue;
    const name = line.replace(/^"|"$/g, '');
    if (/\.(?:v|vl|vh|sv|svh)$/i.test(name)) files.push(path.resolve(root, name));
  }
  return files;
}

function runLines(command, args, cwd, onLine, input) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = childProcess.spawn(command, args, { cwd: cwd });
    } catch (error) {
      reject(error);
      return;
    }
    const tails = ['', ''];
    [proc.stdout, proc.stderr].forEach((stream, streamIndex) => {
      stream.on('data', chunk => {
        const pieces = (tails[streamIndex] + chunk.toString()).split(/\r?\n/);
        tails[streamIndex] = pieces.pop();
        pieces.forEach(line => onLine(line, streamIndex));
      });
    });
    proc.on('error', reject);
    proc.on('close', code => {
      tails.forEach((tail, index) => { if (tail) onLine(tail, index); });
      resolve(code);
    });
    proc.stdin.on('error', () => {});
    if (input !== undefined) proc.stdin.end(input);
  });
}

function tagLocation(tag) {
  return new vscode.Location(vscode.Uri.file(tag.path), new vscode.Position(tag.line - 1, 0));
}

function symbolKind(kind) {
  switch (kind) {
    case 'module': return vscode.SymbolKind.Module;
    case 'package': return vscode.SymbolKind.Package;
    case 'class': return vscode.SymbolKind.Class;
    case 'interface': return vscode.SymbolKind.Interface;
    case 'function': return vscode.SymbolKind.Function;
    case 'task': return vscode.SymbolKind.Method;
    case 'constant': return vscode.SymbolKind.Constant;
    default: return vscode.SymbolKind.Variable;
  }
}

function symbol(tag) {
  return new vscode.SymbolInformation(tag.name, symbolKind(tag.kind), tag.scope || '', tagLocation(tag));
}

function installTags(tags) {
  tagsByName.clear();
  tagsByFile.clear();
  for (const tag of tags) {
    if (!tagsByName.has(tag.name)) tagsByName.set(tag.name, []);
    if (!tagsByFile.has(tag.path)) tagsByFile.set(tag.path, []);
    tagsByName.get(tag.name).push(tag);
    tagsByFile.get(tag.path).push(tag);
  }
}

async function parseTags(files, root) {
  if (!files.length) return [];
  const found = [];
  let errors = '';
  const args = ['--output-format=json', '--fields=+n', '-f', '-', '-L', '-'];
  const code = await runLines(config('ctagsPath', 'ctags'), args, root, (line, stream) => {
    if (stream === 1) {
      errors += line + '\n';
      return;
    }
    let tag;
    try { tag = JSON.parse(line); } catch (_) { return; }
    if (tag._type !== 'tag' || !tag.name || !tag.path || !tag.line) return;
    found.push({
      name: tag.name,
      kind: tag.kind || '',
      scope: tag.scope || '',
      path: path.resolve(root, tag.path),
      line: Number(tag.line)
    });
  }, files.join('\n') + '\n');
  if (code !== 0) throw new Error('Ctags exited with ' + code + ': ' + errors.trim());
  if (errors) output.appendLine(errors.trim());
  return found;
}

async function reindex() {
  const generation = ++indexGeneration;
  const folders = vscode.workspace.workspaceFolders || [];
  if (!folders.length) return;
  const files = new Set();
  const discovered = await vscode.workspace.findFiles(sourcePattern, '**/{.git,node_modules}/**');
  discovered.forEach(uri => files.add(uri.fsPath));
  for (const folder of folders) {
    projectFiles(folder.uri.fsPath).forEach(file => files.add(file));
  }
  const root = folders[0].uri.fsPath;
  const tags = await parseTags(Array.from(files).filter(file => fs.existsSync(file)), root);
  if (generation !== indexGeneration) return;
  installTags(tags);
  output.appendLine('Indexed ' + files.size + ' files, ' + tags.length + ' symbols.');
}

async function reindexFile(uri) {
  if (!/\.(?:v|vl|vh|sv|svh)$/i.test(uri.fsPath)) return;
  const root = workspaceRoot(uri);
  if (!root) return;
  const tags = await parseTags([uri.fsPath], root);
  const retained = [];
  tagsByFile.forEach((entries, filename) => {
    if (filename !== uri.fsPath) retained.push.apply(retained, entries);
  });
  installTags(retained.concat(tags));
}

function wordAt(document, position) {
  const range = document.getWordRangeAtPosition(position, /[a-zA-Z_$][a-zA-Z0-9_$]*/);
  return range && document.getText(range);
}

function parseDiagnostic(line, root, tool) {
  let match;
  let severity;
  if (tool === 'verilator') {
    match = /^%(Error|Warning)(?:-[^:]+)?: (.+?):(\d+):(\d+): (.*)$/.exec(line);
    if (!match) return null;
    severity = match[1] === 'Error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;
    match = [null, match[2], match[3], match[4], match[5]];
  } else {
    match = /^(.+?):(\d+):(\d+): (error|warning|note): (.*)$/.exec(line);
    if (!match) return null;
    severity = match[4] === 'error' ? vscode.DiagnosticSeverity.Error :
      match[4] === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information;
    match = [null, match[1], match[2], match[3], match[5]];
  }
  const filename = path.resolve(root, match[1]);
  const lineNumber = Math.max(0, Number(match[2]) - 1);
  const column = Math.max(0, Number(match[3]) - 1);
  const range = new vscode.Range(lineNumber, column, lineNumber, column + 1);
  const diagnostic = new vscode.Diagnostic(range, match[4], severity);
  diagnostic.source = tool;
  return { filename: filename, diagnostic: diagnostic };
}

async function lint(uri) {
  const root = workspaceRoot(uri);
  if (!root) return;
  const tool = config('linter', 'slang');
  const command = config('linterPath', '') || tool;
  const list = fileList(root);
  const args = tool === 'verilator' ? ['--lint-only', '-Wall'] : ['--lint-only'];
  if (list) args.push('-f', list);
  else args.push(uri.fsPath);
  args.push.apply(args, config('lintArgs', []));
  const found = new Map();
  let otherOutput = '';
  const process = childProcess.spawn(command, args, { cwd: root });
  if (lintProcess) lintProcess.kill();
  lintProcess = process;
  const tails = ['', ''];
  [process.stdout, process.stderr].forEach((stream, index) => {
    stream.on('data', chunk => {
      const parts = (tails[index] + chunk.toString()).split(/\r?\n/);
      tails[index] = parts.pop();
      parts.forEach(line => {
        const parsed = parseDiagnostic(line, root, tool);
        if (parsed) {
          if (!found.has(parsed.filename)) found.set(parsed.filename, []);
          found.get(parsed.filename).push(parsed.diagnostic);
        } else if (line && !/^\s*[\^~]/.test(line) && otherOutput.length < 8192) {
          otherOutput += line + '\n';
        }
      });
    });
  });
  process.on('error', error => {
    if (lintProcess === process) output.appendLine('Lint failed: ' + error.message);
  });
  process.on('close', code => {
    if (lintProcess !== process) return;
    lintProcess = null;
    if (code === null) return;
    tails.forEach(tail => {
      const parsed = parseDiagnostic(tail, root, tool);
      if (parsed) {
        if (!found.has(parsed.filename)) found.set(parsed.filename, []);
        found.get(parsed.filename).push(parsed.diagnostic);
      }
    });
    if (list) diagnostics.clear();
    else diagnostics.delete(uri);
    found.forEach((items, filename) => diagnostics.set(vscode.Uri.file(filename), items));
    output.appendLine(tool + ' lint: ' + found.size + ' file(s) with diagnostics, exit ' + code + '.');
    if (code !== 0 && !found.size && otherOutput) output.appendLine(otherOutput.trim());
  });
}

function scheduleLint(uri) {
  clearTimeout(lintTimer);
  lintTimer = setTimeout(() => {
    lint(uri).catch(error => output.appendLine('Lint failed: ' + error.message));
  }, 250);
}

function activate(context) {
  output = vscode.window.createOutputChannel('Verilog Legacy');
  diagnostics = vscode.languages.createDiagnosticCollection('Verilog Legacy');
  context.subscriptions.push(output, diagnostics);
  context.subscriptions.push(vscode.commands.registerCommand('verilogLegacy.reindex', () =>
    reindex().catch(error => output.appendLine('Index failed: ' + error.message))));
  context.subscriptions.push(vscode.commands.registerCommand('verilogLegacy.lint', () => {
    const editor = vscode.window.activeTextEditor;
    if (editor) scheduleLint(editor.document.uri);
  }));
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(document => {
    reindexFile(document.uri).catch(error => output.appendLine('Index failed: ' + error.message));
    if (languages.indexOf(document.languageId) >= 0) scheduleLint(document.uri);
  }));
  context.subscriptions.push(vscode.languages.registerDefinitionProvider(languages, {
    provideDefinition(document, position) {
      const name = wordAt(document, position);
      if (!name || !tagsByName.has(name)) return [];
      const matches = tagsByName.get(name).slice().sort((a, b) =>
        Number(b.path === document.uri.fsPath) - Number(a.path === document.uri.fsPath));
      return matches.map(tagLocation);
    }
  }));
  context.subscriptions.push(vscode.languages.registerHoverProvider(languages, {
    provideHover(document, position) {
      const name = wordAt(document, position);
      const matches = name && tagsByName.get(name);
      if (!matches || !matches.length) return null;
      return new vscode.Hover(matches.slice(0, 5).map(tag =>
        tag.kind + ' ' + tag.name + ' — ' + path.basename(tag.path) + ':' + tag.line).join('\n'));
    }
  }));
  context.subscriptions.push(vscode.languages.registerDocumentSymbolProvider(languages, {
    provideDocumentSymbols(document) {
      return (tagsByFile.get(document.uri.fsPath) || []).map(symbol);
    }
  }));
  context.subscriptions.push(vscode.languages.registerWorkspaceSymbolProvider({
    provideWorkspaceSymbols(query) {
      const lower = query.toLowerCase();
      const result = [];
      tagsByName.forEach((entries, name) => {
        if (name.toLowerCase().indexOf(lower) < 0) return;
        entries.forEach(tag => { if (result.length < 500) result.push(symbol(tag)); });
      });
      return result;
    }
  }));
  context.subscriptions.push(vscode.languages.registerCompletionItemProvider(languages, {
    provideCompletionItems(document, position) {
      const before = document.lineAt(position.line).text.slice(0, position.character);
      const match = /[a-zA-Z_$][a-zA-Z0-9_$]*$/.exec(before);
      if (!match || match[0].length < 2) return [];
      const prefix = match[0].toLowerCase();
      const result = [];
      tagsByName.forEach((entries, name) => {
        if (result.length >= 200 || name.toLowerCase().indexOf(prefix) !== 0) return;
        const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Text);
        item.detail = entries[0].kind;
        result.push(item);
      });
      return result;
    }
  }));
  reindex().catch(error => output.appendLine('Index failed: ' + error.message));
}

function deactivate() {
  clearTimeout(lintTimer);
  if (lintProcess) lintProcess.kill();
}

exports.activate = activate;
exports.deactivate = deactivate;
