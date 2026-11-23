/**
 * "Sticker" panel section, shown while a sticker is selected: PowerPoint's picture tools. Position,
 * size (with an aspect lock) and rotation as numbers; Crop / Reset crop / Flip / Reset picture; the
 * "Color" gallery (Original, Grayscale, Sepia, Washout, colour washes), a custom tint colour and
 * amount, brightness / contrast / saturation and opacity.
 *
 * Fields write the selected `Decal` in place, show it on the live mesh at once (`live()`, no rebuild)
 * and report the edit; a slider drag is one undo step (main.ts commits on release).
 */
import type { FolderApi } from "tweakpane";
import { DECAL_TINT_PRESETS, decalLookRgb, decalVisibleAspect, type Decal, type DecalTint } from "@card3d/core/model";
import { MM_PER_UNIT, cardFrameSize } from "@card3d/core/editor";
import { placement } from "../stickers/transform.ts";
import { h } from "../ui/dom.ts";
import { buttonRow, note, type Block, type MountedBlock } from "./blocks.ts";
import type { SectionHost } from "./effects-section.ts";

export interface StickerTools {
  selected(): Decal | null;
  /** Show the selected sticker's values on its mesh now. */
  live(): void;
  cropping(): boolean;
  /** Enter crop mode, or apply the crop when in it. */
  crop(): void;
  resetCrop(): void;
  resetPicture(): void;
  flip(axis: "h" | "v"): void;
  resolveUrl(src: string): string;
}

/** The fields as the panel shows them: mm on the card, degrees, percent. */
interface Proxy {
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  lock: boolean;
  tintColor: string;
  tintAmount: number;
  brightness: number;
  contrast: number;
  saturation: number;
  opacity: number;
}

const round = (v: number, k = 10) => Math.round(v * k) / k;
const sameTint = (a: DecalTint | undefined, b: DecalTint | null) => (!a && !b) || (!!a && !!b && a.color === b.color && Math.abs(a.amount - b.amount) < 1e-3);

export class StickerSection {
  private readonly p: Proxy = {
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    rotation: 0,
    lock: true,
    tintColor: "#808080",
    tintAmount: 0,
    brightness: 0,
    contrast: 0,
    saturation: 0,
    opacity: 100,
  };
  private readonly gallery: HTMLDivElement;
  private readonly cropBtn: HTMLButtonElement;
  private readonly resetCropBtn: HTMLButtonElement;
  private readonly title: MountedBlock;
  private swatchesFor = "";
  private swatchToken = 0;

  constructor(
    private readonly f: FolderApi,
    private readonly host: SectionHost,
    private readonly tools: StickerTools,
  ) {
    this.title = host.add(f, note("", "c3-hint c3-sticker-title"));
    const mm = { step: 0.1, format: (v: number) => v.toFixed(1) };
    // Position and size, in mm on the card (centre from its left / top edge).
    f.addBinding(this.p, "x", { label: "X (mm)", min: 0, max: 86, ...mm }).on("change", () => this.write((d) => this.setPosition(d)));
    f.addBinding(this.p, "y", { label: "Y (mm)", min: 0, max: 86, ...mm }).on("change", () => this.write((d) => this.setPosition(d)));
    f.addBinding(this.p, "w", { label: "Width (mm)", min: 2, max: 170, ...mm }).on("change", () => this.write((d) => this.setSize(d, "w")));
    f.addBinding(this.p, "h", { label: "Height (mm)", min: 2, max: 170, ...mm }).on("change", () => this.write((d) => this.setSize(d, "h")));
    f.addBinding(this.p, "lock", { label: "Lock aspect" });
    f.addBinding(this.p, "rotation", { label: "Rotation (°)", min: -180, max: 180, step: 1 }).on("change", () =>
      this.write((d) => (d.rotation = this.p.rotation)),
    );

    const cropRow = buttonRow([
      {
        label: "✂ Crop",
        title: "Crop on the card (or double-click the sticker). Enter applies, Esc cancels",
        onClick: () => this.tools.crop(),
        className: "c3-sticker-crop",
      },
      { label: "Reset crop", title: "Show the whole picture again", onClick: () => this.tools.resetCrop() },
    ]);
    host.add(f, cropRow);
    [this.cropBtn, this.resetCropBtn] = [...cropRow.el.querySelectorAll("button")];
    host.add(
      f,
      buttonRow([
        { label: "⇆ Flip H", title: "Mirror left ↔ right", onClick: () => this.tools.flip("h") },
        { label: "⇅ Flip V", title: "Mirror top ↔ bottom", onClick: () => this.tools.flip("v") },
        { label: "↺ Reset picture", title: "Undo the crop, flip, colour, corrections and opacity", onClick: () => this.tools.resetPicture() },
      ]),
    );

    // Colour: the recolour gallery, then a custom tint.
    host.add(f, note("Color", "c3-cap"));
    this.gallery = h("div.c3-tints", { role: "radiogroup", "aria-label": "Recolor" });
    for (const preset of DECAL_TINT_PRESETS) {
      const b = h(
        "button.c3-tint",
        { type: "button", role: "radio", title: preset.label, "data-tint": preset.id },
        h("img", { alt: "", draggable: "false" }),
        h("span", { text: preset.label }),
      );
      b.addEventListener("click", () => {
        const d = this.tools.selected();
        if (!d || sameTint(d.tint, preset.tint)) return;
        if (preset.tint) d.tint = { ...preset.tint };
        else delete d.tint;
        this.afterEdit(`sticker color ${preset.label.toLowerCase()}`);
      });
      this.gallery.append(b);
    }
    host.add(f, { el: this.gallery, refresh: () => {} } satisfies Block);
    f.addBinding(this.p, "tintColor", { label: "Tint", view: "color" }).on("change", () =>
      this.write((d) => (d.tint = { color: this.p.tintColor.toLowerCase(), amount: d.tint?.amount ?? 1 })),
    );
    f.addBinding(this.p, "tintAmount", { label: "Amount (%)", min: 0, max: 100, step: 1 }).on("change", () =>
      this.write((d) => {
        if (this.p.tintAmount > 0) d.tint = { color: d.tint?.color ?? this.p.tintColor.toLowerCase(), amount: this.p.tintAmount / 100 };
        else delete d.tint;
      }),
    );
    for (const [key, label] of [
      ["brightness", "Brightness"],
      ["contrast", "Contrast"],
      ["saturation", "Saturation"],
    ] as const) {
      f.addBinding(this.p, key, { label: `${label} (%)`, min: -100, max: 100, step: 1 }).on("change", () =>
        this.write((d) => {
          const adjust = { ...d.adjust, [key]: this.p[key] / 100 };
          if (!adjust[key]) delete adjust[key];
          if (Object.keys(adjust).length) d.adjust = adjust;
          else delete d.adjust;
        }),
      );
    }
    f.addBinding(this.p, "opacity", { label: "Opacity (%)", min: 0, max: 100, step: 1 }).on("change", () =>
      this.write((d) => {
        if (this.p.opacity < 100) d.opacity = this.p.opacity / 100;
        else delete d.opacity;
      }),
    );
    this.refresh();
  }

  /** Re-read the selected sticker (selection, gestures on the card, undo). */
  refresh(): void {
    const d = this.tools.selected();
    this.f.hidden = !d;
    if (!d) return;
    const size = cardFrameSize(this.host.design);
    const pl = placement(d, size);
    const k = MM_PER_UNIT;
    Object.assign(this.p, {
      x: round((pl.px / 100) * size.width * k),
      y: round((pl.py / 100) * size.height * k),
      w: round(pl.width * k),
      h: round(pl.height * k),
      rotation: Math.round(d.rotation),
      tintColor: d.tint?.color ?? this.p.tintColor,
      tintAmount: Math.round((d.tint?.amount ?? 0) * 100),
      brightness: Math.round((d.adjust?.brightness ?? 0) * 100),
      contrast: Math.round((d.adjust?.contrast ?? 0) * 100),
      saturation: Math.round((d.adjust?.saturation ?? 0) * 100),
      opacity: Math.round((d.opacity ?? 1) * 100),
    } satisfies Partial<Proxy>);
    const index = this.host.design.decals.indexOf(d);
    this.title.el.textContent = `Sticker ${index + 1} · ${d.side === "back" ? "back" : "front"}${d.crop ? " · cropped" : ""}`;
    const cropping = this.tools.cropping();
    this.cropBtn.textContent = cropping ? "✓ Apply crop" : "✂ Crop";
    this.cropBtn.classList.toggle("is-on", cropping);
    this.resetCropBtn.disabled = !d.crop;
    for (const b of this.gallery.querySelectorAll<HTMLButtonElement>("[data-tint]")) {
      const preset = DECAL_TINT_PRESETS.find((p) => p.id === b.dataset.tint)!;
      const on = sameTint(d.tint, preset.tint);
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-checked", String(on));
    }
    void this.renderSwatches(d.src);
    this.f.refresh();
  }

  /** A field changed: write it into the selected sticker, show it, report it. */
  private write(fn: (d: Decal) => void): void {
    if (this.host.syncing() || this.quiet) return;
    const d = this.tools.selected();
    if (!d) return;
    fn(d);
    this.tools.live();
    this.host.changed();
    this.syncAfter();
  }

  /** A discrete edit (a gallery click): commit it now. */
  private afterEdit(label: string): void {
    this.tools.live();
    this.host.changed(label);
    this.syncAfter();
  }

  /** Other fields may follow (a locked height, a clamped position): show them without re-entering. */
  private syncAfter(): void {
    queueMicrotask(() => this.host.syncing() || this.refreshQuietly());
  }

  /** Refresh without the bindings' change events writing back (the host's flag does this for panel.refresh()). */
  refreshQuietly(): void {
    this.quiet = true;
    try {
      this.refresh();
    } finally {
      this.quiet = false;
    }
  }
  private quiet = false;

  private setPosition(d: Decal): void {
    const size = cardFrameSize(this.host.design);
    d.x = Math.round((this.p.x / MM_PER_UNIT / size.width) * 1e4) / 100;
    d.y = Math.round((this.p.y / MM_PER_UNIT / size.height) * 1e4) / 100;
  }

  private setSize(d: Decal, changed: "w" | "h"): void {
    const size = cardFrameSize(this.host.design);
    const visible = decalVisibleAspect(d.aspect || 1, d.crop);
    let w = this.p.w / MM_PER_UNIT;
    let h = this.p.h / MM_PER_UNIT;
    if (this.p.lock) {
      if (changed === "w") h = w / visible;
      else w = h * visible;
    } else {
      const crop = d.crop ?? { w: 1, h: 1 };
      d.aspect = Math.round((w / h) * (crop.h / crop.w) * 1e4) / 1e4;
    }
    d.width = Math.round((w / (size.width * (d.scale ?? 1))) * 1e4) / 100;
  }

  /** Thumbnails of the sticker in each preset (computed with the shader's own colour maths). */
  private async renderSwatches(src: string): Promise<void> {
    if (this.swatchesFor === src) return;
    this.swatchesFor = src;
    const token = ++this.swatchToken;
    const imgs = [...this.gallery.querySelectorAll<HTMLImageElement>("img")];
    try {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = this.tools.resolveUrl(src);
      await img.decode();
      if (token !== this.swatchToken) return;
      const S = 44;
      const c = document.createElement("canvas");
      c.width = c.height = S;
      const ctx = c.getContext("2d", { willReadFrequently: true })!;
      const iw = img.naturalWidth || S;
      const ih = img.naturalHeight || S;
      const k = Math.min(S / iw, S / ih);
      ctx.drawImage(img, (S - iw * k) / 2, (S - ih * k) / 2, iw * k, ih * k);
      const base = ctx.getImageData(0, 0, S, S);
      DECAL_TINT_PRESETS.forEach((preset, i) => {
        const out = new ImageData(new Uint8ClampedArray(base.data), S, S);
        if (preset.tint) {
          const look = { tint: preset.tint };
          const px = out.data;
          for (let j = 0; j < px.length; j += 4) {
            if (!px[j + 3]) continue;
            const [r, g, b] = decalLookRgb([px[j] / 255, px[j + 1] / 255, px[j + 2] / 255], look);
            px[j] = r * 255;
            px[j + 1] = g * 255;
            px[j + 2] = b * 255;
          }
        }
        ctx.putImageData(out, 0, 0);
        imgs[i].src = c.toDataURL();
      });
    } catch {
      // A cross-origin image without CORS can't be read back: plain colour chips instead.
      DECAL_TINT_PRESETS.forEach((preset, i) => {
        imgs[i].removeAttribute("src");
        imgs[i].parentElement!.style.setProperty("--sw", preset.tint?.color ?? "transparent");
      });
    }
  }
}
