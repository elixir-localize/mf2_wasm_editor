/*
 * localize_mf2_editor — browser-side MF2 syntax highlighter.
 *
 * Ships a Phoenix LiveView hook (`MF2Editor`) that runs the
 * tree-sitter-mf2 grammar directly in the browser via
 * web-tree-sitter. Keystrokes never leave the client for highlighting
 * or diagnostics — server round trips are reserved for formatting
 * (`Localize.Message.format/3`) and other authoritative operations.
 *
 * Load order
 * ----------
 *
 *   <script src="/mf2_editor/tree-sitter.js"></script>
 *   <script src="/mf2_editor/mf2_editor.js"></script>
 *
 * After these load, `window.LocalizeMf2Editor.Hooks.MF2Editor` is the
 * LiveView hook. Merge it into your LiveSocket's `hooks` option.
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
 * Override by setting `window.LocalizeMf2Editor.baseUrl = "..."`
 * before this script loads, or via a `data-mf2-base-url="..."`
 * attribute on the hook element.
 */

(function () {
  const DEFAULT_BASE_URL = "/mf2_editor";

  const ns = (window.LocalizeMf2Editor = window.LocalizeMf2Editor || {});
  ns.baseUrl = ns.baseUrl || DEFAULT_BASE_URL;

  // ------------------------------------------------------------------
  // One-time page-wide initialisation of the tree-sitter runtime,
  // grammar, and highlight query. Cached on the namespace so multiple
  // editor instances share a single Parser.Language and Query.
  // ------------------------------------------------------------------

  let initPromise = null;

  function initialize(baseUrl) {
    if (initPromise) return initPromise;

    initPromise = (async () => {
      if (typeof TreeSitter === "undefined") {
        throw new Error(
          "MF2 editor: tree-sitter.js must be loaded before mf2_editor.js"
        );
      }

      await TreeSitter.init({
        locateFile: (path) => `${baseUrl}/${path}`,
      });

      const language = await TreeSitter.Language.load(
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

      const highlightQuery = language.query(highlightsSource);

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

  function collectDiagnostics(rootNode) {
    const out = [];
    if (!rootNode.hasError) return out;

    // Depth-first walk. Tree-sitter's GLR error recovery yields two
    // flavours of broken-state node: `isMissing` for required tokens
    // the grammar expected but didn't find, and `isError` for spans
    // of input that couldn't be fitted to any production. Either
    // produces a visible diagnostic; everything else is skipped. We
    // only descend when the subtree contains an error anywhere.
    function walk(node) {
      if (node.isMissing) {
        out.push({ kind: "missing", node, message: diagnosticMessage("missing", node) });
      } else if (node.isError) {
        out.push({ kind: "error", node, message: diagnosticMessage("error", node) });
      }

      if (node.hasError) {
        for (const child of node.children) walk(child);
      }
    }

    walk(rootNode);
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
      const nice = MISSING_NICE[raw] || `\`${raw}\``;
      return `Expected ${nice} here`;
    }
    // kind === "error"
    const parent = node.parent;
    if (!parent) return "Unexpected input";
    return ERROR_CONTEXT[parent.type] || `Unexpected input in \`${parent.type}\``;
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

      this.parser = new TreeSitter();
      this.parser.setLanguage(this.language);

      this.onInput = () => this.update();
      this.textarea.addEventListener("input", this.onInput);

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
      const diagnostics = collectDiagnostics(tree.rootNode);
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
      const diagnostics = collectDiagnostics(root);
      const captures = this.highlightQuery.captures(root);
      const html = buildHtml(source, captures, diagnostics, this.matchedBytes);
      this.pre.innerHTML = html;
    },
  };

  ns.Hooks = ns.Hooks || {};
  ns.Hooks.MF2Editor = MF2Editor;
  ns.buildHtml = buildHtml; // exposed for SSR parity tests
})();
