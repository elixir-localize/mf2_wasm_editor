#!/usr/bin/env elixir

# Generate MF2 editor themes from Makeup's Pygments theme sources.
#
# Each theme is mapped onto the tree-sitter capture taxonomy used
# by both the browser editor (this package) and the server-side
# `Localize.Message.to_html/2` renderer, so one CSS file styles
# both renderers consistently.
#
# Source:  Makeup 1.1.0 Pygments theme modules. Fetched from the
#          canonical upstream on GitHub by default; override with
#          `MAKEUP_THEMES_DIR` to use a local checkout. Makeup 1.2+
#          dropped these themes from the package, so the v1.1.0
#          tag is the pinned upstream.
# Target:  priv/themes/*.css (30 files, one per theme).
#
# Usage:
#     # Fetch from upstream and regenerate (default):
#     elixir scripts/generate_themes.exs
#
#     # Use a local Makeup checkout instead of hitting the network:
#     MAKEUP_THEMES_DIR=/path/to/makeup/lib/makeup/styles/html/pygments \
#       elixir scripts/generate_themes.exs

# ───────────────────────── Configuration ──────────────────────────

# Pinned to v1.1.0 — the last Makeup release that shipped these
# themes. Later versions removed `lib/makeup/styles/html/pygments/`.
makeup_tag = "v1.1.0"

upstream_base =
  "https://raw.githubusercontent.com/elixir-makeup/makeup/" <>
    makeup_tag <> "/lib/makeup/styles/html/pygments"

# The 30 theme file basenames shipped in Makeup 1.1.0. These match
# the upstream `.ex` filenames exactly (note `paraiso-dark` and
# `paraiso-light` use hyphens); the emitted CSS filename comes from
# the `short_name:` inside each file (e.g. `paraiso_dark.css`).
# Kept as a stable list so the fetcher doesn't need a GitHub API
# call to enumerate the directory.
theme_names = ~w(
  abap algol algol_nu arduino autumn borland bw colorful default
  emacs friendly fruity igor lovelace manni monokai murphy native
  paraiso-dark paraiso-light pastie perldoc rainbow_dash rrt samba
  tango trac vim vs xcode
)

target_dir = Path.expand("../priv/themes", __DIR__)

# Mapping from Makeup Pygments token classes to tree-sitter capture
# classes. First match in each lookup list wins. Order matters —
# the more specific source class should appear first.
mapping = [
  {:"mf2-highlight code", [:text, :name, :generic]},
  {:"mf2-variable, .mf2-variable-builtin", [:name_variable, :name_variable_instance, :name]},
  {:"mf2-function", [:name_function, :name_other]},
  {:"mf2-keyword, .mf2-keyword-import", [:name_builtin, :keyword_namespace, :keyword]},
  {:"mf2-tag, .mf2-keyword-conditional", [:name_tag, :keyword]},
  {:"mf2-attribute, .mf2-punctuation-special", [:name_attribute, :name_decorator]},
  {:"mf2-property", [:name_label, :name_attribute]},
  {:"mf2-number", [:number_integer, :number, :literal]},
  {:"mf2-string-escape", [:string_escape, :literal, :keyword]},
  {:"mf2-string", [:string, :string_double, :literal]},
  {:"mf2-constant-builtin", [:keyword_constant, :keyword, :name_tag]},
  {:"mf2-punctuation-bracket, .mf2-operator", [:punctuation, :operator]}
]

# ───────────────────────── Modules ────────────────────────────────

defmodule Source do
  # Resolve the set of theme `.ex` contents, either by reading a
  # local directory (when MAKEUP_THEMES_DIR is set) or by fetching
  # each one from the pinned upstream tag.

  def load(theme_names, upstream_base) do
    case System.get_env("MAKEUP_THEMES_DIR") do
      nil ->
        IO.puts("Fetching Makeup themes from #{upstream_base}")
        ensure_http_started()
        Enum.map(theme_names, &fetch_one(&1, upstream_base))

      dir ->
        unless File.dir?(dir) do
          IO.puts(:stderr, "MAKEUP_THEMES_DIR does not exist: #{dir}")
          System.halt(1)
        end

        IO.puts("Reading Makeup themes from #{dir}")
        Enum.map(theme_names, fn name ->
          path = Path.join(dir, "#{name}.ex")
          {name, File.read!(path)}
        end)
    end
  end

  defp fetch_one(name, upstream_base) do
    url = "#{upstream_base}/#{name}.ex"
    request = {String.to_charlist(url), [{~c"accept", ~c"text/plain"}]}

    case :httpc.request(:get, request, [ssl: ssl_options()], []) do
      {:ok, {{_http, status, _reason}, _headers, body}} when status in 200..299 ->
        IO.write("  ↓ #{name}.ex\r")
        {name, :erlang.list_to_binary(body)}

      {:ok, {{_http, status, reason}, _headers, _body}} ->
        IO.puts(:stderr, "\n  ✗ #{name}.ex: HTTP #{status} #{reason}")
        System.halt(1)

      {:error, reason} ->
        IO.puts(:stderr, "\n  ✗ #{name}.ex: #{inspect(reason)}")
        System.halt(1)
    end
  end

  defp ensure_http_started do
    :ssl.start()
    :inets.start()
  end

  defp ssl_options do
    [
      verify: :verify_peer,
      cacerts: :public_key.cacerts_get(),
      customize_hostname_check: [
        match_fun: :public_key.pkix_verify_hostname_match_fun(:https)
      ]
    ]
  end
end

defmodule ThemeParser do
  # Parse a Makeup theme source string and return the metadata +
  # the `@styles %{...}` map as Elixir data. Regex-based to keep
  # this script self-contained (no Mix project, no Code.eval).

  def parse(name, source) do
    [_, styles_body] = Regex.run(~r/@styles\s+%\{(.*?)\n\s*\}\s*\n/s, source)

    styles =
      Regex.scan(~r/:([a-z_]+)\s*=>\s*"([^"]+)"/, styles_body)
      |> Map.new(fn [_, key, value] -> {String.to_atom(key), value} end)

    %{
      short_name: extract(source, ~r/short_name:\s*"([^"]+)"/, name),
      long_name: extract(source, ~r/long_name:\s*"([^"]+)"/, nil),
      background: extract(source, ~r/background_color:\s*"([^"]+)"/, nil),
      styles: styles
    }
  end

  defp extract(source, regex, fallback) do
    case Regex.run(regex, source) do
      [_, value] -> value
      _ -> fallback
    end
  end
end

defmodule StyleParser do
  # Convert a Makeup style string ("bold #204a87", "italic #8f5902",
  # "noitalic #BC7A00") into a list of CSS declarations.

  def parse(nil), do: []

  def parse(string) do
    tokens = String.split(string, ~r/\s+/, trim: true)

    {color, weight, style, extras} =
      Enum.reduce(tokens, {nil, nil, nil, []}, fn token, {color, weight, style, extras} ->
        cond do
          token == "bold" -> {color, "bold", style, extras}
          token == "nobold" -> {color, "normal", style, extras}
          token == "italic" -> {color, weight, "italic", extras}
          token == "noitalic" -> {color, weight, "normal", extras}
          token == "underline" -> {color, weight, style, ["text-decoration: underline" | extras]}
          String.starts_with?(token, "#") -> {token, weight, style, extras}
          String.starts_with?(token, "bg:") -> {color, weight, style, [bg(token) | extras]}
          String.starts_with?(token, "border:") -> {color, weight, style, [border(token) | extras]}
          true -> {color, weight, style, extras}
        end
      end)

    [
      color && "color: #{color}",
      weight && "font-weight: #{weight}",
      style && "font-style: #{style}"
      | Enum.reverse(extras)
    ]
    |> Enum.filter(& &1)
  end

  defp bg(token), do: "background-color: #{String.replace_prefix(token, "bg:", "")}"
  defp border(token), do: "border: 1px solid #{String.replace_prefix(token, "border:", "")}"
end

defmodule Renderer do
  def render(theme, mapping, tag) do
    header = header(theme, tag)

    wrapper = [
      ".mf2-highlight {",
      theme.background && "  background-color: #{theme.background};",
      "  color: #{Map.get(theme.styles, :text, "inherit")};",
      "  padding: 0.75em 1em;",
      "  border-radius: 4px;",
      "  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;",
      "  overflow-x: auto;",
      "}"
    ]

    wrapper_block = wrapper |> Enum.filter(& &1) |> Enum.join("\n")

    rules =
      mapping
      |> Enum.flat_map(fn {selector, candidates} -> render_rule(selector, candidates, theme) end)
      |> Enum.join("\n\n")

    [header, wrapper_block, rules]
    |> Enum.join("\n\n")
    |> String.trim_trailing()
    |> Kernel.<>("\n")
  end

  defp render_rule(selector, candidates, theme) do
    style =
      Enum.find_value(candidates, fn key -> Map.get(theme.styles, key) end)

    case StyleParser.parse(style) do
      [] ->
        []

      decls ->
        [
          [".#{selector} {", Enum.map(decls, &"  #{&1};"), "}"]
          |> List.flatten()
          |> Enum.join("\n")
        ]
    end
  end

  defp header(theme, tag) do
    name = theme.long_name || String.capitalize(theme.short_name)

    """
    /*
     * MF2 editor theme: #{name}
     *
     * Generated by `scripts/generate_themes.exs` from Makeup's
     * `#{theme.short_name}` Pygments theme (pinned to #{tag}).
     * Classes use the tree-sitter capture taxonomy, so this
     * stylesheet styles both the browser editor and the HTML
     * emitted by `Localize.Message.to_html/2`.
     *
     * Editor:
     *   <link rel="stylesheet" href="/mf2_editor/themes/#{theme.short_name}.css" />
     *
     * Server-rendered HTML (standalone):
     *   {:ok, html} = Localize.Message.to_html(msg, standalone: true)
     */
    """
    |> String.trim_trailing()
  end
end

# ───────────────────────── Run ────────────────────────────────────

File.mkdir_p!(target_dir)

sources = Source.load(theme_names, upstream_base)
# Clear the in-place "↓ xxx.ex\r" progress line.
IO.write("\e[2K\r")

for {name, source} <- sources do
  theme = ThemeParser.parse(name, source)
  css = Renderer.render(theme, mapping, makeup_tag)
  out_path = Path.join(target_dir, "#{theme.short_name}.css")
  File.write!(out_path, css)
  IO.puts("  • #{theme.short_name}.css")
end

IO.puts("")
IO.puts("Wrote #{length(sources)} themes to #{Path.relative_to_cwd(target_dir)}/")
