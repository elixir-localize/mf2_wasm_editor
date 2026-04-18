# TODO

Living list of planned editor features, grouped by scope. Checked items have shipped.

## Shipped — original set

* [x] Browser-side tree-sitter highlighting via `web-tree-sitter` + grammar WASM.
* [x] Inline diagnostic squiggles (wavy underlines for ERROR / MISSING nodes).
* [x] Server-push soft canonicalisation on blur (`mf2:canonical` event).
* [x] Server-push hard text replacement (`mf2:set_message` event).
* [x] Auto-close brackets — `{` → `{}`, `|` → `||`, with skip-over, pair-delete, selection wrap, line-balance awareness.
* [x] Rich diagnostic messages — per-parent-type phrasing for ERROR nodes and per-token phrasing for MISSING nodes.
* [x] Diagnostic tooltips — custom floating panel (native `title=` blocked by pointer-events: none on the pre).
* [x] Bracket matching — transient highlight on the bracket pair adjacent to the caret.

## Shipped — IDE-style pass (drives off the `locals.scm`, `folds.scm`, `tags.scm`, `indents.scm` queries)

* [x] **Locals graph** — scope + definitions + references extracted from the CST on every parse, shared by the features below.
* [x] **Goto-definition** — `F12` (or `Cmd/Ctrl + click`) on a `$x` jumps to its `.local` / `.input` declaration.
* [x] **Rename-in-scope** — `F2` renames the variable under the caret across every definition and reference in the current scope, after a browser `prompt` confirmation.
* [x] **Outline picker** — `Cmd/Ctrl + Shift + O` opens a floating list of every `.local` / `.input` binding; arrow keys navigate, Enter jumps.
* [x] **Structural selection** — `Cmd/Ctrl + Shift + →` grows the selection to the enclosing syntactic node; `Cmd/Ctrl + Shift + ←` shrinks back through the stack.
* [x] **Smart newline indent** — `Enter` inside a `{{…}}` quoted pattern, `.match` matcher, or `variant` indents the new line with an extra two spaces relative to the line above.
* [x] **Completion menu** — typing `$` offers in-scope variable names; typing `:` offers the built-in MF2 function registry; typing `@` offers common attributes. Arrow keys navigate, Enter/Tab commit, Esc dismisses.
* [x] **Pluralisation skeleton** — `Tab` after `.match $var` (optionally `:number`) on an otherwise empty line expands to the locale-appropriate CLDR plural categories (`one`, `few`, `many`, `other`, …) with empty `{{…}}` placeholders. Locale comes from the hook element's `data-mf2-locale` attribute; defaults to `en`.

## Partial / deferred from the IDE pass

These were in the original scope of this pass but are only partially shipped; noting what's left so the next session can finish them cleanly.

* [ ] **Unknown-variable warnings** — the locals graph can already produce the set of references with no matching definition, but the warning paint pass (underlining them with a distinct colour) isn't wired yet. ~10 lines in `buildHtml` plus a new CSS class. Low-risk; mostly a matter of threading the set through paint.

* [ ] **Unused-declaration warnings** — same scaffolding; dim or underline `.local` bindings with zero references.

* [ ] **Hover info for variables** — infra is in place (`caretCoords`, locals graph, floating panel). Wiring a mousemove handler that finds the `$name` under the mouse and shows the declaration source is a ~30-line job. The existing `onMouseMove` handler already does diagnostic tooltips; we'd add a second branch.

* [ ] **Hover info for functions** — needs a function-registry docs source (the `FUNCTION_REGISTRY` map in the hook has docs already; wiring them to hover on `:number` etc. is the missing step).

* [ ] **Signature help** — after typing `:number<space>`, show a floating panel listing the function's options. Infrastructure (floating panel, registry) is all present; needs a trigger detection step and a render.

* [ ] **Folding** — `folds.scm` captures the regions, the feature plan is clear, but implementing the gutter UI and line-folding state management is a half-day on its own. Next session.

## Shipped infrastructure (reusable for future features)

* [x] **Locals graph builder** (`buildLocalsGraph`) — returns scope, definitions map, references-by-name map. Rebuilt on every parse.
* [x] **Tree-walking helpers** (`walkTree`, `enclosingNode`, `firstNamedChildOfType`, `namedNodeSpanning`).
* [x] **Caret → pixel coordinate** via the classic mirror-textarea technique (`caretCoords`). Unlocks any feature that needs to anchor a UI at the caret.
* [x] **Floating menu / panel framework** (`createFloatingMenu`, `createFloatingPanel`) — keyboard-navigable list or static info panel, both clean up on destroy.
* [x] **Static MF2 function registry** (client-side) — `number`, `integer`, `currency`, `percent`, `date`, `time`, `datetime`, `string`, `list`, `unit`, with one-line docs and option schemas. Will be replaced by a server push in a later pass to match the host app's actual registered functions.
* [x] **CLDR plural categories per locale** (simplified) — hand-selected subset covering the major locale families. Drives the `.match` skeleton feature.

## Medium effort (remaining)

* [ ] **Jump-to-matching-bracket keyboard shortcut** — `Cmd+Shift+\` moves the caret to the paired bracket. Reuses `findMatchedBrackets`. ~30 lines in the keydown handler.

* [ ] **Linewise duplicate / move (Alt-↑/Alt-↓, Cmd-D)** — editor-standard keybindings, implemented as textarea-value splicing.

## Larger (day+)

* [ ] **Server-driven function registry** — replace the hardcoded `FUNCTION_REGISTRY` with a `push_event("mf2:registry", …)` from the server on mount. Lets host apps surface their own registered functions (including custom ones) in completion + hover + signature help.

* [ ] **Real CLDR plural rules** — replace the hand-selected per-locale categories with a full `Localize.Number.Plural`-backed push from the server. The current fallback is good enough for common languages; a server push covers all of CLDR.

## Big

* [ ] **Fold long `.match` variants** — show the header, collapse the rest behind a disclosure. Requires a gutter overlay (currently none) and some model of "logical lines" that accounts for wrapping. This is where the textarea-over-pre approach really starts to strain; budget it with a view to migrating to CodeMirror if it becomes painful.

* [ ] **Find / replace widget** — browser `Cmd+F` works on textarea text but can't do regex or scoped replace. A custom widget (small modal with input + count + replace + all) can be layered on top. Probably 2-3 days with decent polish.

* [ ] **Line numbers + diagnostic gutter icons** — separate overlay column to the left of the pre. Line numbers are trivial; gutter icons for diagnostics would be a nicer UX than inline squiggles alone.

## Out of scope for this package (probably)

* [ ] **Multi-cursor editing** — standard in CodeMirror / Monaco, hard-to-impossible in a single textarea. Wait for an editor-framework migration.

* [ ] **Vim / Emacs keybindings** — explicitly out of scope. If users want these, it's the motivation to switch to CodeMirror which has keymaps as a first-class extension point.

## Server-side work that enables the above

* [ ] `Localize.Message.Functions.list/0` — enumerate registered formatter functions with docs + option schemas. Unblocks the server-driven registry above.

* [ ] Function docstrings as machine-readable data — the completion menu wants a one-line description per function; the hover tooltip wants a longer explanation.

* [ ] (Nice-to-have) An LSP server — `localize_mf2_lsp`, new package. Would subsume most of the above in a way that works for CLI users (VS Code, Helix, Neovim, Zed) without shipping a WASM bundle.

## Non-features / explicit deferrals

* **Incremental parse** (`parser.parse(source, oldTree)`) — requires a correct `oldTree.edit(descriptor)` call. Full-parse is already microseconds for kilobyte inputs; don't pay the complexity unless someone is editing a 100 KB string.

* **CodeMirror 6 migration** — big project. Triggered when the gutter / find-replace / multi-cursor asks start piling up.

* **Inline format preview** — in-place rendering of the formatted output under each `.match` variant. Nice idea, interacts awkwardly with bracket matching and the overlay model. Needs its own design pass.
