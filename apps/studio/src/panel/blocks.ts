/**
 * Custom panel blocks mounted inside Tweakpane folders: visual pickers Tweakpane has no view for
 * (material swatches, texture and foil chips, the colour grid, preset tiles…). Each block returns
 * its element and a `refresh()` that re-reads the model.
 */
import type { FolderApi } from "tweakpane";
import type { HoloStyle, SurfaceTexture } from "@card3d/core/model";
import { h } from "../ui/dom.ts";

export interface Block {
  el: HTMLElement;
  refresh(): void;
}

export interface MountedBlock extends Block {
  /** Tweakpane blade wrapper, for hiding. */
  blade: { hidden: boolean; element: HTMLElement };
}

/** Put a custom element into a folder at the current position (a separator blade, re-skinned). */
export function mount(folder: FolderApi, block: Block): MountedBlock {
  const blade = folder.addBlade({ view: "separator" }) as unknown as { hidden: boolean; element: HTMLElement };
  blade.element.replaceChildren(block.el);
  blade.element.classList.add("c3-blade");
  return { ...block, blade };
}

export interface Choice<T extends string> {
  value: T;
  label: string;
  title?: string;
  /** CSS background for a visual chip. */
  swatch?: string;
}

/** A radio-like grid of chips. */
export function chipGrid<T extends string>(
  options: readonly Choice<T>[],
  get: () => T,
  set: (v: T) => void,
  o: { columns?: number; className?: string; label: string },
): Block {
  const el = h("div.c3-chips", { role: "radiogroup", "aria-label": o.label });
  if (o.className) el.classList.add(o.className);
  el.style.setProperty("--cols", String(o.columns ?? 3));
  const buttons = options.map((opt) => {
    const b = h(
      "button.c3-chip",
      { type: "button", role: "radio", title: opt.title ?? opt.label, "data-value": opt.value },
      opt.swatch ? h("span.c3-chip-sw", { "aria-hidden": "true" }) : null,
      h("span.c3-chip-label", { text: opt.label }),
    );
    if (opt.swatch) (b.firstElementChild as HTMLElement).style.background = opt.swatch;
    b.addEventListener("click", () => {
      set(opt.value);
      refresh();
    });
    el.append(b);
    return b;
  });
  const refresh = () => {
    const v = get();
    for (const b of buttons) {
      const on = b.dataset.value === v;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-checked", String(on));
    }
  };
  refresh();
  return { el, refresh };
}

/** A compact segmented control (2–4 options) with an optional row label. */
export function segmented<T extends string>(label: string, options: readonly Choice<T>[], get: () => T, set: (v: T) => void): Block {
  const group = h("div.c3-seg", { role: "radiogroup", "aria-label": label });
  const buttons = options.map((opt) => {
    const b = h("button.c3-seg-btn", { type: "button", role: "radio", "data-value": opt.value, title: opt.title ?? opt.label }, opt.label);
    b.addEventListener("click", () => {
      set(opt.value);
      refresh();
    });
    group.append(b);
    return b;
  });
  const el = h("div.c3-row", {}, h("span.c3-row-label", { text: label }), group);
  const refresh = () => {
    const v = get();
    for (const b of buttons) {
      const on = b.dataset.value === v;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-checked", String(on));
    }
  };
  refresh();
  return { el, refresh };
}

/** Swatch grid for colours, with the current value ringed. */
export function colorGrid(colors: readonly string[], get: () => string, set: (c: string) => void): Block {
  const el = h("div.c3-colors", { role: "radiogroup", "aria-label": "Colour" });
  const buttons = colors.map((c) => {
    const b = h("button.c3-color", { type: "button", role: "radio", title: c, "aria-label": c, "data-value": c.toLowerCase() });
    b.style.setProperty("--c", c);
    b.addEventListener("click", () => {
      set(c);
      refresh();
    });
    el.append(b);
    return b;
  });
  const refresh = () => {
    const v = get().toLowerCase();
    for (const b of buttons) {
      const on = b.dataset.value === v;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-checked", String(on));
    }
  };
  refresh();
  return { el, refresh };
}

/** Two buttons side by side (Tweakpane buttons are full-width). */
export function buttonRow(buttons: { label: string; title?: string; onClick: (b: HTMLButtonElement) => void; className?: string }[]): Block {
  const el = h("div.c3-btnrow");
  for (const spec of buttons) {
    const b = h("button.c3-mini", { type: "button", title: spec.title ?? spec.label }, spec.label);
    if (spec.className) b.classList.add(spec.className);
    b.addEventListener("click", () => spec.onClick(b));
    el.append(b);
  }
  return { el, refresh() {} };
}

export function note(text: string, className = "c3-hint"): Block {
  const el = h("p", { class: className, text });
  return { el, refresh() {} };
}

/** Multi-line text (the card bio allows line breaks). */
export function textArea(label: string, get: () => string, set: (v: string) => void, placeholder = ""): Block {
  const area = h("textarea.c3-area", { rows: 2, placeholder, "aria-label": label, spellcheck: "false" });
  area.value = get();
  area.addEventListener("input", () => set(area.value));
  const el = h("label.c3-row c3-row--top", {}, h("span.c3-row-label", { text: label }), area);
  return {
    el,
    refresh() {
      if (document.activeElement !== area) area.value = get();
    },
  };
}

// ── visual previews ─────────────────────────────────────────────────────────

/** CSS previews of each surface texture, for the texture chips. */
export const TEXTURE_SWATCH: Record<SurfaceTexture, string> = {
  none: "linear-gradient(135deg,#7d8285,#d6d9da 55%,#8f9497)",
  brushed: "repeating-linear-gradient(0deg,rgba(255,255,255,.22) 0 1px,rgba(0,0,0,.12) 1px 2px),linear-gradient(135deg,#7d8285,#d6d9da 55%,#8f9497)",
  guilloche:
    "repeating-radial-gradient(circle at 30% 120%,rgba(255,255,255,.35) 0 1px,transparent 1px 4px),linear-gradient(135deg,#7d8285,#d6d9da 55%,#8f9497)",
  crosshatch:
    "repeating-linear-gradient(45deg,rgba(0,0,0,.18) 0 1px,transparent 1px 5px),repeating-linear-gradient(-45deg,rgba(0,0,0,.18) 0 1px,transparent 1px 5px),linear-gradient(135deg,#7d8285,#d6d9da 55%,#8f9497)",
  hammered:
    "radial-gradient(circle at 20% 30%,rgba(255,255,255,.4) 0 3px,transparent 4px),radial-gradient(circle at 70% 60%,rgba(255,255,255,.35) 0 4px,transparent 5px),radial-gradient(circle at 45% 80%,rgba(0,0,0,.2) 0 3px,transparent 4px),radial-gradient(circle at 85% 20%,rgba(0,0,0,.18) 0 3px,transparent 4px),linear-gradient(135deg,#7d8285,#d6d9da 55%,#8f9497)",
  sandblasted:
    "radial-gradient(rgba(0,0,0,.18) 0.6px,transparent 0.8px) 0 0/3px 3px,radial-gradient(rgba(255,255,255,.25) 0.6px,transparent 0.8px) 1px 2px/4px 4px,linear-gradient(135deg,#8a8f92,#c9cccd 55%,#9a9fa2)",
  pinpoint: "radial-gradient(rgba(0,0,0,.35) 0.9px,transparent 1.2px) 0 0/5px 5px,linear-gradient(135deg,#7d8285,#d6d9da 55%,#8f9497)",
  linen:
    "repeating-linear-gradient(0deg,rgba(0,0,0,.12) 0 1px,transparent 1px 3px),repeating-linear-gradient(90deg,rgba(255,255,255,.18) 0 1px,transparent 1px 3px),linear-gradient(135deg,#7d8285,#d6d9da 55%,#8f9497)",
  "carbon-fiber":
    "linear-gradient(45deg,#2a2c2e 25%,transparent 25% 75%,#2a2c2e 75%) 0 0/6px 6px,linear-gradient(45deg,#2a2c2e 25%,#3d4043 25% 75%,#2a2c2e 75%) 3px 3px/6px 6px",
};

/** A recognisable gradient per foil style (UI only). */
export const HOLO_SWATCH: Record<HoloStyle, string> = {
  common: "linear-gradient(135deg,#c9ccd1,#eef0f3 50%,#b7bbc2)",
  uncommon: "linear-gradient(135deg,#b6d4c8,#eef7f1 50%,#9fc1b4)",
  rare: "linear-gradient(135deg,#9ab2ff,#e7ecff 45%,#ffd9f0 60%,#9ab2ff)",
  holo: "linear-gradient(120deg,#ff8ad8,#ffe18a 25%,#8affc1 50%,#8ac7ff 75%,#d18aff)",
  reverse: "linear-gradient(300deg,#ff8ad8,#ffe18a 25%,#8affc1 50%,#8ac7ff 75%,#d18aff)",
  cosmos: "radial-gradient(circle at 30% 30%,#fff 0 1px,transparent 2px) 0 0/7px 7px,linear-gradient(135deg,#2a1b5e,#7a3fd1 45%,#ff7ad9 70%,#3fb6ff)",
  radiant: "repeating-conic-gradient(from 0deg at 50% 50%,#fff3b0 0 10deg,#ffb3e6 10deg 20deg,#b3e1ff 20deg 30deg)",
  amazing: "radial-gradient(circle at 70% 30%,#fff 0 4%,transparent 30%),linear-gradient(135deg,#ff6b6b,#ffd166 30%,#06d6a0 55%,#118ab2 80%,#ef476f)",
  rainbow: "linear-gradient(90deg,#ff5f6d,#ffc371,#fff36d,#6dff9b,#6dc8ff,#a66dff)",
  shiny: "linear-gradient(115deg,#d9d9d9 30%,#fff 45%,#cfe8ff 50%,#fff 55%,#d9d9d9 70%)",
  gallery: "linear-gradient(135deg,#f6e7c8,#fff9ec 50%,#e8d3a7)",
  ultra: "repeating-linear-gradient(60deg,#c0f 0 6px,#0cf 6px 12px,#cf0 12px 18px)",
  vmax: "linear-gradient(135deg,#ff9a3c,#ffe066 30%,#a0ff9a 55%,#5fd3ff 80%,#c58bff)",
  vstar: "conic-gradient(from 45deg,#ffe8a3,#fff,#c9f0ff,#fff,#ffe8a3)",
  gold: "linear-gradient(135deg,#8a6a1f,#f3d27a 45%,#fff3c4 55%,#b88a2b)",
};
