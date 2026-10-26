#!/usr/bin/env python3
"""Deterministic native review fixtures; compare the same command with both binaries.

No cold-cache claims. Thread count is one. Reports initialize and ready separately.
"""
import importlib.util
import json
from pathlib import Path
import re
import sys
import tempfile
import time

spec = importlib.util.spec_from_file_location('protocol', Path(__file__).with_name('review_protocol.py'))
protocol = importlib.util.module_from_spec(spec)
spec.loader.exec_module(protocol)
CHECK = '--check' in sys.argv
if CHECK: sys.argv.remove('--check')

def put(root, file, text):
    path = root / file
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)

def run(case, make, event=None):
    with tempfile.TemporaryDirectory(prefix='verilog-perf-') as temp:
        root = Path(temp)
        put(root, '.slang/server.json', json.dumps({'index': [{'dirs':['.']}], 'indexingThreads':1}))
        make(root)
        start = time.monotonic()
        s = protocol.Server(root)
        initialized = time.monotonic()
        symbols = s.request('workspace/symbol', {'query':''})
        ready = time.monotonic()
        rss = re.search(r'VmHWM:\s+(\d+)', Path(f'/proc/{s.proc.pid}/status').read_text())
        row = dict(case=case, initialize_ms=(initialized-start)*1000,
                   ready_ms=(ready-start)*1000, peak_rss_kib=int(rss[1]), symbols=len(symbols))
        if event:
            event(s, root, row)
        s.close()
        print(json.dumps(row), flush=True)
        if CHECK:
            # Broad smoke limits for this fixed fixture, plus exact work/count guards.
            # Run on an otherwise idle host; the JSON is retained on failure.
            assert row['initialize_ms'] < 1000, row
            if case == 'shared-header-600x20k': assert row['ready_ms'] < 5000, row
            if case == 'same-name-300-headers': assert row['change_ms'] < 150, row
            if case == 'unrelated-created': assert row['analyses'] == 0, row
            if case == 'netlist-20x7mb': assert row['peak_rss_kib'] < 180*1024, row
            if case == 'references-20000': assert row['references_ms'] < 1000, row

def shared(root):
    put(root, 'defs.svh', ''.join(f'`define MACRO_{i} {i}\n' for i in range(20000)))
    for i in range(600):
        put(root, f'm{i}.sv', f'`include "defs.svh"\nmodule m{i}; endmodule\n')

def ips(root):
    for i in range(300):
        put(root, f'ip{i}/defs.svh', ''.join(f'`define M{n} {n}\n' for n in range(1000)))
        put(root, f'ip{i}/top.sv', f'`include "defs.svh"\nmodule top{i}; endmodule\n')

def change(s, root, row):
    put(root, 'ip0/defs.svh', '`define NEW 16\n')
    start=time.monotonic(); s.watched(('ip0/defs.svh', 2))
    row['change_ms']=(time.monotonic()-start)*1000

def small(root):
    for i in range(20): put(root, f'm{i}.sv', f'module m{i}; endmodule\n')

def created(s, root, row):
    for i in range(20): s.open(f'm{i}.sv')
    before=(root/'server.stderr').read_text().count('Analyzed ')
    put(root, 'unrelated.sv', 'module unrelated; endmodule\n')
    start=time.monotonic(); s.watched(('unrelated.sv', 1))
    row['created_ms']=(time.monotonic()-start)*1000
    row['analyses']=(root/'server.stderr').read_text().count('Analyzed ')-before

def netlists(root):
    for i in range(20):
        body = ''.join(f'wire n{j}; assign n{j}=1\'b0;\n' for j in range(50000))
        padding = '/*' + 'netlist padding ' * ((7*1024*1024-len(body))//16) + '*/\n'
        put(root, f'net{i}.sv', f'module net{i};\n'+body+padding+'endmodule\n')

def references(root):
    put(root, 'refs.sv', 'module refs;\nwire x;\ninitial begin\n' + '$display(x);\n'*20000+'end\nendmodule\n')

def query_references(s, root, row):
    s.open('refs.sv')
    start=time.monotonic()
    refs=s.request('textDocument/references', {**s.at('refs.sv',1,5), 'context':{'includeDeclaration':True}})
    row['references_ms']=(time.monotonic()-start)*1000
    row['references']=len(refs)
    assert len(refs)==20001

selected = set(sys.argv[1:])
for case,make,event in [('shared-header-600x20k',shared,None),('same-name-300-headers',ips,change),('unrelated-created',small,created),('netlist-20x7mb',netlists,None),('references-20000',references,query_references)]:
    if not selected or case in selected:
        run(case,make,event)
