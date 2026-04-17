; tree-sitter highlight query for MF2 messages. Maps grammar nodes to
; the capture names used by editor highlighters (nvim-treesitter, Helix,
; Zed). Capture names mirror the Localize MF2 Pygments-style taxonomy
; so authors can reuse the same colour scheme between editor
; highlighting and `Localize.Message.to_html/2` output.

; ─── Builtins ─────────────────────────────────────────────────────────
(keyword_input)   @keyword.import
(keyword_local)   @keyword
(keyword_match)   @keyword.conditional
(catchall)        @constant.builtin

; ─── Names ────────────────────────────────────────────────────────────
(variable (name) @variable)
"$"               @variable.builtin

(function (identifier) @function)
":"               @punctuation.special

(markup_open_or_standalone (identifier (name) @tag))
(markup_close            (identifier (name) @tag))

(attribute (identifier) @attribute)
"@"               @punctuation.special

(option (identifier) @property)

; ─── Literals ─────────────────────────────────────────────────────────
(quoted_literal)  @string
(quoted_char)     @string
(quoted_escape)   @string.escape
(number_literal)  @number
(unquoted_literal (name) @string)

; ─── Escapes ──────────────────────────────────────────────────────────
(escape)          @string.escape

; ─── Text ─────────────────────────────────────────────────────────────
(text)            @string

; ─── Punctuation ──────────────────────────────────────────────────────
"{"               @punctuation.bracket
"}"               @punctuation.bracket
"{{"              @punctuation.bracket
"}}"              @punctuation.bracket
"|"               @punctuation.bracket
"="               @operator
(self_closing)    @punctuation.special
"#"               @punctuation.special
"/"               @punctuation.special
