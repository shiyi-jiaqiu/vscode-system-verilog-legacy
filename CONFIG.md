## Configuration Settings

- `verilog.ctags.path`: path

  Platform Defaults:

    linux:   `ctags-universal`

    mac:     `ctags`

    windows: `ctags.exe`


- `verilog.filelist`: string = ""

    Project filelist relative to the workspace root. Its source files are indexed, +incdir+/-I directories are searched for includes, +define+/-D macros select the active `ifdef branches, and linters get it with -f instead of the current file. Run Reindex after editing it.


- `verilog.moduleGlobs`: array = []

    Without `verilog.filelist`: globs of the module, interface and package files to index


- `verilog.includeGlobs`: array = []

    Without `verilog.filelist`: globs of the include files to index


- `verilog.excludeGlob`: string = ""

    Without `verilog.filelist`: glob of the files the other globs leave out


- `verilog.lint.slang.args`: string = ""

    slang arguments, such as `-j 2`, `-Wextra`, `-Wwidth-trunc -Wport-width-trunc`, `--suppress-warnings ip/**`, `--lint-only`, `--error-limit 100` or `--top name`. The extension reads the diagnostics with `--diag-json`, so do not pass that.


- `verilog.lint.slang.path`: path

  Platform Defaults:

    linux:   `slang`

    mac:     `slang`

    windows: `slang.exe`


- `verilog.lint.slang.enabled`: boolean = true

    Check with slang: the whole project when `verilog.filelist` is set or a top module is selected, otherwise the current file


- `verilog.lint.slang.runOnSave`: boolean = true

    Check when the first Verilog file opens and after saves. When off, only the Verilog: Lint command checks.


- `verilog.format.args`: string = ""

    verible-verilog-format arguments, such as `--indentation_spaces=4`


- `verilog.format.path`: path

  Platform Defaults:

    linux:   `verible-verilog-format`

    mac:     `verible-verilog-format`

    windows: `verible-verilog-format.exe`


