# Wiring and configuration

The full recipe for wiring `mf2_wasm_editor` into a Phoenix LiveView app, plus the gotchas that catch people when a step is missed.

## The five-step wiring recipe

Four pieces need to line up. Each has at least one thing that will silently break the editor if missed; all four are covered by the recipe below.

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

See the [features guide § CSS classes](features.html#css-classes). If the hook is mounting and repainting (you can verify in DevTools) but you see no colour, you need the class rules in your stylesheet.

---

Once all five are in place, reload with **`Cmd+Shift+R` / `Ctrl+F5`** to bypass the browser cache for the new `.js` / `.wasm` / `.css` files. In dev you'll need this cache-bust every time you edit `priv/static/mf2_editor.js` in this package (Plug.Static reads from disk, but the browser will happily serve the old version if the `Cache-Control` headers let it).

## Configuration and caveats

The rest of this guide is a catalogue of sharp edges that *will* bite you if you skip them. Reading them in advance saves debugging time.

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

After the hook has mounted, `hasError` on the client tree is the canonical answer to "is this MF2 valid?". Use the `mf2-diagnostics` `CustomEvent` for any UI that needs to react — do not re-parse on the server side of a `phx-change` event for diagnostic purposes. The server's job shrinks to whatever *authoritative* work it actually owns (format/validate/persist), and even that can be gated: skip server-side formatting whenever the tree-sitter parse reports errors, which removes the "every keystroke produces a parse-error toast while you type" UX.

You can still keep a server-side tree-sitter parse as a separate concern if you want ([`localize_mf2_treesitter`](https://hex.pm/packages/localize_mf2_treesitter) is exactly this), but it is not required for the editor to work.

### Server → client events

The hook listens for two `push_event/3` names from the server:

| Event | Payload | Behaviour |
| --- | --- | --- |
| `mf2:set_message` | `%{value: string}` | Immediately replaces `textarea.value`, moves the caret to the end, and re-highlights. Use this for *hard* text swaps — "Load example" buttons, loading a saved draft, anything where you want to blow away the current textarea content. |
| `mf2:canonical` | `%{value: string}` | *Soft* replacement. If the textarea is not focused, applies immediately. If it is focused, stores the value as a pending apply and installs it on the next `blur`. This is designed for "format-on-blur" UX: the server canonicalises the message whenever it parses cleanly and the hook snaps the textarea to the canonical form when the user tabs or clicks away. Typing is never interrupted. |

The relative caret position is preserved across `mf2:canonical` when possible — if the canonical value is longer than the old text, the caret sits at its old offset; if shorter, it clamps to the end of the new text. Absolute caret preservation is impossible in the general case (canonicalisation may insert/remove characters before the caret) so some motion is expected.

If you don't need the canonical snap, don't emit the event — the hook treats receipt as strictly opt-in. A minimal wiring using the `localize` package's canonicaliser:

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

On mount the hook fetches and compiles the grammar WASM, which takes ~50–200ms on a typical dev machine. Until `initialize()` resolves, the `update()` call is a no-op and the pre shows whatever your server pre-rendered (or nothing, if you didn't SSR). This is why the recommended pattern is to seed `@message_html` on mount with a server-side highlight.

If you don't want the server-side initial paint, leave the pre empty; the user sees nothing (transparent textarea) for a few tens of milliseconds, then the hook's first paint arrives. Depending on your UX tolerance this may be fine.

### UTF-16 indices, not bytes

`node.startIndex` and `node.endIndex` in web-tree-sitter are UTF-16 code-unit offsets (because the tree was parsed from a JS string). This matches `source.length`. It does **not** match the byte offsets you'd see in the Elixir [`localize_mf2_treesitter`](https://hex.pm/packages/localize_mf2_treesitter) NIF, which operates on UTF-8 bytes. The two are identical for ASCII-only messages but diverge for content with multi-byte characters. If you're comparing indices across the two APIs, normalise first.

### Browser support

Runs in anything with WebAssembly and `text-decoration-style: wavy` — Safari 14+, Chrome 80+, Firefox 76+, Edge Chromium. No transpilation, no polyfills shipped.

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

Both "server forwards to get authoritative diagnostics" and "client handles everything, server runs its own tree-sitter parse" patterns work; pick based on whether you already have a server-side MF2 parser.

## Grammar currency

The grammar sources, highlight query, and compiled WASM are vendored from the [`tree-sitter-mf2`](https://www.npmjs.com/package/tree-sitter-mf2) npm package (published from [`mf2_treesitter`](https://github.com/elixir-localize/mf2_treesitter)). The `mix mf2_wasm_editor.sync` task pins a specific version and fetches files from the published tarball via the unpkg CDN — no sibling repo checkout required, fully reproducible.

```bash
# Fetch from npm at the pinned version and update priv/.
mix mf2_wasm_editor.sync

# CI check — exit non-zero if any vendored file drifts from the
# pinned version. Doesn't modify files.
mix mf2_wasm_editor.sync --check

# Rebuild priv/static/tree-sitter-mf2.wasm from priv/grammar/ via the
# tree-sitter CLI + emscripten (or docker/podman). Requires a local
# mf2_treesitter checkout — see MF2_TREESITTER_DIR below.
mix mf2_wasm_editor.sync --build-wasm
```

The pinned version lives at the top of the task module as `@tree_sitter_mf2_version`. To move to a newer grammar release, bump that string and re-run the task. **Keep the pin in step with `localize_mf2_treesitter`'s sync task** — grammar tree shape is the API boundary between server-side (NIF) and browser-side (WASM) parses; a version skew can produce different trees for the same input.

### Offline / local-iteration override

If you're iterating on the grammar locally and want the sync to read from a sibling checkout rather than hit the network, set `MF2_TREESITTER_DIR`:

```bash
MF2_TREESITTER_DIR=/path/to/mf2_treesitter mix mf2_wasm_editor.sync
```

The checkout's layout must match the npm package layout (it does, if you're pointing at a working tree of the [`mf2_treesitter`](https://github.com/elixir-localize/mf2_treesitter) repo).

`--build-wasm` always requires `MF2_TREESITTER_DIR` to be set — the npm tarball doesn't ship the compiled tree-sitter CLI, so rebuilding WASM needs `npm install` to have been run inside the checkout. It also requires `emcc` (emscripten), Docker, or Podman on PATH — tree-sitter's CLI uses one of these to invoke emscripten. On macOS, starting Docker Desktop is the shortest path (`open -a Docker`); on Linux, `sudo pacman -S emscripten` or the equivalent works.

## Troubleshooting

If the editor isn't working, these are the failure modes and how to identify each.

### "Typing moves the caret, but nothing highlights / repaints"

The hook never mounted. Check the DevTools console:

- If there's no `LiveView` chatter about your hook and no errors, the hook isn't registered on the `LiveSocket` — usually a script load-order issue. See Wiring step 2.
- If there's a `ReferenceError: TreeSitter is not defined`, `tree-sitter.js` didn't load — usually a `Plug.Static` misconfiguration.

### "It worked once, now typing produces stale state"

The hook is passing the old tree to `parser.parse()` without calling `edit()` first. This doesn't apply to the shipped hook (it always full-parses) — but if you forked and tried to implement incremental parse, this is the trap. Revert to a full parse unless you've implemented edit descriptors correctly.

### "Caret drifts away from text at end of line"

Font-metric divergence between the textarea and the pre. Pin all the font properties listed in [The textarea is transparent, the pre shows colour](#the-textarea-is-transparent-the-pre-shows-colour).

### "Wavy underlines don't show in Safari"

Add the `-webkit-text-decoration-*` long-form properties and ensure `text-decoration-thickness` is at least 2px. See [Safari needs the `-webkit-` prefix for wavy underlines](#safari-needs-the--webkit--prefix-for-wavy-underlines).

### "Load Example button updates the server state but the textarea still shows the old text"

`phx-update="ignore"` is doing its job — LiveView can't touch the textarea. Use `push_event/3` to send the new text to the hook, which listens for `mf2:set_message`. See [`phx-update="ignore"` is required on both textarea and pre](#phx-updateignore-is-required-on-both-textarea-and-pre).

### "Server parse errors flood the UI while I'm typing mid-word"

Your server's format/validation runs on every `phx-change` event with partial input. Gate it on tree-sitter's `hasError` — server-side (via [`localize_mf2_treesitter`](https://hex.pm/packages/localize_mf2_treesitter)) or client-side (forwarded via `mf2-diagnostics`).

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
