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

* [ ] **Inline-style theming API for `Localize.Message.to_html/2`** — cross-package feature: ship a new `Mf2WasmEditor.Themes` Elixir module that exposes the 30 themes as Elixir palette maps (`%{variable: "color: #fd971f; font-weight: bold", …}`). Then `localize` picks up `mf2_wasm_editor` as an **optional** dep and adds `:inline_styles` + `:theme` options to `to_html/2`: when both are set, emit `<span style="…">` instead of `<span class="…">` so rendered output pastes into Keynote / PowerPoint / rich-text email / Word. The CSS-class workflow already covers GitHub / blogs / Notion, so this is a niche-but-nice polish. Plan: (1) extend `scripts/generate_themes.exs` to emit `lib/mf2_wasm_editor/themes.ex` alongside the CSS, exposing `palette(:monokai)` → `{:ok, map}` and `list_themes/0`; (2) in `localize`, add `{:mf2_wasm_editor, "~> 0.1", optional: true}`, extend `Formatter.HTML.render/2`, guard with `Code.ensure_loaded?/1`, and raise a clear error if the optional dep is missing. ~½ day. See conversation on 2026-04-18 for full design.

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

## Post-npm-publication ecosystem follow-ups

These are cross-cutting items that unblock once `tree-sitter-mf2` is published on npm. They span multiple packages; tracked here as the most active planning doc but touch `localize_mf2_treesitter`, `mf2_editor_extensions`, and (indirectly) `localize_playground` too.

* [x] **Switch `mix mf2_wasm_editor.sync` to fetch from a CDN.** Done — pinned `@tree_sitter_mf2_version` at module top, fetches from `https://unpkg.com/tree-sitter-mf2@<version>/…` over verified HTTPS. `MF2_TREESITTER_DIR` is the offline override. `--build-wasm` now explicitly requires the env var.

* [x] **Do the same for `localize_mf2_treesitter`.** Done — same pattern, same pin variable name, same override env var. Both sync tasks document the "keep pins in lockstep" convention in their READMEs. Ecosystem invariant: bump both pin strings together, commit the refreshed vendored files in each package, release together.

* [ ] **Update `mf2_editor_extensions` to depend on the published npm package.** The VS Code extension especially should have `"dependencies": { "tree-sitter-mf2": "^0.1.0" }` in its package.json rather than vendoring. Zed / Helix / Neovim integrations usually reference the grammar via git URL — update those to npm-via-tag once available.

* [ ] **Thin JS test coverage for `mf2_editor.js`.** Currently only 3 Elixir doctests + 4 module tests cover the package; the ~85 KB `priv/static/mf2_editor.js` hook is exercised only through the playground. Add a Node-based smoke test (~30 lines) that loads the WASM, parses a handful of canonical messages, and asserts expected tree shape and diagnostic output. Put it under `test/js/` and wire into `mix test` via a small shell-out or a `test/js/package.json` with its own `npm test` the Elixir suite calls.

* [ ] **Ecosystem version-alignment doc.** Add a small compatibility table to each of `mf2_wasm_editor`, `localize_mf2_treesitter`, and `mf2_treesitter` READMEs showing "this version of X is built against Y of tree-sitter-mf2 and Z of web-tree-sitter". Saves future-self archaeology when bumping any one of them.

* [ ] **Post-publication release sequence** (order matters): (1) publish `tree-sitter-mf2@0.1.0` on npm; (2) update both `mf2_wasm_editor` and `localize_mf2_treesitter` sync tasks to fetch from unpkg at `0.1.0`; (3) publish `mf2_wasm_editor@0.1.0` on hex; (4) publish `localize_mf2_treesitter@0.1.0` on hex; (5) deploy `localize_playground` with the new hex deps and verify the Message tab end-to-end.

* [ ] **Verify `localize_playground` still deploys** after the ecosystem refactor. Deployment target is fly.io (per earlier work, which constrained us to Elixir 1.19-compatible images). Do a pre-production smoke test before cutting the playground over.

## Non-features / explicit deferrals

* **Incremental parse** (`parser.parse(source, oldTree)`) — requires a correct `oldTree.edit(descriptor)` call. Full-parse is already microseconds for kilobyte inputs; don't pay the complexity unless someone is editing a 100 KB string.

* **CodeMirror 6 migration** — big project. Triggered when the gutter / find-replace / multi-cursor asks start piling up.

* **Inline format preview** — in-place rendering of the formatted output under each `.match` variant. Nice idea, interacts awkwardly with bracket matching and the overlay model. Needs its own design pass.
