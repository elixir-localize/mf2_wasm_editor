# TODO

Living list of planned editor features, grouped by scope. Checked items have shipped.

Each unchecked item includes a rough cost estimate so we can pick off whatever fits a given session. Implementation notes call out dependencies on existing tree-sitter primitives or on additions needed to `localize_mf2_treesitter_server`.

## Shipped

* [x] Browser-side tree-sitter highlighting via `web-tree-sitter` + grammar WASM.
* [x] Inline diagnostic squiggles (wavy underlines for ERROR / MISSING nodes).
* [x] Server-push soft canonicalisation on blur (`mf2:canonical` event).
* [x] Server-push hard text replacement (`mf2:set_message` event).
* [x] Auto-close brackets — `{` → `{}`, `|` → `||`, with skip-over, pair-delete, selection wrap.
* [x] Rich diagnostic messages — per-parent-type phrasing for ERROR nodes and per-token phrasing for MISSING nodes.
* [x] Diagnostic tooltips — `title="..."` on squiggled spans.
* [x] Bracket matching — transient highlight on the bracket pair adjacent to the caret.

## Medium effort (half a day each)

* [ ] **Jump-to-matching-bracket keyboard shortcut** — `Cmd+Shift+\` (or similar) moves the caret to the paired bracket. Reuses `findMatchedBrackets`. ~30 lines of JS in the hook's `keydown` handler.

* [ ] **Structural newline indent** — Enter inside a `{{...}}` pattern auto-indents to match the opener; inside `.match` variants, Enter starts a new line at the variant indent column. Requires tracking the node under the caret and injecting spaces. Fiddly to get right in a plain textarea; if it starts feeling bad, this is the feature that motivates a CodeMirror rewrite.

* [ ] **Linewise duplicate / move (Alt-↑/Alt-↓, Cmd-D)** — editor-standard keybindings, implemented as textarea-value splicing. Common asks for translator UX; cheap if we already have the event plumbing for the two items above.

## Larger (day+ each)

* [ ] **Completion menu** — after typing `:` offer a floating dropdown of available function names (`number`, `datetime`, `string`, `currency`, `date`, `time`, `integer`, etc.). Needs:
  - A source of truth for the function registry — likely a `Localize.Message.Functions.list/0` or similar on the server, pushed to the client once at mount as a JSON blob.
  - A floating DOM element absolutely-positioned at the caret (use `getBoundingClientRect` on a temporary zero-width span inserted into a hidden mirror of the textarea — the common technique).
  - Keyboard navigation (↑/↓ to move, Enter/Tab to commit, Esc to dismiss).
  - Probably also: `@` for attributes, `$` for declared variables (requires tracking `.local` / `.input` declarations from the CST).

* [ ] **Variable-scope awareness** — walk the CST for `local_declaration` / `input_declaration` and expose the declared names as completions after `$`. Pairs naturally with the completion menu above.

* [ ] **Hover tooltips for identifiers** — hovering `:number` shows documentation for the function, hovering `$count` shows where it was declared. Needs:
  - Mouse-position → byte offset lookup (again the mirror-textarea technique).
  - A content source — function docs could be scraped from `Localize.Message.Functions` docstrings at build time and pushed as a JSON blob; `.local` / `.input` target lookups are pure CST walks.

## Big

* [ ] **Fold long `.match` variants** — show the header, collapse the rest behind a disclosure. Requires a gutter overlay (currently none) and some model of "logical lines" that accounts for wrapping. This is where the textarea-over-pre approach really starts to strain; budget it with a view to migrating to CodeMirror if it becomes painful.

* [ ] **Find / replace widget** — browser `Cmd+F` works on textarea text but can't do regex or scoped replace. A custom widget (small modal with input + count + replace + all) can be layered on top. Probably 2-3 days with decent polish.

* [ ] **Line numbers + diagnostic gutter icons** — separate overlay column to the left of the pre. Line numbers are trivial; gutter icons for diagnostics would be a nicer UX than inline squiggles alone.

## Out of scope for this package (probably)

* [ ] **Multi-cursor editing** — standard in CodeMirror / Monaco, hard-to-impossible in a single textarea. Wait for an editor-framework migration.

* [ ] **Syntax-aware selection expansion (Cmd+Shift+→)** — trivial given `Node.parent/1` / `next_sibling/1`, BUT requires intercepting selection keystrokes and fighting the textarea's native behaviour. Doable but not fun. Punt.

* [ ] **Vim / Emacs keybindings** — explicitly out of scope. If users want these, it's the motivation to switch to CodeMirror which has keymaps as a first-class extension point.

## Server-side work that enables the above

These go into [`localize_mf2_treesitter_server`](https://github.com/elixir-localize/localize_mf2_treesitter_server) rather than here, but are pre-requisites for several of the items above:

* [ ] `Localize.Message.Functions.list/0` — enumerate registered formatter functions. Unblocks the completion menu.

* [ ] Function docstrings as machine-readable data — the completion menu wants a one-line description per function; the hover tooltip wants a longer explanation. A `@docs` module attribute or ETS lookup would do it.

* [ ] (Nice-to-have) An LSP server — `localize_mf2_lsp`, new package. Would subsume most of the above in a way that works for CLI users (VS Code, Helix, Neovim, Zed) without shipping a WASM bundle. The editor's hover / completion / rename / goto-definition support then becomes "forward to the LSP" rather than "implement in JS".

## Non-features / explicit deferrals

* **Incremental parse** (`parser.parse(source, oldTree)`) — requires a correct `oldTree.edit(descriptor)` call describing exactly which bytes changed. Full-parse is already microseconds for kilobyte inputs; don't pay the complexity unless someone is editing a 100 KB string.

* **CodeMirror 6 migration** — big project. Viable if and when the structural features above start costing more in the textarea model than the migration itself would cost. Not triggered yet.

* **Inline format preview** — in-place rendering of the formatted output under each `.match` variant. Nice idea, interacts awkwardly with bracket matching and the overlay model. Needs its own design pass.
