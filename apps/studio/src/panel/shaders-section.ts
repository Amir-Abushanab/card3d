/**
 * "Shaders" panel section: the face-shader layer list (`design.shaders`: enable, reorder, duplicate,
 * remove, select) and the selected layer's settings (side, target, blend, opacity, clock, and params
 * generated from its `ShaderParamSpec`s — for custom layers, from the code's annotations).
 */
import type { FolderApi } from "tweakpane";
import type { FaceShader, ShaderParamValue, Side } from "@card3d/core/model";
import { coerceParam, type ShaderBlend, type ShaderError, type ShaderParamSpec } from "@card3d/core/editor";
import { MAX_SHADER_LAYERS, cloneLayer, isCustom, layerDefinition, layerName, layerParams } from "../state/fx.ts";
import { h } from "../ui/dom.ts";
import { note, segmented, type Block, type MountedBlock } from "./blocks.ts";
import { isGlass, type SectionHost } from "./effects-section.ts";
import { buildParamControls, type ParamControls } from "./params.ts";

export interface ShadersHost extends SectionHost {
  /** Open the shader picker (adds a layer). */
  onAdd(): void;
  /** Open the code editor on a custom layer. */
  onEdit(index: number): void;
  /** Layers the card skipped at build time (compile errors), by design index. */
  errors(): { index: number; side: Side; errors: ShaderError[] }[];
  /** Index of the layer open in the code editor, if any. */
  editing(): number | null;
}

const SIDE_LABEL: Record<FaceShader["side"], string> = { front: "Front", back: "Back", both: "Both" };
const BLENDS: { text: string; value: ShaderBlend }[] = [
  { text: "Normal", value: "normal" },
  { text: "Add", value: "add" },
  { text: "Multiply", value: "multiply" },
  { text: "Screen", value: "screen" },
];

const ICON = {
  up: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 15 6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
  dup: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  del: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
};

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export class ShadersSection {
  private readonly listEl: HTMLDivElement;
  private readonly addBtn: HTMLButtonElement;
  private readonly limitNote: MountedBlock;
  private settings: FolderApi | null = null;
  private settingsBlocks: Block[] = [];
  private params: ParamControls | null = null;
  private errorNote: HTMLElement | null = null;
  private selected = 0;
  private signature = "";

  constructor(
    private readonly f: FolderApi,
    private readonly host: ShadersHost,
  ) {
    host.add(
      f,
      note("Shader layers paint the faces: skins replace the face colour under the metal lighting; overlays blend on top. Layers apply top to bottom."),
    );
    this.listEl = h("div.c3-layers", { role: "list", "aria-label": "Shader layers" });
    host.add(f, { el: this.listEl, refresh: () => {} });
    this.addBtn = h("button.c3-mini c3-mini--add", { type: "button", title: "Add a built-in or custom shader layer" }, "＋ Add shader layer…");
    this.addBtn.addEventListener("click", () => this.host.onAdd());
    host.add(f, { el: h("div.c3-btnrow", {}, this.addBtn), refresh: () => {} });
    this.limitNote = host.add(f, note(`A card holds up to ${MAX_SHADER_LAYERS} layers.`));
    this.refresh();
  }

  private get layers(): FaceShader[] {
    return this.host.design.shaders ?? [];
  }

  /** Select a layer (e.g. the one just added) and show its settings. */
  select(index: number): void {
    this.selected = index;
    this.refresh(true);
  }

  /** Re-read the design. Rebuilds the settings only when the layer structure or its params changed. */
  refresh(force = false): void {
    const layers = this.layers;
    if (this.selected >= layers.length) this.selected = Math.max(0, layers.length - 1);
    this.renderList();
    const sel = layers[this.selected];
    const sig = sel
      ? `${this.selected}|${layers.length}|${sel.id}|${sel.target}|${JSON.stringify(layerParams(sel).map((p) => [p.key, p.type, p.min, p.max, p.step, p.options, p.label]))}`
      : "none";
    if (force || sig !== this.signature) {
      this.signature = sig;
      this.renderSettings();
    } else {
      for (const b of this.settingsBlocks) b.refresh();
      this.params?.refresh();
      this.settings?.refresh();
      this.refreshErrors();
    }
    const n = layers.length;
    const on = layers.filter((l) => l.enabled !== false).length;
    this.f.title = n ? `Shaders · ${on === n ? n : `${on}/${n}`} layer${n > 1 ? "s" : ""}` : "Shaders";
    this.addBtn.disabled = n >= MAX_SHADER_LAYERS;
    this.limitNote.blade.hidden = n < MAX_SHADER_LAYERS;
  }

  /** The card's skipped-layer errors changed (after a rebuild). */
  refreshErrors(): void {
    this.renderList();
    if (!this.errorNote) return;
    const msgs = this.errorsFor(this.selected);
    this.errorNote.hidden = !msgs.length;
    this.errorNote.textContent = msgs.length ? `⚠ Not rendering: ${msgs.slice(0, 3).join(" · ")}` : "";
  }

  private errorsFor(i: number): string[] {
    const out: string[] = [];
    for (const e of this.host.errors()) {
      if (e.index !== i) continue;
      for (const x of e.errors) out.push(x.line ? `line ${x.line}: ${x.message}` : x.message);
    }
    return [...new Set(out)];
  }

  // ── list ──────────────────────────────────────────────────────────────────

  private commit(label: string, select = this.selected): void {
    this.selected = select;
    this.host.changed(label);
    this.refresh(true);
  }

  private move(i: number, to: number): void {
    const layers = this.layers;
    if (to < 0 || to >= layers.length || i === to) return;
    const [l] = layers.splice(i, 1);
    layers.splice(to, 0, l);
    this.commit("reorder shader layers", to);
    this.listEl.querySelectorAll<HTMLElement>(".c3-layer-main")[to]?.focus();
  }

  private renderList(): void {
    const layers = this.layers;
    if (!layers.length) {
      this.listEl.replaceChildren(h("p.c3-empty", { text: "No shader layers. Add one to paint the card with a built-in shader or your own WGSL." }));
      return;
    }
    const glass = isGlass(this.host.design);
    const editing = this.host.editing();
    const rows = layers.map((layer, i) => {
      const def = layerDefinition(layer);
      const name = layerName(layer);
      const on = layer.enabled !== false;
      const errs = this.errorsFor(i);
      const skinLost = layer.target === "skin" && glass;
      const meta = [SIDE_LABEL[layer.side], layer.target, layer.blend && layer.blend !== "normal" ? layer.blend : null, on ? null : "paused"]
        .filter(Boolean)
        .join(" · ");

      const box = h("input.c3-layer-on", {
        type: "checkbox",
        "aria-label": `${on ? "Pause" : "Enable"} layer ${i + 1} (${name})`,
        title: on ? "Shown (untick to pause)" : "Paused (tick to show)",
      });
      box.checked = on;
      box.addEventListener("change", () => {
        if (box.checked) delete layer.enabled;
        else layer.enabled = false;
        this.commit(`${box.checked ? "enable" : "pause"} ${name}`, i);
      });

      const main = h(
        "button.c3-layer-main",
        { type: "button", "aria-pressed": String(i === this.selected), title: `${def?.description ?? name}\nAlt+↑/↓ moves the layer.` },
        h("span.c3-layer-name", { text: `${i + 1}. ${name}` }),
        h("small.c3-layer-meta", { text: meta }),
      );
      main.addEventListener("click", () => {
        if (this.selected === i) return;
        this.selected = i;
        this.refresh();
      });
      main.addEventListener("dblclick", () => isCustom(layer) && this.host.onEdit(i));
      main.addEventListener("keydown", (e) => {
        if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
        e.preventDefault();
        this.move(i, i + (e.key === "ArrowUp" ? -1 : 1));
      });

      const warn =
        errs.length || skinLost
          ? h("span.c3-layer-warn", {
              role: "img",
              "aria-label": errs.length ? "Has errors" : "Not visible on this card",
              title: errs.length ? errs.join("\n") : "Skins don't render on glass: switch the target to overlay.",
              text: "⚠",
            })
          : null;

      const btn = (icon: string, label: string, fn: () => void, disabled = false) => {
        const b = h("button.c3-icon-btn c3-layer-btn", { type: "button", "aria-label": `${label} (layer ${i + 1})`, title: label, html: icon });
        b.disabled = disabled;
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          fn();
        });
        return b;
      };
      const row = h(
        "div.c3-layer",
        { role: "listitem" },
        box,
        main,
        warn,
        btn(ICON.up, "Move up", () => this.move(i, i - 1), i === 0),
        btn(ICON.down, "Move down", () => this.move(i, i + 1), i === layers.length - 1),
        btn(
          ICON.dup,
          "Duplicate",
          () => {
            if (layers.length >= MAX_SHADER_LAYERS) return;
            layers.splice(i + 1, 0, cloneLayer(layer));
            this.commit(`duplicate ${name}`, i + 1);
          },
          layers.length >= MAX_SHADER_LAYERS,
        ),
        btn(ICON.del, "Remove", () => {
          layers.splice(i, 1);
          if (!layers.length) delete this.host.design.shaders;
          this.commit(`remove ${name}`, Math.min(i, Math.max(0, layers.length - 1)));
        }),
      );
      row.classList.toggle("is-on", i === this.selected);
      row.classList.toggle("is-off", !on);
      row.classList.toggle("is-editing", editing === i);
      return row;
    });
    this.listEl.replaceChildren(...rows);
  }

  // ── selected layer ────────────────────────────────────────────────────────

  private renderSettings(): void {
    this.params?.dispose();
    this.params = null;
    this.settings?.dispose();
    this.settings = null;
    this.settingsBlocks = [];
    this.errorNote = null;
    const i = this.selected;
    const layer = this.layers[i];
    if (!layer) return;
    const def = layerDefinition(layer);
    const f = this.f.addFolder({ title: `Layer ${i + 1} · ${layerName(layer)}`, expanded: true });
    this.settings = f;
    const add = (b: Block) => {
      this.settingsBlocks.push(b);
      return this.host.add(f, b);
    };
    const changed = (label?: string) => {
      this.host.changed(label);
      this.renderList();
    };

    if (def?.description && !isCustom(layer)) add(note(def.description));
    if (isCustom(layer)) {
      const edit = h("button.c3-mini c3-mini--add", { type: "button", title: "Open the WGSL editor (double-click the layer also works)" }, "✎ Edit code…");
      edit.addEventListener("click", () => this.host.onEdit(this.selected));
      add({ el: h("div.c3-btnrow", {}, edit), refresh() {} });
    }
    const err = h("p.c3-hint c3-hint--error", { role: "status" });
    add({ el: err, refresh() {} });
    this.errorNote = err;

    add(
      segmented<FaceShader["side"]>(
        "Side",
        [
          { value: "front", label: "Front" },
          { value: "back", label: "Back" },
          { value: "both", label: "Both" },
        ],
        () => this.layers[this.selected]?.side ?? "front",
        (v) => {
          const l = this.layers[this.selected];
          if (!l || l.side === v) return;
          l.side = v;
          changed(`${layerName(l)} side`);
        },
      ),
    );
    const targets = def?.targets ?? ["skin", "overlay"];
    if (targets.length > 1) {
      add(
        segmented<FaceShader["target"]>(
          "Target",
          targets.map((t) => ({
            value: t,
            label: t === "skin" ? "Skin" : "Overlay",
            title: t === "skin" ? "Replaces the face colour under the metal lighting" : "Blends on top of the face, view-dependent",
          })),
          () => this.layers[this.selected]?.target ?? "skin",
          (v) => {
            const l = this.layers[this.selected];
            if (!l || l.target === v) return;
            l.target = v;
            changed(`${layerName(l)} target`);
            this.refresh(true);
          },
        ),
      );
    } else add(note(`${targets[0] === "skin" ? "Skin" : "Overlay"} only.`));

    const glass = isGlass(this.host.design);
    if (layer.target === "skin" && glass) add(note("Skins don't render on glass cards: switch the target to Overlay.", "c3-hint c3-hint--warn"));

    const look = { blend: (layer.blend ?? def?.defaultBlend ?? "normal") as ShaderBlend, opacity: layer.opacity ?? 1 };
    const blend = f.addBinding(look, "blend", { label: "Blend", options: BLENDS });
    blend.element.title = "How the layer combines with what is below it";
    blend.on("change", (e) => {
      const l = this.layers[this.selected];
      if (this.host.syncing() || !l) return;
      if (e.value === "normal") delete l.blend;
      else l.blend = e.value;
      changed(`${layerName(l)} blend`);
    });
    const opacity = f.addBinding(look, "opacity", { label: "Opacity", min: 0, max: 1, step: 0.01, format: (v: number) => v.toFixed(2) });
    opacity.on("change", (e) => {
      const l = this.layers[this.selected];
      if (this.host.syncing() || !l) return;
      if (e.value >= 1) delete l.opacity;
      else l.opacity = Number(e.value.toFixed(3));
      changed();
    });
    this.settingsBlocks.push({
      el: blend.element,
      refresh: () => {
        const l = this.layers[this.selected];
        if (!l) return;
        look.blend = (l.blend ?? def?.defaultBlend ?? "normal") as ShaderBlend;
        look.opacity = l.opacity ?? 1;
        blend.refresh();
        opacity.refresh();
      },
    });

    if (def?.animated) {
      const clock = { live: layer.animated !== false, frozen: layer.time !== undefined, time: layer.time ?? 2 };
      const live = f.addBinding(clock, "live", { label: "Animate" });
      live.element.title = "Run the shader's clock (never under reduced motion)";
      const frozen = f.addBinding(clock, "frozen", { label: "Freeze time" });
      frozen.element.title = "Hold the clock at a fixed time (stills, exports)";
      const time = f.addBinding(clock, "time", { label: "", min: 0, max: 60, step: 0.05, format: (v: number) => `${v.toFixed(2)} s` });
      const vis = () => {
        frozen.hidden = !clock.live;
        time.hidden = !clock.live || !clock.frozen;
      };
      vis();
      live.on("change", (e) => {
        const l = this.layers[this.selected];
        vis();
        if (this.host.syncing() || !l) return;
        if (e.value) delete l.animated;
        else l.animated = false;
        changed(`${layerName(l)} ${e.value ? "animated" : "static"}`);
      });
      frozen.on("change", (e) => {
        const l = this.layers[this.selected];
        vis();
        if (this.host.syncing() || !l) return;
        if (e.value) l.time = clock.time;
        else delete l.time;
        changed(`${layerName(l)} ${e.value ? "frozen" : "running"}`);
      });
      time.on("change", (e) => {
        const l = this.layers[this.selected];
        if (this.host.syncing() || !l || !clock.frozen) return;
        l.time = Number(e.value.toFixed(3));
        changed();
      });
      this.settingsBlocks.push({
        el: live.element,
        refresh: () => {
          const l = this.layers[this.selected];
          if (!l) return;
          clock.live = l.animated !== false;
          clock.frozen = l.time !== undefined;
          if (l.time !== undefined) clock.time = l.time;
          live.refresh();
          frozen.refresh();
          time.refresh();
          vis();
        },
      });
    }

    const specs = layerParams(layer);
    if (specs.length) {
      this.host.add(f, note(isCustom(layer) ? "Parameters · from annotations" : "Parameters", "c3-cap"));
      this.params = buildParamControls(
        f,
        specs,
        (k) => this.layers[this.selected]?.params?.[k],
        (k, v) => this.setParam(k, v, specs),
        { syncing: () => this.host.syncing(), onChange: () => changed() },
      );
      const reset = h("button.c3-mini", { type: "button", title: "Every parameter back to its default" }, "Reset parameters");
      reset.addEventListener("click", () => {
        const l = this.layers[this.selected];
        if (!l?.params) return;
        delete l.params;
        changed(`${layerName(l)} defaults`);
        this.params?.refresh();
      });
      add({ el: h("div.c3-btnrow", {}, reset), refresh() {} });
    } else if (isCustom(layer)) {
      add(note('No parameters yet. Annotate a uniform in the code, e.g.  uniform float uSpeed; // @param 0 3 1 label="Speed"'));
    }
    this.refreshErrors();
  }

  private setParam(key: string, v: ShaderParamValue | undefined, specs: ShaderParamSpec[]): void {
    const l = this.layers[this.selected];
    const spec = specs.find((s) => s.key === key);
    if (!l || !spec) return;
    const value = v === undefined ? undefined : coerceParam(spec, v);
    const params = { ...l.params };
    if (value === undefined || sameValue(value, coerceParam(spec, spec.default))) delete params[key];
    else params[key] = value;
    if (Object.keys(params).length) l.params = params;
    else delete l.params;
  }
}
