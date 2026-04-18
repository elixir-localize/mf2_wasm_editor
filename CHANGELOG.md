# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versioning follows [Semantic Versioning](https://semver.org/).

## [0.1.0] — unreleased

### Highlights

First release — ships a browser-side MF2 syntax highlighter as a drop-in Phoenix LiveView hook. Keystrokes parse and highlight in the browser via the [`web-tree-sitter`](https://github.com/tree-sitter/tree-sitter/tree/master/lib/binding_web) runtime running the [`mf2_treesitter`](https://github.com/elixir-localize/mf2_treesitter) grammar compiled to WASM. No per-keystroke server round trip for highlighting or diagnostics; the server is reserved for formatting and other authoritative operations.

Contents of the released package:

* **`priv/static/tree-sitter.js`** — the web-tree-sitter loader (MIT, 165 KB raw / ~45 KB gzipped).
* **`priv/static/tree-sitter.wasm`** — the tree-sitter runtime compiled to WASM (MIT, ~190 KB raw / ~80 KB gzipped).
* **`priv/static/tree-sitter-mf2.wasm`** — the MF2 grammar compiled to WASM (Apache-2.0, ~23 KB).
* **`priv/static/highlights.scm`** — canonical tree-sitter highlight query, vendored from `mf2_treesitter`.
* **`priv/static/mf2_editor.js`** — the LiveView hook. Binds a transparent `<textarea>` over a highlighted `<pre>`, runs parse + highlight + diagnostic collection on every `input` event, supports auto-close brackets with line-balance awareness, bracket matching, diagnostic tooltips, server-push text replacement (`mf2:set_message`), and canonical-on-blur reformatting (`mf2:canonical`). Emits `mf2-diagnostics` `CustomEvent`s on the hook element.
* **`priv/grammar/`** — the grammar source files vendored from `mf2_treesitter` for reproducibility; the WASM can be regenerated from them with `--build-wasm`.
* **`Mf2WasmEditor.script_tags/1`** — emits the two `<script>` tags that load the runtime and the hook.
* **`Mf2WasmEditor.static_paths/0`** — the file list for `Plug.Static`'s `:only` option.
* **`mix mf2_wasm_editor.sync`** — syncs vendored grammar sources + queries + WASM from the sibling [`mf2_treesitter`](https://github.com/elixir-localize/mf2_treesitter) repo. `--check` reports drift without modifying files (CI). `--build-wasm` rebuilds `tree-sitter-mf2.wasm` via the tree-sitter CLI and emscripten / docker / podman, rather than copying the prebuilt WASM.

### Rename note

This package was developed under the name `localize_mf2_editor` before being renamed to `mf2_wasm_editor` in the 2026 ecosystem reshuffle. The package was never Localize-specific; the `mf2_` prefix + `_wasm_` middle signal "browser editor over WASM grammar, ecosystem-neutral", matching the sibling naming:

* `mf2_treesitter` — grammar and WASM (JS ecosystem).
* `mf2_wasm_editor` — browser editor + LiveView hook (this package).
* `mf2_editor_extensions` — per-editor integrations (Zed/Helix/etc).
* `localize_mf2_treesitter` — Elixir NIF (Localize ecosystem).

See the [README](https://github.com/elixir-localize/mf2_wasm_editor/blob/v0.1.0/README.md) for wiring instructions and the expected DOM shape.
