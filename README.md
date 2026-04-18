# mf2_wasm_editor

Browser-side syntax highlighter for [ICU MessageFormat 2.0](https://unicode.org/reports/tr35/tr35-messageFormat.html) (MF2) messages. Drop-in [Phoenix LiveView](https://github.com/phoenixframework/phoenix_live_view) hook.

The hook runs the [`mf2_treesitter`](https://github.com/elixir-localize/mf2_treesitter) grammar directly in the browser via [`web-tree-sitter`](https://github.com/tree-sitter/tree-sitter/tree/master/lib/binding_web). Keystrokes are highlighted and diagnostics surface without leaving the client — no server round trip per edit. The server stays in the loop only for authoritative operations (formatting, validation, persistence) that it actually owns.

## Package scope, next time I come back here

This package ships three browser-side artefacts plus the Elixir glue to serve them:

1. **Web-tree-sitter runtime** (`tree-sitter.js`, `tree-sitter.wasm`) — vendored from the `web-tree-sitter` npm package, MIT-licensed.
2. **Compiled MF2 grammar** (`tree-sitter-mf2.wasm`) — vendored from [`mf2_treesitter`](https://github.com/elixir-localize/mf2_treesitter); regeneratable locally via the `--build-wasm` flag on the sync task.
3. **LiveView hook** (`mf2_editor.js`) — the IDE-style editor runtime. Handles parsing, highlighting, diagnostics, auto-close, bracket matching, tooltips, goto-definition, rename-in-scope, outline picker, structural selection, smart indent, completion, `.match` pluralisation skeletons, and server-push text replacement. See [Editing features and keyboard bindings](#editing-features-and-keyboard-bindings) for the full list.

Not in this package (so I don't get confused next time):

* **The grammar itself** — that's [`mf2_treesitter`](https://github.com/elixir-localize/mf2_treesitter).
* **Server-side MF2 parsing in Elixir** — that's [`localize_mf2_treesitter`](https://github.com/elixir-localize/localize_mf2_treesitter) (NIF).
* **Editor extensions** (Zed, Helix, Neovim, VS Code, Emacs, Vim) — that's [`mf2_editor_extensions`](https://github.com/elixir-localize/mf2_editor_extensions).
* **The Localize hex package** itself — this editor doesn't depend on Localize. The playground that consumes it happens to use Localize for server-side formatting, but `mf2_wasm_editor` doesn't know or care.

The `mf2_` prefix (no `localize_`) signals ecosystem-neutrality: this editor works for any Phoenix LiveView app editing MF2 messages, not only Localize-flavoured ones.

---

## Contents

1. [What ships in this package](#what-ships-in-this-package)
2. [Installation](#installation)
3. [Wiring](#wiring) — read this carefully; several gotchas
4. [Editing features and keyboard bindings](#editing-features-and-keyboard-bindings) — what the user can actually do
5. [Configuration and caveats](#configuration-and-caveats) — read this before filing a bug
6. [CSS classes](#css-classes)
7. [Themes](#themes) — 30 ready-to-serve colour schemes
8. [Receiving diagnostics server-side](#receiving-diagnostics-server-side)
9. [Grammar currency](#grammar-currency)
10. [Troubleshooting](#troubleshooting)
11. [Status and roadmap](#status-and-roadmap)
12. [Licence](#licence)

## What ships in this package

Everything sits under `priv/static/` (so a single `Plug.Static` declaration exposes it all):

| File | Size | Purpose |
| --- | ---: | --- |
| `tree-sitter.js` | 165 KB raw, ~45 KB gz | web-tree-sitter loader (MIT). Registers a global `TreeSitter` class. |
| `tree-sitter.wasm` | 190 KB raw, ~80 KB gz | tree-sitter runtime compiled to WASM (MIT). Loaded by `tree-sitter.js`. |
| `tree-sitter-mf2.wasm` | ~23 KB | MF2 grammar compiled to WASM (Apache-2.0). Loaded by the hook. |
| `highlights.scm` | small | Capture query for syntax highlighting (vendored from the grammar repo). |
| `injections.scm` | small | Injection hints (currently unused by the hook but shipped for completeness). |
| `mf2_editor.js` | ~10 KB | The LiveView hook. Registers `window.Mf2WasmEditor.Hooks.MF2Editor`. |

Plus under `priv/themes/` — 30 drop-in colour themes ported from the Pygments set (Monokai, Native, Default, Tango, etc.); see [Themes](#themes) — and under `priv/grammar/` the grammar source used by the `--build-wasm` sync task. In the package's `lib/`, the Elixir helpers:

* `Mf2WasmEditor.script_tags/1` — emits the two `<script>` tags.
* `Mf2WasmEditor.static_paths/0` — the file list for `Plug.Static`'s `:only` option.

## Installation

```elixir
def deps do
  [
    {:mf2_wasm_editor, "~> 0.1"}
  ]
end
```

No compile-time toolchain is required for consumers — the WASM artefacts and JS hook are pre-built and shipped.

## Wiring

Four pieces need to line up. Each has at least one thing that will silently break the editor if missed; all four are covered by the five-step recipe below.

### 1. Serve the static assets

```elixir
# endpoint.ex
plug Plug.Static,
  at: "/mf2_editor",
  from: {:mf2_wasm_editor, "priv/static"},
  gzip: false,
  only: Mf2WasmEditor.static_paths()
```

The `:at` path is arbitrary but **must match the `base_url` option of `script_tags/1`** (see next step) and the path the hook fetches from at runtime. `/mf2_editor` is the default in both. If you need a different prefix (e.g. to route under an existing `/assets` mount), pass it to `script_tags/1` too.

The `:only` option scopes `Plug.Static` to the six files the hook needs; nothing else in `priv/` is exposed.

### 2. Emit the `<script>` tags in the root layout

```heex
<link phx-track-static rel="stylesheet" href="/assets/app.css" />
<%!-- MF2 editor scripts MUST appear before app.js (see below). --%>
{raw(Mf2WasmEditor.script_tags())}
<script defer phx-track-static type="text/javascript" src="/assets/app.js"></script>
```

**`script_tags/1` must come before `app.js` in the document.** Both sets of scripts use `defer`, which runs them in document order after parsing finishes. `app.js` constructs the `LiveSocket` and reads `window.Mf2WasmEditor.Hooks.MF2Editor` at that moment — so the MF2 scripts must have executed first and populated the namespace. Put them after `app.js` and the hook is silently unregistered; the editor mounts with no hook bound and you get the full **cursor moves but nothing highlights** failure mode. This is a very easy mistake to make; there is no runtime error.

If you pass a custom base URL:

```heex
{raw(Mf2WasmEditor.script_tags(base_url: "/assets/mf2"))}
```

The hook's runtime asset fetches (`tree-sitter.wasm`, `tree-sitter-mf2.wasm`, `highlights.scm`) are derived from the same base URL via `window.Mf2WasmEditor.baseUrl` (set by the `<script>` preamble) or a `data-mf2-base-url` attribute on the hook element.

### 3. Merge the hook into your `LiveSocket`

```js
// assets/js/app.js
const Hooks = {}
// ...your other hooks...

// Merge the MF2 editor hook in. It registers onto
// `window.Mf2WasmEditor.Hooks` from mf2_editor.js.
const AllHooks = Object.assign({}, Hooks, window.Mf2WasmEditor?.Hooks || {})

const liveSocket = new LiveSocket("/live", Socket, {
  hooks: AllHooks,
  params: { _csrf_token: csrfToken }
})
liveSocket.connect()
```

The `?.` guard is important for dev-mode reloads where the global might not be set yet.

### 4. Drop the editor markup into a template

```heex
<div phx-hook="MF2Editor" id="my-mf2-editor" class="lp-mf2-editor">
  <pre class="lp-mf2-highlight mf2-highlight" aria-hidden="true" phx-update="ignore" id="my-mf2-editor-pre"><code></code></pre>
  <textarea name="message" phx-update="ignore" phx-debounce="100" rows="8" spellcheck="false">{@message}</textarea>
</div>
```

The hook looks for exactly this shape: a `<pre>` and a `<textarea>`, both inside the hook element. It fills `pre > code` with highlighted HTML on every keystroke.

Three attributes matter:

1. **`phx-update="ignore"` on the textarea** — stops LiveView from overwriting the user's input value on every server round trip. Without it, the caret jumps to the end every ~100ms.

2. **`phx-update="ignore"` on the `<pre>`** — stops LiveView from overwriting the hook's rendered highlight with stale server state. Without it, you get flicker (the hook paints, then LiveView immediately paints over with the initial @message_html).

3. **Stable `id` on both the hook element and the `<pre>`** — LiveView uses them to recognise elements across re-renders. `phx-update="ignore"` requires an `id`.

### 5. Style the tokens

See [CSS classes](#css-classes). If the hook is mounting and repainting (you can verify in DevTools) but you see no colour, you need the class rules in your stylesheet.

---

Once all five are in place, reload with **`Cmd+Shift+R` / `Ctrl+F5`** to bypass the browser cache for the new `.js` / `.wasm` / `.css` files. In dev you'll need this cache-bust every time you edit `priv/static/mf2_editor.js` in this package (Plug.Static reads from disk, but the browser will happily serve the old version if the `Cache-Control` headers let it).

## Editing features and keyboard bindings

The editor covers most of what a translator or developer expects from a modern code editor, inside a plain `<textarea>`. Everything below works out of the box after the five-step wiring above — no extra configuration needed.

On macOS the modifier is **Cmd** (⌘); on Windows and Linux it's **Ctrl**. The table below lists both as `Cmd/Ctrl`.

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
| `mf2-diagnostics` (DOM `CustomEvent`) | `detail: [{kind, startByte, endByte, startPoint, endPoint, message}]` | Dispatched on the hook element whenever the tree changes. Attach a companion LiveView hook to forward it to the server if the server needs to know (see [Receiving diagnostics server-side](#receiving-diagnostics-server-side)). |

### Optional hook-element attributes

Data attributes on the outer `<div phx-hook="MF2Editor">` tune per-editor behaviour.

| Attribute | Default | Effect |
| --- | --- | --- |
| `data-mf2-base-url` | `/mf2_editor` | URL prefix for the WASM and query fetches. Must match the `Plug.Static` `:at` option. |
| `data-mf2-locale` | `en` | Target locale for the pluralisation skeleton feature. Accepts a BCP-47 tag (`fr`, `en-GB`, `pt-BR`, etc.); the base language is what determines the CLDR plural categories inserted. |

## Configuration and caveats

The rest of this section is a catalogue of sharp edges that *will* bite you if you skip them. Reading them in advance saves debugging time.

### Script load order is load-bearing

Both `tree-sitter.js` and `mf2_editor.js` must be loaded and parsed before `app.js`'s `defer` callback runs. The default `script_tags/1` output is correct **only if you place the call to `script_tags/1` before the `<script>` tag for your `app.js`**. See step 2 above.

Symptom if violated: hook never mounts, typing works natively (the textarea accepts input) but the `<pre>` never repaints. Typically no console errors.

### `phx-update="ignore"` is required on both textarea and pre

The hook reads `textarea.value` on every `input` event and writes to `pre.innerHTML`. LiveView's server-driven patches must not touch either element, or one of two failure modes appears:

- Without it on the textarea: caret jumps to the end of the text every time the server round-trips.
- Without it on the pre: highlight flickers back to stale server state every time the server round-trips.

If you need to *force* the textarea to a new value from the server (e.g. a "Load example" button), use `push_event/3`:

```elixir
socket |> push_event("mf2:set_message", %{value: example.message})
```

The hook listens for this event specifically, sets `textarea.value` directly, and re-paints. This is the only way to get server-initiated text into a `phx-update="ignore"` textarea.

### The textarea is transparent, the pre shows colour

By CSS convention in this design the `<textarea>` has `color: transparent` and its `::selection` background is a light tint; the visible tokens come from the `<pre>` underneath. Two implications:

1. **The caret's visual position depends on the textarea's font metrics, not the pre's.** If the two elements use even slightly different font settings, characters will visually drift apart along the line and end-of-line typing will show a gap between the last character and the caret (or between the caret and the next character). Pin these properties **identically** on both elements:

   ```css
   .lp-mf2-message, .lp-mf2-editor .lp-mf2-highlight {
     font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
     font-size: 13px;
     line-height: 1.5;
     letter-spacing: 0;
     tab-size: 4;
     font-kerning: none;
     font-variant-ligatures: none;
     font-feature-settings: normal;
     font-optical-sizing: none;
   }
   ```

   The defaults for these properties differ between `<textarea>` and text-flow elements in all major browsers; silence here means per-glyph drift of fractions of a pixel, which accumulates across a line.

2. **The caret glyph is visible against the pre's background colour.** Give the textarea an explicit `caret-color: <visible-colour>` so the caret shows even though the text is transparent. Without this, focusing the editor looks broken.

### Safari needs the `-webkit-` prefix for wavy underlines

Diagnostic squiggles use `text-decoration-style: wavy`. WebKit (Safari, iOS, macOS embedded webviews) only renders wavy underlines reliably when:

- The `-webkit-text-decoration-*` long-form properties are set alongside the unprefixed ones, and
- `text-decoration-thickness` is at least 2px (thinner squiggles paint as single pixels that alias into invisibility).

The recommended rules:

```css
.mf2-diag-error {
  text-decoration-line: underline;
  text-decoration-style: wavy;
  text-decoration-color: #ef4444;
  text-decoration-thickness: 2px;
  -webkit-text-decoration-line: underline;
  -webkit-text-decoration-style: wavy;
  -webkit-text-decoration-color: #ef4444;
  text-underline-offset: 2px;
}
.mf2-diag-missing {
  /* same shape, different colour (e.g. amber) */
}
```

Chrome and Firefox render the unprefixed form correctly, so the `-webkit-` lines are additive, not overriding. If you just write `text-decoration: underline wavy #ef4444` as a shorthand, WebKit silently drops the wave style in some releases.

### Full parse per keystroke (no incremental parse)

The hook does a fresh `parser.parse(source)` on every `input` event. For sub-kilobyte MF2 messages this is microseconds; it is **not** the source of any latency you might observe.

There is an incremental-parse API on tree-sitter (`parser.parse(source, oldTree)`) that reuses unchanged subtrees for large inputs. The hook does **not** use it, because incremental parse requires an explicit `oldTree.edit(descriptor)` call describing exactly which bytes changed — without it, tree-sitter silently returns a tree whose byte positions are stale, and your captures and `hasError` checks drift against the wrong source. The defensive thing is to full-parse. If you ever need to pay the complexity for a genuinely large input, do it in a fork and measure carefully.

### Client-side `hasError` is authoritative for the edit flow

After the hook has mounted, `hasError` on the client tree is the canonical answer to "is this MF2 valid?". Use the `mf2-diagnostics` `CustomEvent` (see below) for any UI that needs to react — do not re-parse on the server side of a `phx-change` event for diagnostic purposes. The server's job shrinks to whatever *authoritative* work it actually owns (format/validate/persist), and even that can be gated: the playground skips `Localize.Message.format/3` whenever the tree-sitter parse reports errors, which removes the "every keystroke produces a parse-error toast while you type" UX.

You can still keep a server-side tree-sitter parse as a separate concern if you want (the `localize_mf2_treesitter_server` package is exactly this), but it is not required for the editor to work.

### Server → client events

The hook listens for two `push_event/3` names from the server:

| Event | Payload | Behaviour |
| --- | --- | --- |
| `mf2:set_message` | `%{value: string}` | Immediately replaces `textarea.value`, moves the caret to the end, and re-highlights. Use this for *hard* text swaps — "Load example" buttons, loading a saved draft, anything where you want to blow away the current textarea content. |
| `mf2:canonical` | `%{value: string}` | *Soft* replacement. If the textarea is not focused, applies immediately. If it is focused, stores the value as a pending apply and installs it on the next `blur`. This is designed for "format-on-blur" UX: the server canonicalises the message whenever it parses cleanly and the hook snaps the textarea to the canonical form when the user tabs or clicks away. Typing is never interrupted. |

The relative caret position is preserved across `mf2:canonical` when possible — if the canonical value is longer than the old text, the caret sits at its old offset; if shorter, it clamps to the end of the new text. Absolute caret preservation is impossible in the general case (canonicalisation may insert/remove characters before the caret) so some motion is expected.

If you don't need the canonical snap, don't emit the event — the hook treats receipt as strictly opt-in. The playground uses `Localize.Message.canonical_message/2` inside its `compute/1` to produce the canonical form; a minimal wiring looks like:

```elixir
defp maybe_push_canonical(socket, message) do
  case Localize.Message.canonical_message(message, trim: false) do
    {:ok, canonical} when canonical != message ->
      push_event(socket, "mf2:canonical", %{value: canonical})
    _ ->
      socket
  end
end
```

Call it on every valid `phx-change` update. If canonical equals input, nothing fires — the event is only pushed when there is an actual change to apply, so the round trip amortises to zero once the textarea is already canonical.

### Hard-reload after every change to this package

`Plug.Static` serves from disk, so edits to `priv/static/mf2_editor.js` appear live on the server — but browsers cache static assets aggressively. During development, `Cmd+Shift+R` (macOS) or `Ctrl+F5` (Windows/Linux) after editing any `.js`/`.wasm`/`.css` in the package.

### First keystroke after mount

On mount the hook fetches and compiles the grammar WASM, which takes ~50–200ms on a typical dev machine. Until `initialize()` resolves, the `update()` call is a no-op and the pre shows whatever your server pre-rendered (or nothing, if you didn't SSR). This is why the recommended pattern is to seed `@message_html` on mount with a server-side highlight — see [the playground's `compute/1`](https://github.com/elixir-localize/localize_playground/blob/main/lib/localize_playground_web/live/messages_live.ex) for the pattern using `assign_new`.

If you don't want the server-side initial paint, leave the pre empty; the user sees nothing (transparent textarea) for a few tens of milliseconds, then the hook's first paint arrives. Depending on your UX tolerance this may be fine.

### UTF-16 indices, not bytes

`node.startIndex` and `node.endIndex` in web-tree-sitter are UTF-16 code-unit offsets (because the tree was parsed from a JS string). This matches `source.length`. It does **not** match the byte offsets you'd see in the Elixir `localize_mf2_treesitter_server` NIF, which operates on UTF-8 bytes. The two are identical for ASCII-only messages but diverge for content with multi-byte characters. If you're comparing indices across the two APIs, normalise first.

### Browser support

Runs in anything with WebAssembly and `text-decoration-style: wavy` — Safari 14+, Chrome 80+, Firefox 76+, Edge Chromium. No transpilation, no polyfills shipped.

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

## Receiving diagnostics server-side

The hook dispatches a `mf2-diagnostics` `CustomEvent` on the hook element whenever the tree changes. The `detail` is an array of:

```js
{
  kind: "error" | "missing",
  startByte: number,   // actually UTF-16 code units; see caveat above
  endByte: number,
  startPoint: [row, col],
  endPoint: [row, col],
  message: string
}
```

If you need the server to know about diagnostics — for instance to gate a format call or to render an authoritative diagnostics panel — forward the event. The simplest way is a companion hook:

```js
Hooks.MF2DiagnosticsForwarder = {
  mounted() {
    this._h = (e) => this.pushEvent("mf2:diagnostics", {count: e.detail.length})
    this.el.addEventListener("mf2-diagnostics", this._h)
  },
  destroyed() {
    if (this._h) this.el.removeEventListener("mf2-diagnostics", this._h)
  }
}
```

And then on the LiveView side:

```elixir
def handle_event("mf2:diagnostics", %{"count" => count}, socket) do
  {:noreply, assign(socket, :mf2_error_count, count)}
end
```

The playground does not do this — it prefers to parse on the server via `localize_mf2_treesitter_server` for any server-side diagnostic logic, and lets the client handle visual squiggles independently. Both patterns work.

## Grammar currency

The grammar sources, highlight query, and compiled WASM are vendored from [`mf2_treesitter`](https://github.com/elixir-localize/mf2_treesitter). The `mix mf2_wasm_editor.sync` task keeps them in step:

```bash
# Copy sources + queries from the sibling repo.
mix mf2_wasm_editor.sync

# CI check — exit non-zero if vendored files drift from the grammar repo.
mix mf2_wasm_editor.sync --check

# Rebuild priv/static/tree-sitter-mf2.wasm from priv/grammar/ via the
# tree-sitter CLI + emscripten (or docker/podman).
mix mf2_wasm_editor.sync --build-wasm
```

The sync task looks for the grammar at `../mf2_editor_extensions/tree-sitter-mf2` by default; override with `MF2_GRAMMAR_DIR=/path`.

`--build-wasm` requires either `emcc` (emscripten), Docker, or Podman on PATH — tree-sitter's CLI uses one of these to invoke emscripten. On macOS, starting Docker Desktop is the shortest path (`open -a Docker`); on Linux, `sudo pacman -S emscripten` or the equivalent works.

## Troubleshooting

If the editor isn't working, these are the failure modes and how to identify each.

### "Typing moves the caret, but nothing highlights / repaints"

The hook never mounted. Check the DevTools console:

- If there's no `LiveView` chatter about your hook and no errors, the hook isn't registered on the `LiveSocket` — usually a script load-order issue. See [Wiring step 2](#2-emit-the-script-tags-in-the-root-layout).
- If there's a `ReferenceError: TreeSitter is not defined`, `tree-sitter.js` didn't load — usually a `Plug.Static` misconfiguration.

### "It worked once, now typing produces stale state"

The hook is passing the old tree to `parser.parse()` without calling `edit()` first. This doesn't apply to the shipped hook (it always full-parses) — but if you forked and tried to implement incremental parse, this is the trap. Revert to a full parse unless you've implemented edit descriptors correctly.

### "Caret drifts away from text at end of line"

Font-metric divergence between the textarea and the pre. Pin all the font properties in [Configuration and caveats § transparent textarea](#the-textarea-is-transparent-the-pre-shows-colour).

### "Wavy underlines don't show in Safari"

Add the `-webkit-text-decoration-*` long-form properties and ensure `text-decoration-thickness` is at least 2px. See [Configuration and caveats § Safari](#safari-needs-the--webkit--prefix-for-wavy-underlines).

### "Load Example button updates the server state but the textarea still shows the old text"

`phx-update="ignore"` is doing its job — LiveView can't touch the textarea. Use `push_event/3` to send the new text to the hook, which listens for `mf2:set_message`. See [Configuration and caveats § phx-update](#phx-updateignore-is-required-on-both-textarea-and-pre).

### "Server parse errors flood the UI while I'm typing mid-word"

Your server's format/validation runs on every `phx-change` event with partial input. Gate it on tree-sitter's `hasError` — server-side (via `localize_mf2_treesitter_server`) or client-side (forwarded via `mf2-diagnostics` as shown above).

### "Everything works in Chrome but not in Safari / iOS"

Check that the `-webkit-text-decoration-*` CSS is present (above) and that your Safari is 14 or newer. If on older Safari, wavy styling fails; fall back to a solid underline or a background tint.

### "F12 opens DevTools instead of jumping to a definition"

Some browsers claim `F12` at the OS level. The hook's keydown handler runs with `preventDefault`, so focus-inside-the-editor should win — but an extension (Vimium, Dash, etc.) may intercept first. Workarounds: use `Cmd/Ctrl + click` instead, or remap the browser's `F12` shortcut. `Cmd/Ctrl + click` always works because the mouse click is unambiguous.

### "The completion menu doesn't open when I type `$` / `:` / `@`"

The completion menu only opens on *keyboard input* (`inputType: "insertText"`). Paste, drag-drop, and speech-to-text don't trigger it by design — the assumption is that those operations deliver a complete token rather than the start of an identifier. If you expected completion and it didn't open, check whether the character actually came from a keystroke.

Also: the `$` variant requires a populated locals graph. If the message has no `.local` / `.input` declarations, typing `$` opens the menu with zero items and it immediately hides. That's correct; there's nothing to complete against.

### "Pluralisation skeleton doesn't expand on Tab"

The trigger is `Tab` at the end of a line matching `/^\s*\.match\s+\$\w+(\s+:number)?\s*$/` — i.e. `.match $var` (optionally followed by `:number`) with nothing else on the line. If anything else appears after the variable or there's a variant already below, `Tab` falls through to the browser's default (inserting a tab character). Clear the line and try again.

The target locale for skeleton generation comes from the `data-mf2-locale` attribute on the hook element. Without that attribute the editor defaults to `en` (just `one` + `*`). Set `data-mf2-locale="ar"` for six-category Arabic plurals, `data-mf2-locale="fr"` for French's `one | many | other`, etc.

## Status and roadmap

Reasonably complete for an in-textarea editor. The hook is 100%-conformant against the MF2 WG syntax test suite (because the underlying `mf2_treesitter` grammar is), and the IDE-style layer covers most of what a translator or developer expects — highlighting, diagnostics with tooltips, auto-close, bracket matching, goto-definition, rename, outline, structural selection, smart indent, completion, and `.match` pluralisation skeletons. See [Editing features and keyboard bindings](#editing-features-and-keyboard-bindings) for the full list.

Tracked in [`TODO.md`](./TODO.md). Things still to ship or improve:

* **Unknown-variable warnings** — the locals graph already computes them; just needs a paint pass.
* **Hover info** for variables (declaration source) and functions (docstring). Scaffolding is in place; needs a mousemove handler that identifies the node under the cursor.
* **Signature help** — after typing `:number<space>`, show the function's option list. Uses the same registry that powers completion.
* **Code folding** — `folds.scm` is shipped and consumed by other tooling but this editor doesn't implement a fold-gutter yet. Would need a third overlay column and fold-state management; likely the motivating moment to consider a CodeMirror 6 migration.
* **Server-driven function registry** — the current registry is a hardcoded set of the 10 MF2 built-ins. A `push_event("mf2:registry", …)` from the server would let host apps surface their own registered functions (including custom ones) in completion / hover / signature help.
* **Jump-to-matching-bracket** keyboard shortcut, linewise duplicate / move keybindings, and find-replace widget — not urgent, tracked in TODO.

Other roadmap items, unchanged from the original release:

* Optional built-in diagnostics-forwarding hook (rather than the boilerplate shown above).
* `Plug.Static` convenience helper so consumers don't have to repeat the declaration.
* Pre-rendered SSR helper for initial paint (right now that's the consumer's responsibility via their own `Mf2Highlighter.highlight/1`-style function).

## Licence

Apache-2.0 for this package. Third-party notices in [`LICENSE.md`](./LICENSE.md).
