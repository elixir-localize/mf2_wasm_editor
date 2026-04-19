# Editing features, CSS classes, and themes

What the editor does once you have it wired up, plus the styling hooks for customising the look.

## Editing features and keyboard bindings

The editor covers most of what a translator or developer expects from a modern code editor, inside a plain `<textarea>`. Everything below works out of the box after the [five-step wiring](https://hexdocs.pm/mf2_wasm_editor/wiring.html#the-five-step-wiring-recipe) — no extra configuration needed.

On macOS the modifier is **Cmd** (⌘); on Windows and Linux it's **Ctrl**. The tables below list both as `Cmd/Ctrl`.

### Typing and structural editing

| Action | Trigger | Notes |
| --- | --- | --- |
| Auto-close `{` → `{}` | typing `{` | Caret lands between the pair. Respects line balance: if the line already has an unmatched `}`, the opener is inserted bare so you don't over-balance. Selection-wrap: select text first, then type `{` to wrap it. |
| Auto-close `\|` → `\|\|` | typing `\|` | Same rules as `{}`; wraps selections. |
| Skip over closer | typing `}` or `\|` immediately before the same character | Advances past the existing closer instead of duplicating it. |
| Delete bracket pair | `Backspace` with the caret sitting between an opener and its matching closer (`{▌}` — caret shown as `▌`) | Removes both characters at once. |
| Smart newline indent | `Enter` | When the caret sits inside a `{{…}}` quoted pattern, a `.match` matcher, or a `variant`, the new line gets an extra two-space indent relative to the current line. |
| `.match` pluralisation skeleton | `Tab` after `.match $var` (optionally `:number`) on an otherwise blank line | Expands to the locale's CLDR plural categories with empty `{{…}}` placeholders: English gets `one {{}}` + `* {{}}`; French gets `one {{}}` + `many {{}}` + `* {{}}`; Arabic gets all six CLDR categories. Target locale comes from the hook element's `data-mf2-locale="fr-CA"` attribute (defaults to `en`). |

### Navigation

| Action | Trigger | Notes |
| --- | --- | --- |
| Goto-definition | `F12`, or `Cmd/Ctrl + click` on a `$x` reference | Jumps the caret to the matching `.local $x = …` or `.input {$x …}` declaration and selects the name. |
| Outline picker | `Cmd/Ctrl + Shift + O` | Opens a floating list of every `.local` and `.input` binding in the message. Arrow keys navigate, `Enter` jumps, `Esc` dismisses. Each entry shows the binding name plus whether it's `.local` or `.input`. |
| Expand selection | `Cmd/Ctrl + Shift + →` | Grows the current selection to the enclosing syntactic node — one press might grow from `name` to `variable`, the next from `variable` to `variable_expression`, then to `placeholder`, etc. Selection history is kept so you can go back. |
| Shrink selection | `Cmd/Ctrl + Shift + ←` | Pops the last expansion off the stack and restores the previous selection. |

### Rename

| Action | Trigger | Notes |
| --- | --- | --- |
| Rename-in-scope | `F2` on a `$x` | Opens a browser prompt for the new name. On confirm, every definition *and* every reference of that variable in the current `complex_message` is rewritten atomically. The canonical form is pushed back from the server on blur, so the result normalises cleanly. |

### Completion

Typing one of the trigger characters opens a filterable dropdown. Keep typing to narrow; arrow keys navigate; `Enter` or `Tab` commits; `Esc` dismisses.

| Trigger | Completes with | Source |
| --- | --- | --- |
| `$` | In-scope variables from `.local` and `.input` declarations | Client-side CST walk of the current message. |
| `:` | MF2 function names (`number`, `integer`, `currency`, `percent`, `date`, `time`, `datetime`, `string`, `list`, `unit`) | Client-side built-in registry. A server push will eventually replace this with the host app's actual registered functions. |
| `@` | Common attributes (`translate`, `locale`, `dir`) | Client-side hardcoded list. |

Each item shows a short hint alongside the name — the declaration kind for variables, a one-line doc for functions.

### Diagnostics

| Action | Trigger | Notes |
| --- | --- | --- |
| Inline squiggle | automatic on every keystroke | Wavy red underline on spans covered by an `ERROR` node; amber on `MISSING`. Zero-width `MISSING` nodes "steal" the preceding character so the squiggle has something to draw on. |
| Diagnostic tooltip | hover over a squiggled span | Custom floating panel (can't use native `title=` because the pre has `pointer-events: none`). Shows a spec-aware message like *"Expected closing `}}` here"* or *"Expected a selector after `.match` (e.g. `.match $count`)"*. |
| Bracket-match highlight | caret moves adjacent to a bracket token (`{`, `}`, `{{`, `}}`, `\|`) | Transient background tint on both the caret-side token and its matching partner, located via the CST. |

### Server round-trip events

Two events flow from server to client via `push_event/3`. The hook listens for both.

| Event | Payload | Behaviour |
| --- | --- | --- |
| `mf2:set_message` | `%{value: string}` | *Hard* replace — overwrites the textarea immediately, moves the caret to the end, repaints. Use for "Load example" buttons or saved-draft loads. |
| `mf2:canonical` | `%{value: string}` | *Soft* replace — defers if the textarea has focus, then applies on blur. Designed for format-on-blur: the server canonicalises the message whenever it parses cleanly, and the editor snaps to that form when the user tabs or clicks away. Typing is never interrupted. |

Plus one event flowing the other way:

| Event | Payload | Behaviour |
| --- | --- | --- |
| `mf2-diagnostics` (DOM `CustomEvent`) | `detail: [{kind, startByte, endByte, startPoint, endPoint, message}]` | Dispatched on the hook element whenever the tree changes. Attach a companion LiveView hook to forward it to the server if the server needs to know (see [Wiring § Receiving diagnostics server-side](https://hexdocs.pm/mf2_wasm_editor/wiring.html#receiving-diagnostics-server-side)). |

### Optional hook-element attributes

Data attributes on the outer `<div phx-hook="MF2Editor">` tune per-editor behaviour.

| Attribute | Default | Effect |
| --- | --- | --- |
| `data-mf2-base-url` | `/mf2_editor` | URL prefix for the WASM and query fetches. Must match the `Plug.Static` `:at` option. |
| `data-mf2-locale` | `en` | Target locale for the pluralisation skeleton feature. Accepts a BCP-47 tag (`fr`, `en-GB`, `pt-BR`, etc.); the base language is what determines the CLDR plural categories inserted. |

## CSS classes

The hook emits span classes derived from the tree-sitter capture names in `highlights.scm`, replacing `.` with `-` (so `keyword.conditional` becomes `mf2-keyword-conditional`):

```
mf2-variable          mf2-keyword              mf2-punctuation-bracket
mf2-variable-builtin  mf2-keyword-conditional  mf2-punctuation-special
mf2-function          mf2-keyword-import       mf2-operator
mf2-string            mf2-number               mf2-string-escape
mf2-tag               mf2-attribute            mf2-constant-builtin
mf2-property
```

Diagnostic wrappers are **additive** — they sit alongside the highlight class on the same span:

```
mf2-diag-error        mf2-diag-missing
```

Keep the diagnostic CSS to `text-decoration` (wavy underline) only. Anything that changes glyph width — `letter-spacing`, `padding`, `text-shadow` with layout-affecting params — will break caret alignment with the transparent textarea. Background-color tints are safe.

The IDE-style UI widgets (completion menu, outline picker, hover / signature panels) need their own styling. They live outside the `<pre>` overlay so layout-affecting CSS is safe here:

```
mf2-floating-menu            /* outer wrapper — completion + outline */
mf2-floating-menu-item       /* one row */
mf2-floating-menu-item.selected  /* highlighted row */
mf2-completion-label         /* name (emphasised) */
mf2-completion-hint          /* doc / kind (muted) */
mf2-outline-label            /* binding name */
mf2-outline-hint             /* `.local` or `.input` marker */
mf2-floating-panel           /* hover / signature info */
mf2-caret-mirror             /* hidden offscreen helper; inherit font from the real textarea */
```

Transient bracket-match highlight:

```
mf2-bracket-match
```

You can write your own stylesheet against these classes, or serve one of the bundled themes described below.

## Themes

30 drop-in colour themes ship in `priv/themes/`, ported from Makeup's Pygments theme set. Linking one of them is the fastest way to get a polished look.

The classes use the tree-sitter capture taxonomy (`.mf2-variable`, `.mf2-punctuation-bracket`, etc.), which matches the output of [`Localize.Message.to_html/2`](https://hexdocs.pm/localize/Localize.Message.html#to_html/2) — so **one stylesheet styles both** the browser editor here and any server-rendered MF2 HTML. Pick the same theme name in both places for a consistent look.

### Available themes

**Light.** `abap`, `algol_nu`, `autumn`, `borland`, `bw`, `colorful`, `default`, `emacs`, `friendly`, `igor`, `lovelace`, `manni`, `murphy`, `paraiso_light`, `pastie`, `perldoc`, `rainbow_dash`, `samba`, `tango`, `trac`, `vs`, `xcode`.

**Dark.** `fruity`, `monokai`, `native`, `paraiso_dark`, `rrt`, `vim`.

**Monochrome.** `algol`.

### Using a theme from a host application

Expose `priv/themes/` the same way you expose `priv/static/`, with a `Plug.Static` declaration in your endpoint:

```elixir
# endpoint.ex
plug Plug.Static,
  at: "/mf2_editor/themes",
  from: {:mf2_wasm_editor, "priv/themes"},
  only: ~w(abap.css algol.css algol_nu.css arduino.css autumn.css borland.css
           bw.css colorful.css default.css emacs.css friendly.css fruity.css
           igor.css lovelace.css manni.css monokai.css murphy.css native.css
           paraiso_dark.css paraiso_light.css pastie.css perldoc.css
           rainbow_dash.css rrt.css samba.css tango.css trac.css vim.css
           vs.css xcode.css),
  gzip: true
```

Then link the theme from your root layout, next to your app's own stylesheet:

```heex
<link rel="stylesheet" href={~p"/mf2_editor/themes/monokai.css"} />
```

The theme only styles elements with the `mf2-highlight` or `mf2-<capture>` classes; it won't affect anything else on the page.

### Switching themes at runtime

Themes are plain stylesheets — swap them by swapping the `<link>`. The simplest pattern is a `phx-click` handler on a picker that toggles `@mf2_theme` in assigns:

```heex
<link rel="stylesheet" href={~p"/mf2_editor/themes/#{@mf2_theme}.css"} />
```

```elixir
def handle_event("theme", %{"name" => name}, socket) when name in @known_themes do
  {:noreply, assign(socket, :mf2_theme, name)}
end
```

For a client-only toggle (no LiveView round trip) swap the `<link>`'s `href` directly in a small JS snippet.

### Customising a theme

Each file is a standalone ~13-rule stylesheet — open one up and you'll see one block per token class:

```css
.mf2-variable, .mf2-variable-builtin { color: #f8f8f2; }
.mf2-function { color: #a6e22e; }
.mf2-keyword, .mf2-keyword-import { color: #f92672; }
/* … */
```

To tweak: copy the file into your own assets pipeline and edit. To add a new token accent (say, distinguish `variable` from `variable-builtin`), split the combined selector and give each its own rule.

### Regenerating the themes

The themes are generated by `scripts/generate_themes.exs`. By default it fetches the 30 Pygments theme sources directly from the canonical upstream on GitHub, pinned to Makeup's `v1.1.0` tag (the last release that shipped these files — Makeup 1.2+ dropped them):

```bash
elixir scripts/generate_themes.exs
```

This is the recommended path: no local Makeup checkout required, anyone with network access can reproduce the themes from scratch.

To use a local Makeup checkout instead (e.g. if you're iterating on the mapping offline), point `MAKEUP_THEMES_DIR` at a directory containing the theme `.ex` files:

```bash
MAKEUP_THEMES_DIR=/path/to/makeup/lib/makeup/styles/html/pygments \
  elixir scripts/generate_themes.exs
```

The Makeup → tree-sitter capture mapping lives at the top of the script; the 30 theme names are listed there too.
