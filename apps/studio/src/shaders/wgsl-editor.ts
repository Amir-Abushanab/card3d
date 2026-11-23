/**
 * The CodeMirror 6 editor used by the shader drawer: WGSL highlighting (the legacy clike mode with
 * WGSL's keywords, types and built-ins, extended with the face-shader prelude's names), line numbers,
 * lint markers for errors, completion of prelude/WGSL names and annotation snippets, and a dark theme
 * in the studio's palette. Loaded lazily (dynamic import) so the studio's first load doesn't pay for it.
 */
import { EditorState, Transaction, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, StreamLanguage, bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { clike } from "@codemirror/legacy-modes/mode/clike";
import { lintGutter, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completeFromList,
  completionKeymap,
  snippetCompletion,
  type Completion,
} from "@codemirror/autocomplete";
import { tags as t } from "@lezer/highlight";
import type { ShaderError } from "@card3d/core/editor";
import { WGSL_BUILTINS, PRELUDE_DOCS } from "./cheatsheet.ts";

const words = (s: string) =>
  Object.fromEntries(
    s
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => [w, true]),
  );

const wgsl = StreamLanguage.define(
  clike({
    name: "wgsl",
    keywords: words(
      "fn let var const override struct alias private function return if else switch case default for while loop break continue continuing discard",
    ),
    types: words(
      "f32 i32 u32 f16 bool vec2 vec3 vec4 vec2f vec3f vec4f vec2i vec3i vec4i vec2u vec3u vec4u vec2h vec3h vec4h " +
        "mat2x2 mat2x3 mat2x4 mat3x2 mat3x3 mat3x4 mat4x2 mat4x3 mat4x4 mat2x2f mat3x3f mat4x4f array",
    ),
    blockKeywords: words("fn for while loop if else struct switch"),
    builtin: words(WGSL_BUILTINS.join(" ")),
    atoms: words(`true false PI TAU ${PRELUDE_DOCS.map((d) => d.name).join(" ")}`),
    hooks: {
      // Attributes: @vertex, @location(…) (and the annotations' @param inside comments, which the
      // comment rule takes first).
      "@": (stream: { eatWhile(re: RegExp): boolean }) => {
        stream.eatWhile(/[\w]/);
        return "meta";
      },
    },
  }),
);

const highlight = HighlightStyle.define([
  { tag: t.keyword, color: "#c4a2ff" },
  { tag: [t.typeName, t.className], color: "#7fd1ff" },
  { tag: [t.standard(t.variableName), t.function(t.variableName)], color: "#9fe0b8" },
  { tag: [t.atom, t.bool], color: "#ffcf8a" },
  { tag: t.number, color: "#ffab8a" },
  { tag: t.string, color: "#e6db8f" },
  { tag: t.comment, color: "#7d8197", fontStyle: "italic" },
  { tag: t.meta, color: "#ff8fb4" },
  { tag: t.operator, color: "#d6d8e0" },
  { tag: t.variableName, color: "#e3e4ea" },
]);

/** `@param`, `@color`, `@replaces-artwork` (and their key=value bits) inside comments. */
const annotationMarks = new MatchDecorator({
  regexp: /@(?:param|color|replaces-artwork)\b|\b(?:label|description|default|options|step|min|max)=/g,
  decoration: () => Decoration.mark({ class: "cm-annotation" }),
});
const annotations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = annotationMarks.createDeco(view);
    }
    update(u: ViewUpdate) {
      this.decorations = annotationMarks.updateDeco(u, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);

const theme = EditorView.theme(
  {
    "&": { height: "100%", color: "#e3e4ea", backgroundColor: "#0f1014", fontSize: "12.5px" },
    ".cm-scroller": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", lineHeight: "1.55" },
    ".cm-content": { caretColor: "#9dbbff", padding: "8px 0" },
    "&.cm-focused .cm-cursor": { borderLeftColor: "#9dbbff" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "rgba(111, 151, 255, 0.32) !important" },
    ".cm-gutters": { backgroundColor: "#0f1014", color: "rgba(232, 232, 238, 0.32)", border: "none", borderRight: "1px solid rgba(255,255,255,0.06)" },
    ".cm-activeLine": { backgroundColor: "rgba(255, 255, 255, 0.035)" },
    ".cm-activeLineGutter": { backgroundColor: "rgba(255, 255, 255, 0.05)", color: "rgba(232, 232, 238, 0.7)" },
    ".cm-matchingBracket": { backgroundColor: "rgba(157, 187, 255, 0.22)", outline: "none" },
    ".cm-annotation": { color: "#ffd98a", fontStyle: "normal", fontWeight: "600" },
    ".cm-lintRange-error": { backgroundImage: "none", textDecoration: "underline wavy #ff6b6b", textUnderlineOffset: "3px" },
    ".cm-tooltip": { backgroundColor: "#1d1e26", border: "1px solid rgba(255,255,255,0.14)", color: "#e3e4ea" },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "rgba(111, 151, 255, 0.35)", color: "#fff" },
    ".cm-tooltip-lint": { padding: "0" },
    ".cm-diagnostic-error": { borderLeftColor: "#ff6b6b" },
    ".cm-errorLine": { backgroundColor: "rgba(255, 90, 90, 0.08)" },
  },
  { dark: true },
);

function completions(): Completion[] {
  const out: Completion[] = PRELUDE_DOCS.map((d) => ({ label: d.name, type: d.kind === "helper" ? "function" : "variable", detail: d.type, info: d.doc }));
  for (const b of WGSL_BUILTINS) out.push({ label: b, type: "function", boost: -1 });
  for (const k of ["f32", "i32", "bool", "vec2f", "vec3f", "vec4f", "mat2x2f", "mat3x3f", "let", "var", "fn", "return"])
    out.push({ label: k, type: "keyword", boost: -2 });
  out.push(
    snippetCompletion('var<private> ${uName}: f32; // @param ${min} ${max} ${default} label="${Label}"', {
      label: "@param f32",
      type: "text",
      detail: "annotated slider",
      boost: 2,
    }),
    snippetCompletion('var<private> ${uColor}: vec3f; // @color ${hex} label="${Label}"', {
      label: "@color",
      type: "text",
      detail: "annotated colour",
      boost: 2,
    }),
    snippetCompletion('var<private> ${uFlag}: bool; // @param default=${true} label="${Label}"', {
      label: "@param bool",
      type: "text",
      detail: "annotated checkbox",
      boost: 2,
    }),
    snippetCompletion('var<private> ${uMode}: f32; // @param options="${options}" label="${Label}"', {
      label: "@param options",
      type: "text",
      detail: "annotated dropdown (Label:value,…)",
      boost: 2,
    }),
    snippetCompletion("fn mainImage(uv: vec2f) -> vec4f {\n\t${}\n\treturn vec4f(uBaseColor, 1.0);\n}", {
      label: "mainImage",
      type: "function",
      detail: "entry point",
      boost: 3,
    }),
  );
  return out;
}

export interface WgslEditor {
  readonly view: EditorView;
  getDoc(): string;
  /** Replace the whole document: `undoable` in the editor (examples), else a silent sync (undo/redo outside). */
  setDoc(code: string, undoable?: boolean): void;
  /** A fresh document with an empty undo history (opening another layer). */
  reset(code: string): void;
  setErrors(errors: ShaderError[]): void;
  goToLine(line: number): void;
  focus(): void;
  destroy(): void;
}

export function createWgslEditor(parent: HTMLElement, opts: { doc: string; onChange(doc: string): void; label: string }): WgslEditor {
  const extensions: Extension[] = [
    lineNumbers(),
    highlightActiveLineGutter(),
    history(),
    drawSelection(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    highlightActiveLine(),
    lintGutter(),
    autocompletion({ override: [completeFromList(completions())], icons: false }),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
    wgsl,
    syntaxHighlighting(highlight),
    annotations,
    theme,
    EditorState.tabSize.of(2),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ "aria-label": opts.label, spellcheck: "false", autocorrect: "off", autocapitalize: "off" }),
    EditorView.updateListener.of((u) => {
      if (u.docChanged && !silent) opts.onChange(u.state.doc.toString());
    }),
  ];
  const view = new EditorView({ parent, state: EditorState.create({ doc: opts.doc, extensions }) });
  let silent = false;

  return {
    view,
    getDoc: () => view.state.doc.toString(),
    setDoc(code, undoable = false) {
      if (code === view.state.doc.toString()) return;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: code }, annotations: Transaction.addToHistory.of(undoable) });
    },
    reset(code) {
      silent = true;
      try {
        view.setState(EditorState.create({ doc: code, extensions }));
      } finally {
        silent = false;
      }
    },
    setErrors(errors) {
      const doc = view.state.doc;
      const diags: Diagnostic[] = [];
      for (const e of errors) {
        if (e.line < 1 || e.line > doc.lines) continue;
        const line = doc.line(e.line);
        // Underline the line's code (not its leading indentation).
        const lead = /^\s*/.exec(line.text)![0].length;
        diags.push({ from: Math.min(line.from + lead, line.to), to: line.to, severity: "error", message: e.message });
      }
      view.dispatch(setDiagnostics(view.state, diags));
    },
    goToLine(n) {
      const doc = view.state.doc;
      const line = doc.line(Math.max(1, Math.min(doc.lines, n)));
      view.dispatch({ selection: { anchor: line.from, head: line.to }, scrollIntoView: true });
      view.focus();
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
