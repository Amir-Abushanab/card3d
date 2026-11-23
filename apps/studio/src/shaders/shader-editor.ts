/**
 * The custom shader editor: a resizable side drawer (a bottom sheet on narrow screens) beside the
 * live card, with a CodeMirror WGSL editor, inline error markers and an error list, examples, and a
 * cheat sheet. Edits are checked as you type (`parseCustomShader`, debounced) and compiled on the
 * card engine's GPU (`EngineStage.checkShader`); only code that compiles is pushed to the card, so the
 * last good version keeps rendering while you type.
 *
 * Custom layers are WGSL (`language: "wgsl"`). A layer still in GLSL (the three.js engine's language)
 * is skipped by the card: the drawer says so, and the first edit that compiles as WGSL replaces it.
 *
 * The drawer is bound to one layer object of `design.shaders`; it follows that object through
 * reorders, and falls back to the same index after undo/redo (which replace the objects).
 */
import type { CardDesign, FaceShader } from "@card3d/core/model";
import { WGSL_SHADER_EXAMPLES, parseCustomShader, type ShaderError } from "@card3d/core/editor";
import { GLSL_LAYER_MESSAGE, MAX_CUSTOM_CODE, isGlslLayer, layerName } from "../state/fx.ts";
import { h, modKey } from "../ui/dom.ts";
import { cheatSheet } from "./cheatsheet.ts";
import type { WgslEditor } from "./wgsl-editor.ts";

export interface ShaderEditorDeps {
  design: CardDesign;
  /** Compiles WGSL on the card engine's GPU: its errors (lines of `code`), or null when it can't now. */
  check(code: string): Promise<ShaderError[] | null>;
  /** Code that compiles: write it to the layer at `index` and rebuild. */
  apply(index: number, code: string): void;
  /** The drawer opened, closed or moved to another layer (panel highlight). */
  onTarget(index: number | null): void;
  /** Persisted drawer width (px). */
  width: number;
  onResize(width: number): void;
}

type Status = "ok" | "checking" | "error" | "paused" | "glsl";

const PARSE_MS = 90;
const COMPILE_MS = 320;
const MIN_W = 340;

export class ShaderEditor {
  private readonly el: HTMLElement;
  private readonly title: HTMLElement;
  private readonly status: HTMLElement;
  private readonly host: HTMLDivElement;
  private readonly errorsEl: HTMLDivElement;
  private readonly revert: HTMLButtonElement;
  private editor: WgslEditor | null = null;
  private loading: Promise<void> | null = null;
  private layer: FaceShader | null = null;
  private index = -1;
  /** The code the card is running (last that compiled, or what the layer had). */
  private applied = "";
  /** Unapplied edits per layer object, kept when the drawer closes or switches layers. */
  private readonly drafts = new WeakMap<FaceShader, string>();
  private parseTimer = 0;
  private compileTimer = 0;
  private parseErrors: ShaderError[] = [];
  private compileErrors: ShaderError[] = [];
  /** The latest check: an older one that finishes later is dropped. */
  private checks = 0;

  constructor(private readonly deps: ShaderEditorDeps) {
    this.title = h("h2.c3-drawer-title", { text: "Custom shader" });
    this.status = h("span.c3-status-pill", { role: "status", "aria-live": "polite" });
    const examples = h(
      "select.c3-select",
      { "aria-label": "Load an example" },
      h("option", { value: "", text: "Examples…" }),
      ...WGSL_SHADER_EXAMPLES.map((e) => h("option", { value: e.id, text: e.label })),
    );
    examples.addEventListener("change", () => {
      const ex = WGSL_SHADER_EXAMPLES.find((e) => e.id === examples.value);
      examples.value = "";
      if (ex && this.editor) {
        this.editor.setDoc(ex.code, true);
        this.editor.focus();
      }
    });
    const close = h("button.c3-dialog-x", { type: "button", "aria-label": "Close the shader editor", title: "Close" }, "×");
    close.addEventListener("click", () => this.close());
    const grip = h("div.c3-drawer-grip", {
      role: "separator",
      tabindex: 0,
      "aria-orientation": "vertical",
      "aria-label": "Resize the editor (arrow keys)",
      title: "Drag to resize",
    });
    this.bindGrip(grip);
    this.host = h("div.c3-cm-host");
    this.errorsEl = h("div.c3-errlist", { "aria-label": "Errors" });
    this.revert = h(
      "button.c3-mini",
      { type: "button", title: "Discard the edits that don't compile and go back to the code the card is running" },
      "Revert to running version",
    );
    this.revert.addEventListener("click", () => {
      this.editor?.setDoc(this.applied, true);
      this.editor?.focus();
    });
    this.el = h(
      "aside.c3-drawer",
      { "aria-label": "Custom shader editor", hidden: true },
      grip,
      h("header.c3-drawer-hd", {}, this.title, this.status, examples, close),
      this.host,
      this.errorsEl,
      h(
        "footer.c3-drawer-ft",
        {},
        h("small.c3-muted", {
          text: `Applies live when it compiles; the card keeps the last working version meanwhile. ${modKey}Z undoes typing; the studio's undo restores earlier versions.`,
        }),
        this.revert,
      ),
      cheatSheet(),
    );
    // Keystrokes in the drawer are the editor's: never studio shortcuts (undo/redo, sticker nudges).
    this.el.addEventListener("keydown", (e) => e.stopPropagation());
    document.body.append(this.el);
    this.setWidth(deps.width);
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  /** Index of the layer being edited (null when closed). */
  get editing(): number | null {
    return this.isOpen ? this.index : null;
  }

  async open(index: number): Promise<void> {
    const layer = this.deps.design.shaders?.[index];
    if (!layer || layer.id !== "custom") return;
    if (this.layer && this.layer !== layer && this.editor) this.stash();
    this.layer = layer;
    this.index = index;
    this.applied = layer.code ?? "";
    this.el.hidden = false;
    document.documentElement.classList.add("has-drawer");
    await this.ensureEditor();
    this.editor!.reset(this.drafts.get(layer) ?? this.applied);
    this.drafts.delete(layer);
    this.updateTitle();
    this.check(true);
    this.editor!.focus();
    this.deps.onTarget(index);
  }

  close(): void {
    if (!this.isOpen) return;
    this.stash();
    this.el.hidden = true;
    document.documentElement.classList.remove("has-drawer");
    clearTimeout(this.parseTimer);
    clearTimeout(this.compileTimer);
    this.layer = null;
    this.index = -1;
    this.deps.onTarget(null);
  }

  /**
   * The design changed outside the editor: re-find the layer (it moves with reorders) and pick up its
   * code when it changed underneath. `replaced` (undo/redo/load, which replace every layer object)
   * falls back to the layer at the same index; otherwise a layer that is gone closes the editor.
   */
  sync(replaced = false): void {
    if (!this.isOpen || !this.layer) return;
    const shaders = this.deps.design.shaders ?? [];
    let i = shaders.indexOf(this.layer);
    if (i < 0) {
      const same = replaced ? shaders[this.index] : undefined;
      if (same?.id !== "custom") {
        this.layer = null;
        this.close();
        return;
      }
      this.layer = same;
      i = this.index;
    }
    this.index = i;
    const code = this.layer.code ?? "";
    if (code !== this.applied) {
      this.applied = code;
      this.editor?.setDoc(code);
    }
    this.updateTitle();
    this.check(false);
    this.deps.onTarget(i);
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private stash(): void {
    if (!this.layer || !this.editor) return;
    const doc = this.editor.getDoc();
    if (doc !== this.applied) this.drafts.set(this.layer, doc);
  }

  private async ensureEditor(): Promise<void> {
    if (this.editor) return;
    this.loading ??= import("./wgsl-editor.ts").then(({ createWgslEditor }) => {
      this.editor = createWgslEditor(this.host, {
        doc: "",
        label: "WGSL code",
        onChange: () => this.onEdit(),
      });
    });
    await this.loading;
  }

  private updateTitle(): void {
    if (!this.layer) return;
    this.title.textContent = `Layer ${this.index + 1} · ${layerName(this.layer)}`;
  }

  private onEdit(): void {
    if (!this.isOpen) return;
    this.setStatus("checking");
    clearTimeout(this.parseTimer);
    clearTimeout(this.compileTimer);
    this.parseTimer = window.setTimeout(() => this.parse(), PARSE_MS);
    this.compileTimer = window.setTimeout(() => this.check(true), COMPILE_MS);
  }

  /** Annotation errors only (pure, fast): immediate feedback while typing. */
  private parse(): void {
    if (!this.editor) return;
    this.parseErrors = parseCustomShader(this.editor.getDoc(), "wgsl").errors.filter((e) => e.line > 0);
    this.showErrors([...this.parseErrors, ...this.compileErrors.filter((c) => !this.parseErrors.some((p) => p.line === c.line))]);
  }

  /** Full check with the GPU's compiler; on success push the code to the card (when `apply`). */
  private check(apply: boolean): void {
    if (!this.editor || !this.layer) return;
    clearTimeout(this.compileTimer);
    const layer = this.layer;
    const code = this.editor.getDoc();
    const mine = ++this.checks;
    // A GLSL layer as it came (not edited yet): the card skips it; say so instead of listing WGSL errors.
    if (isGlslLayer(layer) && code === this.applied) {
      this.compileErrors = [{ line: 0, message: GLSL_LAYER_MESSAGE }];
      this.parseErrors = [];
      this.showErrors(this.compileErrors);
      this.revert.hidden = true;
      this.setStatus("glsl");
      return;
    }
    const done = (errors: ShaderError[]) => {
      if (mine !== this.checks || this.layer !== layer || !this.editor) return;
      // Still GLSL on the card until an edit compiles: keep the notice on top.
      if (errors.length && isGlslLayer(layer)) errors = [{ line: 0, message: GLSL_LAYER_MESSAGE }, ...errors];
      this.compileErrors = errors;
      this.parseErrors = [];
      this.showErrors(errors);
      if (!errors.length && apply && (code !== this.applied || isGlslLayer(layer))) {
        this.applied = code;
        this.deps.apply(this.index, code);
      }
      this.revert.hidden = code === this.applied;
      this.setStatus(errors.length ? "error" : layer.enabled === false ? "paused" : "ok", errors.length);
    };
    if (code.length > MAX_CUSTOM_CODE)
      return done([
        { line: 0, message: `The shader is too long (${code.length.toLocaleString()} characters; the limit is ${MAX_CUSTOM_CODE.toLocaleString()}).` },
      ]);
    if (!code.trim()) return done([{ line: 0, message: "The shader is empty." }]);
    const parsed = parseCustomShader(code, "wgsl").errors;
    if (parsed.length) return done(parsed);
    void this.deps.check(code).then(
      (errors) => done(errors ?? [{ line: 0, message: "The shader can't be checked right now (the graphics context is restarting)." }]),
      (e: unknown) => done([{ line: 0, message: `The shader couldn't be checked: ${(e as Error)?.message ?? e}` }]),
    );
  }

  private setStatus(s: Status, n = 0): void {
    this.status.dataset.state = s;
    this.status.textContent =
      s === "ok"
        ? "✓ Running"
        : s === "paused"
          ? "✓ Compiles · layer paused"
          : s === "checking"
            ? "Checking…"
            : s === "glsl"
              ? "GLSL · skipped"
              : `✕ ${n} error${n === 1 ? "" : "s"}`;
    this.status.title =
      s === "error" ? "The card keeps rendering the last version that compiled." : s === "glsl" ? "The card engine runs WGSL: rewrite this layer in WGSL." : "";
  }

  private showErrors(errors: ShaderError[]): void {
    this.editor?.setErrors(errors);
    const sorted = [...errors].sort((a, b) => a.line - b.line);
    this.errorsEl.replaceChildren(
      h("p.c3-errlist-hd", { text: "Not applied — the card keeps the last version that compiled." }),
      ...sorted.map((e) => {
        const b = h(
          "button.c3-err",
          { type: "button", title: e.line ? `Go to line ${e.line}` : "Not tied to a line" },
          h("span.c3-err-line", { text: e.line ? `Line ${e.line}` : "General" }),
          h("span.c3-err-msg", { text: e.message }),
        );
        b.disabled = !e.line;
        b.addEventListener("click", () => this.editor?.goToLine(e.line));
        return b;
      }),
    );
    this.errorsEl.hidden = !errors.length;
  }

  private setWidth(w: number): void {
    const max = Math.max(MIN_W, Math.round(window.innerWidth * 0.7));
    const width = Math.round(Math.min(max, Math.max(MIN_W, w || 520)));
    document.documentElement.style.setProperty("--drawer-w", `${width}px`);
    this.width = width;
  }
  private width = 520;

  private bindGrip(grip: HTMLElement): void {
    grip.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const start = this.width;
      const move = (ev: PointerEvent) => this.setWidth(start + (startX - ev.clientX));
      const up = () => {
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", up);
        grip.removeEventListener("pointercancel", up);
        this.deps.onResize(this.width);
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up);
      grip.addEventListener("pointercancel", up);
    });
    grip.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      this.setWidth(this.width + (e.key === "ArrowLeft" ? 32 : -32));
      this.deps.onResize(this.width);
    });
  }
}
