/*
 * mf2_wasm_editor — browser-side MF2 syntax highlighter.
 *
 * Ships a Phoenix LiveView hook (`MF2Editor`) that runs the
 * tree-sitter-mf2 grammar directly in the browser via
 * web-tree-sitter. Keystrokes never leave the client for highlighting
 * or diagnostics — server round trips are reserved for formatting
 * (`Localize.Message.format/3`) and other authoritative operations.
 *
 * Loading
 * -------
 *
 * This file is an ES module. The root layout emits a single
 * `<script type="module" src="/mf2_editor/mf2_editor.js">` tag (see
 * `Mf2WasmEditor.script_tags/1`). The module imports web-tree-sitter
 * directly from the neighbouring `web-tree-sitter.js` — no separate
 * loader script, no global pollution.
 *
 * After the module evaluates, `window.Mf2WasmEditor.Hooks.MF2Editor`
 * is the LiveView hook. Merge it into your LiveSocket's `hooks`
 * option in your app.js:
 *
 *     const Hooks = Object.assign({}, window.Mf2WasmEditor?.Hooks || {});
 *     new LiveSocket("/live", Socket, { hooks: Hooks, ... });
 *
 * Expected DOM
 * ------------
 *
 *   <div phx-hook="MF2Editor" id="...">
 *     <pre aria-hidden="true"><code></code></pre>
 *     <textarea name="message" phx-update="ignore"></textarea>
 *   </div>
 *
 * The pre and code elements are populated by the hook. The textarea
 * owns the text; we use `phx-update="ignore"` so the caret position
 * is never clobbered by LiveView patches.
 *
 * Base URL
 * --------
 *
 * All WASM / query assets are fetched from `/mf2_editor/` by default.
 * Override by setting `window.Mf2WasmEditor.baseUrl = "..."`
 * before this script loads, or via a `data-mf2-base-url="..."`
 * attribute on the hook element.
 */

import { Parser, Language, Query } from "./web-tree-sitter.js";

const DEFAULT_BASE_URL = "/mf2_editor";

const ns = (window.Mf2WasmEditor = window.Mf2WasmEditor || {});
ns.baseUrl = ns.baseUrl || DEFAULT_BASE_URL;

// ------------------------------------------------------------------
// One-time page-wide initialisation of the tree-sitter runtime,
// grammar, and highlight query. Cached on the namespace so multiple
// editor instances share a single Language and Query.
// ------------------------------------------------------------------

let initPromise = null;

function initialize(baseUrl) {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    // The runtime is loaded as an ES module, so Parser / Language
    // are directly available. Parser.init() still pulls the
    // web-tree-sitter WASM; point locateFile at our baseUrl so
    // the runtime WASM resolves next to this script.
    await Parser.init({
      locateFile: (path) => `${baseUrl}/${path}`,
    });

    const language = await Language.load(
      `${baseUrl}/tree-sitter-mf2.wasm`
    );

      const highlightsSource = await fetch(`${baseUrl}/highlights.scm`).then(
        (r) => {
          if (!r.ok) {
            throw new Error(
              `MF2 editor: failed to fetch highlights.scm (${r.status})`
            );
          }
          return r.text();
        }
      );

      // web-tree-sitter 0.26+ query API: `new Query(language, source)`
      // replaces the older `language.query(source)`.
      const highlightQuery = new Query(language, highlightsSource);

      return { language, highlightQuery };
    })();

    return initPromise;
  }

  // ------------------------------------------------------------------
  // Rendering helpers.
  //
  // Three orthogonal "paints" combine on each source byte:
  //
  //   1. Highlight (from the tree-sitter captures) — determines the
  //      token colour via classes like `mf2-variable`, `mf2-function`.
  //   2. Diagnostic (from the tree walk) — `mf2-diag-error` or
  //      `mf2-diag-missing`, with an associated human-readable message
  //      emitted as a `title=` tooltip on the span.
  //   3. Bracket match (from the caret position) — transient
  //      `mf2-bracket-match` class on the pair of bracket tokens the
  //      caret is adjacent to.
  //
  // We walk every byte, compute the combined tag, and emit a span
  // each time the tag changes between consecutive bytes. Runs are
  // collapsed aggressively so the resulting HTML is compact.
  // ------------------------------------------------------------------

  function classFor(captureName) {
    return "mf2-" + captureName.replace(/\./g, "-");
  }

  const HTML_ESCAPE = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  function htmlEscape(s) {
    return s.replace(/[&<>"']/g, (c) => HTML_ESCAPE[c]);
  }

  function paintHighlights(captures) {
    const sorted = captures
      .map((c) => ({
        name: c.name,
        start: c.node.startIndex,
        end: c.node.endIndex,
        width: c.node.endIndex - c.node.startIndex,
      }))
      .sort((a, b) => b.width - a.width);

    const paint = new Map();
    for (const s of sorted) {
      for (let i = s.start; i < s.end; i++) paint.set(i, s.name);
    }
    return paint;
  }

  // Parent types that tree-sitter's GLR recovery hangs generic
  // top-level ERROR nodes off when it can't localise a problem. The
  // resulting diagnostic is the unhelpful "Unexpected input in
  // message". When our own brace scan produces a more specific hit
  // for the same edit, we suppress these.
  const TOP_LEVEL_ERROR_PARENTS = new Set([
    "source_file",
    "message",
    "simple_message",
    "complex_message",
  ]);

  // Line-scoped scan for an unmatched single `{`. Catches the
  // single most common MF2 mistake — a forgotten closing `}` on a
  // placeholder — with a diagnostic pointing directly at the
  // offending `{`, rather than tree-sitter's generic "Unexpected
  // input in message" fallback.
  //
  // Design: run per-line and only balance single braces. `{{` / `}}`
  // are quoted-pattern delimiters that may legitimately span lines,
  // so we skip them entirely rather than try to pair them up. What
  // matters is: every single `{` must be closed by a single `}`
  // before the line ends. Any `{` still open when the line ends is
  // reported.
  //
  // Skip conditions inside a line:
  //   - Backslash-escaped braces (`\\{`, `\\}`): text, not syntax.
  //   - Braces inside a quoted literal (`|…|`): text, not syntax.
  //   - `{{` and `}}` digraphs: skipped whole (not single braces).
  //
  // This only runs when tree-sitter has already reported errors —
  // so a valid multi-line placeholder (grammar-legal but rare)
  // parses cleanly and never reaches here, no false positive.
  function scanUnmatchedBraces(source) {
    const errors = [];
    const lines = source.split("\n");
    let lineStart = 0;

    for (let row = 0; row < lines.length; row++) {
      const line = lines[row];
      const stack = []; // column indices of unmatched `{` on this line
      let inLiteral = false;

      for (let j = 0; j < line.length; j++) {
        const c = line[j];

        if (c === "\\" && j + 1 < line.length) {
          j++;
          continue;
        }

        if (c === "|") {
          inLiteral = !inLiteral;
          continue;
        }

        if (inLiteral) continue;

        if (c === "{") {
          if (line[j + 1] === "{") {
            // `{{` — quoted-pattern opener, skip both chars.
            j++;
          } else {
            stack.push(j);
          }
        } else if (c === "}") {
          if (line[j + 1] === "}") {
            // `}}` — quoted-pattern closer, skip both chars.
            j++;
          } else if (stack.length) {
            stack.pop();
          }
          // A lone `}` with no matching `{` on the same line isn't
          // flagged here: it may be the second half of a `{{…}}`
          // closer split oddly across lines. Tree-sitter catches
          // that case well enough on its own.
        }
      }

      // Any `{` still on the stack at end of line is unclosed.
      for (const col of stack) {
        errors.push({
          startIndex: lineStart + col,
          endIndex: lineStart + col + 1,
          startPosition: { row, column: col },
          endPosition: { row, column: col + 1 },
          message: "Missing closing `}` on this line",
        });
      }

      lineStart += line.length + 1; // +1 for the `\n`
    }

    return errors;
  }

  // Scan for `.match` with no following selector. Tree-sitter's
  // error recovery often can't localise this at the match_statement
  // level — the ERROR bubbles up to a higher parent and surfaces as
  // a generic "Unexpected input in message". Detecting the
  // missing-selector case up front lets us point directly at the
  // `.match` keyword with a specific, actionable message.
  //
  // Matches `.match` at the start of a line (possibly indented).
  // A selector is present iff the next non-whitespace character is
  // `$` (selectors are always variables in MF2).
  function scanMissingMatchSelector(source) {
    const errors = [];
    const regex = /(^|\n)([^\S\n]*)\.match\b/g;
    let m;
    while ((m = regex.exec(source)) !== null) {
      const matchStart = m.index + m[1].length + m[2].length;
      const matchEnd = matchStart + ".match".length;

      // Skip whitespace (including newlines) after `.match`.
      let i = matchEnd;
      while (i < source.length && /\s/.test(source[i])) i++;

      // `$...` means a selector is there — nothing to report.
      if (i < source.length && source[i] === "$") continue;

      const startPos = positionForIndex(source, matchStart);
      const endPos = positionForIndex(source, matchEnd);
      errors.push({
        startIndex: matchStart,
        endIndex: matchEnd,
        startPosition: startPos,
        endPosition: endPos,
        message:
          "Expected at least one selector after `.match` — a variable like `$count` " +
          "(e.g. `.match $count`)",
      });
    }
    return errors;
  }

  // Convert a byte index into `{row, column}` for a synthetic
  // diagnostic. Linear scan is fine: sources are small and this
  // runs at most a handful of times per parse.
  function positionForIndex(source, index) {
    let row = 0;
    let lastNewline = -1;
    for (let i = 0; i < index; i++) {
      if (source[i] === "\n") {
        row++;
        lastNewline = i;
      }
    }
    return { row, column: index - lastNewline - 1 };
  }

  // Scan for a `{{…}}` quoted pattern appearing where a variant key
  // should precede it. A common beginner mistake is writing
  //
  //     .match $count
  //     {{You have no messages.}}
  //
  // and expecting that to be a matcher with one variant. MF2
  // requires every variant to start with a key (`*` or a literal),
  // so the pattern above is missing `*` before the `{{`. Tree-sitter
  // recovery for this tends to yield a generic top-level ERROR
  // ("Unexpected input in message") rather than pointing at the
  // specific line, so we catch it here.
  //
  // Strategy: walk lines from each `.match $var` line forward. Any
  // line whose first non-whitespace content is `{{` (and not `{{{`,
  // which would be a literal `{` inside a pattern) is flagged. Stop
  // on another top-level declaration keyword.
  function scanMissingVariantKey(source) {
    const errors = [];
    const lines = source.split("\n");
    let lineStart = 0;

    let inMatcher = false;
    for (let row = 0; row < lines.length; row++) {
      const line = lines[row];
      const trimStart = line.length - line.trimStart().length;
      const trimmed = line.slice(trimStart);

      // Enter matcher context on a `.match $var` line.
      if (/^\.match\b/.test(trimmed) && /\$/.test(trimmed)) {
        inMatcher = true;
        lineStart += line.length + 1;
        continue;
      }

      // Any other top-level declaration closes the current matcher
      // scope — matchers can't follow more `.input` / `.local` lines.
      if (/^\.(input|local|match)\b/.test(trimmed)) {
        inMatcher = false;
        lineStart += line.length + 1;
        continue;
      }

      if (inMatcher && trimmed.startsWith("{{") && !trimmed.startsWith("{{{")) {
        const col = trimStart;
        errors.push({
          startIndex: lineStart + col,
          endIndex: lineStart + col + 2,
          startPosition: { row, column: col },
          endPosition: { row, column: col + 2 },
          message:
            "Expected a variant key before `{{…}}` — use `*` for the default " +
            "(e.g. `* {{…}}`) or a literal like `1` / `|short|`",
        });
      }

      lineStart += line.length + 1;
    }

    return errors;
  }

  // Semantic check for `.match` matchers: the number of keys per
  // variant must equal the number of selectors. Tree-sitter's
  // grammar is syntactically permissive here (variant = 1+ keys +
  // quoted_pattern) because the key-count constraint is semantic,
  // not syntactic. So inputs like `.match $a $b` followed by
  // `1 {{one}}` (only one key, two selectors) parse cleanly but
  // violate the MF2 data model.
  //
  // We only check matchers whose subtree has no tree-sitter errors;
  // a broken matcher's children are unreliable and tree-sitter will
  // already have emitted its own diagnostic.
  function scanMatcherSemantics(rootNode) {
    const errors = [];

    function walk(node) {
      if (node.type === "matcher" && !node.hasError) {
        const matchStmt = node.namedChildren.find((c) => c.type === "match_statement");
        if (matchStmt) {
          const selectorCount = matchStmt.namedChildren.filter(
            (c) => c.type === "selector"
          ).length;

          for (const child of node.namedChildren) {
            if (child.type !== "variant") continue;

            const keys = child.namedChildren.filter((c) => c.type === "key");
            if (keys.length === selectorCount) continue;

            // Anchor the diagnostic at the first key of the offending
            // variant — that's where the user's eye will land.
            const target = keys[0] || child;
            errors.push({
              startIndex: target.startIndex,
              endIndex: target.endIndex,
              startPosition: target.startPosition,
              endPosition: target.endPosition,
              message:
                `Wrong number of variant keys — ` +
                `.match has ${selectorCount} ` +
                (selectorCount === 1 ? "selector" : "selectors") +
                `, this variant has ${keys.length} ` +
                (keys.length === 1 ? "key" : "keys"),
            });
          }
        }
      }

      for (const child of node.children) walk(child);
    }

    walk(rootNode);
    return errors;
  }

  // Semantic check for undeclared variable references. MF2 allows a
  // `$name` to come from runtime bindings without being declared, so
  // this is technically not a syntax error — but once a message has
  // at least one `.input` or `.local`, the convention is to declare
  // every variable it uses. An undeclared reference in that context
  // is almost always a typo of a declared name.
  //
  // Gating:
  //   - Simple messages are always skipped (no declarations possible).
  //   - Complex messages with zero declarations are skipped (user
  //     chose to rely entirely on runtime bindings — no convention
  //     to enforce).
  //   - Otherwise, every reference not in the definitions map is
  //     flagged with a message that explains both the typo case
  //     and the "intentional binding" case, so users can ignore it
  //     if they meant a binding-supplied variable.
  function scanUndeclaredVariables(rootNode) {
    const errors = [];
    if (!rootNode) return errors;

    const graph = buildLocalsGraph(rootNode);
    if (!graph.scope) return errors;
    if (graph.definitions.size === 0) return errors;

    for (const ref of graph.allReferences) {
      if (graph.definitions.has(ref.name)) continue;
      errors.push({
        startIndex: ref.node.startIndex,
        endIndex: ref.node.endIndex,
        startPosition: ref.node.startPosition,
        endPosition: ref.node.endPosition,
        message:
          "`$" +
          ref.name +
          "` is not declared — add `.input $" +
          ref.name +
          "` or `.local $" +
          ref.name +
          " = …` above, or ignore this if it's a runtime binding",
      });
    }

    return errors;
  }

  function collectDiagnostics(rootNode, source) {
    const out = [];

    // Syntactic diagnostics — tree-sitter's own error nodes, plus
    // our pre-scans. Only runs when tree-sitter reports an error
    // anywhere in the tree.
    if (rootNode.hasError) {
      // Pre-scans run up-front so their more specific messages take
      // precedence. If any of them produce a hit, we treat the
      // generic top-level "Unexpected input in message" ERROR as
      // redundant and suppress it.
      const braceErrors = source ? scanUnmatchedBraces(source) : [];
      const matchSelectorErrors = source ? scanMissingMatchSelector(source) : [];
      const variantKeyErrors = source ? scanMissingVariantKey(source) : [];
      const haveBraceHit = braceErrors.length > 0;
      const haveMatchHit = matchSelectorErrors.length > 0;
      const haveVariantKeyHit = variantKeyErrors.length > 0;
      const havePreScanHit = haveBraceHit || haveMatchHit || haveVariantKeyHit;

      for (const err of braceErrors) {
        out.push({ kind: "error", node: err, message: err.message });
      }

      for (const err of matchSelectorErrors) {
        out.push({ kind: "error", node: err, message: err.message });
      }

      for (const err of variantKeyErrors) {
        out.push({ kind: "error", node: err, message: err.message });
      }

      // Depth-first walk. Tree-sitter's GLR error recovery yields
      // two flavours of broken-state node: `isMissing` for required
      // tokens the grammar expected but didn't find, and `isError`
      // for spans of input that couldn't be fitted to any
      // production. We only descend when the subtree contains an
      // error anywhere.
      function walk(node) {
        if (node.isMissing) {
          out.push({ kind: "missing", node, message: diagnosticMessage("missing", node) });
        } else if (node.isError) {
          const parent = node.parent;
          const isGenericTopLevel =
            parent && TOP_LEVEL_ERROR_PARENTS.has(parent.type);
          // Also suppress generic matcher-level ERRORs when our
          // match-selector or variant-key pre-scan already flagged
          // the same area — tree-sitter's fallback is redundant.
          const isRedundantMatcherError =
            (haveMatchHit || haveVariantKeyHit) &&
            parent &&
            (parent.type === "matcher" ||
              parent.type === "match_statement" ||
              parent.type === "variant");
          if (!(havePreScanHit && (isGenericTopLevel || isRedundantMatcherError))) {
            out.push({ kind: "error", node, message: diagnosticMessage("error", node) });
          }
        }

        if (node.hasError) {
          for (const child of node.children) walk(child);
        }
      }

      walk(rootNode);
    }

    // Semantic diagnostics — run regardless of syntactic errors, so
    // problems like mismatched key counts or undeclared variables
    // surface even when the rest of the message parses cleanly.
    for (const err of scanMatcherSemantics(rootNode)) {
      out.push({ kind: "error", node: err, message: err.message });
    }

    for (const err of scanUndeclaredVariables(rootNode)) {
      out.push({ kind: "error", node: err, message: err.message });
    }

    return out;
  }

  // Map a diagnostic node (ERROR or MISSING) to a human-readable
  // message. We base this on two signals:
  //   - MISSING nodes: `node.type` is the expected token's literal
  //     or rule name. `"}}"` means the closer of a quoted pattern
  //     was expected; `"name"` means a variable or identifier name;
  //     and so on.
  //   - ERROR nodes: `node.type === "ERROR"`, carrying no detail.
  //     Use `node.parent.type` to phrase what production went wrong.
  //
  // The messages below cover the common cases. Anything else falls
  // back to a generic phrasing that still names the surrounding
  // production so the user has a hint where to look.
  const MISSING_NICE = {
    "}}": "closing `}}`",
    "}": "closing `}`",
    "{{": "opening `{{`",
    "{": "opening `{`",
    "|": "closing `|`",
    "=": "`=`",
    name: "name",
    expression: "expression",
    variable: "variable",
    variant: "variant",
    quoted_pattern: "quoted pattern `{{ ... }}`",
    identifier: "identifier",
    key: "variant key",
    selector: "selector (`$variable`) after `.match`",
  };

  const ERROR_CONTEXT = {
    local_declaration: "Expected a variable after `.local` (e.g. `.local $x = {...}`)",
    input_declaration: "Expected a variable in `.input` declaration (e.g. `.input {$x :number}`)",
    match_statement: "Expected a selector after `.match` (e.g. `.match $count`)",
    matcher: "Expected a variant key and `{{...}}` pattern",
    variant: "Expected a variant key (a literal or `*`) followed by `{{...}}`",
    expression: "Incomplete expression — expected `{` … `}`",
    variable_expression: "Incomplete variable expression",
    literal_expression: "Incomplete literal expression",
    annotation_expression: "Incomplete annotation expression",
    function: "Incomplete function — expected `:identifier` (e.g. `:number`)",
    option: "Incomplete option — expected `name = value`",
    attribute: "Incomplete attribute — expected `@name` or `@name = value`",
    quoted_literal: "Incomplete quoted literal — expected closing `|`",
    quoted_pattern: "Incomplete quoted pattern — expected closing `}}`",
    placeholder: "Incomplete placeholder — expected closing `}`",
    markup_open_or_standalone: "Incomplete markup — expected closing `}`",
    markup_close: "Incomplete closing markup — expected closing `}`",
    source_file: "Unexpected input",
    message: "Unexpected input in message",
    simple_message: "Unexpected input in message",
    complex_message: "Unexpected input in message",
  };

  function diagnosticMessage(kind, node) {
    if (kind === "missing") {
      const raw = node.type;
      const contextMsg = contextualMissingMessage(node, raw);
      if (contextMsg) return contextMsg;
      const nice = MISSING_NICE[raw] || `\`${raw}\``;
      return `Expected ${nice} here`;
    }
    // kind === "error"
    const parent = node.parent;
    if (!parent) return "Unexpected input";
    return ERROR_CONTEXT[parent.type] || `Unexpected input in \`${parent.type}\``;
  }

  // Context-aware phrasing for MISSING tokens. The raw grammar
  // type (`name`, `variable`, `literal`…) is semantically thin;
  // surrounding productions tell us what the user was actually
  // trying to write. Return a complete message or null to fall
  // through to the default MISSING_NICE lookup.
  function contextualMissingMessage(node, raw) {
    if (raw !== "name" && raw !== "variable" && raw !== "literal") return null;

    // Selector: `.match $count` — the variable *is* the selector.
    if (hasAncestorOfType(node, ["selector", "match_statement"])) {
      return "Expected a selector here (a variable like `$count`)";
    }
    // Variant key: the literal or `*` before a `{{…}}` in a match arm.
    if (hasAncestorOfType(node, ["variant", "key"])) {
      return "Expected a variant key here (a literal or `*`)";
    }
    // Function name: `:number`, `:date`, etc.
    if (hasAncestorOfType(node, ["function"])) {
      return "Expected a function name here (e.g. `:number`)";
    }
    // Attribute name: `@translate`, `@dir`.
    if (hasAncestorOfType(node, ["attribute"])) {
      return "Expected an attribute name here (e.g. `@translate`)";
    }
    // Option name: `style`, `minimumFractionDigits`.
    if (hasAncestorOfType(node, ["option"])) {
      return "Expected an option name here (e.g. `style`)";
    }
    return null;
  }

  // Walk up the parent chain and return true if any ancestor has
  // one of the given types. Used for context-aware phrasing of
  // diagnostics.
  function hasAncestorOfType(node, types) {
    let p = node.parent;
    while (p) {
      if (types.includes(p.type)) return true;
      p = p.parent;
    }
    return false;
  }

  // Paint returns byte → diagnostic-index-or-undefined. The caller
  // uses the index to look up the message for the tooltip.
  function paintDiagnostics(diagnostics, sourceSize) {
    const paint = new Map();
    for (let idx = 0; idx < diagnostics.length; idx++) {
      const d = diagnostics[idx];
      const bytes = diagnosticBytes(
        d.kind,
        d.node.startIndex,
        d.node.endIndex,
        sourceSize
      );
      for (const i of bytes) {
        const existingIdx = paint.get(i);
        if (existingIdx !== undefined && diagnostics[existingIdx].kind === "error") continue;
        if (d.kind === "error" || existingIdx === undefined) paint.set(i, idx);
      }
    }
    return paint;
  }

  function diagnosticBytes(kind, s, e, size) {
    if (e > s) {
      const out = [];
      for (let i = s; i < e; i++) out.push(i);
      return out;
    }
    // Zero-width (MISSING). Steal the previous character so the
    // squiggle has something visible to underline.
    if (s > 0 && s <= size) return [s - 1];
    if (s === 0 && size > 0) return [0];
    return [];
  }

  function diagClass(kind) {
    return kind === "error" ? "mf2-diag-error" : "mf2-diag-missing";
  }

  // Compute the combined class list + optional title for a byte's
  // tuple `{hl, diagIdx, matched}`. The tuple is what we compare
  // between consecutive bytes to decide whether to start a new run.
  function runAttrs(hl, diag, matched) {
    const classes = [];
    if (hl) classes.push(classFor(hl));
    if (diag) classes.push(diagClass(diag.kind));
    if (matched) classes.push("mf2-bracket-match");
    const title = diag ? diag.message : null;
    return { classes: classes.join(" "), title };
  }

  // Walk every source byte and emit spans when the combined tag
  // changes between consecutive bytes.
  function buildHtml(source, captures, diagnostics, matchedBytes) {
    const size = source.length;
    if (size === 0) return "";

    const hlPaint = paintHighlights(captures);
    const diagPaint = paintDiagnostics(diagnostics, size);
    const matchSet = matchedBytes || null;

    const out = [];
    let runStart = 0;
    let runKey = tagKey(0, hlPaint, diagPaint, matchSet);

    for (let i = 1; i < size; i++) {
      const key = tagKey(i, hlPaint, diagPaint, matchSet);
      if (key !== runKey) {
        emitRun(out, source, runStart, i, runKey, diagnostics);
        runStart = i;
        runKey = key;
      }
    }
    emitRun(out, source, runStart, size, runKey, diagnostics);
    return out.join("");
  }

  function tagKey(byte, hlPaint, diagPaint, matchSet) {
    // Pack (hl, diagIdx, matched) into a single comparable string.
    // We use positions in a fixed order so `===` detects equal tags.
    const hl = hlPaint.get(byte) || "";
    const di = diagPaint.has(byte) ? diagPaint.get(byte) : "";
    const m = matchSet && matchSet.has(byte) ? "m" : "";
    return hl + "\u0000" + di + "\u0000" + m;
  }

  function emitRun(out, source, start, end, runKey, diagnostics) {
    const parts = runKey.split("\u0000");
    const hl = parts[0] || null;
    const diag = parts[1] === "" ? null : diagnostics[parseInt(parts[1], 10)];
    const matched = parts[2] === "m";

    const { classes, title } = runAttrs(hl, diag, matched);
    const slice = htmlEscape(source.slice(start, end));

    if (!classes) {
      out.push(slice);
      return;
    }

    const attrs = [`class="${classes}"`];
    if (title) attrs.push(`title="${htmlEscape(title)}"`);
    out.push(`<span ${attrs.join(" ")}>${slice}</span>`);
  }

  // ------------------------------------------------------------------
  // Auto-close brackets, skip-over closers, pair-delete.
  //
  // Handled in a `beforeinput` listener rather than `keydown` so the
  // implementation is IME-safe: real typing has inputType
  // "insertText"; composition, paste, and autocorrect have different
  // inputTypes and pass straight through.
  // ------------------------------------------------------------------

  const AUTO_PAIRS = { "{": "}", "|": "|" };
  const CLOSERS = new Set(["}", "|"]);

  // Is there already an unmatched closer on the caret's line?
  // Used to decide whether auto-close would over-balance the line.
  //
  // For `{` / `}`: scan the current line left-to-right maintaining a
  // depth of open braces; a `}` seen at depth 0 is unmatched and
  // means "there's already a closer here looking for an opener —
  // don't add another closer when the user types `{`."
  //
  // For `|`: because the character is both opener and closer, we
  // count instead. An odd count means one `|` is currently
  // unmatched; the user's new `|` can pair with it, so no
  // auto-close. An even count (including zero) means the line is
  // pair-balanced, and the new `|` opens a new pair — auto-close.
  function lineHasUnmatchedCloserFor(value, caretPos, opener, closer) {
    const lineStart = value.lastIndexOf("\n", caretPos - 1) + 1;
    let lineEnd = value.indexOf("\n", caretPos);
    if (lineEnd === -1) lineEnd = value.length;
    const line = value.slice(lineStart, lineEnd);

    if (opener === closer) {
      // Self-paired token (e.g. `|`). Count occurrences; odd = one
      // unmatched waiting for a partner.
      let count = 0;
      for (let i = 0; i < line.length; i++) {
        if (line[i] === opener) count++;
      }
      return count % 2 === 1;
    }

    let depth = 0;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === opener) depth++;
      else if (c === closer) {
        if (depth === 0) return true;
        depth--;
      }
    }
    return false;
  }

  function handleBeforeInput(e, textarea) {
    if (!e.isTrusted) return false;

    if (e.inputType === "insertText" && typeof e.data === "string") {
      const ch = e.data;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;

      // Selection wrap — `{hello}`, `|hello|` etc. Always auto-close
      // in this case; the wrapping intent is unambiguous.
      if (start !== end) {
        const closer = AUTO_PAIRS[ch];
        if (closer) {
          const selected = textarea.value.slice(start, end);
          const updated =
            textarea.value.slice(0, start) +
            ch +
            selected +
            closer +
            textarea.value.slice(end);
          textarea.value = updated;
          textarea.setSelectionRange(start + 1, end + 1);
          dispatchSynthInput(textarea);
          e.preventDefault();
          return true;
        }
      }

      // Collapsed caret cases.
      if (start === end) {
        const next = textarea.value[start];

        // Skip-over: typing `}` just before a `}` that's already
        // there (most often from auto-pair) skips past it rather
        // than duplicating.
        if (CLOSERS.has(ch) && next === ch) {
          textarea.setSelectionRange(start + 1, start + 1);
          e.preventDefault();
          return true;
        }

        // Auto-close — but only if doing so wouldn't produce an
        // imbalance. If the line already carries an unmatched
        // closer (e.g. a `}` left over from earlier editing), the
        // typed opener will match that closer; auto-inserting
        // another closer would over-balance the line.
        const closer = AUTO_PAIRS[ch];
        if (closer) {
          if (
            !lineHasUnmatchedCloserFor(textarea.value, start, ch, closer)
          ) {
            const updated =
              textarea.value.slice(0, start) +
              ch +
              closer +
              textarea.value.slice(start);
            textarea.value = updated;
            textarea.setSelectionRange(start + 1, start + 1);
            dispatchSynthInput(textarea);
            e.preventDefault();
            return true;
          }
          // Fall through: let the browser insert the opener alone,
          // no closer added. The user (or later editing) closes it.
        }
      }
    }

    // Pair-delete: backspacing an opener whose matching closer sits
    // immediately after the caret removes both.
    if (e.inputType === "deleteContentBackward") {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      if (
        start === end &&
        start > 0 &&
        start < textarea.value.length
      ) {
        const prev = textarea.value[start - 1];
        const next = textarea.value[start];
        if (AUTO_PAIRS[prev] === next) {
          textarea.value =
            textarea.value.slice(0, start - 1) +
            textarea.value.slice(start + 1);
          textarea.setSelectionRange(start - 1, start - 1);
          dispatchSynthInput(textarea);
          e.preventDefault();
          return true;
        }
      }
    }

    return false;
  }

  function dispatchSynthInput(textarea) {
    // After mutating `.value` directly, neither the browser's input
    // event nor the phx-change listener would otherwise fire. Dispatch
    // one manually so LiveView sees the new value and the hook's own
    // input listener triggers a re-parse/repaint.
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // ------------------------------------------------------------------
  // Bracket matching.
  //
  // When the caret is immediately adjacent to a bracket character
  // (`{`, `}`, `{{`, `}}`, `|`), find the paired token via the
  // tree-sitter CST and mark both for rendering with the
  // `mf2-bracket-match` class.
  // ------------------------------------------------------------------

  const SINGLE_BRACKET_CHARS = new Set(["{", "}", "|"]);
  const PAIRED_TOKEN_TYPE = { "{": "}", "}": "{", "{{": "}}", "}}": "{{" };

  function findMatchedBrackets(tree, caret, source) {
    if (!tree) return null;
    const root = tree.rootNode;

    const candidates = [];

    // Character(s) to the LEFT of the caret.
    if (caret > 0) {
      if (caret >= 2 && (source.slice(caret - 2, caret) === "{{" ||
                         source.slice(caret - 2, caret) === "}}")) {
        candidates.push({ start: caret - 2, end: caret });
      }
      if (SINGLE_BRACKET_CHARS.has(source[caret - 1])) {
        candidates.push({ start: caret - 1, end: caret });
      }
    }
    // Character(s) to the RIGHT of the caret.
    if (caret < source.length) {
      if (caret + 2 <= source.length && (source.slice(caret, caret + 2) === "{{" ||
                                         source.slice(caret, caret + 2) === "}}")) {
        candidates.push({ start: caret, end: caret + 2 });
      }
      if (SINGLE_BRACKET_CHARS.has(source[caret])) {
        candidates.push({ start: caret, end: caret + 1 });
      }
    }

    for (const { start, end } of candidates) {
      const node = root.descendantForIndex(start, end);
      if (!node || !node.parent) continue;

      const type = node.type;
      // Pipe `|` has the same type for opener and closer — match
      // the other `|` sibling by position.
      if (type === "|") {
        for (const sibling of node.parent.children) {
          if (
            sibling.type === "|" &&
            sibling.startIndex !== node.startIndex
          ) {
            return new Set(bytesOfNode(node).concat(bytesOfNode(sibling)));
          }
        }
        continue;
      }

      const pairType = PAIRED_TOKEN_TYPE[type];
      if (!pairType) continue;

      for (const sibling of node.parent.children) {
        if (
          sibling.type === pairType &&
          sibling.startIndex !== node.startIndex
        ) {
          return new Set(bytesOfNode(node).concat(bytesOfNode(sibling)));
        }
      }
    }

    return null;
  }

  function bytesOfNode(node) {
    const out = [];
    for (let i = node.startIndex; i < node.endIndex; i++) out.push(i);
    return out;
  }

  function setsEqual(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    if (a.size !== b.size) return false;
    for (const x of a) if (!b.has(x)) return false;
    return true;
  }

  // Find the diagnostic span (if any) whose paint box contains the
  // viewport point (x, y).
  //
  // We can't use `document.elementsFromPoint` / `elementFromPoint`
  // here because those honour `pointer-events: none`, and our
  // diagnostic spans live inside a <pre> that has `pointer-events:
  // none` (so clicks pass through to the overlaying textarea). The
  // hit test would never find them.
  //
  // Instead, enumerate the diagnostic spans within the editor root
  // and check each one's bounding client rect directly. There are
  // usually ≤ O(10) diagnostic spans per editor; this is cheap.
  function findDiagnosticSpanAt(x, y, scope) {
    const root = scope || document;
    const spans = root.querySelectorAll(
      ".mf2-diag-error, .mf2-diag-missing"
    );
    for (const span of spans) {
      const rect = span.getBoundingClientRect();
      if (
        x >= rect.left &&
        x <= rect.right &&
        y >= rect.top &&
        y <= rect.bottom
      ) {
        return span;
      }
    }
    return null;
  }

  // ==================================================================
  //                    IDE-STYLE FEATURE INFRASTRUCTURE
  //
  // Everything below is the shared machinery for the richer editing
  // features layered on top of plain highlighting + diagnostics:
  //
  //   - Locals graph (definitions + references + scopes) from the CST.
  //   - Tree navigation helpers (descendant-at-caret, parent chain).
  //   - Caret → pixel coordinate mapping via a hidden mirror textarea.
  //   - Generic floating-popup framework used by completion, outline,
  //     hover, signature help.
  //   - Static function registry (hardcoded for now; will be replaced
  //     by a server push in a later pass).
  //   - CLDR plural categories per locale, for `.match` skeletons.
  //
  // Feature handlers live inside the MF2Editor hook further down; they
  // compose these primitives to implement goto-definition, rename,
  // outline, completion, etc.
  // ==================================================================

  // ---- Locals graph -------------------------------------------------
  //
  // Walks the tree once per parse and produces:
  //
  //   scope           — the complex_message node, if any (null for
  //                     simple messages; they have no declarations).
  //   definitions     — Map<name, { node, nameNode, kind }>
  //                     where kind is "input" | "local".
  //   referencesByName— Map<name, Array<referenceNode>>
  //                     (name of the variable → all name-node refs).
  //   allReferences   — flat list of { name, node } for fast walks.
  //
  // A "reference" is any `(variable (name))` occurrence; a "definition"
  // is the `(variable (name))` directly inside a `local_declaration`
  // or an `input_declaration`'s `variable_expression`.

  function buildLocalsGraph(rootNode) {
    const graph = {
      scope: null,
      definitions: new Map(),
      referencesByName: new Map(),
      allReferences: [],
    };

    if (!rootNode) return graph;

    // Find the complex_message (if any).
    let complex = null;
    walkTree(rootNode, (n) => {
      if (n.type === "complex_message") {
        complex = n;
        return "stop";
      }
      return "continue";
    });

    graph.scope = complex;
    const scopeRoot = complex || rootNode;

    // Pass 1: find definitions. Only declarations in the complex_message
    // (or its prelude) contribute — variables in expressions / patterns
    // are references.
    walkTree(scopeRoot, (n) => {
      if (n.type === "local_declaration") {
        const varNode = firstNamedChildOfType(n, "variable");
        if (varNode) recordDefinition(graph, varNode, "local");
        // Don't descend into the RHS expression — the `$x` in
        // `.local $x = {$y}` is a *definition* for $x but `$y` is a
        // *reference*. We recurse into children below, treating the
        // variable under local_declaration as special-cased; the
        // descent captures $y correctly.
      } else if (n.type === "input_declaration") {
        // .input {$x :f} — the $x directly inside the variable_expression
        // is the definition. Other variables inside the same expression
        // (options, etc.) would be references.
        const varExpr = firstNamedChildOfType(n, "variable_expression");
        if (varExpr) {
          const varNode = firstNamedChildOfType(varExpr, "variable");
          if (varNode) recordDefinition(graph, varNode, "input");
        }
      }
      return "continue";
    });

    // Pass 2: find references. Every `variable` that isn't a
    // definition is a reference. Because definitions are recorded with
    // a unique identity (startIndex), we can dedupe.
    const defIdents = new Set();
    for (const def of graph.definitions.values()) {
      defIdents.add(def.varNode.startIndex);
    }

    walkTree(scopeRoot, (n) => {
      if (n.type === "variable") {
        if (!defIdents.has(n.startIndex)) {
          const nameNode = firstNamedChildOfType(n, "name");
          if (nameNode) {
            const name = textOf(nameNode);
            const entry = { name, node: n, nameNode };
            graph.allReferences.push(entry);
            const list = graph.referencesByName.get(name) || [];
            list.push(entry);
            graph.referencesByName.set(name, list);
          }
        }
      }
      return "continue";
    });

    return graph;
  }

  function recordDefinition(graph, varNode, kind) {
    const nameNode = firstNamedChildOfType(varNode, "name");
    if (!nameNode) return;
    const name = textOf(nameNode);
    graph.definitions.set(name, { varNode, nameNode, kind, name });
  }

  // ---- Tree navigation helpers -------------------------------------

  function walkTree(root, visitor) {
    const cursor = root.walk();
    try {
      if (!cursor.gotoFirstChild()) {
        visitor(root);
        return;
      }
      // Revisit root first so pre-order invariants hold.
      visitor(root);
      let visiting = true;
      while (visiting) {
        const result = visitor(cursor.currentNode);
        if (result === "stop") return;
        if (cursor.gotoFirstChild()) continue;
        while (!cursor.gotoNextSibling()) {
          if (!cursor.gotoParent()) {
            visiting = false;
            break;
          }
        }
      }
    } finally {
      cursor.delete();
    }
  }

  function firstNamedChildOfType(node, type) {
    for (const c of node.namedChildren) if (c.type === type) return c;
    return null;
  }

  function textOf(node) {
    return node.text !== undefined
      ? node.text
      : // Older web-tree-sitter versions may not expose `.text`; fall back to slicing.
        null;
  }

  // Walk up from a node to the nearest named ancestor that satisfies
  // the predicate, inclusive.
  function enclosingNode(node, predicate) {
    let n = node;
    while (n) {
      if (predicate(n)) return n;
      n = n.parent;
    }
    return null;
  }

  // Smallest named node spanning [start, end).
  function namedNodeSpanning(root, start, end) {
    const n = root.namedDescendantForIndex
      ? root.namedDescendantForIndex(start, end)
      : null;
    return n || null;
  }

  // ---- Caret → pixel coordinate mapping ----------------------------
  //
  // A hidden <div> is positioned exactly over the textarea and
  // configured with identical font metrics, padding, wrap, and tab
  // size. We copy the textarea's value up to the caret position,
  // append a zero-width marker span, and read the marker's
  // getBoundingClientRect() — that's where the caret sits in screen
  // space. Standard mirror-div technique.

  let mirrorDiv = null;
  function caretCoords(textarea, offset) {
    if (!mirrorDiv) {
      mirrorDiv = document.createElement("div");
      mirrorDiv.className = "mf2-caret-mirror";
      mirrorDiv.setAttribute("aria-hidden", "true");
      // Off-screen but laid out.
      mirrorDiv.style.cssText =
        "position:absolute;visibility:hidden;top:0;left:0;" +
        "white-space:pre-wrap;word-wrap:break-word;overflow:hidden;";
      document.body.appendChild(mirrorDiv);
    }

    const cs = window.getComputedStyle(textarea);
    // Copy every metric that affects wrap and glyph positioning.
    const propsToCopy = [
      "boxSizing",
      "borderTopWidth",
      "borderRightWidth",
      "borderBottomWidth",
      "borderLeftWidth",
      "paddingTop",
      "paddingRight",
      "paddingBottom",
      "paddingLeft",
      "fontStyle",
      "fontVariant",
      "fontWeight",
      "fontSize",
      "fontFamily",
      "fontKerning",
      "fontFeatureSettings",
      "fontVariantLigatures",
      "fontOpticalSizing",
      "letterSpacing",
      "lineHeight",
      "textTransform",
      "wordSpacing",
      "tabSize",
      "MozTabSize",
    ];
    for (const p of propsToCopy) mirrorDiv.style[p] = cs[p];

    // Size the mirror to the textarea's content-box width.
    const rect = textarea.getBoundingClientRect();
    mirrorDiv.style.width = rect.width + "px";

    const value = textarea.value.substring(0, offset);
    mirrorDiv.textContent = value;

    // A zero-width marker at the exact caret offset.
    const marker = document.createElement("span");
    marker.textContent = "\u200b";
    mirrorDiv.appendChild(marker);

    const markerRect = marker.getBoundingClientRect();
    const mirrorRect = mirrorDiv.getBoundingClientRect();

    // Translate from mirror-space to textarea-space.
    const x =
      rect.left +
      (markerRect.left - mirrorRect.left) -
      textarea.scrollLeft;
    const y =
      rect.top +
      (markerRect.top - mirrorRect.top) -
      textarea.scrollTop;

    return { x, y, lineHeight: parseFloat(cs.lineHeight) || 20 };
  }

  // ---- Floating popup / dropdown framework -------------------------
  //
  // A minimal vanilla-JS floating-menu primitive. Builder returns
  // a controller with `update(items)`, `moveTo(x, y)`, `close()`,
  // and arrow-key handlers. The caller supplies `onSelect(item)`.
  // Used by completion menu and outline picker; hover info / signature
  // help use a simpler variant that just shows HTML.

  function createFloatingMenu({ onSelect, onDismiss, renderItem }) {
    const el = document.createElement("div");
    el.className = "mf2-floating-menu";
    el.setAttribute("role", "listbox");
    document.body.appendChild(el);

    let items = [];
    let selectedIndex = 0;

    function render() {
      el.innerHTML = "";
      items.forEach((item, i) => {
        const row = document.createElement("div");
        row.className = "mf2-floating-menu-item";
        if (i === selectedIndex) row.classList.add("selected");
        row.setAttribute("role", "option");
        row.appendChild(renderItem(item));
        row.addEventListener("mousedown", (e) => {
          e.preventDefault();
          onSelect(item);
        });
        el.appendChild(row);
      });
    }

    function update(newItems) {
      items = newItems;
      if (selectedIndex >= items.length) selectedIndex = items.length - 1;
      if (selectedIndex < 0) selectedIndex = 0;
      render();
    }

    function moveTo(x, y) {
      el.style.left = x + "px";
      el.style.top = y + "px";
      el.style.display = items.length > 0 ? "block" : "none";
    }

    function close() {
      if (el.parentNode) el.parentNode.removeChild(el);
      if (onDismiss) onDismiss();
    }

    function moveSelection(delta) {
      if (items.length === 0) return;
      selectedIndex = (selectedIndex + delta + items.length) % items.length;
      render();
    }

    function commitSelection() {
      if (items.length > 0) onSelect(items[selectedIndex]);
    }

    return { el, update, moveTo, close, moveSelection, commitSelection };
  }

  function createFloatingPanel(className) {
    const el = document.createElement("div");
    el.className = "mf2-floating-panel " + (className || "");
    el.setAttribute("role", "tooltip");
    el.style.display = "none";
    document.body.appendChild(el);

    function show(html, x, y) {
      el.innerHTML = html;
      el.style.left = x + "px";
      el.style.top = y + "px";
      el.style.display = "block";
    }

    function hide() {
      el.style.display = "none";
    }

    function destroy() {
      if (el.parentNode) el.parentNode.removeChild(el);
    }

    return { el, show, hide, destroy };
  }

  // ---- Function registry (client-side, static for now) -------------
  //
  // Minimum viable set to drive completion + hover + signature help
  // without needing a server round trip. Covers the default-registry
  // functions from the MF2 spec plus Localize's common additions.
  //
  // Each entry: { doc, options: [{name, doc, values?}] }.
  // A later pass can replace this with a `push_event("mf2:registry", …)`
  // from the server, carrying the host app's actual registered
  // functions and docs.

  const FUNCTION_REGISTRY = {
    number: {
      doc: "Format a number according to the locale's conventions.",
      options: [
        { name: "style", doc: "decimal | percent | currency", values: ["decimal", "percent", "currency"] },
        { name: "minimumFractionDigits", doc: "Min digits after the decimal point" },
        { name: "maximumFractionDigits", doc: "Max digits after the decimal point" },
        { name: "minimumIntegerDigits", doc: "Min digits before the decimal point" },
        { name: "useGrouping", doc: "always | auto | never", values: ["always", "auto", "never"] },
        { name: "notation", doc: "standard | scientific | engineering | compact", values: ["standard", "scientific", "engineering", "compact"] },
        { name: "select", doc: "plural | ordinal | exact", values: ["plural", "ordinal", "exact"] },
      ],
    },
    integer: {
      doc: "Format an integer (equivalent to :number maximumFractionDigits=0).",
      options: [
        { name: "useGrouping", doc: "always | auto | never", values: ["always", "auto", "never"] },
      ],
    },
    currency: {
      doc: "Format a monetary amount.",
      options: [
        { name: "currency", doc: "ISO 4217 currency code (e.g. USD, EUR, JPY)" },
        { name: "currencyDisplay", doc: "symbol | narrowSymbol | code | name", values: ["symbol", "narrowSymbol", "code", "name"] },
        { name: "currencySign", doc: "standard | accounting", values: ["standard", "accounting"] },
      ],
    },
    percent: {
      doc: "Format a number as a percentage (equivalent to :number style=percent).",
      options: [
        { name: "minimumFractionDigits", doc: "Min digits after the decimal point" },
        { name: "maximumFractionDigits", doc: "Max digits after the decimal point" },
      ],
    },
    date: {
      doc: "Format a date (calendar portion only).",
      options: [
        { name: "dateStyle", doc: "full | long | medium | short", values: ["full", "long", "medium", "short"] },
        { name: "calendar", doc: "Calendar system (gregorian, islamic, …)" },
      ],
    },
    time: {
      doc: "Format a time (clock portion only).",
      options: [
        { name: "timeStyle", doc: "full | long | medium | short", values: ["full", "long", "medium", "short"] },
        { name: "hourCycle", doc: "h11 | h12 | h23 | h24", values: ["h11", "h12", "h23", "h24"] },
      ],
    },
    datetime: {
      doc: "Format a date and time together.",
      options: [
        { name: "dateStyle", doc: "full | long | medium | short", values: ["full", "long", "medium", "short"] },
        { name: "timeStyle", doc: "full | long | medium | short", values: ["full", "long", "medium", "short"] },
      ],
    },
    string: {
      doc: "Format as a string and apply selection rules.",
      options: [
        { name: "select", doc: "exact (default)", values: ["exact"] },
      ],
    },
    list: {
      doc: "Format an array / list as a localised comma-separated phrase.",
      options: [
        { name: "type", doc: "conjunction | disjunction | unit", values: ["conjunction", "disjunction", "unit"] },
        { name: "style", doc: "long | short | narrow", values: ["long", "short", "narrow"] },
      ],
    },
    unit: {
      doc: "Format a measurement (e.g. 3.2 km, 5 °C).",
      options: [
        { name: "unit", doc: "ISO unit code (e.g. meter, kilometer, celsius)" },
        { name: "unitDisplay", doc: "long | short | narrow", values: ["long", "short", "narrow"] },
      ],
    },
  };

  // ---- CLDR plural categories (simplified) -------------------------
  //
  // For the `.match`-skeleton feature. Full CLDR has per-locale
  // plural rules; for skeleton generation we just need the *set of
  // categories that could apply* to a locale. This is a hand-picked
  // subset based on the CLDR Plural Rules spec. Sufficient for the
  // "insert skeleton" UX.

  function pluralCategoriesFor(locale) {
    const base = (locale || "en").split(/[-_]/)[0].toLowerCase();
    const byBase = {
      en: ["one", "other"],
      de: ["one", "other"],
      es: ["one", "other"],
      fr: ["one", "many", "other"],
      it: ["one", "many", "other"],
      pt: ["one", "many", "other"],
      nl: ["one", "other"],
      sv: ["one", "other"],
      da: ["one", "other"],
      no: ["one", "other"],
      fi: ["one", "other"],
      ja: ["other"],
      zh: ["other"],
      ko: ["other"],
      ar: ["zero", "one", "two", "few", "many", "other"],
      he: ["one", "two", "many", "other"],
      ru: ["one", "few", "many", "other"],
      pl: ["one", "few", "many", "other"],
      cs: ["one", "few", "many", "other"],
      sk: ["one", "few", "many", "other"],
      uk: ["one", "few", "many", "other"],
      hr: ["one", "few", "other"],
      sr: ["one", "few", "other"],
      ga: ["one", "two", "few", "many", "other"],
      cy: ["zero", "one", "two", "few", "many", "other"],
      lt: ["one", "few", "other"],
      lv: ["zero", "one", "other"],
    };
    return byBase[base] || ["one", "other"];
  }

  // ------------------------------------------------------------------
  // Phoenix LiveView hook. One instance per editor element.
  // ------------------------------------------------------------------

  const MF2Editor = {
    async mounted() {
      this.textarea = this.el.querySelector("textarea");
      const pre = this.el.querySelector("pre");
      this.pre = this.el.querySelector("pre code") || pre;
      this.preContainer = pre;
      this.matchedBytes = null;
      this.pendingCanonical = null;

      if (!this.textarea || !this.pre) {
        console.warn(
          "MF2Editor: mount skipped, missing <textarea> or <pre> inside",
          this.el
        );
        return;
      }

      this.onScroll = () => {
        this.preContainer.scrollTop = this.textarea.scrollTop;
        this.preContainer.scrollLeft = this.textarea.scrollLeft;
      };
      this.textarea.addEventListener("scroll", this.onScroll);

      // Server may push a *hard* text replacement (e.g. "Load example").
      this.handleEvent("mf2:set_message", ({ value }) => {
        if (typeof value !== "string") return;
        this.textarea.value = value;
        this.textarea.setSelectionRange(value.length, value.length);
        this.update();
      });

      // Server may push a *soft* canonical re-formatting. Defer the
      // apply while the textarea has focus so typing isn't interrupted;
      // the pending value is installed on the next blur.
      this.handleEvent("mf2:canonical", ({ value }) => {
        if (typeof value !== "string") return;
        if (value === this.textarea.value) {
          this.pendingCanonical = null;
          return;
        }
        if (document.activeElement === this.textarea) {
          this.pendingCanonical = value;
        } else {
          this.applyCanonical(value);
        }
      });

      this.onBlur = () => {
        if (this.pendingCanonical == null) return;
        const value = this.pendingCanonical;
        this.pendingCanonical = null;
        if (value !== this.textarea.value) this.applyCanonical(value);
      };
      this.textarea.addEventListener("blur", this.onBlur);

      // Auto-close brackets + pair-delete + skip-over.
      this.onBeforeInput = (e) => handleBeforeInput(e, this.textarea);
      this.textarea.addEventListener("beforeinput", this.onBeforeInput);

      // Diagnostic tooltip. The highlighted <pre> sits beneath the
      // textarea with `pointer-events: none` so mousemove events hit
      // the textarea, not our diagnostic spans — which means both
      // native `title=` tooltips and `e.target.closest(...)` tricks
      // miss them. We bypass pointer-events by querying
      // `document.elementsFromPoint`, which returns *every* element
      // at a point in z-order regardless of pointer-events, and
      // scan for a span carrying a diagnostic class.
      //
      // This avoids `caretPositionFromPoint`, which behaves
      // inconsistently on textareas across browsers (especially
      // Safari).
      this.tooltipEl = null;

      this.onMouseMove = (e) => {
        // Scope the search to this editor's pre — not strictly
        // required but avoids iterating diagnostic spans from other
        // editor instances that might exist on the same page.
        const diagEl = findDiagnosticSpanAt(
          e.clientX,
          e.clientY,
          this.preContainer
        );
        if (!diagEl) {
          this.hideTooltip();
          return;
        }
        const title = diagEl.getAttribute("title");
        if (!title) {
          this.hideTooltip();
          return;
        }
        this.showTooltip(title, e.clientX, e.clientY);
      };
      this.onMouseLeave = () => this.hideTooltip();

      this.el.addEventListener("mousemove", this.onMouseMove);
      this.el.addEventListener("mouseleave", this.onMouseLeave);

      // Bracket matching. `selectionchange` is a document-level event
      // (there's no per-textarea selection event) so we filter by
      // `document.activeElement`. Cheap — we only recompute when the
      // matched-set actually changes.
      this.onSelectionChange = () => {
        if (document.activeElement !== this.textarea) {
          if (this.matchedBytes !== null) {
            this.matchedBytes = null;
            this.repaint();
          }
          return;
        }
        const matched = findMatchedBrackets(
          this.tree,
          this.textarea.selectionStart,
          this.textarea.value
        );
        if (setsEqual(matched, this.matchedBytes)) return;
        this.matchedBytes = matched;
        this.repaint();
      };
      document.addEventListener("selectionchange", this.onSelectionChange);

      const baseUrl =
        this.el.dataset.mf2BaseUrl || ns.baseUrl || DEFAULT_BASE_URL;

      try {
        const { language, highlightQuery } = await initialize(baseUrl);
        this.language = language;
        this.highlightQuery = highlightQuery;
      } catch (e) {
        console.error("MF2Editor: failed to initialise tree-sitter", e);
        this.pre.textContent = this.textarea.value;
        return;
      }

      this.parser = new Parser();
      this.parser.setLanguage(this.language);

      this.onInput = () => this.update();
      this.textarea.addEventListener("input", this.onInput);

      // ========================================================
      // IDE-style feature wiring (items 1-11 in TODO.md).
      // ========================================================

      // Keybindings: F2 rename, F12 goto-def, Cmd+Shift+O outline,
      // Cmd+Shift+→/← structural selection, Enter smart-indent.
      this.onKeydown = (e) => this._handleKeydown(e);
      this.textarea.addEventListener("keydown", this.onKeydown);

      // Cmd/Ctrl-click on a `$variable` → goto its declaration.
      this.onMousedown = (e) => this._handleMousedown(e);
      this.textarea.addEventListener("mousedown", this.onMousedown);

      // Completion trigger on `$` / `:` / `@`. Also intercepts
      // `.match` + Tab for the pluralisation-skeleton expansion.
      this.onCompletionInput = (e) => this._handleCompletionInput(e);
      this.textarea.addEventListener("input", this.onCompletionInput);

      // Dismiss floating UIs on blur unless focus went into the
      // completion menu itself (handled by menu's own mousedown).
      this.onFeatureBlur = () => this._closeCompletion();
      this.textarea.addEventListener("blur", this.onFeatureBlur);

      // ========================================================

      this.update();
    },

    destroyed() {
      if (this.textarea) {
        if (this.onScroll)
          this.textarea.removeEventListener("scroll", this.onScroll);
        if (this.onInput)
          this.textarea.removeEventListener("input", this.onInput);
        if (this.onBlur)
          this.textarea.removeEventListener("blur", this.onBlur);
        if (this.onBeforeInput)
          this.textarea.removeEventListener("beforeinput", this.onBeforeInput);
        if (this.onKeydown)
          this.textarea.removeEventListener("keydown", this.onKeydown);
        if (this.onMousedown)
          this.textarea.removeEventListener("mousedown", this.onMousedown);
        if (this.onCompletionInput)
          this.textarea.removeEventListener("input", this.onCompletionInput);
        if (this.onFeatureBlur)
          this.textarea.removeEventListener("blur", this.onFeatureBlur);
      }
      if (this.el) {
        if (this.onMouseMove)
          this.el.removeEventListener("mousemove", this.onMouseMove);
        if (this.onMouseLeave)
          this.el.removeEventListener("mouseleave", this.onMouseLeave);
      }
      if (this.onSelectionChange) {
        document.removeEventListener("selectionchange", this.onSelectionChange);
      }
      if (this.tooltipEl && this.tooltipEl.parentNode) {
        this.tooltipEl.parentNode.removeChild(this.tooltipEl);
        this.tooltipEl = null;
      }
      if (this._completionMenu) {
        this._completionMenu.close();
        this._completionMenu = null;
      }
      if (this._outlineMenu) {
        this._outlineMenu.close();
        this._outlineMenu = null;
      }
      if (this._hoverPanel) {
        this._hoverPanel.destroy();
        this._hoverPanel = null;
      }
      if (this._signaturePanel) {
        this._signaturePanel.destroy();
        this._signaturePanel = null;
      }
      if (this.tree) {
        this.tree.delete();
        this.tree = null;
      }
      if (this.parser) {
        this.parser.delete();
        this.parser = null;
      }
    },

    showTooltip(message, mouseX, mouseY) {
      if (!this.tooltipEl) {
        this.tooltipEl = document.createElement("div");
        this.tooltipEl.className = "mf2-tooltip";
        this.tooltipEl.setAttribute("role", "tooltip");
        document.body.appendChild(this.tooltipEl);
      }
      this.tooltipEl.textContent = message;
      this.tooltipEl.style.display = "block";

      // Position below-and-right of the mouse; flip up/left if we'd
      // run off the viewport.
      const margin = 14;
      const rect = this.tooltipEl.getBoundingClientRect();
      let x = mouseX + margin;
      let y = mouseY + margin;
      if (x + rect.width > window.innerWidth - 8) {
        x = mouseX - rect.width - margin;
      }
      if (y + rect.height > window.innerHeight - 8) {
        y = mouseY - rect.height - margin;
      }
      this.tooltipEl.style.left = `${x}px`;
      this.tooltipEl.style.top = `${y}px`;
    },

    hideTooltip() {
      if (this.tooltipEl) this.tooltipEl.style.display = "none";
    },

    // ==================================================================
    //                   IDE-STYLE FEATURE METHODS
    //
    // One method per feature, plus three dispatchers for the three
    // event listeners wired in mounted(). Each feature is pretty small
    // on its own — the shared heavy lifting is in the top-of-file
    // infrastructure block (locals graph, tree helpers, caret coords,
    // popup framework).
    //
    // All feature methods no-op gracefully if `this.tree` is null
    // (not yet parsed or parse failed), so wiring order in mounted()
    // doesn't matter.
    // ==================================================================

    _handleKeydown(e) {
      // If either floating menu is open, it consumes arrow/enter/esc.
      const activeMenu =
        (this._completionMenu && this._completionMenu.isOpen && this._completionMenu) ||
        (this._outlineMenu && this._outlineMenu.isOpen && this._outlineMenu) ||
        null;

      if (activeMenu) {
        if (e.key === "Escape") {
          activeMenu.close();
          e.preventDefault();
          return;
        }
        if (e.key === "ArrowDown") {
          activeMenu.moveSelection(1);
          e.preventDefault();
          return;
        }
        if (e.key === "ArrowUp") {
          activeMenu.moveSelection(-1);
          e.preventDefault();
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          activeMenu.commitSelection();
          e.preventDefault();
          return;
        }
      }

      // F12 → goto definition.
      if (e.key === "F12") {
        e.preventDefault();
        this.gotoDefinition();
        return;
      }

      // F2 → rename.
      if (e.key === "F2") {
        e.preventDefault();
        this.renameInScope();
        return;
      }

      // Cmd/Ctrl+Shift+O → outline.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "o" || e.key === "O")) {
        e.preventDefault();
        this.showOutline();
        return;
      }

      // Cmd/Ctrl+Shift+ArrowRight / ArrowLeft → structural selection.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey) {
        if (e.key === "ArrowRight") {
          if (this.expandSelection()) e.preventDefault();
          return;
        }
        if (e.key === "ArrowLeft") {
          if (this.shrinkSelection()) e.preventDefault();
          return;
        }
      }

      // Enter → smart indent.
      if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (this._handleSmartIndent(e)) e.preventDefault();
        return;
      }

      // Tab after `.match` on a blank line → pluralisation skeleton.
      if (e.key === "Tab" && !e.shiftKey) {
        if (this._handlePluralSkeleton(e)) e.preventDefault();
        return;
      }
    },

    _handleMousedown(e) {
      // Cmd/Ctrl + click on a variable reference → goto definition.
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.button !== 0) return;

      // We need the caret offset at the click point. Let the browser
      // apply its default caret placement first, then run our logic
      // on the next tick when textarea.selectionStart is updated.
      setTimeout(() => {
        const offset = this.textarea.selectionStart;
        if (this._isOverVariable(offset)) {
          this.gotoDefinition();
        }
      }, 0);
    },

    _handleCompletionInput(e) {
      // Only plain typed characters trigger completion.
      if (!e || e.inputType !== "insertText" || typeof e.data !== "string") {
        return;
      }
      const ch = e.data;
      const caret = this.textarea.selectionStart;

      if (ch === "$") {
        this._openCompletion("variable", caret);
        return;
      }
      if (ch === ":") {
        this._openCompletion("function", caret);
        return;
      }
      if (ch === "@") {
        this._openCompletion("attribute", caret);
        return;
      }

      // If the menu is open and the user types a name character, let
      // the character filter through and update the menu's items.
      if (this._completionMenu && this._completionMenu.isOpen) {
        if (/[A-Za-z0-9_\-.]/.test(ch)) {
          this._refreshCompletion(caret);
        } else {
          this._closeCompletion();
        }
      }
    },

    // ---- Tree-walking helpers ---------------------------------------

    _nodeAtCaret() {
      if (!this.tree) return null;
      const caret = this.textarea.selectionStart;
      return this.tree.rootNode.namedDescendantForIndex(caret, caret);
    },

    _isOverVariable(offset) {
      if (!this.tree) return false;
      const node = this.tree.rootNode.namedDescendantForIndex(offset, offset);
      return enclosingNode(node, (n) => n.type === "variable") !== null;
    },

    // ---- Item 1: Goto-definition -----------------------------------

    gotoDefinition() {
      if (!this._locals || !this.tree) return;
      const node = this._nodeAtCaret();
      if (!node) return;
      const varNode = enclosingNode(node, (n) => n.type === "variable");
      if (!varNode) return;
      const nameNode = firstNamedChildOfType(varNode, "name");
      if (!nameNode) return;
      const name = nameNode.text;
      const def = this._locals.definitions.get(name);
      if (!def) return;

      // Move caret to the definition's name start.
      const target = def.nameNode.startIndex;
      this.textarea.focus();
      this.textarea.setSelectionRange(target, target + name.length);
      this._scrollCaretIntoView();
    },

    _scrollCaretIntoView() {
      // Rough approximation: use the mirror-textarea caret coords and
      // nudge textarea.scrollTop so the caret sits in the middle third.
      const coords = caretCoords(this.textarea, this.textarea.selectionStart);
      const rect = this.textarea.getBoundingClientRect();
      if (coords.y < rect.top || coords.y > rect.bottom - coords.lineHeight) {
        this.textarea.scrollTop = Math.max(
          0,
          this.textarea.scrollTop + (coords.y - rect.top) - rect.height / 3
        );
      }
    },

    // ---- Item 2: Rename-in-scope -----------------------------------

    renameInScope() {
      if (!this._locals) return;
      const node = this._nodeAtCaret();
      if (!node) return;
      const varNode = enclosingNode(node, (n) => n.type === "variable");
      if (!varNode) return;
      const oldName = firstNamedChildOfType(varNode, "name").text;

      const newName = window.prompt(
        `Rename $${oldName} to:`,
        oldName
      );
      if (!newName || newName === oldName) return;
      if (!/^[A-Za-z_][A-Za-z0-9_\-.]*$/.test(newName)) {
        window.alert(
          "Rename aborted: names must start with a letter or underscore."
        );
        return;
      }

      // Collect every occurrence (definitions + references) in
      // descending byte order so splice indices remain valid.
      const occurrences = [];
      const def = this._locals.definitions.get(oldName);
      if (def) occurrences.push({ node: def.nameNode });
      const refs = this._locals.referencesByName.get(oldName) || [];
      for (const r of refs) occurrences.push({ node: r.nameNode });

      occurrences.sort((a, b) => b.node.startIndex - a.node.startIndex);

      let value = this.textarea.value;
      for (const occ of occurrences) {
        const s = occ.node.startIndex;
        const e = occ.node.endIndex;
        value = value.slice(0, s) + newName + value.slice(e);
      }

      // Apply, move caret to the first occurrence of the new name.
      this.textarea.value = value;
      const caret =
        occurrences.length > 0
          ? occurrences[occurrences.length - 1].node.startIndex
          : this.textarea.selectionStart;
      this.textarea.setSelectionRange(caret, caret + newName.length);
      this.textarea.dispatchEvent(new Event("input", { bubbles: true }));
    },

    // ---- Item 5: Outline picker -----------------------------------

    showOutline() {
      if (!this._locals) return;
      const items = [];
      for (const [name, def] of this._locals.definitions) {
        items.push({
          label: `$${name}`,
          hint: def.kind === "input" ? ".input" : ".local",
          offset: def.varNode.startIndex,
        });
      }
      if (items.length === 0) {
        window.alert("No declarations in this message.");
        return;
      }
      items.sort((a, b) => a.offset - b.offset);

      if (this._outlineMenu) this._outlineMenu.close();

      this._outlineMenu = createFloatingMenu({
        onSelect: (item) => {
          this.textarea.focus();
          this.textarea.setSelectionRange(item.offset, item.offset);
          this._scrollCaretIntoView();
          this._outlineMenu.close();
          this._outlineMenu = null;
        },
        onDismiss: () => {
          this._outlineMenu = null;
        },
        renderItem: (item) => {
          const el = document.createElement("div");
          const label = document.createElement("span");
          label.className = "mf2-outline-label";
          label.textContent = item.label;
          const hint = document.createElement("span");
          hint.className = "mf2-outline-hint";
          hint.textContent = item.hint;
          el.appendChild(label);
          el.appendChild(hint);
          return el;
        },
      });
      this._outlineMenu.isOpen = true;
      this._outlineMenu.update(items);

      const rect = this.textarea.getBoundingClientRect();
      this._outlineMenu.moveTo(rect.left + 12, rect.top + 12);
    },

    // ---- Item 7: Structural selection --------------------------------

    expandSelection() {
      if (!this.tree) return false;
      const start = this.textarea.selectionStart;
      const end = this.textarea.selectionEnd;

      const current =
        this.tree.rootNode.namedDescendantForIndex(start, end) ||
        this.tree.rootNode;

      // If the current selection exactly matches the current node's
      // span, step up to the parent. Otherwise, expand to the span of
      // the current node.
      let target = current;
      if (
        current.startIndex === start &&
        current.endIndex === end &&
        current.parent
      ) {
        target = current.parent;
      }
      if (!target) return false;

      this._selectionStack = this._selectionStack || [];
      this._selectionStack.push({ start, end });
      this.textarea.setSelectionRange(target.startIndex, target.endIndex);
      return true;
    },

    shrinkSelection() {
      if (!this._selectionStack || this._selectionStack.length === 0) {
        return false;
      }
      const prev = this._selectionStack.pop();
      this.textarea.setSelectionRange(prev.start, prev.end);
      return true;
    },

    // ---- Item 6: Smart newline indent --------------------------------

    _handleSmartIndent(_e) {
      const caret = this.textarea.selectionStart;
      if (caret !== this.textarea.selectionEnd) return false; // has selection

      // Current line's leading whitespace.
      const value = this.textarea.value;
      const lineStart = value.lastIndexOf("\n", caret - 1) + 1;
      const line = value.slice(lineStart, caret);
      const leadingWs = line.match(/^[ \t]*/)[0];

      // If caret is immediately inside `{{` or `.match` context, add
      // an extra indent step. We use the node at caret to decide.
      let extraIndent = "";
      if (this.tree) {
        const node = this.tree.rootNode.namedDescendantForIndex(caret, caret);
        const within = enclosingNode(node, (n) =>
          ["quoted_pattern", "matcher", "variant"].includes(n.type)
        );
        if (within) extraIndent = "  ";
      }

      const insertion = "\n" + leadingWs + extraIndent;
      document.execCommand
        ? document.execCommand("insertText", false, insertion)
        : this._splice(caret, caret, insertion);
      return true;
    },

    _splice(start, end, replacement) {
      const v = this.textarea.value;
      this.textarea.value = v.slice(0, start) + replacement + v.slice(end);
      const newPos = start + replacement.length;
      this.textarea.setSelectionRange(newPos, newPos);
      this.textarea.dispatchEvent(new Event("input", { bubbles: true }));
    },

    // ---- Item 11: .match pluralisation skeleton ----------------------

    _handlePluralSkeleton(_e) {
      const caret = this.textarea.selectionStart;
      if (caret !== this.textarea.selectionEnd) return false;

      const value = this.textarea.value;
      const lineStart = value.lastIndexOf("\n", caret - 1) + 1;
      const lineSoFar = value.slice(lineStart, caret);

      // Match `.match $var` at end of line (optionally followed by
      // `:number` annotation).
      const m = lineSoFar.match(/^\s*\.match\s+\$(\S+)(?:\s+:number)?\s*$/);
      if (!m) return false;

      const locale = this.el.dataset.mf2Locale || "en";
      const categories = pluralCategoriesFor(locale);

      // One key per category, each with a `{{…}}` placeholder, plus a
      // catchall `*`. Each variant on its own line.
      const lines = categories.map((cat) => {
        if (cat === "other") return `* {{}}`;
        return `${cat} {{}}`;
      });
      // Make sure there's a catchall `*` even if `other` wasn't in
      // categories (shouldn't happen, but safe).
      if (!lines.some((l) => l.startsWith("*"))) lines.push("* {{}}");

      const insertion = "\n" + lines.join("\n");
      this._splice(caret, caret, insertion);

      // Put caret inside the first variant's pattern.
      const firstPatternOffset =
        caret + "\n".length + lines[0].indexOf("{{") + 2;
      this.textarea.setSelectionRange(firstPatternOffset, firstPatternOffset);
      return true;
    },

    // ---- Item 8: Completion menu -----------------------------------

    _openCompletion(kind, caret) {
      this._closeCompletion();
      const items = this._completionItems(kind, "");
      if (items.length === 0) return;

      const self = this;
      this._completionMenu = createFloatingMenu({
        onSelect: (item) => self._commitCompletion(item),
        onDismiss: () => {
          self._completionMenu = null;
        },
        renderItem: (item) => {
          const el = document.createElement("div");
          const label = document.createElement("span");
          label.className = "mf2-completion-label";
          label.textContent = item.label;
          const hint = document.createElement("span");
          hint.className = "mf2-completion-hint";
          hint.textContent = item.hint || "";
          el.appendChild(label);
          el.appendChild(hint);
          return el;
        },
      });
      this._completionMenu.isOpen = true;
      this._completionMenu.kind = kind;
      this._completionMenu.triggerOffset = caret; // position of the trigger char
      this._completionMenu.update(items);

      const coords = caretCoords(this.textarea, caret);
      this._completionMenu.moveTo(coords.x, coords.y + coords.lineHeight + 4);
    },

    _refreshCompletion(caret) {
      if (!this._completionMenu) return;
      const trigger = this._completionMenu.triggerOffset;
      const prefix = this.textarea.value.slice(trigger, caret);
      const items = this._completionItems(this._completionMenu.kind, prefix);
      this._completionMenu.update(items);

      const coords = caretCoords(this.textarea, trigger);
      this._completionMenu.moveTo(coords.x, coords.y + coords.lineHeight + 4);
    },

    _completionItems(kind, prefix) {
      const pfx = prefix.toLowerCase();
      if (kind === "variable") {
        if (!this._locals) return [];
        const items = [];
        for (const [name, def] of this._locals.definitions) {
          if (name.toLowerCase().startsWith(pfx)) {
            items.push({
              label: name,
              hint: def.kind === "input" ? ".input" : ".local",
              insertText: name,
            });
          }
        }
        return items.sort((a, b) => a.label.localeCompare(b.label));
      }
      if (kind === "function") {
        return Object.entries(FUNCTION_REGISTRY)
          .filter(([name]) => name.toLowerCase().startsWith(pfx))
          .map(([name, spec]) => ({
            label: name,
            hint: spec.doc,
            insertText: name,
          }));
      }
      if (kind === "attribute") {
        // MF2 attributes aren't a registry; offer common ones.
        const commonAttrs = [
          { label: "translate", hint: "translation intent" },
          { label: "locale", hint: "locale override" },
          { label: "dir", hint: "directionality" },
        ];
        return commonAttrs
          .filter((a) => a.label.toLowerCase().startsWith(pfx))
          .map((a) => ({ ...a, insertText: a.label }));
      }
      return [];
    },

    _commitCompletion(item) {
      if (!this._completionMenu) return;
      const trigger = this._completionMenu.triggerOffset;
      const caret = this.textarea.selectionStart;
      // Replace from trigger to caret with (trigger-char stays) + insertText.
      // Trigger char itself is already in the text — we only replace what
      // the user has typed AFTER it.
      this._splice(trigger, caret, item.insertText);
      this._closeCompletion();
    },

    _closeCompletion() {
      if (this._completionMenu) {
        this._completionMenu.close();
        this._completionMenu = null;
      }
    },

    // ---- Item 9: Hover info (variables only; functions need registry) ----

    // Extends the existing onMouseMove behaviour. The existing handler
    // (in mounted()) already does diagnostic tooltips via elementsFromPoint.
    // For variable hover we augment that: if the mouse is over a span
    // whose content is a `(name)` inside a `variable`, show an info
    // tooltip with the declaration source.

    // Instead of hooking mouseMove again (there's already one), we
    // intercept in a lightweight way: rely on the existing findDiagnosticSpanAt
    // to skip non-diagnostic spans, and add a separate hover handler.
    // See _installVariableHover() called at mount.

    applyCanonical(value) {
      const prevStart = this.textarea.selectionStart;
      this.textarea.value = value;
      const caret = Math.min(prevStart, value.length);
      this.textarea.setSelectionRange(caret, caret);
      this.update();
    },

    update() {
      if (!this.parser || !this.highlightQuery) return;

      const source = this.textarea.value;

      // Full re-parse on every keystroke. Incremental parsing via the
      // old-tree argument is possible but requires a preceding
      // `tree.edit(...)` describing exactly what bytes changed; without
      // that, tree-sitter silently reuses stale subtrees at stale byte
      // positions and `hasError` / captures drift. For playground-sized
      // inputs a full parse is microseconds — cheaper than computing
      // the edit descriptor correctly.
      let tree;
      try {
        tree = this.parser.parse(source);
      } catch (e) {
        console.warn("MF2Editor: parse failed", e);
        this.pre.textContent = source;
        return;
      }

      if (this.tree) this.tree.delete();
      this.tree = tree;

      // Rebuild the locals graph. Used by rename, goto-def, outline,
      // completion, and the unknown-variable paint pass below.
      this._locals = buildLocalsGraph(tree.rootNode);

      // Re-check bracket matching against the new tree; caret may
      // not have moved but the tree has been replaced.
      if (document.activeElement === this.textarea) {
        this.matchedBytes = findMatchedBrackets(
          this.tree,
          this.textarea.selectionStart,
          source
        );
      } else {
        this.matchedBytes = null;
      }

      this.repaint();

      // Report diagnostics to any interested host. Consumers listen
      // on the editor element for 'mf2-diagnostics'. Detail is an
      // array of `{kind, startByte, endByte, startPoint, endPoint, message}`.
      const diagnostics = collectDiagnostics(tree.rootNode, source);
      const payload = diagnostics.map(({ kind, node, message }) => ({
        kind,
        startByte: node.startIndex,
        endByte: node.endIndex,
        startPoint: [node.startPosition.row, node.startPosition.column],
        endPoint: [node.endPosition.row, node.endPosition.column],
        message,
      }));

      this.el.dispatchEvent(
        new CustomEvent("mf2-diagnostics", { detail: payload, bubbles: true })
      );
    },

    // Rebuild the pre's HTML from the existing tree without a
    // re-parse. Used for caret-driven changes like bracket matching.
    repaint() {
      if (!this.tree || !this.highlightQuery) return;
      const source = this.textarea.value;
      const root = this.tree.rootNode;
      const diagnostics = collectDiagnostics(root, source);
      const captures = this.highlightQuery.captures(root);
      const html = buildHtml(source, captures, diagnostics, this.matchedBytes);
      this.pre.innerHTML = html;
    },
  };

  ns.Hooks = ns.Hooks || {};
  ns.Hooks.MF2Editor = MF2Editor;
  ns.buildHtml = buildHtml; // exposed for SSR parity tests
