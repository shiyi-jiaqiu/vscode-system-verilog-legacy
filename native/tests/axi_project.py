#!/usr/bin/env python3
"""Validate AXI interfaces and macro-generated structs against an unmodified PULP AXI checkout.

Usage: axi_project.py SERVER AXI_REPOSITORY --slang SLANG
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

# The existing protocol harness consumes SERVER from sys.argv.
from review_protocol import Server


def check(axi, slang):
    with tempfile.TemporaryDirectory(prefix='verilog-axi-') as temporary:
        root = Path(temporary)
        source = '''`include "axi/typedef.svh"
module axi_smoke;
  typedef logic [31:0] addr_t;
  typedef logic [63:0] data_t;
  typedef logic [7:0] strb_t;
  typedef logic [3:0] id_t;
  typedef logic user_t;
  `AXI_TYPEDEF_ALL(smoke, addr_t, id_t, data_t, strb_t, user_t)
  smoke_req_t req;
  AXI_BUS #(.AXI_ADDR_WIDTH(32), .AXI_DATA_WIDTH(64), .AXI_ID_WIDTH(4), .AXI_USER_WIDTH(1)) bus();
  function automatic smoke_req_t make_req(); return '0; endfunction
  initial begin
    req.aw.addr = '0;
    req.w.data = '0;
    bus.aw_addr = '0;
    $display(make_req().aw.addr);
  end
endmodule
'''
        (root / 'axi_smoke.sv').write_text(source)
        (root / '.slang').mkdir()
        (root / '.slang/server.json').write_text(json.dumps({
            'index': [{'dirs': [str(root), str(axi / 'src')]}], 'indexingThreads': 1,
            'incdirs': [str(axi / 'include')]}))
        server = Server(root)
        try:
            symbols = server.request('workspace/symbol', {'query': 'smoke_req_t'})
            assert len(symbols) == 1, symbols
            assert symbols[0]['location']['uri'] == server.uri('axi_smoke.sv'), symbols
            assert symbols[0]['location']['range']['start']['line'] == 7, symbols
            server.open('axi_smoke.sv')
            interface = axi / 'src/axi_intf.sv'
            address_line = next(i for i, line in enumerate(interface.read_text().splitlines())
                                if 'aw_addr;' in line)
            for anchor, prefix, target, target_line in [
                ('req.aw.addr', 'req.aw.', root / 'axi_smoke.sv', 7),
                ('req.w.data', 'req.w.', root / 'axi_smoke.sv', 7),
                ('bus.aw_addr', 'bus.', interface, address_line),
                ('make_req().aw.addr', 'make_req().aw.', root / 'axi_smoke.sv', 7),
            ]:
                offset = source.index(anchor) + len(prefix)
                line = source[:offset].count('\n')
                column = offset - source.rfind('\n', 0, offset) - 1
                position = server.at('axi_smoke.sv', line, column)
                definitions = server.request('textDocument/definition', position)
                assert any(d['uri'] == target.as_uri() and d['range']['start']['line'] == target_line
                           for d in definitions), (anchor, definitions)
                assert server.request('textDocument/hover', position), anchor
                completion = server.request('textDocument/completion', {**position,
                    'context': {'triggerKind': 1}})
                items = completion['items'] if isinstance(completion, dict) else completion
                assert any(item['label'] == anchor[len(prefix):] for item in items), (anchor, items)
            assert not [d for d in server.diags[server.uri('axi_smoke.sv')]['diagnostics']
                        if d['severity'] == 1]
            run = subprocess.run([str(slang), '--single-unit', '--error-limit', '0',
                f'-I{axi / "include"}', str(axi / 'src/axi_pkg.sv'), str(axi / 'src/axi_intf.sv'),
                str(root / 'axi_smoke.sv'), '--top', 'axi_smoke', '--diag-json', str(root / 'cli.json')],
                cwd=root, capture_output=True, text=True, timeout=60)
            assert run.returncode == 0, run.stderr
            diagnostics = json.loads((root / 'cli.json').read_text())
            assert not [d for d in diagnostics if d['severity'] in ['error', 'fatal']], diagnostics
            print(json.dumps({'project': 'pulp-platform/axi', 'macro_type_index': 'pass',
                              'definition_hover_completion_checks': 4,
                              'native_errors': 0, 'full_cli_errors': 0}), flush=True)
        finally:
            server.close()
            if os.environ.get('VERILOG_TEST_EVIDENCE'):
                shutil.copytree(root, Path(os.environ['VERILOG_TEST_EVIDENCE']) / 'axi',
                                dirs_exist_ok=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('axi_repository', type=Path)
    parser.add_argument('--slang', type=Path, required=True)
    args = parser.parse_args()
    check(args.axi_repository.resolve(), args.slang.resolve())
