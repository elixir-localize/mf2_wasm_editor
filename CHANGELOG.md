# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versioning follows [Semantic Versioning](https://semver.org/).

## [0.1.0] — unreleased

### Highlights

First release — ships a browser-side MF2 syntax highlighter as a drop-in Phoenix LiveView hook. Keystrokes parse and highlight in the browser via the [`web-tree-sitter`](https://github.com/tree-sitter/tree-sitter/tree/master/lib/binding_web) runtime running the [`tree-sitter-mf2`](https://github.com/elixir-localize/mf2_editor_extensions/tree/main/tree-sitter-mf2) grammar compiled to WASM. No per-keystroke server round trip for highlighting or diagnostics; the server is reserved for formatting and other authoritative operations.

Contents of the released package:

* **`priv/static/tree-sitter.js`** — the web-tree-sitter loader (MIT, 165 KB raw / ~45 KB gzipped).
* **`priv/static/tree-sitter.wasm`** — the tree-sitter runtime compiled to WASM (MIT, ~190 KB raw / ~80 KB gzipped).
* **`priv/static/tree-sitter-mf2.wasm`** — the MF2 grammar compiled to WASM (Apache-2.0, ~23 KB).
* **`priv/static/highlights.scm`** and **`priv/static/injections.scm`** — the canonical tree-sitter highlight queries from the grammar repo.
* **`priv/static/mf2_editor.js`** — the LiveView hook. Binds a transparent `<textarea>` over a highlighted `<pre>`, runs parse + highlight + diagnostic collection on every `input` event, emits `mf2-diagnostics` `CustomEvent`s on the hook element, and handles a `mf2:set_message` `push_event` for server-initiated text replacement.
* **`priv/grammar/`** — the grammar sources (`grammar.js`, `src/parser.c`, etc.) kept for reproducibility; the WASM can be regenerated from them.
* **`LocalizeMf2Editor.script_tags/1`** — emits the two `<script>` tags that load the runtime and the hook.
* **`LocalizeMf2Editor.static_paths/0`** — the file list for `Plug.Static`'s `:only` option.
* **`mix localize_mf2_editor.sync`** — syncs vendored grammar sources + queries from the sibling `mf2_editor_extensions` repo. `--check` reports drift without modifying files (CI). `--build-wasm` rebuilds `tree-sitter-mf2.wasm` via the tree-sitter CLI and emscripten / docker / podman.

See the [README](https://github.com/elixir-localize/localize_mf2_editor/blob/v0.1.0/README.md) for wiring instructions and the expected DOM shape.
