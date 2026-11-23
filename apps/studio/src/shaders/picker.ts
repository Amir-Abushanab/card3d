/**
 * "Add shader layer" picker: the built-in library as a grid (live-rendered thumbnails from the
 * offscreen thumbnail stage, cached for the session), a blank custom shader and the
 * `WGSL_SHADER_EXAMPLES` starters (custom shaders are WGSL). Resolves with the choice, or null when
 * dismissed.
 */
import { WGSL_SHADER_EXAMPLES, listShaders, type ShaderDefinition } from "@card3d/core/editor";
import { createDialog } from "../ui/dialog.ts";
import { h } from "../ui/dom.ts";

export type ShaderPick = { kind: "builtin"; def: ShaderDefinition } | { kind: "custom"; code: string; target: "skin" | "overlay"; label: string };

export interface PickerDeps {
  /** Cached thumbnail for a key ("builtin:<id>" / "example:<id>"), if rendered. */
  thumb(key: string): string | undefined;
  /** Render missing thumbnails (in order); `onThumb` fires as each one is ready. */
  renderThumbs(keys: string[], onThumb: (key: string, url: string) => void): void;
  /** At the layer limit: picking is disabled with this message. */
  full(): string | null;
}

const BLANK_SHADER = `// My shader: edit me. mainImage returns the colour (display sRGB) and alpha of each pixel.
var<private> uColor: vec3f;  // @color #7aa2ff label="Colour"
var<private> uSpeed: f32;    // @param 0 4 1 label="Speed"

fn mainImage(uv: vec2f) -> vec4f {
  let wave = 0.5 + 0.5 * sin(facePos.x * 8.0 + uTime * uSpeed);
  let col = mix(uBaseColor, uColor, wave * 0.6);
  return vec4f(col, 1.0);
}
`;

const thumbKey = {
  builtin: (id: string) => `builtin:${id}`,
  example: (id: string) => `example:${id}`,
};

export class ShaderPicker {
  private readonly shell = createDialog("Add a shader layer", { wide: true, className: "c3-picker", onClose: () => this.finish(null) });
  private readonly grid: HTMLDivElement;
  private readonly customGrid: HTMLDivElement;
  private readonly full: HTMLParagraphElement;
  private readonly imgs = new Map<string, HTMLImageElement>();
  private resolve: ((p: ShaderPick | null) => void) | null = null;

  constructor(private readonly deps: PickerDeps) {
    this.full = h("p.c3-note", { role: "status" });
    this.grid = h("div.c3-shp-grid", { role: "group", "aria-label": "Built-in shaders" });
    this.customGrid = h("div.c3-shp-grid", { role: "group", "aria-label": "Custom shaders" });
    for (const def of listShaders()) {
      const tags = [def.targets.join(" / "), def.animated ? "animated" : null, ...(def.tags ?? []).filter((t) => t !== "animated")]
        .filter(Boolean)
        .slice(0, 4) as string[];
      this.grid.append(this.card(thumbKey.builtin(def.id), def.label, def.description, tags, () => this.finish({ kind: "builtin", def })));
    }
    this.customGrid.append(
      this.card(null, "Blank custom shader", "Start from a minimal mainImage() with one colour and one speed parameter.", ["WGSL", "skin"], () =>
        this.finish({ kind: "custom", code: BLANK_SHADER, target: "skin", label: "Custom" }),
      ),
    );
    for (const ex of WGSL_SHADER_EXAMPLES) {
      this.customGrid.append(
        this.card(thumbKey.example(ex.id), `${ex.label}`, ex.description, ["starter", ex.target], () =>
          this.finish({ kind: "custom", code: ex.code, target: ex.target, label: ex.label }),
        ),
      );
    }
    this.shell.body.append(
      this.full,
      h("h3.c3-shp-h", { text: "Built-in library" }),
      this.grid,
      h("h3.c3-shp-h", { text: "Custom WGSL" }),
      h("p.c3-muted", {
        text: "Write your own fn mainImage(uv: vec2f) -> vec4f. Annotated var<private> declarations become controls; the editor checks and applies it live.",
      }),
      this.customGrid,
    );
  }

  /** Every thumbnail key the picker shows (to pre-render them in the background). */
  static keys(): string[] {
    return [...listShaders().map((d) => thumbKey.builtin(d.id)), ...WGSL_SHADER_EXAMPLES.map((e) => thumbKey.example(e.id))];
  }

  open(): Promise<ShaderPick | null> {
    this.finish(null);
    const full = this.deps.full();
    this.full.textContent = full ?? "";
    this.full.hidden = !full;
    for (const b of this.shell.body.querySelectorAll<HTMLButtonElement>(".c3-shp")) b.disabled = !!full;
    for (const [key, img] of this.imgs) {
      const url = this.deps.thumb(key);
      if (url) this.setImg(img, url);
    }
    const missing = [...this.imgs.keys()].filter((k) => !this.deps.thumb(k));
    if (missing.length) this.deps.renderThumbs(missing, (key, url) => this.imgs.get(key) && this.setImg(this.imgs.get(key)!, url));
    this.shell.open();
    this.shell.body.querySelector<HTMLButtonElement>(".c3-shp:not(:disabled)")?.focus();
    return new Promise((r) => (this.resolve = r));
  }

  private setImg(img: HTMLImageElement, url: string): void {
    if (img.src !== url) img.src = url;
    img.closest(".c3-shp")?.classList.add("has-thumb");
  }

  private finish(p: ShaderPick | null): void {
    const r = this.resolve;
    this.resolve = null;
    if (p && this.shell.dialog.open) this.shell.close();
    r?.(p);
  }

  private card(key: string | null, label: string, description: string, tags: string[], pick: () => void): HTMLElement {
    const img = h("img", { alt: "", draggable: "false" });
    if (key) this.imgs.set(key, img);
    const thumb = h("span.c3-shp-thumb", { "aria-hidden": "true" }, key ? img : h("span.c3-shp-glyph", { text: "{ }" }));
    const b = h(
      "button.c3-shp",
      { type: "button", title: description },
      thumb,
      h("span.c3-shp-name", { text: label }),
      h("span.c3-shp-desc", { text: description }),
      h("span.c3-shp-tags", {}, ...tags.map((t) => h("span.c3-shp-tag", { text: t }))),
    );
    b.addEventListener("click", pick);
    return b;
  }
}
