'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

exports.run = function (_testsRoot, done) {
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const source = path.join(root, 'top.sv');
  const dependency = path.join(root, 'dependency.sv');
  fs.writeFileSync(source, 'module top; dependency instance(); endmodule\n');
  fs.writeFileSync(dependency, 'module dependency; endmodule\n');

  vscode.commands.executeCommand('verilogLegacy.reindex').then(() =>
    vscode.workspace.openTextDocument(source)
  ).then(document =>
    vscode.commands.executeCommand('vscode.executeDefinitionProvider', document.uri, new vscode.Position(0, 12))
  ).then(locations => {
    assert(locations.some(location => location.uri.fsPath === dependency));
    done();
  }, done);
};
