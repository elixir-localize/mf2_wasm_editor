; Suggested injection — place in the host language's injections.scm so
; MF2 message strings inside source code are highlighted as MF2.
;
; Elixir example (nvim-treesitter):
;
;   ((call
;      target: (identifier) @_fn
;      (arguments (string (quoted_content) @injection.content)))
;     (#match? @_fn "^(gettext|dpgettext|format|to_html|to_ansi)$")
;     (#set! injection.language "mf2"))
