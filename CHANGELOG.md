# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versioning follows [Semantic Versioning](https://semver.org/).

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
