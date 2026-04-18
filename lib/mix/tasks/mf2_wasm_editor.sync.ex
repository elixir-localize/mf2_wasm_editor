defmodule Mix.Tasks.Mf2WasmEditor.Sync do
  @moduledoc """
  Sync the vendored grammar + WASM + queries from the
  [`mf2_treesitter`](https://github.com/elixir-localize/mf2_treesitter)
  repo.

  This package embeds the MF2 grammar as browser-facing artefacts:

    * **WASM** (`priv/static/tree-sitter-mf2.wasm`) — what the
      `web-tree-sitter` runtime actually loads.

    * **Queries** (`priv/static/highlights.scm`, `injections.scm`)
      — fetched at runtime by the JS hook.

    * **Grammar source** (`priv/grammar/`) — parser.c, parser.h,
      grammar.json, node-types.json, grammar.js. Kept alongside as
      reference so the WASM can be regenerated locally if needed.

  The canonical source for all three lives in `mf2_treesitter`.
  This task keeps our vendored copy in step.

  ## Usage

      # Copy sources + queries + WASM from the sibling mf2_treesitter.
      mix mf2_wasm_editor.sync

      # Fail (exit 1) if anything has drifted; do not modify files.
      # Intended for CI.
      mix mf2_wasm_editor.sync --check

      # Additionally rebuild priv/static/tree-sitter-mf2.wasm from
      # the vendored grammar (rather than just copying the grammar
      # repo's prebuilt .wasm). Requires emcc, docker, or podman on
      # PATH; uses the tree-sitter CLI under node_modules/.bin of
      # mf2_treesitter.
      mix mf2_wasm_editor.sync --build-wasm

  ## Locating the grammar repo

  The task looks for `mf2_treesitter` at `../mf2_treesitter` relative
  to this package. Override with `MF2_TREESITTER_DIR`:

      MF2_TREESITTER_DIR=/path/to/mf2_treesitter mix mf2_wasm_editor.sync
  """
  use Mix.Task

  @shortdoc "Sync the vendored tree-sitter-mf2 grammar + WASM + queries from mf2_treesitter."

  # Files to sync from mf2_treesitter. Each tuple is `{source_rel, dest_rel}`
  # — source relative to the mf2_treesitter repo root, dest relative to
  # this package's priv/ directory.
  @grammar_files [
    {"grammar.js", "grammar/grammar.js"},
    {"src/grammar.json", "grammar/src/grammar.json"},
    {"src/node-types.json", "grammar/src/node-types.json"},
    {"src/parser.c", "grammar/src/parser.c"},
    {"src/tree_sitter/parser.h", "grammar/src/tree_sitter/parser.h"}
  ]

  @query_files [
    {"queries/highlights.scm", "static/highlights.scm"}
  ]

  @wasm_files [
    # mf2_treesitter ships a prebuilt .wasm; copy it verbatim into
    # priv/static/ so we don't need emscripten/docker on consumers'
    # machines. Override via --build-wasm.
    {"wasm/tree-sitter-mf2.wasm", "static/tree-sitter-mf2.wasm"}
  ]

  @switches [check: :boolean, build_wasm: :boolean]

  @impl Mix.Task
  def run(argv) do
    {opts, _rest} = OptionParser.parse!(argv, switches: @switches)

    check? = opts[:check] == true
    build_wasm? = opts[:build_wasm] == true

    grammar_dir = grammar_dir!()
    priv_dir = priv_dir()

    Mix.shell().info("[sync] grammar source: #{grammar_dir}")
    Mix.shell().info("[sync] package priv:   #{priv_dir}")

    files_to_sync = @grammar_files ++ @query_files

    # When --build-wasm is passed we rebuild locally instead of
    # copying the prebuilt WASM, so skip the WASM copy in that path.
    files_to_sync =
      if build_wasm?, do: files_to_sync, else: files_to_sync ++ @wasm_files

    drift = sync_files(grammar_dir, priv_dir, files_to_sync, check?)

    cond do
      check? and drift != [] ->
        Mix.shell().error("[sync] drift detected in #{length(drift)} file(s):")

        Enum.each(drift, fn path ->
          Mix.shell().error("  - #{path}")
        end)

        Mix.shell().error("Run `mix mf2_wasm_editor.sync` to update.")
        exit({:shutdown, 1})

      check? ->
        Mix.shell().info("[sync] check: all vendored files match the source repo.")

      drift == [] ->
        Mix.shell().info("[sync] already in sync; no files changed.")

      true ->
        Mix.shell().info("[sync] updated #{length(drift)} file(s).")
    end

    if build_wasm? do
      build_wasm(grammar_dir, priv_dir)
    end

    :ok
  end

  defp sync_files(src_root, dst_root, pairs, check?) do
    Enum.reduce(pairs, [], fn {src_rel, dst_rel}, acc ->
      src_path = Path.join(src_root, src_rel)
      dst_path = Path.join(dst_root, dst_rel)

      unless File.exists?(src_path) do
        Mix.raise("missing source file: #{src_path}")
      end

      if changed?(src_path, dst_path) do
        unless check? do
          File.mkdir_p!(Path.dirname(dst_path))
          File.cp!(src_path, dst_path)
          Mix.shell().info("[sync] wrote #{dst_rel}")
        end

        [dst_rel | acc]
      else
        acc
      end
    end)
  end

  defp changed?(src, dst) do
    cond do
      not File.exists?(dst) -> true
      File.read!(src) != File.read!(dst) -> true
      true -> false
    end
  end

  defp build_wasm(grammar_dir, priv_dir) do
    tree_sitter_bin = Path.join([grammar_dir, "node_modules", ".bin", "tree-sitter"])

    unless File.exists?(tree_sitter_bin) do
      Mix.raise("""
      Could not find tree-sitter CLI at #{tree_sitter_bin}.

      Run `npm install` inside #{grammar_dir} first, or set
      MF2_TREESITTER_DIR to a grammar checkout where dependencies are
      installed.
      """)
    end

    output_path = Path.join(priv_dir, "static/tree-sitter-mf2.wasm")
    File.mkdir_p!(Path.dirname(output_path))

    Mix.shell().info("[sync] building tree-sitter-mf2.wasm from #{grammar_dir}")
    Mix.shell().info("[sync] (requires emcc, docker, or podman on PATH)")

    {output, status} =
      System.cmd(tree_sitter_bin, ["build", "--wasm", "--output", output_path],
        cd: grammar_dir,
        stderr_to_stdout: true
      )

    if status == 0 do
      Mix.shell().info("[sync] built #{output_path}")
    else
      Mix.shell().error(output)
      Mix.raise("tree-sitter build --wasm failed (exit #{status})")
    end
  end

  defp grammar_dir! do
    override = System.get_env("MF2_TREESITTER_DIR")

    path =
      cond do
        is_binary(override) and override != "" -> override
        true -> Path.expand("../mf2_treesitter", File.cwd!())
      end

    unless File.dir?(path) do
      Mix.raise("""
      mf2_treesitter not found at: #{path}

      Set MF2_TREESITTER_DIR to the mf2_treesitter repo, or check
      it out as a sibling of this package.
      """)
    end

    path
  end

  defp priv_dir do
    Path.join(File.cwd!(), "priv")
  end
end
