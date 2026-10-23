# Verilog/SystemVerilog Legacy

This branch adapts the [AndrewNolte Verilog/SystemVerilog extension](https://github.com/AndrewNolte/vscode-system-verilog) for VS Code 1.18.1 and has also been tested on VS Code 1.81.1. It retains the upstream TextMate grammars and snippets and provides workspace Ctags indexing, F12 definition lookup, hover, symbols, basic completion, and save-triggered Slang or Verilator diagnostics through the VS Code 1.18 API. The upstream MIT license is retained.

Install the packaged VSIX with `code --install-extension verilog-systemverilog-legacy-0.1.0.vsix` on the machine running VS Code 1.18.1 or 1.81.1. Install Universal Ctags with JSON output support and either `slang` or `verilator` there as separate executables. The extension runs the tools on the same machine as its VS Code extension host.

For a project with a tool filelist, set its path in VS Code settings. The filelist is passed to the linter with `-f`; source lines are also added to the Ctags index. All `.v`, `.vh`, `.sv`, and `.svh` files inside the opened workspace are indexed as well. Reindex manually after external dependencies or the filelist change.

```json
{
  "verilog.legacy.ctagsPath": "/path/to/ctags-universal",
  "verilog.legacy.filelist": ".vscode/rtl.f",
  "verilog.legacy.linter": "slang",
  "verilog.legacy.linterPath": "/path/to/slang",
  "verilog.legacy.lintArgs": []
}
```

For the RedMulE test repository, `bender checkout` followed by `mkdir -p .vscode && bender script flist-plus -t rtl > .vscode/rtl.f` produces an example project filelist. Open the repository root in VS Code. Use **Verilog Legacy: Reindex Workspace** after creating the filelist, and **Verilog Legacy: Lint Current File or Project** to run lint without saving. Lint runs on the whole filelist when one is configured, or on the saved file otherwise. Results appear in Problems; setup and command errors appear in the **Verilog Legacy** output channel.

For a single-folder workspace without a filelist, run `scripts/hdl-setup /path/to/workspace` (Python 3 required). It creates an initial `.vscode/hdl.f` from `.v`, `.vl`, and `.sv` files, adds include directories containing `.vh` or `.svh`, and configures `.vscode/settings.json` for the filelist and the toolkit's `ctags` and `slang` commands while preserving unrelated settings. Run VS Code through the toolkit launcher, which puts those commands on PATH. Review the generated filelist for the project's actual source selection and macros. Optional Slang arguments go after `--`, for example `scripts/hdl-setup /path/to/workspace -- --top my_top -Wextra`; they become `verilog.legacy.lintArgs`. Running it again keeps an existing filelist and can update those arguments.

This is a smaller implementation than the current upstream extension. Ctags locates lexical symbols, so conditional compilation and duplicate definitions can produce multiple F12 destinations. The current branch does not provide a module hierarchy or a SystemVerilog semantic language server.
