# Verilog/SystemVerilog Legacy

This fork of the [AndrewNolte Verilog/SystemVerilog extension](https://github.com/AndrewNolte/vscode-system-verilog) targets VS Code 1.84 on servers without a semantic language server. It keeps the upstream TextMate grammars, snippets, Ctags index and hierarchy view, checks code with slang, formats it with Verible, and adds:

- **Hovers** show the declaration, the default value of parameters and object-like macros computed through other parameters, macros, imported packages and `pkg::` references (`= 2048 (0x800)`), the comment above or after the declaration, related parameters, and a link to the file and line.
- **Go to definition** looks in the enclosing module first, then the rest of the file, then imported packages, so a port such as `clk_i` resolves to one place. Modules, interfaces and packages are found by name even when the file is named differently.
- **Macros** from `.svh`, `.vh` and other source files are indexed, so `` `NAME `` hovers and jumps to its `` `define ``. The hover of a macro, or of a parameter set from one, lists the macros and parameters its value goes through with their values and places, down to the number or to the name that is not defined. A macro is read where it is used, so a parameter name in its text is looked up in the module of the hover.
- **Semantic highlighting** colors parameters, ports, signals, instances, types, modules and functions by what the index says they are.
- **Filelist** support: `verilog.filelist` names the files to index (its sources and the headers in its `+incdir+`/`-I` directories, instead of the workspace globs), the directories for include lookup, the `+define+`/`-D` macros that select the active `` `ifdef `` branches, and is passed to slang with `-f`. Changes to the filelist file are picked up as by Reindex.
- **Project lint**: with a filelist, slang checks the project once when the first editor opens and after saves (one check for Save All), stopping a check still running; switching editors does not check again. An undefined macro, missing include or unknown module is reported at its first use in each file, with the other uses and the parse errors its missing text causes listed under it. When slang stops at its error limit (20 by default), the filelist shows that later files were not checked.
- **Perl templates**: Verilog with `<perl>...</perl>` blocks of Perl code and `<pl>...</pl>` Perl expressions is checked without running Perl. Slang reads copies, kept in the extension's storage, where the markup and the Verilog inside Perl loops and ifs (over any number of blocks) are blanked out, with lines and columns unchanged; markup within a line of Verilog becomes a placeholder name. What slang reports about the markup or right after it is dropped, and so are undeclared names in a file with markup, which the markup may declare; their number is shown at the first markup. The index, hovers and highlighting skip the markup, and the editor colors it as Perl.
- **Uses of a signal** in its module are highlighted under the cursor, assignments and declarations as writes, skipping comments, strings and `.port(` names; F7 and Shift+F7 go to the next and previous use.

Values are computed lexically from defaults; parameter overrides at instantiations are not applied. Ctags runs on the editor text with macro calls blanked out, so a macro inside a port or parameter list no longer hides the rest of the list. A module whose name is itself a macro is not indexed.

## Install

```sh
code --install-extension verilog-systemverilog-legacy-0.4.1.vsix
```

Requirements on the machine running the extension host: [Universal Ctags](https://github.com/universal-ctags/ctags), [slang](https://github.com/MikePopoloski/slang) for linting and [verible-verilog-format](https://github.com/chipsalliance/verible) for formatting.

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

Review the generated filelist for the real source selection and macros, then run **Verilog: Reindex**, which also checks the project again. Reindex again after editing the filelist. Without a filelist, the files matching `verilog.moduleGlobs` and `verilog.includeGlobs` (all `**/*.{sv,v}` and `**/*.{svh,vh}` files by default) are indexed and slang checks the current file. The full list of settings is in [CONFIG.md](CONFIG.md).

Slang checks are chosen with `verilog.lint.slang.args`, for example `-Wwidth-trunc -Wport-width-trunc` for truncating assignments and port connections (not reported by default), `-Wextra` for more warnings, `-Wno-<name>` to turn one off, `--suppress-warnings ip/**` for third-party code, `--error-limit 0` for no error limit, and on a slow or shared server `-j 2` to limit threads or `--lint-only` to skip elaborating the hierarchy (which misses errors across instances). With `verilog.lint.slang.runOnSave` off, only **Verilog: Lint** checks.

Formatting uses `verilog.format.path` and `verilog.format.args`; to format on save, turn on `editor.formatOnSave` for the `verilog` and `systemverilog` languages. To save work on a slow server, turn off `editor.semanticHighlighting.enabled` or `editor.inlayHints.enabled` for those languages.

Themes decide the colors of semantic tokens. Ports and instances use their own token types (`port`, `instance`), which fall back to parameter and variable colors; to give them distinct colors:

```json
"editor.semanticTokenColorCustomizations": {
  "rules": { "port": "#D7BA7D", "instance": { "italic": true } }
}
```

## With vscode-slang

When the [vscode-slang](https://github.com/hudson-trading/slang-server) extension is installed, this extension leaves hovers, definitions, completions, diagnostics, the hierarchy views and the language client to it and only adds semantic highlighting.
