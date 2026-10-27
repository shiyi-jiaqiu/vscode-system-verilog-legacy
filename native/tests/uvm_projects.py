#!/usr/bin/env python3
"""Exercise unmodified TinyALU and UBus sources with the public native protocol.

Usage: uvm_projects.py SERVER UVMPRIMER UVM_REFERENCE UVM_CORE --slang SLANG
The repository revisions and clone commands are recorded in README.md.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from urllib.parse import unquote

# The existing protocol harness consumes SERVER from sys.argv.
from review_protocol import Server


def position(text, anchor, prefix=''):
    offset = text.index(anchor) + len(prefix)
    return text[:offset].count('\n'), offset - text.rfind('\n', 0, offset) - 1


def check_project(name, original, uvm, slang, dut=None):
    with tempfile.TemporaryDirectory(prefix=f'verilog uvm 验证 %20-{name}-') as temporary:
        root = Path(temporary) / name
        shutil.copytree(original, root, ignore=shutil.ignore_patterns(
            '.slang', '.vscode', 'server.stderr', 'protocol.json'))
        if dut:
            shutil.copyfile(dut, root / 'tinyalu_dut.sv')
        includes = [root, uvm]
        if name == 'primer':
            includes.append(root / 'tb_classes')
            top = 'top.sv'
            sources = ['tinyalu_pkg.sv', 'tinyalu_bfm.sv', 'tinyalu_dut.sv', top]
            checks = [
                ('tb_classes/driver.svh', 'extends uvm_driver', 'extends ', uvm / 'comps/uvm_driver.svh', 'class uvm_driver'),
                ('tb_classes/driver.svh', '#(sequence_item)', '#(', root / 'tb_classes/sequence_item.svh', 'class sequence_item'),
                ('tb_classes/driver.svh', 'seq_item_port.get_next_item', 'seq_item_port.', uvm / 'tlm1/uvm_sqr_connections.svh', '`UVM_SEQ_ITEM_PULL_IMP'),
                ('tb_classes/driver.svh', 'bfm.send_op', 'bfm.', root / 'tinyalu_bfm.sv', 'task send_op'),
                ('tb_classes/driver.svh', 'cmd.A', 'cmd.', root / 'tb_classes/sequence_item.svh', 'rand byte unsigned'),
                ('tb_classes/env.svh', 'driver::type_id::create', 'driver::type_id::', uvm / 'base/uvm_registry.svh', 'static function T create'),
                (top, 'virtual tinyalu_bfm', 'virtual ', root / 'tinyalu_bfm.sv', 'interface tinyalu_bfm'),
            ]
            expected_classes = {'driver', 'sequence_item', 'env', 'fibonacci_test', 'random_sequence'}
        else:
            includes.extend([root / 'sv', root / 'examples'])
            top = 'examples/ubus_tb_top.sv'
            sources = [top]
            checks = [
                ('sv/ubus_master_driver.sv', 'extends uvm_driver', 'extends ', uvm / 'comps/uvm_driver.svh', 'class uvm_driver'),
                ('sv/ubus_master_driver.sv', 'virtual ubus_if', 'virtual ', root / 'sv/ubus_if.sv', 'interface ubus_if'),
                ('sv/ubus_master_driver.sv', 'virtual ubus_if)::get', 'virtual ', root / 'sv/ubus_if.sv', 'interface ubus_if'),
                ('sv/ubus_master_driver.sv', 'vif.sig_reset', 'vif.', root / 'sv/ubus_if.sv', 'sig_reset;'),
                ('sv/ubus_master_driver.sv', 'seq_item_port.get_next_item', 'seq_item_port.', uvm / 'tlm1/uvm_sqr_connections.svh', '`UVM_SEQ_ITEM_PULL_IMP'),
                ('sv/ubus_master_driver.sv', 'trans.transmit_delay', 'trans.', root / 'sv/ubus_transfer.sv', 'transmit_delay = 0'),
                ('sv/ubus_master_agent.sv', 'ubus_master_driver::type_id::create', 'ubus_master_driver::type_id::', uvm / 'base/uvm_registry.svh', 'static function T create'),
                ('examples/ubus_example_tb.sv', 'extends uvm_env', 'extends ', uvm / 'comps/uvm_env.svh', 'class uvm_env'),
            ]
            expected_classes = {'ubus_transfer', 'ubus_master_driver', 'ubus_slave_driver', 'ubus_env', 'ubus_example_tb'}
        (root / '.slang').mkdir()
        (root / '.slang/server.json').write_text(json.dumps({
            'index': [{'dirs': [str(root), str(uvm)]}], 'indexingThreads': 1,
            'incdirs': list(map(str, includes)), 'flags': '+define+UVM_NO_DPI'}))
        server = Server(root)
        try:
            # Query the cold metadata index before opening any source buffers.
            symbols = server.request('workspace/symbol', {'query': ''})
            classes = [s for s in symbols if s['kind'] == 5]
            assert expected_classes <= {s['name'] for s in classes}, expected_classes
            for symbol in classes:
                location = symbol['location']
                path = Path(location['uri'].removeprefix('file://'))
                source = path.read_text().splitlines()[location['range']['start']['line']]
                column = location['range']['start']['character']
                assert source[column:].startswith(symbol['name']), symbol
            for file, anchor, prefix, target, declaration in checks:
                server.open(file)
                line, column = position((root / file).read_text(), anchor, prefix)
                definitions = server.request('textDocument/definition', server.at(file, line, column))
                assert definitions, (file, anchor)
                expected_line = position(target.read_text(), declaration)[0]
                assert any(d['uri'] == unquote(target.as_uri()) and d['range']['start']['line'] == expected_line
                           for d in definitions), (file, anchor, definitions, str(target), expected_line)
                assert server.request('textDocument/hover', server.at(file, line, column)), (file, anchor)
            server.open(top)
            for file in {top, checks[0][0]}:
                diagnostics = server.diags[unquote(server.uri(file))]['diagnostics']
                assert not [d for d in diagnostics if d['severity'] == 1], (file, diagnostics)
            original_top = (root / top).read_text()
            broken_top = original_top.replace('endmodule', 'initial uvm_navigation_missing = 1;\nendmodule', 1)
            server.change(top, broken_top)
            errors = server.diags[unquote(server.uri(top))]['diagnostics']
            assert any(d.get('code') == 'UndeclaredIdentifier' and 'uvm_navigation_missing' in d['message']
                       for d in errors), errors
            server.change(top, original_top, 3)
            assert not [d for d in server.diags[unquote(server.uri(top))]['diagnostics'] if d['severity'] == 1]
            cli_results = {}
            for mode in ['--parse-only', '--lint-only', '--top']:
                output = root / 'cli.json'
                arguments = [str(slang), '--single-unit', '--error-limit', '0',
                             '+define+UVM_NO_DPI', *[f'-I{x}' for x in includes],
                             str(uvm / 'uvm_pkg.sv'), *sources]
                if mode == '--parse-only':
                    arguments.extend(['--diag-source=false', '--diag-column', '--diag-location',
                                      '--color-diagnostics=false'])
                else:
                    arguments.extend(['--diag-json', str(output)])
                arguments.extend([mode, 'top' if name == 'primer' else 'ubus_tb_top']
                                 if mode == '--top' else [mode])
                run = subprocess.run(arguments, cwd=root, capture_output=True, text=True, timeout=60)
                diagnostics = ([{'severity': m[1]} for m in re.finditer(
                    r'^.*:\d+:\d+: (error|warning|note): ', run.stderr, re.M)]
                    if mode == '--parse-only' else json.loads(output.read_text()))
                errors = [d for d in diagnostics if d['severity'] in ['error', 'fatal']]
                if name == 'ubus' and mode == '--top':
                    assert run.returncode == 1 and len(errors) == 2, (run.stderr, errors)
                    assert all(d['code'] == 'UndeclaredIdentifier' and 'uvm_test_done' in d['message']
                               for d in errors), errors
                else:
                    assert run.returncode == 0 and not errors, (run.stderr, errors)
                cli_results[mode] = {'diagnostics': len(diagnostics), 'errors': len(errors)}
            print(json.dumps({'project': name, 'definition_and_hover_checks': len(checks),
                              'class_symbols': len(classes), 'native_lint_edit_and_restore': 'pass',
                              'cli_diagnostics': cli_results}), flush=True)
        finally:
            server.close()
            if os.environ.get('VERILOG_TEST_EVIDENCE'):
                shutil.copytree(root, Path(os.environ['VERILOG_TEST_EVIDENCE']) / name,
                                dirs_exist_ok=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('uvmprimer', type=Path)
    parser.add_argument('uvm_reference', type=Path)
    parser.add_argument('uvm_core', type=Path)
    parser.add_argument('--slang', type=Path, required=True)
    args = parser.parse_args()
    core = args.uvm_core.resolve() / 'src'
    check_project('primer', args.uvmprimer.resolve() / '23_UVM_Sequences', core,
                  args.slang.resolve(), args.uvmprimer.resolve() / 'misc/tinyalu.sv')
    check_project('ubus', args.uvm_reference.resolve() / 'distrib/examples/integrated/ubus',
                  core, args.slang.resolve())
