defmodule Mf2WasmEditor.MixProject do
  use Mix.Project

  @version "0.1.0"
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
      extra_applications: [:logger]
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
      extras: ["README.md", "CHANGELOG.md", "LICENSE.md"]
    ]
  end

  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_), do: ["lib"]
end
