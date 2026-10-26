# Independent review regressions

The review HTML covers extension commit `4be60e23e3b31cacc3851637ebdfc8e3b0a3156b`.
These tests recreate its minimal cases; the original evidence ZIP was not part of
this repair workspace. They do not replace target ABI or long-session acceptance.

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
verify event processing, not an OS watcher. The client template-shadow case uses
actual editor saves without saving its includer.

## Finding coverage

| Finding | Repair | Regression |
| --- | --- | --- |
| F01 | Merge live open-buffer reference metadata into query candidates | Native references and rename from both ends; apply/save edits and requery |
| F02 | Invalidate SourceManager lookup and dependent syntax on disk topology changes; retain editor-owned buffers | Native `.svh`, `.sv`, `.v` delete/create, atomic replace, rename, dirty header ownership |
| F03 | Reject template trees in metadata/dependency loads; route with effective native includes; rescan open dependency graphs on topology changes | Native unopened template exclusion/recovery; client native-only `-I`, local shadow creation/save and marker removal |
| F04 | Manual current-version result bypasses the save-only display gate | Client dirty manual Lint with both run-on-save values and further edits |
| F05 | Request byte columns and translate saved input snapshots to UTF-16 | Real syntax/local/full CLI after Chinese, emoji, tab and combining text; real notes and synthetic multiline ranges; compiler-discovered libraries/includes |
| F06 | Metadata uses effective preprocessor options and reparses dependents | Native flags, nested filelists, header macros, and headers outside index roots |
| F07 | Atomically replace index tables and enforce scope for watcher updates | Native shrink/exclude/restore plus out-of-scope source/header events |
| F08 | Continue dispatching source events while retaining the last valid config | Native malformed JSON, header edits and recovery in a mixed notification |
| F09 | Preserve package qualification and nearest lexical/import scope; avoid arbitrary constant candidates | Client same/separate-file packages, imports, completion, ambiguous imports, function and named-block shadows |
| F10 | Textual macro substitution and SV exponent precedence/associativity; conservative sizing limits | Client values 7/4/64 and rejected width-sensitive expressions |
| F11 | Resolve macros and header symbols through the requesting source's include closure | Client local/`-I` priority, nontraditional header extensions and dirty header updates |
| F12 | Use a filtered placeholder for dynamic template declarators | Client outline excludes fragments, `int` and placeholders while retaining static siblings |
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
