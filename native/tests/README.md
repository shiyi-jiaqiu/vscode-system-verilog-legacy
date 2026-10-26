# Independent review regressions

The review HTML covers extension commit `4be60e23e3b31cacc3851637ebdfc8e3b0a3156b`.
These tests recreate its minimal cases; the original evidence ZIP was not part of
this repair workspace. They do not replace target ABI or long-session acceptance.

## UVM projects

`uvm_projects.py` exercises the unmodified TinyALU sequence testbench from
[UVM Primer](https://github.com/raysalemi/uvmprimer/tree/4958c6f2a8099302d6a55660661556a5e95b3a9f/23_UVM_Sequences)
and the [Accellera UBus example](https://github.com/accellera/uvm/tree/69c55a3326379576b4946f79e133d64d69142daa/distrib/examples/integrated/ubus),
using the [current reference library](https://github.com/accellera-official/uvm-core/tree/78c06547a2a0a29b3dc9dcafae62b75b2ff61544).
The test uses temporary copies, selects the supplied SystemVerilog DUT for TinyALU,
and disables optional UVM DPI calls. It needs no simulator or modified vendor sources.

```sh
git clone https://github.com/raysalemi/uvmprimer.git /tmp/uvmprimer
git -C /tmp/uvmprimer checkout 4958c6f2a8099302d6a55660661556a5e95b3a9f
git clone https://github.com/accellera/uvm.git /tmp/uvm-reference
git -C /tmp/uvm-reference checkout 69c55a3326379576b4946f79e133d64d69142daa
git clone https://github.com/accellera-official/uvm-core.git /tmp/uvm-core
git -C /tmp/uvm-core checkout 78c06547a2a0a29b3dc9dcafae62b75b2ff61544
python3 native/tests/uvm_projects.py /absolute/path/to/slang-server \
  /tmp/uvmprimer /tmp/uvm-reference /tmp/uvm-core --slang /absolute/path/to/slang
```

Checks cover cold class indexing with declaration ranges, cross-file definitions
and hover, inheritance, factory creation, virtual interfaces and member calls.
Native lint must report an injected undeclared identifier and clear it after repair.
The CLI must accept both projects in parse and local-lint modes, and TinyALU in
full-elaboration mode. UBus full elaboration must report exactly two errors for its
obsolete `uvm_test_done` API, which the current library removed; those errors are
checked explicitly and remain visible. Compiler warnings remain visible. The original UVM library bundled with the
older `accellera/uvm` checkout has compatibility errors with slang 12; these checks
use the pinned `uvm-core` library instead. They validate editor/compiler behavior,
not simulation results. Set `VERILOG_TEST_EVIDENCE` to retain fixtures and protocol traffic.

## Common SystemVerilog declarations and member access

The feature categories follow the [slang language support list](https://sv-lang.com/language-support.html).
The results below describe the patched native editor service. Compiler language
support alone does not establish editor navigation support.

| Construct | Workspace search | Navigation checks |
| --- | --- | --- |
| module, interface, package | Existing | Instantiation, parameters and cross-file imports |
| modport and clocking block | Added | Interface ports, aliases, clocking signals and virtual handles |
| typedef struct/union, enum, aliases and nettypes | Added | Type references, nested fields and enum values |
| packed/unpacked arrays, dynamic arrays, queues, associative arrays | Named typedefs added | Element field selection; queue-method return values |
| class and interface class | Class search added in the preceding UVM repair | Inheritance, implementation, parameters, extern methods and factory calls |
| function/task | Added | Calls and return-value members |
| property, sequence and let | Added | SVA and let references |
| covergroup | Added | Named covergroup type references |
| macro-generated typedefs | Added | Cold discovery, declaration locations and header refresh |

The `[sv-features]` C++ cases protect declaration search and member navigation,
hover and completion after calls, casts, parentheses, conditional expressions and
queue-method calls. The public-protocol macro case also checks a transitive macro
header before opening any source, then edits that header and requeries the index.
Workspace search collects named declarations in design scopes; local variables
and anonymous types are not separately added to that global search. Compiler
built-in methods such as `covergroup.sample()` have no source declaration for F12.

`axi_project.py` additionally checks the unmodified
[PULP AXI repository](https://github.com/pulp-platform/axi/tree/70b8e54fd460e3308e58be596ceb3566a6e3576e).
Its small consumer uses the actual `AXI_TYPEDEF_ALL` macros, `AXI_BUS` interface,
and AXI package. It checks cold type search, nested field definitions, hover,
completion and full CLI elaboration without requiring a simulator.

```sh
git clone https://github.com/pulp-platform/axi.git /tmp/axi
git -C /tmp/axi checkout 70b8e54fd460e3308e58be596ceb3566a6e3576e
python3 native/tests/axi_project.py /absolute/path/to/slang-server /tmp/axi \
  --slang /absolute/path/to/slang
```

## Run

Build the matching native binary using [../README.md](../README.md), then from the
extension root:

```sh
npm ci --ignore-scripts
SLANG_SERVER_PATH=/absolute/path/to/slang-server \
CTAGS_PATH=/absolute/path/to/ctags \
SLANG_PATH=/absolute/path/to/slang \
npm run test-headless

python3 native/tests/review_protocol.py /absolute/path/to/slang-server -v
ctest --test-dir /absolute/path/to/slang-server-build --output-on-failure -j 3
npm run lint
npm run package
```

`test-headless` requires Xvfb; use `npm test` on a graphical desktop. The runner
uses official VS Code **1.84.2**, isolated user/extensions directories and a temporary
workspace. It builds `dist/main.js` before launching the manifest entry point.
Set `VSCODE_EXECUTABLE_PATH` to a previously downloaded 1.84.2 executable if the
Node downloader cannot use your network proxy. Tool paths should be absolute;
Electron can load a different login-shell PATH. Ctags and slang are checked before
launch, and the complete review suite fails explicitly if `SLANG_SERVER_PATH` is
missing. The CLI must support `--diag-column-unit=byte` (tested with slang 12).

For debugging, `VERILOG_TEST_GREP` selects Mocha tests,
`VERILOG_TEST_EXTENSION_PATH` runs the same suite against an unpacked/installed VSIX directory,
`VERILOG_TEST_HOST_LOGS` retains extension-host logs, and `VERILOG_TEST_EVIDENCE`
retains native fixtures, stderr and both directions of public LSP traffic. Native
requests have timeouts and each server child has a 2 GiB address-space cap. The
protocol watcher cases explicitly send `workspace/didChangeWatchedFiles`; they
verify event processing, not an OS watcher. The client include-shadow case uses
actual editor saves without saving its includer.

## Finding coverage

| Finding | Repair | Regression |
| --- | --- | --- |
| F01 | Merge live open-buffer reference metadata into query candidates | Native references and rename from both ends; apply/save edits and requery |
| F02 | Invalidate SourceManager lookup and dependent syntax on disk topology changes; retain editor-owned buffers | Native `.svh`, `.sv`, `.v` delete/create, atomic replace, rename, dirty header ownership |
| F03 | Use ordinary HDL analysis for all sources; retain effective native includes | Native markup in comments preserves metadata/hover, unexpanded markup produces syntax errors; client native-only `-I` and local shadow save |
| F04 | Manual current-version result bypasses the save-only display gate | Client dirty manual Lint with both run-on-save values and further edits |
| F05 | Request byte columns and translate saved input snapshots to UTF-16 | Real syntax/local/full CLI after Chinese, emoji, tab and combining text; real notes and synthetic multiline ranges; compiler-discovered libraries/includes |
| F06 | Metadata uses effective preprocessor options and reparses dependents | Native flags, nested filelists, header macros, and headers outside index roots |
| F07 | Atomically replace index tables and enforce scope for watcher updates | Native shrink/exclude/restore plus out-of-scope source/header events |
| F08 | Continue dispatching source events while retaining the last valid config | Native malformed JSON, header edits and recovery in a mixed notification |
| F09 | Preserve package qualification and nearest lexical/import scope; avoid arbitrary constant candidates | Client same/separate-file packages, imports, completion, ambiguous imports, function and named-block shadows |
| F10 | Textual macro substitution and SV exponent precedence/associativity; conservative sizing limits | Client values 7/4/64 and rejected width-sensitive expressions |
| F11 | Resolve macros and header symbols through the requesting source's include closure | Client local/`-I` priority, nontraditional header extensions and dirty header updates |
| F12 | Removed with template masking | The former filtered-outline test no longer applies |
| F13 | Convert native hover-link columns through the UTF-16 helper | Native Unicode link target |
| F14 | Return declaration ranges with workspace symbols | Native second module has its actual line/range |
| F15 | Cancel startup before lifecycle queueing, bound initialization, terminate child and settle client startup | Client never-replying server: disable, timeout, PID exit, no unhandled rejection, then real native startup |
| F16 | Cancel affected checks and clear affected results on HDL edits; reject changed saved inputs | Client delayed CLI result after an unsaved correction is discarded |
| F17 | Notify the Raw content provider whenever CLI results change or clear | Client already-open Raw view clears and displays the next clean result |
| F18 | Supply stable native diagnostic codes and classify missing dependencies by code | Native code; client reading/strict mode missing-include result |
| F19 | Default omitted completion context to `Invoked` | Native absent and explicit context return the same result; subsequent request succeeds |

The original twelve regression cases remain enabled. Test-entry corrections also
remove the unconditional early return and workspace-changing host restart from
the former activation test. Environment-specific performance, full elaboration,
Windows/macOS, external slang-extension coexistence, long sessions and CentOS 7
release acceptance are outside these focused checks.

## Follow-up review of 4998dac

[Cross-validation and N1–N17 repairs](review2.md) add real-host scope/import/macro,
CLI isolation, library/include, encoding and lifecycle cases. A fixed, nonempty
hover golden is enabled. The runner starts with product defaults for run-on-save
and reading mode; individual suites explicitly select the modes they exercise.

Run `python3 native/tests/review_benchmark.py /path/to/slang-server --check` on an
otherwise idle host for the bounded native performance fixtures. The command prints
JSON measurements and fails on the stated broad limits, including exact zero work
for unrelated creation. Omit `--check` to measure a baseline expected to fail those
limits. The host suite separately guards block-rich symbol-building latency/scaling.
