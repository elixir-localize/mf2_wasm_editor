defmodule Mix.Tasks.LocalizeMf2Editor.Sync do
  @moduledoc """
  Sync the vendored grammar + queries from the `mf2_editor_extensions`
  sibling repo, and optionally rebuild `tree-sitter-mf2.wasm`.

  This package embeds the MF2 grammar as three parallel artefacts:

    * Source and generated parser (`priv/grammar/`) — `parser.c`,
      `grammar.json`, `node-types.json`, plus `grammar.js` for
      reference. Used to regenerate the WASM from scratch.

    * Highlight and injection queries (`priv/queries/`) — the two
      `.scm` files consumed by the browser-side `web-tree-sitter`
      loader at runtime.

    * The compiled WASM (`priv/static/tree-sitter-mf2.wasm`) — the
      artefact browsers load.

  The canonical source of all three lives in
  `mf2_editor_extensions/tree-sitter-mf2/`. This task keeps our
  vendored copy in step.

  ## Usage

      # Copy sources + queries from the sibling repo.
      mix localize_mf2_editor.sync

      # Fail (exit 1) if anything has drifted; do not modify files.
      # Intended for CI.
      mix localize_mf2_editor.sync --check

      # Additionally rebuild priv/static/tree-sitter-mf2.wasm.
      # Requires either emcc, docker, or podman on PATH. Uses the
      # tree-sitter CLI under node_modules/.bin of the source repo.
      mix localize_mf2_editor.sync --build-wasm

  ## Locating the grammar repo

  The task looks for the grammar at `../mf2_editor_extensions/tree-sitter-mf2`
  relative to this package. Override with `MF2_GRAMMAR_DIR`:

      MF2_GRAMMAR_DIR=/path/to/tree-sitter-mf2 mix localize_mf2_editor.sync
  """
  use Mix.Task

  @shortdoc "Sync the vendored tree-sitter-mf2 grammar sources and queries."

  @grammar_files [
    {"grammar.js", "grammar/grammar.js"},
    {"package.json", "grammar/package.json"},
    {"src/grammar.json", "grammar/src/grammar.json"},
    {"src/node-types.json", "grammar/src/node-types.json"},
    {"src/parser.c", "grammar/src/parser.c"},
    {"src/tree_sitter/parser.h", "grammar/src/tree_sitter/parser.h"}
  ]

  @query_files [
    {"queries/highlights.scm", "static/highlights.scm"},
    {"queries/injections.scm", "static/injections.scm"}
  ]

  @wasm_output "static/tree-sitter-mf2.wasm"

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

    drift =
      sync_files(grammar_dir, priv_dir, @grammar_files, check?) ++
        sync_files(grammar_dir, priv_dir, @query_files, check?)

    cond do
      check? and drift != [] ->
        Mix.shell().error("[sync] drift detected in #{length(drift)} file(s):")

        Enum.each(drift, fn path ->
          Mix.shell().error("  - #{path}")
        end)

        Mix.shell().error("Run `mix localize_mf2_editor.sync` to update.")
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
      MF2_GRAMMAR_DIR to a grammar checkout where dependencies are
      installed.
      """)
    end

    output_path = Path.join(priv_dir, @wasm_output)
    File.mkdir_p!(Path.dirname(output_path))

    Mix.shell().info("[sync] building #{@wasm_output}")
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
    override = System.get_env("MF2_GRAMMAR_DIR")

    path =
      cond do
        is_binary(override) and override != "" ->
          override

        true ->
          Path.expand("../mf2_editor_extensions/tree-sitter-mf2", File.cwd!())
      end

    unless File.dir?(path) do
      Mix.raise("""
      grammar source not found at: #{path}

      Set MF2_GRAMMAR_DIR to the tree-sitter-mf2 directory of
      `mf2_editor_extensions`, or check out that repo as a sibling
      of this package.
      """)
    end

    path
  end

  defp priv_dir do
    Path.join(File.cwd!(), "priv")
  end
end
