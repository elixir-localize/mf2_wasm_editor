defmodule Mf2WasmEditor do
  @moduledoc """
  Browser-side MF2 syntax highlighter for Phoenix LiveView apps.

  Ships three things:

    * The web-tree-sitter runtime (`tree-sitter.js`, `tree-sitter.wasm`).
    * The compiled `tree-sitter-mf2` grammar (`tree-sitter-mf2.wasm`).
    * A Phoenix LiveView hook (`mf2_editor.js`) that wires a
      transparent textarea + highlighted `<pre>` into the grammar,
      highlighting and surfacing diagnostics on every keystroke —
      with no server round trip.

  The assets live under `priv/static/` inside this package. Consumers
  serve them as-is via `Plug.Static` (or equivalent) and include them
  with two `<script>` tags. See `script_tags/1` for the canonical
  markup and `Plug.Static` configuration snippet in the README.

  ## Wiring up a host app

      # endpoint.ex
      plug Plug.Static,
        at: "/mf2_editor",
        from: {:mf2_wasm_editor, "priv/static"},
        gzip: false,
        only: Mf2WasmEditor.static_paths()

      # root layout (HEEx)
      {raw(Mf2WasmEditor.script_tags())}

      # app.js
      const Hooks = Object.assign({}, window.Mf2WasmEditor?.Hooks || {})
      new LiveSocket("/live", Socket, {hooks: Hooks, params: {...}})

      # any LiveView template
      <div phx-hook="MF2Editor" id="my-editor">
        <pre aria-hidden="true" phx-update="ignore"><code></code></pre>
        <textarea name="message" phx-update="ignore"></textarea>
      </div>

  The hook reads and writes `textarea.value` directly. The server sees
  the text through the form's ordinary `phx-change` event — no
  additional plumbing. Server-initiated text changes (e.g. loading a
  saved example) must use `push_event/3` to dispatch `mf2:set_message`
  with a `%{value: string}` payload, since `phx-update="ignore"`
  prevents LiveView from overwriting the textarea directly.
  """

  @doc """
  Emit the two `<script>` tags needed to load the editor.

  The output is a raw HTML string. In a HEEx template wrap with
  `Phoenix.HTML.raw/1` (or `{raw(...)}` in HEEx 1.1+).

  ### Options

  * `:base_url` — URL prefix where the package's assets are served.
    Must match the `:at` option of your `Plug.Static` declaration.
    Defaults to `"/mf2_editor"`.

  ### Examples

      iex> Mf2WasmEditor.script_tags()
      ~s(<script src="/mf2_editor/tree-sitter.js" defer></script>\\n) <>
        ~s(<script src="/mf2_editor/mf2_editor.js" defer></script>)

      iex> Mf2WasmEditor.script_tags(base_url: "/assets/mf2")
      ~s(<script src="/assets/mf2/tree-sitter.js" defer></script>\\n) <>
        ~s(<script src="/assets/mf2/mf2_editor.js" defer></script>)

  """
  @spec script_tags(keyword()) :: binary()
  def script_tags(options \\ []) do
    base_url = Keyword.get(options, :base_url, "/mf2_editor")

    ~s(<script src="#{base_url}/tree-sitter.js" defer></script>\n) <>
      ~s(<script src="#{base_url}/mf2_editor.js" defer></script>)
  end

  @doc """
  File names served from `priv/static/`. Pass to
  `Plug.Static`'s `:only` option so nothing else in the package is
  exposed.

  ### Examples

      iex> Mf2WasmEditor.static_paths()
      ["highlights.scm", "mf2_editor.js", "tree-sitter-mf2.wasm",
       "tree-sitter.js", "tree-sitter.wasm"]

  """
  @spec static_paths() :: [String.t()]
  def static_paths do
    ~w(highlights.scm mf2_editor.js tree-sitter-mf2.wasm
       tree-sitter.js tree-sitter.wasm)
  end
end
