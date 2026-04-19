defmodule Mf2WasmEditor.MixProject do
  use Mix.Project

  @version "0.2.0"
  @source_url "https://github.com/elixir-localize/mf2_wasm_editor"

  def project do
    [
      app: :mf2_wasm_editor,
      version: @version,
      name: "MF2 WASM Editor",
      source_url: @source_url,
      description: description(),
      package: package(),
      deps: deps(),
      docs: docs(),
      elixir: "~> 1.17",
      start_permanent: Mix.env() == :prod,
      elixirc_paths: elixirc_paths(Mix.env())
    ]
  end

  def application do
    [
      # `:ssl`, `:inets`, `:public_key` are used by the
      # `mix mf2_wasm_editor.sync` task to fetch the grammar from
      # the unpkg CDN. They're OTP-bundled so they add no third-party
      # dependency surface.
      extra_applications: [:logger, :ssl, :inets, :public_key]
    ]
  end

  defp description do
    "Browser-side MF2 syntax highlighter + Phoenix LiveView hook. " <>
      "Ships a prebuilt web-tree-sitter bundle and the tree-sitter-mf2 " <>
      "grammar compiled to WASM. Consumers drop a script tag and a " <>
      "textarea-over-pre widget — no per-keystroke server round trip."
  end

  defp package do
    [
      maintainers: ["Kip Cole"],
      licenses: ["Apache-2.0"],
      links: %{
        "GitHub" => @source_url,
        "Changelog" => "#{@source_url}/blob/v#{@version}/CHANGELOG.md"
      },
      files: [
        "lib",
        "priv/static",
        "priv/grammar",
        "priv/themes",
        "guides",
        "mix.exs",
        "README.md",
        "CHANGELOG.md",
        "LICENSE.md"
      ]
    ]
  end

  defp deps do
    [
      {:ex_doc, "~> 0.34", only: [:dev, :release], runtime: false}
    ]
  end

  defp docs do
    [
      source_ref: "v#{@version}",
      main: "readme",
      formatters: ["html", "markdown"],
      extras: [
        "README.md",
        "guides/wiring.md": [title: "Wiring"],
        "guides/features.md": [title: "Features"],
        "CHANGELOG.md": [title: "Changelog"],
        "LICENSE.md": [title: "Licence"]
      ],
      groups_for_extras: [
        Guides: ["guides/wiring.md", "guides/features.md"]
      ]
    ]
  end

  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_), do: ["lib"]
end
