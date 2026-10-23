# Verilog/SystemVerilog Legacy

This fork of the [AndrewNolte Verilog/SystemVerilog extension](https://github.com/AndrewNolte/vscode-system-verilog) targets VS Code 1.84 on servers without a semantic language server. It keeps the upstream TextMate grammars, snippets, Ctags index, linters, hierarchy view and formatters, and adds:

- **Hovers** show the declaration, the default value of parameters and object-like macros computed through other parameters, macros, imported packages and `pkg::` references (`= 2048 (0x800)`), the comment above or after the declaration, related parameters, and a link to the file and line.
- **Go to definition** looks in the enclosing module first, then the rest of the file, then imported packages, so a port such as `clk_i` resolves to one place. Modules, interfaces and packages are found by name even when the file is named differently.
- **Macros** from `.svh`, `.vh` and other source files are indexed, so `` `NAME `` hovers and jumps to its `` `define ``.
- **Semantic highlighting** colors parameters, ports, signals, instances, types, modules and functions by what the index says they are.
- **Filelist** support: `verilog.filelist` adds the listed sources to the index, its `+incdir+`/`-I` directories to include lookup, its `+define+`/`-D` macros to dim inactive `` `ifdef `` branches, and passes it to linters with `-f`.

Values are computed lexically from defaults; parameter overrides at instantiations are not applied. Ctags runs on the editor text with macro calls blanked out, so a macro inside a port or parameter list no longer hides the rest of the list. A module whose name is itself a macro is not indexed.

## Install

```sh
code --install-extension verilog-systemverilog-legacy-0.2.1.vsix
```

Requirements on the machine running the extension host: [Universal Ctags](https://github.com/universal-ctags/ctags), and for linting [slang](https://github.com/MikePopoloski/slang) (or another linter supported upstream).

## Configure

For a single-folder workspace, `scripts/hdl-setup` (Python 2.7 or 3) writes an initial `.vscode/hdl.f` and sets the extension's settings while keeping unrelated ones. The filelist lists the `.v`, `.vl` and `.sv` files with packages first, leaves out files that other files `` `include ``, and adds the `-I` directories those `` `include `` lines need; includes it cannot find in the workspace are printed. Slang arguments go after `--`:

```sh
scripts/hdl-setup /path/to/workspace -- --top my_top -Wextra
```

The resulting settings, which can also be written by hand:

```json
{
  "verilog.filelist": ".vscode/hdl.f",
  "verilog.ctags.path": "ctags",
  "verilog.lint.slang.enabled": true,
  "verilog.lint.slang.path": "slang",
  "verilog.lint.slang.args": "--top my_top -Wextra"
}
```

Review the generated filelist for the real source selection and macros, then run **Verilog: Reindex**. Reindex again after editing the filelist. Without a filelist, all `**/*.{sv,v}` and `**/*.{svh,vh}` files of the workspace are indexed and linters check the current file. The full list of settings is in [CONFIG.md](CONFIG.md).

Themes decide the colors of semantic tokens. Ports and instances use their own token types (`port`, `instance`), which fall back to parameter and variable colors; to give them distinct colors:

```json
"editor.semanticTokenColorCustomizations": {
  "rules": { "port": "#D7BA7D", "instance": { "italic": true } }
}
```

## With vscode-slang

When the [vscode-slang](https://github.com/hudson-trading/slang-server) extension is installed, this extension leaves hovers, definitions, completions, diagnostics, the hierarchy views and the language client to it and only adds semantic highlighting.
