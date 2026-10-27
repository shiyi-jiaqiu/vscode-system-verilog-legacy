#!/usr/bin/env python3
"""Public-protocol regressions for the pinned native server (F01-F03, F06-F08, F13-F14, F18-F19).

Usage: python3 native/tests/review_protocol.py /absolute/path/to/slang-server
Every child has an address-space cap; requests and shutdown are bounded.
"""
import json
import os
from pathlib import Path
import queue
import resource
import subprocess
import sys
import tempfile
import threading
import time
import unittest

SERVER = str(Path(sys.argv.pop(1)).resolve())

class Server:
    def __init__(self, root):
        self.root = Path(root)
        self.log = open(self.root / 'server.stderr', 'w')
        def limit():
            resource.setrlimit(resource.RLIMIT_AS, (2 * 1024**3, 2 * 1024**3))
        self.proc = subprocess.Popen([SERVER], cwd=root, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=self.log,
            env={**os.environ, 'SLANG_SERVER_TESTS': '1'}, preexec_fn=limit)
        self.messages = queue.Queue()
        self.diags = {}
        self.events = []
        self.sequence = 0
        threading.Thread(target=self.read, daemon=True).start()
        result = self.request('initialize', {
            'processId': os.getpid(), 'rootUri': self.root.as_uri(),
            'workspaceFolders': [{'uri': self.root.as_uri(), 'name': 'review'}],
            'capabilities': {'general': {'positionEncodings': ['utf-8', 'utf-16']},
                'textDocument': {'completion': {'contextSupport': False}},
                'workspace': {'didChangeWatchedFiles': {'dynamicRegistration': True}}}})
        assert result['capabilities'].get('positionEncoding', 'utf-16') == 'utf-16', result
        self.notify('initialized', {})

    def read(self):
        try:
            while True:
                headers = {}
                while True:
                    line = self.proc.stdout.readline()
                    if not line:
                        raise EOFError('server exited')
                    if line in (b'\r\n', b'\n'):
                        break
                    key, value = line.decode().split(':', 1)
                    headers[key.lower()] = value.strip()
                body = self.proc.stdout.read(int(headers['content-length']))
                self.messages.put(json.loads(body))
        except BaseException as error:
            self.messages.put(error)

    def send(self, message):
        self.events.append({'direction': 'send', 'message': message})
        data = json.dumps({'jsonrpc': '2.0', **message}, ensure_ascii=False).encode()
        self.proc.stdin.write(f'Content-Length: {len(data)}\r\n\r\n'.encode() + data)
        self.proc.stdin.flush()

    def notify(self, method, params):
        self.send({'method': method, 'params': params})

    def receive(self, timeout=20):
        message = self.messages.get(timeout=timeout)
        if isinstance(message, BaseException):
            raise RuntimeError(f'{message}; stderr: {(self.root / "server.stderr").read_text()[-3000:]}')
        self.events.append({'direction': 'receive', 'message': message})
        if 'method' in message and 'id' in message:
            self.send({'id': message['id'], 'result': None})
        if message.get('method') == 'textDocument/publishDiagnostics':
            self.diags[message['params']['uri']] = message['params']
        return message

    def request(self, method, params):
        self.sequence += 1
        seq = self.sequence
        self.send({'id': seq, 'method': method, 'params': params})
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            message = self.receive(max(.01, deadline-time.monotonic()))
            if message.get('id') == seq and 'method' not in message:
                if 'error' in message:
                    raise AssertionError(f'{method}: {message["error"]}')
                return message.get('result')
        raise TimeoutError(method)

    def uri(self, file): return (self.root / file).as_uri()
    def open(self, file, text=None):
        self.notify('textDocument/didOpen', {'textDocument': {'uri': self.uri(file),
            'languageId': 'systemverilog', 'version': 1,
            'text': text if text is not None else (self.root / file).read_text()}})
        self.request('workspace/symbol', {'query': ''})
    def change(self, file, text, version=2):
        self.notify('textDocument/didChange', {'textDocument': {'uri': self.uri(file), 'version': version},
            'contentChanges': [{'text': text}]})
        self.request('workspace/symbol', {'query': ''})
    def watched(self, *changes):
        self.notify('workspace/didChangeWatchedFiles', {'changes': [
            {'uri': self.uri(file), 'type': kind} for file, kind in changes]})
        self.request('workspace/symbol', {'query': ''})
    def at(self, file, line, character):
        return {'textDocument': {'uri': self.uri(file)}, 'position': {'line': line, 'character': character}}
    def hover(self, file, line, character):
        return json.dumps(self.request('textDocument/hover', self.at(file, line, character)), ensure_ascii=False)
    def close(self):
        try:
            self.request('shutdown', None)
            self.notify('exit', None)
            self.proc.wait(timeout=5)
        finally:
            if self.proc.poll() is None:
                self.proc.kill()
                self.proc.wait()
            self.proc.stdin.close()
            self.proc.stdout.close()
            self.log.close()
            (self.root / 'protocol.json').write_text(json.dumps(self.events, indent=2))

class ReviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='verilog-native-review-')
        self.root = Path(self.temp.name)
        self.server = None
    def tearDown(self):
        try:
            if self.server: self.server.close()
        finally:
            if os.environ.get('VERILOG_TEST_EVIDENCE'):
                import shutil
                destination = Path(os.environ['VERILOG_TEST_EVIDENCE']) / self.id().split('.')[-1]
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copytree(self.root, destination, dirs_exist_ok=True)
            self.temp.cleanup()
    def write(self, file, text):
        path = self.root / file
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    def config(self, **options):
        self.write('.slang/server.json', json.dumps({'index': [{'dirs': ['.']}], 'indexingThreads': 1, **options}))
    def start(self):
        self.server = Server(self.root)
        return self.server
    def names(self):
        return {entry['name'] for entry in self.server.request('workspace/symbol', {'query': ''})}

    def test_SV_standalone_class_members_resolve_without_the_base_class(self):
        self.config()
        declaration = ('class uvm_pcie7_sh1 extends uvm_pcie7_comom_tools;\n'
                       '  int own_id;\n'
                       '  function int get_id(); return own_id; endfunction\n'
                       '  static function uvm_pcie7_sh1 body(); return null; endfunction\n'
                       'endclass\n')
        self.write('seq/uvm_pcie_sh1.sv', declaration)
        self.write('seq/hidden_pkg.sv', 'package hidden_pkg;\n'
                   'class uvm_pcie7_sh1; int own_id; endclass\n'
                   'class hidden_only; endclass\nendpackage\n')
        reference = ('module top;\n  uvm_pcie7_sh1 obj;\n  initial begin\n'
                     '    $display(obj.own_id);\n'
                     '    $display(obj.get_id());\n'
                     '    $display(uvm_pcie7_sh1::body().get_id());\n'
                     '  end\nendmodule\n')
        file = 'test/test_uvm_pcie7_sh1.sv'
        self.write(file, reference)
        s = self.start()
        self.assertIn('uvm_pcie7_sh1', self.names())
        s.open(file)
        self.assertTrue(any('uvm_pcie7_sh1' in d['message'] and d['severity'] == 1
                            for d in s.diags[s.uri(file)]['diagnostics']))
        for anchor, prefix, line, column in [
                ('uvm_pcie7_sh1 obj', '', 0, 6), ('obj.own_id', 'obj.', 1, 6),
                ('obj.get_id', 'obj.', 2, 15), ('uvm_pcie7_sh1::body', '', 0, 6),
                ('::body()', '::', 3, 32), ('body().get_id', 'body().', 2, 15)]:
            offset = reference.index(anchor) + len(prefix)
            query = s.at(file, reference[:offset].count('\n'),
                         offset - reference.rfind('\n', 0, offset) - 1)
            definitions = s.request('textDocument/definition', query)
            self.assertEqual(len(definitions), 1, (anchor, definitions))
            self.assertEqual(definitions[0]['uri'], s.uri('seq/uvm_pcie_sh1.sv'))
            self.assertEqual(definitions[0]['range']['start'], {'line': line, 'character': column})
            self.assertTrue(s.request('textDocument/hover', query), anchor)
        completions = s.request('textDocument/completion', s.at(file, 3, 17))
        self.assertIn('own_id', {item['label'] for item in completions})
        self.write('test/imported.sv', 'module imported; import hidden_pkg::*; '
                   'uvm_pcie7_sh1 obj; initial $display(obj.own_id); endmodule\n')
        s.open('test/imported.sv')
        text = (self.root / 'test/imported.sv').read_text()
        definitions = s.request('textDocument/definition', s.at('test/imported.sv', 0, text.index('own_id')))
        self.assertEqual(len(definitions), 1)
        self.assertEqual(definitions[0]['uri'], s.uri('seq/hidden_pkg.sv'))
        self.write('test/local.sv', 'module local_scope;\n'
                   'class uvm_pcie7_sh1; int own_id; endclass\n'
                   'uvm_pcie7_sh1 obj; initial $display(obj.own_id); endmodule\n')
        s.open('test/local.sv')
        definitions = s.request('textDocument/definition', s.at('test/local.sv', 2, 40))
        self.assertEqual(len(definitions), 1)
        self.assertEqual(definitions[0]['uri'], s.uri('test/local.sv'))
        self.assertEqual(definitions[0]['range']['start']['line'], 1)
        self.write('test/hidden.sv', 'module hidden; hidden_only obj; endmodule\n')
        s.open('test/hidden.sv')
        self.assertEqual(s.request('textDocument/definition', s.at('test/hidden.sv', 0, 15)), [])
        s.open('seq/uvm_pcie_sh1.sv')
        self.assertEqual(s.request('textDocument/definition', s.at('seq/uvm_pcie_sh1.sv', 0, 28)), [])
        s.change('seq/uvm_pcie_sh1.sv', declaration.replace('own_id', 'changed'))
        self.assertEqual(s.request('textDocument/definition', s.at(file, 3, 17)), [])
        s.change('seq/uvm_pcie_sh1.sv', declaration, 3)
        self.assertTrue(s.request('textDocument/definition', s.at(file, 3, 17)))
        self.write('test/inherited.sv', 'module inherited;\nuvm_pcie7_sh1 obj;\n'
                   'initial $display(obj.inherited_id()); endmodule\n')
        s.open('test/inherited.sv')
        inherited = s.at('test/inherited.sv', 2, 21)
        self.assertEqual(s.request('textDocument/definition', inherited), [])
        self.write('seq/base.sv', 'class uvm_pcie7_comom_tools;\n'
                   '  function int inherited_id(); return 9; endfunction\nendclass\n')
        s.watched(('seq/base.sv', 1))
        definitions = s.request('textDocument/definition', inherited)
        self.assertEqual(len(definitions), 1)
        self.assertEqual(definitions[0]['uri'], s.uri('seq/base.sv'))
        self.assertEqual(definitions[0]['range']['start'], {'line': 1, 'character': 15})

    def test_SV_repeated_type_queries_keep_memory_bounded(self):
        fields = '\n'.join(f'logic [63:0] data_{i};' for i in range(500))
        params = ', '.join(f'input int arg{i}' for i in range(60))
        args = ', '.join(str(i) for i in range(60))
        cases = [
            ('virtual-interface', f'interface bus;\n{fields}\nmodport mp(output data_0);\n'
             'endinterface\nclass C; virtual bus.mp vif; endclass\n', 'bus.mp vif', 600),
            ('call-result', 'package p; typedef struct packed { int payload; } packet_t; '
             f"function automatic packet_t make_packet({params}); return '0; endfunction endpackage\n"
             f'module top; import p::*; initial $display(make_packet({args}).payload); endmodule\n',
             'payload);', 1500),
        ]
        self.config()
        for name, text, anchor, count in cases:
            with self.subTest(name=name):
                self.write('query.sv', text)
                s = self.start()
                try:
                    s.open('query.sv')
                    offset = text.index(anchor)
                    query = s.at('query.sv', text[:offset].count('\n'),
                                  offset - text.rfind('\n', 0, offset) - 1)
                    for _ in range(15):
                        self.assertTrue(s.request('textDocument/hover', query))
                    status = Path(f'/proc/{s.proc.pid}/status')
                    before = int(next(line.split()[1] for line in status.read_text().splitlines()
                                      if line.startswith('VmRSS:')))
                    for _ in range(count):
                        self.assertTrue(s.request('textDocument/hover', query))
                    after = int(next(line.split()[1] for line in status.read_text().splitlines()
                                     if line.startswith('VmRSS:')))
                    self.assertLess(after - before, 2 * 1024, f'{name}: grew {after - before} KiB')
                    self.assertTrue(s.request('textDocument/definition', query))
                    changed = text.replace('bus.mp vif', 'missing_bus.mp vif') if name == 'virtual-interface' \
                        else text.replace('int payload', 'int changed')
                    s.change('query.sv', changed)
                    self.assertFalse(s.request('textDocument/definition', query))
                    s.change('query.sv', text, 3)
                    self.assertTrue(s.request('textDocument/definition', query))
                finally:
                    s.close()
                    self.server = None

    def test_SV_macro_typedefs_are_indexed_cold_and_refresh_from_headers(self):
        self.config()
        self.write('types.svh', '`define DECL_T(n) typedef struct packed { int payload; } n;\n')
        self.write('wrapper.svh', '`include "types.svh"\n`define WRAP_T(n) `DECL_T(n)\n')
        self.write('packets.sv', '`include "wrapper.svh"\npackage packets;\n`WRAP_T(packet_t)\nendpackage\n')
        self.write('user.sv', 'module user; import packets::*; packet_t data; initial data.payload=1; endmodule\n')
        s = self.start()
        matches = s.request('workspace/symbol', {'query': 'packet_t'})
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0]['location']['uri'], s.uri('packets.sv'))
        self.assertEqual(matches[0]['location']['range']['start']['line'], 2)
        self.assertNotEqual(matches[0]['kind'], 0)
        s.open('user.sv')
        column = (self.root/'user.sv').read_text().index('payload')
        definitions = s.request('textDocument/definition', s.at('user.sv', 0, column))
        self.assertTrue(definitions)
        self.write('types.svh', '`define DECL_T(n) typedef struct packed { int changed; } n; typedef int added_t;\n')
        s.watched(('types.svh', 2))
        self.assertIn('added_t', self.names())
        self.assertEqual(s.request('textDocument/definition', s.at('user.sv', 0, column)), [])

    def test_F01_unsaved_reference_and_rename(self):
        self.config()
        self.write('child.sv', 'module child; endmodule\n')
        self.write('user.sv', 'module user; endmodule\n')
        s = self.start()
        s.open('child.sv'); s.open('user.sv')
        s.change('user.sv', 'module user; child fresh_inst(); endmodule\n')
        for file, column in [('child.sv', 8), ('user.sv', 14)]:
            references = s.request('textDocument/references', {**s.at(file, 0, column), 'context': {'includeDeclaration': True}})
            self.assertEqual({r['uri'] for r in references}, {s.uri('child.sv'), s.uri('user.sv')})
            edits = s.request('textDocument/rename', {**s.at(file, 0, column), 'newName': 'renamed'})
            self.assertEqual(set(edits['changes']), {s.uri('child.sv'), s.uri('user.sv')})
            for uri, changes in edits['changes'].items():
                self.assertEqual(len(changes), 1)
                self.assertEqual(changes[0]['newText'], 'renamed')
                self.assertEqual(changes[0]['range']['end']['character']-changes[0]['range']['start']['character'], 5)
        texts = {'child.sv': 'module child; endmodule\n',
                 'user.sv': 'module user; child fresh_inst(); endmodule\n'}
        for file, source in texts.items():
            edit = edits['changes'][s.uri(file)][0]
            start, end = edit['range']['start']['character'], edit['range']['end']['character']
            self.assertEqual(source[start:end], 'child')
            updated = source[:start] + edit['newText'] + source[end:]
            s.change(file, updated, 3)
            self.write(file, updated)
            s.notify('textDocument/didSave', {'textDocument': {'uri': s.uri(file)}, 'text': updated})
        references = s.request('textDocument/references', {**s.at('child.sv', 0, 8), 'context': {'includeDeclaration': True}})
        self.assertEqual({r['uri'] for r in references}, {s.uri('child.sv'), s.uri('user.sv')})

    def test_F02_delete_recreate_and_open_buffer_ownership(self):
        self.config()
        for ext in ['svh', 'sv', 'v']:
            self.write(f'defs.{ext}', '`define WIDTH 8\n')
            self.write(f'top_{ext}.sv', f'`include "defs.{ext}"\nmodule top_{ext};\nlocalparam int W=`WIDTH;\nendmodule\n')
        s = self.start()
        for ext in ['svh', 'sv', 'v']:
            with self.subTest(extension=ext):
                top, header = f'top_{ext}.sv', f'defs.{ext}'
                s.open(top)
                self.assertRegex(s.hover(top, 2, 15), r'\b8\b')
                (self.root / header).unlink(); s.watched((header, 3))
                codes = [d.get('code') for d in s.diags[s.uri(top)]['diagnostics']]
                self.assertIn('CouldNotOpenIncludeFile', codes)
                self.write(header, '`define WIDTH 16\n'); s.watched((header, 1))
                self.assertRegex(s.hover(top, 2, 15), r'\b16\b')
                self.write('replacement.tmp', '`define WIDTH 32\n')
                (self.root / 'replacement.tmp').replace(self.root / header)
                s.watched((header, 2))
                self.assertRegex(s.hover(top, 2, 15), r'\b32\b')
                (self.root / header).rename(self.root / (header + '.renamed'))
                s.watched((header, 3), (header + '.renamed', 1))
                self.assertIn('CouldNotOpenIncludeFile', [d.get('code') for d in s.diags[s.uri(top)]['diagnostics']])
                (self.root / (header + '.renamed')).rename(self.root / header)
                s.watched((header + '.renamed', 3), (header, 1))
                self.assertRegex(s.hover(top, 2, 15), r'\b32\b')
                s.open(header); s.change(header, '`define WIDTH 99\n')
                (self.root / header).unlink(); s.watched((header, 3))
                self.assertRegex(s.hover(top, 2, 15), r'\b99\b')

    def test_F03_markup_uses_ordinary_indexing_and_diagnostics(self):
        self.config(flags='-I inc')
        self.write('ordinary.sv', '// <perl>example</perl>\nmodule ordinary; endmodule\n')
        self.write('inc/defs.svh', '// <pl>$value</pl>\n`define WIDTH 8\n')
        self.write('dependent.sv', '`include "defs.svh"\nmodule dependent; localparam int W=`WIDTH; endmodule\n')
        self.write('invalid.sv', 'module invalid; logic sig_<pl>$name</pl>; endmodule\n')
        s = self.start()
        self.assertTrue({'ordinary', 'dependent'} <= self.names())
        s.open('ordinary.sv')
        self.assertEqual(s.diags[s.uri('ordinary.sv')]['diagnostics'], [])
        s.open('dependent.sv')
        self.assertRegex(s.hover('dependent.sv', 1, 35), r'\b8\b')
        s.open('invalid.sv')
        self.assertTrue(any(d['severity'] == 1 for d in s.diags[s.uri('invalid.sv')]['diagnostics']))

    def test_F06_conditional_metadata_uses_flags_nested_lists_and_headers(self):
        self.write('flags.f', '-f nested.f\n')
        self.write('nested.f', '-DENABLE_CHILD\n')
        self.config(flags='-f flags.f -I inc')
        self.write('conditional.sv', '`ifdef ENABLE_CHILD\nmodule conditional_child; endmodule\n`endif\n')
        self.write('inc/defs.svh', '`define ENABLE_HEADER\n')
        self.write('header_child.sv', '`include "defs.svh"\n`ifdef ENABLE_HEADER\nmodule header_child; endmodule\n`endif\n')
        self.write('top.sv', 'module top; conditional_child i(); header_child j(); endmodule\n')
        s = self.start(); s.open('top.sv')
        self.assertTrue({'conditional_child', 'header_child'} <= self.names())
        self.assertTrue(s.request('textDocument/definition', s.at('top.sv', 0, 14)))
        self.write('nested.f', '-UENABLE_CHILD\n'); s.watched(('nested.f', 2))
        self.assertNotIn('conditional_child', self.names())
        self.write('inc/defs.svh', '// removed\n'); s.watched(('inc/defs.svh', 2))
        self.assertNotIn('header_child', self.names())
        self.write('nested.f', '-DENABLE_CHILD\n'); s.watched(('nested.f', 2))
        self.assertIn('conditional_child', self.names())

    def test_F03_opened_new_header_replaces_cached_missing_path_before_watcher(self):
        self.config(flags='-I inc')
        self.write('inc/shadow.svh', '`define WIDTH 8\n')
        source = '`include "shadow.svh"\nmodule top; localparam int W=`WIDTH; endmodule\n'
        self.write('top.sv', source)
        s = self.start(); s.open('top.sv')
        column = source.splitlines()[1].index('W=')
        self.assertRegex(s.hover('top.sv', 1, column), r'\b8\b')
        # No watched-file event: opening the new editor buffer must supersede a
        # cached ENOENT from the earlier local include search.
        s.notify('textDocument/didClose', {'textDocument': {'uri': s.uri('top.sv')}})
        self.write('shadow.svh', '`define WIDTH 16\n')
        s.open('shadow.svh')
        s.open('top.sv')
        self.assertRegex(s.hover('top.sv', 1, column), r'\b16\b')

    def test_F07_index_scope_is_replaced_and_watch_events_respect_exclusions(self):
        self.config()
        self.write('a/keep.sv', 'module keep; endmodule\n')
        self.write('b/drop.sv', 'module drop; endmodule\n')
        s = self.start(); self.assertTrue({'keep','drop'} <= self.names())
        self.config(index=[{'dirs':['a']}]); s.watched(('.slang/server.json', 2))
        self.assertEqual(self.names(), {'keep'})
        self.write('b/drop.sv', 'module ghost; endmodule\n')
        self.write('b/new.sv', 'module ghost2; endmodule\n')
        s.watched(('b/drop.sv', 2), ('b/new.sv', 1)); self.assertEqual(self.names(), {'keep'})
        self.config(index=[{'dirs':['.'], 'excludeDirs':['b']}]); s.watched(('.slang/server.json', 2))
        s.watched(('b/drop.sv', 2)); self.assertEqual(self.names(), {'keep'})
        self.config(); s.watched(('.slang/server.json', 2))
        self.assertTrue({'keep','ghost','ghost2'} <= self.names())

    def test_F06_F07_header_outside_index_still_refreshes_in_scope_metadata(self):
        self.config(index=[{'dirs': ['rtl']}], flags='-I inc')
        self.write('inc/defs.svh', '`define SWITCH\n')
        self.write('rtl/conditional.sv', '`include "defs.svh"\n`ifdef SWITCH\nmodule enabled; endmodule\n`endif\n')
        s = self.start()
        self.assertEqual(self.names(), {'enabled'})
        self.write('inc/defs.svh', '// removed\n'); s.watched(('inc/defs.svh', 2))
        self.assertEqual(self.names(), set())
        self.write('inc/defs.svh', '`define SWITCH\n'); s.watched(('inc/defs.svh', 2))
        self.assertEqual(self.names(), {'enabled'})

    def test_F08_bad_config_does_not_swallow_source_events(self):
        self.config()
        self.write('defs.svh', '`define WIDTH 8\n')
        self.write('top.sv', '`include "defs.svh"\nmodule top;\nlocalparam int W=`WIDTH;\nendmodule\n')
        s = self.start(); s.open('top.sv')
        self.write('.slang/server.json', '{broken'); s.watched(('.slang/server.json', 2))
        self.write('defs.svh', '`define WIDTH 16\n'); s.watched(('defs.svh', 2))
        self.assertRegex(s.hover('top.sv', 2, 15), r'\b16\b')
        self.config(); self.write('defs.svh', '`define WIDTH 32\n')
        s.watched(('.slang/server.json', 2), ('defs.svh', 2))
        self.assertRegex(s.hover('top.sv', 2, 15), r'\b32\b')

    def test_F13_F14_utf16_hover_links_and_workspace_ranges(self):
        self.config()
        self.write('multi.sv', 'module first; endmodule\nmodule second; endmodule\n')
        self.write('unicode.sv', 'module unicode(input logic b, output logic val);\n\n\n  /* 中文🙂 */ assign val=b;\nendmodule\n')
        s = self.start(); s.open('unicode.sv')
        self.assertIn('#L4,14', s.hover('unicode.sv', 3, 21))
        symbols = s.request('workspace/symbol', {'query':'second'})
        self.assertEqual(len(symbols), 1)
        self.assertEqual(symbols[0]['location']['range']['start'], {'line':1,'character':7})
        self.assertEqual(symbols[0]['location']['range']['end'], {'line':1,'character':13})

    def test_F18_F19_diagnostic_codes_and_optional_completion_context(self):
        self.config()
        self.write('small.sv', 'module small; logic s; assign s=1; endmodule\n')
        self.write('missing.sv', '`include "noexist.svh"\nmodule missing; endmodule\n')
        s = self.start(); s.open('missing.sv'); s.open('small.sv')
        self.assertIn('CouldNotOpenIncludeFile', [d.get('code') for d in s.diags[s.uri('missing.sv')]['diagnostics']])
        a = s.request('textDocument/completion', s.at('small.sv', 0, 30))
        b = s.request('textDocument/completion', {**s.at('small.sv', 0, 30), 'context':{'triggerKind':1}})
        self.assertEqual(a, b)
        self.assertTrue(s.hover('small.sv', 0, 19))

    def test_N08_N09_unrelated_topology_and_same_name_headers_are_targeted(self):
        self.config()
        for i in range(20):
            self.write(f'ip{i}/defs.svh', '`define WIDTH 8\n')
            self.write(f'ip{i}/top.sv', f'`include "defs.svh"\nmodule top{i}; localparam int W=`WIDTH; endmodule\n')
        s = self.start()
        for i in range(20): s.open(f'ip{i}/top.sv')
        before = (self.root / 'server.stderr').read_text().count('Analyzed ')
        self.write('unrelated.sv', 'module unrelated; endmodule\n')
        s.watched(('unrelated.sv', 1))
        self.assertEqual((self.root / 'server.stderr').read_text().count('Analyzed '), before)
        self.write('ip0/defs.svh', '`define WIDTH 16\n')
        s.watched(('ip0/defs.svh', 2))
        log = (self.root / 'server.stderr').read_text()
        self.assertEqual(log.count('Analyzed ') - before, 1)
        self.assertIn('Refreshing metadata for 2 files', log)
        self.assertRegex(s.hover('ip0/top.sv', 1, 28), r'\b16\b')
        self.assertRegex(s.hover('ip1/top.sv', 1, 28), r'\b8\b')

    def test_N15_scope_checks_ignore_ancestors_and_globs_match_new_paths(self):
        self.config(index=[{'dirs':['rtl'], 'excludeDirs':[self.root.name, self.root.parent.name]}])
        self.write('rtl/old.sv', 'module old; endmodule\n')
        s = self.start()
        self.write('rtl/fresh.sv', 'module fresh; endmodule\n')
        s.watched(('rtl/fresh.sv', 1))
        self.assertEqual(self.names(), {'old', 'fresh'})
        self.config(index=[], indexGlobs=[str(self.root/'rtl/*.sv')])
        s.watched(('.slang/server.json', 2))
        self.write('rtl/new.sv', 'module newest; endmodule\n')
        self.write('rtl/child/hidden.sv', 'module hidden; endmodule\n')
        s.watched(('rtl/new.sv', 1), ('rtl/child/hidden.sv', 1))
        self.assertEqual(self.names(), {'old', 'fresh', 'newest'})

    def test_N14_oversized_incremental_column_clamps_without_losing_next_edit(self):
        self.config()
        self.write('top.sv', 'module old; endmodule // 🙂\n')
        s = self.start(); s.open('top.sv')
        s.notify('textDocument/didChange', {
            'textDocument': {'uri':s.uri('top.sv'), 'version':2},
            'contentChanges':[
                {'range':{'start':{'line':0,'character':999},'end':{'line':0,'character':999}},'text':' appended'},
                {'range':{'start':{'line':0,'character':7},'end':{'line':0,'character':10}},'text':'fresh'}]})
        symbols=s.request('textDocument/documentSymbol', {'textDocument':{'uri':s.uri('top.sv')}})
        self.assertEqual(symbols[0]['name'], 'fresh')
        self.assertNotIn('Error handling notification', (self.root/'server.stderr').read_text())

    def test_N02_lightweight_index_distinguishes_comment_and_macro_includes(self):
        self.config()
        self.write('template.svh', 'parameter int <pl>$name</pl> = 1;\n')
        self.write('comment.sv', '// `include "template.svh"\nmodule comment_ok; endmodule\n')
        self.write('macro.sv', '`define HEADER "template.svh"\n`include `HEADER\nmodule hidden; endmodule\n')
        self.write('names.svh', '`define UNIT expanded_name\n')
        self.write('named.sv', '`include "names.svh"\nmodule `UNIT; endmodule\n')
        self.write('child.sv', 'module child; endmodule\n')
        self.write('guard.svh', '`define ENABLE_CHILD\n')
        self.write('guarded-use.sv', '`include "guard.svh"\nmodule guarded_use;\n`ifdef ENABLE_CHILD\nchild inst();\n`endif\nendmodule\n')
        s = self.start()
        self.assertIn('comment_ok', self.names())
        self.assertIn('expanded_name', self.names())
        self.assertIn('hidden', self.names())
        s.open('child.sv')
        references = s.request('textDocument/references', {**s.at('child.sv', 0, 8), 'context':{'includeDeclaration':True}})
        self.assertIn(s.uri('guarded-use.sv'), {item['uri'] for item in references})

if __name__ == '__main__': unittest.main(verbosity=2)
