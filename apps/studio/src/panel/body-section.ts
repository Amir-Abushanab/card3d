/**
 * "Card body" panel section: the card's shape (orientation, corner radius, cutouts), its edge (side
 * wall colour and finish, diamond-cut chamfer) and the contactless mark. Every control writes the
 * optional design fields (`shape`, `edge`, `contactless`) and removes them again at their defaults,
 * so an untouched card stays the standard one.
 */
import type { FolderApi } from "tweakpane";
import type { BindingApi } from "./params.ts";
import type { CardContactless, CardCutout, CardDesign, CardEdge, CardShape, MarkFinish } from "@card3d/core/model";
import {
  CORNER_RADIUS_MM_PER_UNIT,
  CORNER_RADIUS_RANGE,
  DEFAULT_CORNER_RADIUS,
  clampCornerRadius,
  EDGE_DEFAULT_COLOR,
  CONTACTLESS_SCALE,
  contactlessHeightMm,
} from "@card3d/core/editor";
import { colorGrid, note, segmented, type Block, type MountedBlock } from "./blocks.ts";
import type { SectionHost } from "./effects-section.ts";
import { h } from "../ui/dom.ts";

type EdgeChoice = "body" | NonNullable<CardEdge["finish"]>;

/** Mark finish choices, shared with the Identity section. */
export const FINISH_CHOICES: readonly { value: MarkFinish; label: string; title: string }[] = [
  { value: "default", label: "Print", title: "The standard branding finish: a shiny, faintly raised print" },
  { value: "embossed", label: "Emboss", title: "Raised out of the metal, with rounded shoulders" },
  { value: "engraved", label: "Engrave", title: "Cut into the metal: a darker floor and a lit inner wall" },
  { value: "etched", label: "Etch", title: "Laser-etched: frosted, lighter, almost no relief" },
];

const CUTOUTS: readonly { value: CardCutout; label: string; title: string }[] = [
  { value: "lanyard", label: "Lanyard slot", title: "A slot by the short edge (the top edge in portrait). Not ISO: ID-1 cards have no holes" },
  { value: "notch", label: "Corner notch", title: "A rounded bite out of the top-right corner. Not ISO: ID-1 cards have no holes" },
  { value: "window", label: "Window", title: "A round see-through window above the number line. Not ISO: ID-1 cards have no holes" },
];

/** Edge colour swatches: gold, rose gold, gunmetal, black, and anodised blue, red, green, violet. */
const EDGE_SWATCHES = ["#d4af37", "#e2a68f", "#5b6068", "#141416", "#2f6fd6", "#d23a4c", "#2e9e6a", "#7a52d1"];

/** Corner radius, mm on an ID-1 card (`cornerRadius` is a fraction of half the short side). */
const cornerMm = (v: number) => v * CORNER_RADIUS_MM_PER_UNIT;

const isShapeDefault = (s: CardShape) =>
  s.orientation !== "portrait" && !s.cutouts?.length && (s.cornerRadius === undefined || Math.abs(s.cornerRadius - DEFAULT_CORNER_RADIUS) < 5e-4);

export class BodySection {
  private readonly edgeBlades: { hidden: boolean }[] = [];
  private readonly contactBlades: { hidden: boolean }[] = [];
  private readonly glassNote: MountedBlock;
  private readonly corner = { radius: DEFAULT_CORNER_RADIUS };
  private readonly edgeColor = { color: EDGE_DEFAULT_COLOR.metal };
  private readonly chamfer = { on: false };
  private readonly contact = { on: false, scale: CONTACTLESS_SCALE.default as number };
  private readonly bindings: { binding: BindingApi; read(): void }[] = [];
  private refreshCutouts: () => void = () => {};
  /** True while refresh() writes the proxies (Tweakpane echoes a change event for them). */
  private refreshing = false;

  constructor(
    f: FolderApi,
    private readonly host: SectionHost,
  ) {
    const d = () => host.design;
    host.add(f, note("The card's own shape, edge and contactless mark. Shapes use the procedural card."));
    this.glassNote = host.add(f, note("Glass keeps the standard shape (edge and contactless still apply where they can).", "c3-hint c3-hint--warn"));

    // ── shape ──
    host.add(f, note("Shape", "c3-cap"));
    host.add(
      f,
      segmented<"landscape" | "portrait">(
        "Orientation",
        [
          { value: "landscape", label: "Landscape", title: "The standard card" },
          {
            value: "portrait",
            label: "Portrait",
            title: "A vertical card: the chip stays at its ISO place on the body (near the top), the print stays upright",
          },
        ],
        () => d().shape?.orientation ?? "landscape",
        (v) => this.setShape({ orientation: v === "portrait" ? "portrait" : undefined }, `orientation ${v}`),
      ),
    );
    const radius = f.addBinding(this.corner, "radius", {
      label: "Corners",
      min: CORNER_RADIUS_RANGE.min,
      max: CORNER_RADIUS_RANGE.max,
      step: 0.001,
      format: (v: number) => `${cornerMm(v).toFixed(2)} mm${Math.abs(v - CORNER_RADIUS_RANGE.iso) < 0.0015 ? " (ISO)" : ""}`,
    });
    radius.element.title = "Corner radius, within ISO/IEC 7810 ID-1: 3.18 mm ± 0.30 (the standard card is 3.18 mm)";
    radius.on("change", (e) => {
      if (host.syncing() || this.refreshing) return;
      this.setShape({ cornerRadius: clampCornerRadius(Math.round(e.value * 1000) / 1000) });
    });
    this.bindings.push({ binding: radius, read: () => (this.corner.radius = d().shape?.cornerRadius ?? DEFAULT_CORNER_RADIUS) });
    host.add(f, this.cutoutChips());

    // ── edge ──
    host.add(f, note("Edge", "c3-cap"));
    host.add(
      f,
      segmented<EdgeChoice>(
        "",
        [
          { value: "body", label: "Body", title: "The body metal (standard)" },
          { value: "metal", label: "Metal", title: "Polished metal in a colour (e.g. gold edges on a black card)" },
          { value: "anodized", label: "Anodised", title: "Dyed anodised aluminium with a faint shimmer" },
          { value: "match", label: "Match", title: "The face's colour: its artwork's border colour, else the body" },
        ],
        () => d().edge?.finish ?? "body",
        (v) => this.setEdge({ finish: v === "body" ? undefined : v }, `edge ${v}`),
      ),
    );
    this.edgeBlades.push(
      host.add(
        f,
        colorGrid(
          EDGE_SWATCHES,
          () => d().edge?.color ?? this.defaultEdgeColor(),
          (c) => this.setEdge({ color: c }, "edge colour"),
        ),
      ).blade,
    );
    const color = f.addBinding(this.edgeColor, "color", { label: "Edge colour", view: "color" });
    color.on("change", (e) => {
      if (host.syncing() || this.refreshing) return;
      this.setEdge({ color: String(e.value).toLowerCase() });
    });
    this.edgeBlades.push(color);
    this.bindings.push({ binding: color, read: () => (this.edgeColor.color = d().edge?.color ?? this.defaultEdgeColor()) });
    const chamfer = f.addBinding(this.chamfer, "on", { label: "Chamfer" });
    chamfer.element.title = "A polished, diamond-cut highlight along the rim";
    chamfer.on("change", (e) => {
      if (host.syncing() || this.refreshing) return;
      this.setEdge({ chamfer: e.value ? true : undefined }, e.value ? "chamfer on" : "chamfer off");
    });
    this.bindings.push({ binding: chamfer, read: () => (this.chamfer.on = d().edge?.chamfer === true) });

    // ── contactless ──
    host.add(f, note("Contactless", "c3-cap"));
    const contact = f.addBinding(this.contact, "on", { label: "Mark" });
    contact.element.title = "The contactless indicator beside the chip (EMVCo's four graduating arcs)";
    contact.on("change", (e) => {
      if (host.syncing() || this.refreshing) return;
      if (e.value) d().contactless = { ...d().contactless };
      else delete d().contactless;
      this.refresh();
      host.changed(e.value ? "contactless on" : "contactless off");
    });
    this.bindings.push({ binding: contact, read: () => (this.contact.on = !!d().contactless) });
    this.contactBlades.push(
      host.add(
        f,
        segmented<MarkFinish>(
          "Finish",
          FINISH_CHOICES,
          () => d().contactless?.finish ?? "embossed",
          (v) => {
            const c: CardContactless = { ...d().contactless };
            if (v === "embossed") delete c.finish;
            else c.finish = v;
            d().contactless = c;
            host.changed(`contactless ${v}`);
          },
        ),
      ).blade,
    );
    const size = f.addBinding(this.contact, "scale", {
      label: "Size",
      min: CONTACTLESS_SCALE.min,
      max: CONTACTLESS_SCALE.max,
      step: 0.01,
      format: (v: number) => `${contactlessHeightMm(v, d().shape?.orientation === "portrait").toFixed(1)} mm`,
    });
    size.element.title = "The mark's height. EMVCo's minimum is 4.5 mm and there is no maximum; on a landscape card it stops short of the number line";
    size.on("change", (e) => {
      if (host.syncing() || this.refreshing || !d().contactless) return;
      const c: CardContactless = { ...d().contactless };
      const v = Math.round(e.value * 100) / 100;
      if (Math.abs(v - CONTACTLESS_SCALE.default) < 0.005) delete c.scale;
      else c.scale = v;
      d().contactless = c;
      host.changed("contactless size");
    });
    this.bindings.push({ binding: size, read: () => (this.contact.scale = d().contactless?.scale ?? CONTACTLESS_SCALE.default) });
    this.contactBlades.push(size);
    this.refresh();
  }

  private defaultEdgeColor(): string {
    const fin = this.host.design.edge?.finish;
    return fin === "anodized" ? EDGE_DEFAULT_COLOR.anodized : EDGE_DEFAULT_COLOR.metal;
  }

  private cutoutChips(): Block {
    const d = () => this.host.design;
    const el = h("div.c3-chips c3-chips--toggle", { role: "group", "aria-label": "Cutouts" });
    el.style.setProperty("--cols", "3");
    const buttons = CUTOUTS.map((c) => {
      const b = h(
        "button.c3-chip",
        { type: "button", "aria-pressed": "false", title: c.title, "data-value": c.value },
        h("span.c3-chip-label", { text: c.label }),
      );
      b.addEventListener("click", () => {
        const cur = new Set(d().shape?.cutouts ?? []);
        if (cur.has(c.value)) cur.delete(c.value);
        else cur.add(c.value);
        const cutouts = CUTOUTS.map((x) => x.value).filter((x) => cur.has(x));
        this.setShape({ cutouts: cutouts.length ? cutouts : undefined }, `${c.label.toLowerCase()} ${cur.has(c.value) ? "on" : "off"}`);
        refresh();
      });
      el.append(b);
      return b;
    });
    const refresh = () => {
      const cur = d().shape?.cutouts ?? [];
      for (const b of buttons) {
        const on = cur.includes(b.dataset.value as CardCutout);
        b.classList.toggle("is-on", on);
        b.setAttribute("aria-pressed", String(on));
      }
    };
    this.refreshCutouts = refresh;
    // Cutouts go beyond ISO/IEC 7810 (no holes in an ID-1 card); they keep clear of the chip contacts,
    // the antenna and the embossing areas wherever they are.
    const row = h(
      "div.c3-row",
      {},
      h(
        "span.c3-row-label",
        {
          text: "Cutouts",
          title: "Not ISO: ISO/IEC 7810 ID-1 cards have no holes. Each cutout keeps clear of the chip contacts, the antenna and the number and name areas.",
        },
        h("span.c3-row-label-note", { text: "not ISO" }),
      ),
      el,
    );
    return { el: row, refresh };
  }

  private setShape(patch: Partial<CardShape>, label?: string): void {
    const d = this.host.design;
    const next: CardShape = { ...d.shape };
    for (const [k, v] of Object.entries(patch) as [keyof CardShape, unknown][]) {
      if (v === undefined) delete next[k];
      else (next as Record<string, unknown>)[k] = v;
    }
    if (next.cornerRadius !== undefined && Math.abs(next.cornerRadius - DEFAULT_CORNER_RADIUS) < 5e-4) delete next.cornerRadius;
    if (isShapeDefault(next)) delete d.shape;
    else d.shape = next;
    this.host.changed(label);
  }

  private setEdge(patch: Partial<CardEdge>, label?: string): void {
    const d = this.host.design;
    const next: CardEdge = { ...d.edge };
    for (const [k, v] of Object.entries(patch) as [keyof CardEdge, unknown][]) {
      if (v === undefined) delete next[k];
      else (next as Record<string, unknown>)[k] = v;
    }
    if (next.finish === "match" || !next.finish) delete next.color;
    if (!next.finish && !next.chamfer) delete d.edge;
    else d.edge = next;
    this.refresh();
    this.host.changed(label);
  }

  refresh(): void {
    const d: CardDesign = this.host.design;
    const glass = d.recipe.material === "glass" || (d.materialOverride?.transmission ?? 0) > 0.5;
    this.glassNote.blade.hidden = !glass;
    const tint = d.edge?.finish === "metal" || d.edge?.finish === "anodized";
    for (const b of this.edgeBlades) b.hidden = !tint;
    for (const b of this.contactBlades) b.hidden = !d.contactless;
    this.refreshCutouts();
    this.refreshing = true;
    try {
      for (const { binding, read } of this.bindings) {
        read();
        binding.refresh();
      }
    } finally {
      this.refreshing = false;
    }
  }
}
