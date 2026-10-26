# Verilog/SystemVerilog Legacy

This fork of the [AndrewNolte Verilog/SystemVerilog extension](https://github.com/AndrewNolte/vscode-system-verilog) targets VS Code 1.84, including CentOS 7 / glibc 2.17 hosts. An integrated client uses [slang-server](https://github.com/hudson-trading/slang-server) for standard Verilog and SystemVerilog; Ctags and the slang CLI provide a fallback when the server is unavailable. The fallback keeps the upstream TextMate grammars, snippets, Ctags index and hierarchy view, checks code with slang, formats it with Verible, and adds:

- **Hovers** show the declaration, the default value of parameters and object-like macros computed through other parameters, macros, imported packages and `pkg::` references (`= 2048 (0x800)`), the comment above or after the declaration, related parameters, and a link to the file and line.
- **Go to definition** searches the nearest lexical scope, enclosing scopes and their explicit imports; qualified names retain their package, so sibling packages and blocks do not supply an unrelated declaration. Modules, interfaces and packages are found by name even when the file is named differently.
- **Macros** from `.svh`, `.vh` and other source files are indexed, so `` `NAME `` hovers and jumps to its `` `define ``. The hover of a macro, or of a parameter set from one, lists the macros and parameters its value goes through with their values and places, down to the number or to the name that is not defined. A macro is read where it is used, so a parameter name in its text is looked up in the module of the hover.
- **Semantic highlighting** colors parameters, ports, signals, instances, types, modules and functions by what the index says they are.
- **Filelist** support: `verilog.filelist` names the files to index (its sources and the headers in its `+incdir+`/`-I` directories, instead of the workspace globs), the directories for include lookup, the `+define+`/`-D` macros that select the active `` `ifdef `` branches, and supplies the lint include paths and macros. In project lint mode, it is passed to slang with `-f`. Nested `-f` / `-F` lists, quoted paths, comments and `$VAR` / `${VAR}` / `$(VAR)` expansion from the extension host environment are supported. `-f` retains the current directory; `-F` resolves paths relative to that list. Nested lists are watched too; malformed lists retain the last valid configuration and report an error.
- **Lint** defaults to the `.sv` and `.v` files in open editor tabs. Opening or saving a file checks that file; switching tabs does not repeat the check, and closing the last tab for a file clears its diagnostics. Saving a header rechecks affected open sources. Checks run one process at a time, with one slang thread by default. Set `verilog.lint.slang.scope` to `project` to check the full filelist or selected top, with one check after Save All. Missing definitions are grouped at their first use in each file. If slang reaches its error limit, a diagnostic explains that checking stopped.
- **Uses of a signal** in its module are highlighted under the cursor, assignments and declarations as writes, skipping comments, strings and `.port(` names; F7 and Shift+F7 go to the next and previous use.

Values are computed lexically from defaults; parameter overrides at instantiations are not applied. Expressions involving based literals, packed or unsigned declarations, or integer overflow are left unevaluated instead of displaying a value without the required SystemVerilog sizing rules. Ctags runs on the editor text with macro calls blanked out, so a macro inside a port or parameter list no longer hides the rest of the list. A module whose name is itself a macro is not indexed.

## Install

```sh
code --install-extension verilog-systemverilog-legacy-0.6.4.vsix
```

Requirements on the machine running the extension host: [Universal Ctags](https://github.com/universal-ctags/ctags), [slang](https://github.com/MikePopoloski/slang) for linting and [verible-verilog-format](https://github.com/chipsalliance/verible) for formatting.

## Language engine

`verilog.server.enabled` defaults to on. Set `verilog.server.path` to a compatible `slang-server` executable; an empty path searches PATH and the configured slang executable's directory. The VSIX embeds the client, so the upstream VS Code extension is not required. This version uses the `0.3.1+60857ce-legacy0.6.4` server, based on upstream commit `60857ce` with the [included patch](native/README.md). Upgrade both the VSIX and native service to receive the UVM and SystemVerilog indexing/navigation repairs. The client waits for the server’s effective include configuration before routing documents; startup can be cancelled; `verilog.server.startupTimeout` bounds the protocol handshake (15 seconds by default). Metadata indexing runs after the handshake. The 0.6.4 Linux x86_64 offline kit includes the matching server built with GCC 11.4 against a glibc 2.17 sysroot. Servers older than `legacy0.6.2` retain the template exclusions.

The native engine provides semantic hovers, definitions, completion, references, rename, workspace symbols using shallow analysis. Incoming call hierarchy requires a selected elaborated design; default shallow mode can return no hierarchy, and outgoing call hierarchy is unsupported. It indexes source metadata across the workspace and analyzes open files with referenced design units. It does not run make or a simulator as part of this extension's setup. Existing native server configurations remain in effect.

Diagnostics are displayed only for open `.sv` / `.v` editor tabs and only when their server version matches the current document. Manual **Verilog: Lint** publishes the current buffer result, including unsaved edits with either run-on-save setting, and shows a waiting status until that version arrives. Further edits invalidate the manual result. **Verilog: Show Raw Diagnostics** opens the unfiltered result, including errors hidden by reading mode. A server without the effective-include handshake falls back to Ctags/CLI after the startup timeout; use the matching patched binary. Unversioned diagnostics remain hidden because their freshness cannot be checked. The lint enable checkbox, run-on-save/manual mode, warning checkboxes, reading mode and indexing thread count also control this engine. Inactive branches are dimmed from the native preprocessor result, including macros from headers. Syntax highlighting remains active; the Ctags semantic-token provider and global Ctags index are disabled while the native server owns standard files. The built-in client does not include the upstream hierarchy sidebar; its document outline and references are available through VS Code.

The extension writes filelist include paths and macros to `.slang/local/verilog-editor.f`, referenced by `.slang/local/server.json`. Warning checkboxes use its `diagnosticWarnings` field; the thread setting updates `indexingThreads`. Other local JSON fields, flags, comments and trailing commas are preserved. Invalid JSON is reported without overwriting it.

**Verilog: Configure Native Index** opens `.slang/server.json`. If absent, it creates an editable `index` entry from filelist source directories (or the workspace root). Existing configurations are opened unchanged. Edit `dirs` and `excludeDirs` there; exclusions accept directory names or `./relative/paths`, not wildcards. **Verilog: Auto-configure Native Index and Includes** invokes the upstream server's discovery command and opens the resulting configuration. Native workspace, user and local index entries combine. Directory indexing includes sources absent from the filelist; it is not an exact source whitelist.

Warning, reading-mode, thread-count and filelist updates reload the server configuration without restarting its process. Rapid settings changes are combined, and unchanged generated files are left alone. Display controls only filter cached diagnostics. Warning toggles reuse parsed analysis, preprocessor macro/include changes rebuild analysis and metadata so conditional declarations stay discoverable, and changes to index roots/exclusions/environment/thread count restart indexing. Edits to included `.sv`/`.v` files and headers update affected open sources, including multiple files changed together. If the server exits, navigation, highlighting and the hierarchy sidebar return to the Ctags fallback; **Verilog: Reindex** retries the native server.

`verilog.lint.slang.analysis`, `.scope`, `.args`, and `.path` configure the **CLI fallback only**. Native slang-server always uses its shallow analysis and its own configuration. To use full project CLI checks, switch off `verilog.server.enabled`.

Files are passed to the selected HDL tools without special handling for embedded scripts or unexpanded `<perl>` / `<pl>` markup. Generate valid Verilog/SystemVerilog before analysis or formatting.

The language status shows the active engine or a startup failure. The integrated server currently supports a single-folder workspace.

To hide selected diagnostic types, add their exact codes to User or Workspace settings:

```json
"verilog.lint.slang.ignoredDiagnostics": [
  "ExpectedMember",
  "ExpectedDeclarator",
  "NotAllowedInCU",
  "ExpectedExpression",
  "ExpectedIdentifier",
  "unknown-sys-name"
]
```

The default list is empty. This filters Problems from both the built-in server and CLI fallback; **Show Raw Diagnostics** keeps the original results. Parsing and the compiler error limit are unchanged. Built-in server results update when the setting changes; with manual CLI lint, run **Verilog: Lint** again after changing it.

The CLI must support `--diag-column-unit=byte` and `--all-deps` (tested with slang 12). The extension translates diagnostic endpoints and notes from original saved bytes using `files.encoding`, loading only files mentioned in diagnostics. Its compiler dependency list also covers libraries and macro includes. Unavailable source/encoding retains the reported file and line with an explicit unknown-column note. Save affected sources and headers before CLI lint. Editing an input cancels affected checks and clears affected results, including an open Raw view; unrelated files keep their saved diagnostics. In project scope, editing any compiler input clears the project result because library changes can affect diagnostics in other files. Native manual lint uses the current editor buffer.

## Configure the CLI fallback

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
  "verilog.lint.slang.scope": "project",
  "verilog.lint.slang.args": "--top my_top -Wextra"
}
```

Review the generated filelist for source selection and macros. Filelist changes reload automatically; **Verilog: Reindex** also refreshes the index and lint. Without a filelist, the workspace globs select the files to index. The full list of settings is in [CONFIG.md](CONFIG.md).

Open Settings and search `verilog.lint.slang`. Choose **User** for global defaults or **Workspace** to save project choices in `.vscode/settings.json`. The scope dropdown defaults to `openFiles`; choose `project` when dependencies in other source files need to be compiled together. Open-file mode takes only include paths and macros from the filelist; other filelist options apply in project mode.

The checkboxes follow [slang's warning options](https://www.sv-lang.com/warning-ref.html): width truncation (including lossy constants), port connections, implicit nets, and case checks are on by default. Width expansion, signedness, unused declarations and missing modules are off. Reading mode is on by default: missing includes/macros/packages and dependent undeclared-name diagnostics become one information message per affected file. Nested includes propagate this dependency context to their includers. Real name mistakes can also be hidden in an affected file. Turn off `verilog.lint.slang.readingMode` for strict dependency diagnostics, including missing modules. Unrelated syntax errors and name errors in dependency-complete files remain visible.

`verilog.lint.slang.analysis` chooses the cost and coverage: `local` (default) runs `--lint-only`, skipping full hierarchy elaboration; `syntax` runs `--parse-only` without type checking; `full` checks instance-dependent behavior. Most warning checkboxes require local or full analysis; port connections and other hierarchy-dependent checks need full analysis. `verilog.lint.slang.threads` defaults to 1; increasing it can trade memory and CPU use for speed on larger projects.

For external files and build-time macros, put the actual paths and values from the build configuration in the filelist, for example:

```text
+incdir+/path/to/shared/include
+define+FEATURE_ENABLED+DATA_WIDTH=32
rtl/top.sv
```

Reading mode reduces noise when those dependencies are unavailable; it cannot reconstruct their types or values. The compiler error limit still applies, and a diagnostic says when it prevented further checking.

`verilog.lint.slang.args` accepts additional flags such as `-j 2`, `-Wextra`, `--suppress-warnings ip/**` and `--error-limit 100`. Arguments follow the checkbox flags; slang gives individual warning flags precedence over groups, so `-Wextra` does not re-enable an individually disabled checkbox warning. Remove conflicting explicit flags when using a checkbox. With `verilog.lint.slang.runOnSave` off, **Verilog: Lint** manually checks the selected scope.

Formatting uses `verilog.format.path` and `verilog.format.args`; to format on save, turn on `editor.formatOnSave` for the `verilog` and `systemverilog` languages. To save work on a slow server, turn off `editor.semanticHighlighting.enabled` or `editor.inlayHints.enabled` for those languages.

Themes decide the colors of semantic tokens. Ports and instances use their own token types (`port`, `instance`), which fall back to parameter and variable colors; to give them distinct colors:

```json
"editor.semanticTokenColorCustomizations": {
  "rules": { "port": "#D7BA7D", "instance": { "italic": true } }
}
```

## With the separate vscode-slang extension

When the [vscode-slang](https://github.com/hudson-trading/slang-server) extension is installed, this extension leaves hovers, definitions, completions, diagnostics, the hierarchy views and the language client to it and disables its built-in server, CLI checks and Ctags providers. TextMate grammars and snippets remain available. This is coexistence mode; installation of that extension does not confirm that its server is running. Its settings belong to that extension.
