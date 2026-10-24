## Configuration Settings

- `verilog.ctags.path`: path

  Platform Defaults:

    linux:   `ctags-universal`

    mac:     `ctags`

    windows: `ctags.exe`


- `verilog.filelist`: string = ""

    Project filelist relative to the workspace root. Its sources are indexed, include paths and macros are used by lint and indexing, and changes reload automatically. Set verilog.lint.slang.scope to project to lint all sources.


- `verilog.moduleGlobs`: array = []

    Without `verilog.filelist`: globs of the module, interface and package files to index


- `verilog.includeGlobs`: array = []

    Without `verilog.filelist`: globs of the include files to index


- `verilog.excludeGlob`: string = ""

    Without `verilog.filelist`: glob of the files the other globs leave out


- `verilog.server.enabled`: boolean = true

    Use slang-server for standard Verilog navigation and diagnostics when available. Falls back to ctags and slang CLI if unavailable. Perl templates use static browsing only.


- `verilog.server.path`: string = ""

    Path to slang-server. Empty searches PATH and the directory containing the configured slang executable. Requires a binary compatible with this operating system.


- `verilog.lint.slang.args`: string = ""

    CLI fallback arguments only; native server options belong in .slang/server.json. Examples: `-j 2`, `-Wextra`, `--suppress-warnings ip/**`, `--lint-only`, `--error-limit 100` or `--top name`. Appended after the checkbox options; individual warning flags override warning groups. Do not pass `--diag-json`, which the extension uses to read diagnostics.


- `verilog.lint.slang.path`: path

  Platform Defaults:

    linux:   `slang`

    mac:     `slang`

    windows: `slang.exe`


- `verilog.lint.slang.enabled`: boolean = true

    Enable slang lint diagnostics.


- `verilog.lint.slang.scope`: string = "openFiles"

    CLI fallback scope. Open files checks .sv/.v editor tabs with filelist include paths and macros. Entire project checks the filelist or top; without either, checks open files. Built-in slang-server always displays diagnostics only for open source tabs.

    Options:
    - openFiles
    - project

- `verilog.lint.slang.runOnSave`: boolean = true

    Check when files open and after saves. When off, only the Verilog: Lint command checks.


- `verilog.lint.slang.analysis`: string = "local"

    CLI fallback only. Local lint skips full hierarchy elaboration; syntax skips type checking and most warnings; full checks instance-dependent behavior. Built-in slang-server uses native shallow analysis regardless of this setting.

    Options:
    - local
    - syntax
    - full

- `verilog.lint.slang.readingMode`: boolean = true

    Group missing includes/macros/packages into an information message and hide dependent undeclared-name errors. Turn off for strict diagnostics, including missing modules. Real name mistakes may also be hidden in files with incomplete dependencies.


- `verilog.lint.slang.threads`: integer = 1

    Threads per slang process. One reduces peak resource use. Checks run one process at a time; additional arguments can override this with -j.


- `verilog.lint.slang.reportMissingModules`: boolean = false

    Also report unknown modules, interfaces and programs in reading mode. Strict mode always reports them. Local lint does not check the full instance hierarchy.


- `verilog.lint.slang.warnings.widthTruncation`: boolean = true

    Report expression/port width truncation and lossy constant conversions.


- `verilog.lint.slang.warnings.widthExpansion`: boolean = false

    Report implicit expression/port width expansion.


- `verilog.lint.slang.warnings.signedness`: boolean = false

    Report implicit signedness conversions and comparisons of differently signed values.


- `verilog.lint.slang.warnings.portConnections`: boolean = true

    Report unconnected ports and explicitly empty input/inout connections.


- `verilog.lint.slang.warnings.implicitNets`: boolean = true

    Report implicitly declared wires, which can indicate misspelled signal names.


- `verilog.lint.slang.warnings.caseStatements`: boolean = true

    Report missing case defaults, duplicate/overlapping items and incomplete coverage.


- `verilog.lint.slang.warnings.unused`: boolean = false

    Report unused or undriven signals, ports, parameters and other declarations.


- `verilog.format.args`: string = ""

    verible-verilog-format arguments, such as `--indentation_spaces=4`


- `verilog.format.path`: path

  Platform Defaults:

    linux:   `verible-verilog-format`

    mac:     `verible-verilog-format`

    windows: `verible-verilog-format.exe`


