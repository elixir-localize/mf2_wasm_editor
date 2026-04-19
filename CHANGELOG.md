# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versioning follows [Semantic Versioning](https://semver.org/).

## [0.2.0] — unreleased

### Breaking change

The hook is now loaded as an ES module that imports `web-tree-sitter` directly. This replaces the two-script model used in 0.1.0 (a global `TreeSitter` loader plus the hook script). Consequences for consumers upgrading from 0.1.0:

* **One `<script>` tag, not two.** `Mf2WasmEditor.script_tags/1` now emits a single `<script type="module" src=".../mf2_editor.js">`. Re-render your root layout — no code change if you call `script_tags/1`.

* **Vendored filenames changed.** The web-tree-sitter runtime is now `web-tree-sitter.js` + `web-tree-sitter.wasm` (matching upstream npm naming) instead of `tree-sitter.js` + `tree-sitter.wasm`. If your `Plug.Static` declaration pins `:only` to the literal file list, replace it with `Mf2WasmEditor.static_paths()` which tracks the package.

* **No more `window.TreeSitter`.** The hook imports `Parser` and `Language` as ES-module named exports. Host code shouldn't touch the runtime directly, but if it did, switch to `import { Parser, Language } from "/mf2_editor/web-tree-sitter.js"`.

### Why

The 0.1.0 runtime (web-tree-sitter 0.24.x) couldn't parse queries compiled against the grammar shipped in the same release (`tree-sitter-mf2@0.1.4`, built with tree-sitter CLI 0.26.x → ABI 15). The runtime bundled in 0.1.0 only supported the ABI-14 query format, so `language.query(highlightsSource)` threw `SyntaxError: Bad syntax at offset 14` and the editor never mounted. Bumping the runtime to 0.26.8 required moving to its ES-module distribution — hence the loader-model change.

### Runtime / grammar versions

* web-tree-sitter: **0.26.8** (was 0.24.x).
* tree-sitter-mf2 grammar: unchanged — `tree-sitter-mf2@0.1.4` as in 0.1.0.

## [0.1.0] — April 19th, 2026

### Highlights

First release. Ships a browser-side MF2 syntax highlighter and IDE-style editor as a drop-in Phoenix LiveView hook. Keystrokes parse, highlight, and produce diagnostics in the browser via [`web-tree-sitter`](https://github.com/tree-sitter/tree-sitter/tree/master/lib/binding_web) running the [`mf2_treesitter`](https://github.com/elixir-localize/mf2_treesitter) grammar compiled to WASM — no per-keystroke server round trip. The server stays in the loop only for authoritative operations (formatting, validation, persistence).

The package covers three scopes:

**Highlighter and editor runtime.** Parse-and-paint on every input event, with inline wavy-underline diagnostics and hover tooltips for every ERROR and MISSING node. Auto-closing brackets (`{` → `{}`, `|` → `||`) with line-balance awareness, skip-over on typed-over closers, pair-delete on backspace, and selection-wrap. Bracket matching highlights the paired brace adjacent to the caret. Server-push canonicalisation on blur (`mf2:canonical` event) and server-push text replacement (`mf2:set_message` event) for host-driven content changes through the `phx-update="ignore"` barrier.

**IDE-style editing features,** all driven off the tree-sitter queries shipped by `mf2_treesitter`:

  * **Goto-definition** — `F12` (or `Cmd/Ctrl+click`) on a `$var` jumps to its `.input` / `.local` declaration.
  * **Rename-in-scope** — `F2` renames the variable under the caret across every definition and reference.
  * **Outline picker** — `Cmd/Ctrl+Shift+O` opens a floating list of every `.input` / `.local` binding; arrow keys + Enter to navigate.
  * **Structural selection** — `Cmd/Ctrl+Shift+→` grows the selection to the enclosing syntactic node; `Cmd/Ctrl+Shift+←` shrinks back through the stack.
  * **Smart newline indent** — `Enter` inside a `{{…}}` quoted pattern, `.match` matcher, or variant indents the new line.
  * **Completion menu** — typing `$` offers in-scope variables; `:` offers the built-in MF2 function registry; `@` offers common attributes.
  * **Pluralisation skeleton** — `Tab` after `.match $var` (optionally `:number`) on an otherwise empty line expands to the locale-appropriate CLDR plural categories with empty `{{…}}` placeholders. Locale comes from a `data-mf2-locale` attribute on the hook element.

**Rich diagnostics beyond tree-sitter's defaults.** The diagnostic layer combines tree-sitter's ERROR / MISSING nodes with source-level pre-scans and semantic post-checks so users see specific, actionable messages instead of generic "unexpected input" fallbacks:

  * **Line-scoped brace balancer** catches a forgotten closing `}` on a placeholder and points directly at the unmatched `{`.
  * **Missing-selector pre-scan** catches `.match` with no following selector and pins the diagnostic on the `.match` keyword.
  * **Missing variant-key pre-scan** catches a bare `{{…}}` appearing where a variant key should be (a beginner-common mistake) and points at the `{{`.
  * **Matcher key-count semantic check** flags variants whose key count doesn't match the selector count (e.g. `.match $a $b` followed by `1 {{…}}`).
  * **Undeclared-variable check** — in complex messages with at least one `.input` / `.local`, flags `$var` references that aren't declared.
  * **Context-aware MISSING phrasing** — "Expected name here" becomes "Expected a selector here", "Expected a variant key here", "Expected a function 
