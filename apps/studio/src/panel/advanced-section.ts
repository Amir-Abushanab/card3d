/**
 * "Advanced material" panel section: per-field material overrides (each with an override checkbox;
 * off = the recipe's computed value, shown greyed), the branding colour and the name layout.
 */
import type { FolderApi } from "tweakpane";
import type { BindingApi } from "./params.ts";
import type { MaterialOverride } from "@card3d/core/model";
import { recipeToMaterialConfig, resolveMaterial } from "@card3d/core/editor";
import { LAYOUT_RANGES } from "../state/fx.ts";
import { buttonRow, note } from "./blocks.ts";
import type { SectionHost } from "./effects-section.ts";
import { h } from "../ui/dom.ts";

type MaterialField = "color" | "metalness" | "roughness" | "clearcoat" | "clearcoatRoughness";

const MATERIAL_FIELDS: { key: MaterialField; label: string; min?: number; max?: number; step?: number; help: string }[] = [
  { key: "color", label: "Colour", help: "Base colour of the body (overrides the recipe colour after the material maths)." },
  { key: "metalness", label: "Metalness", min: 0, max: 1, step: 0.01, help: "0 = dielectric, 1 = metal." },
  { key: "roughness", label: "Roughness", min: 0, max: 1, step: 0.01, help: "Micro-surface roughness (blurrier reflections)." },
  { key: "clearcoat", label: "Clearcoat", min: 0, max: 1, step: 0.01, help: "Strength of the lacquer layer." },
  { key: "clearcoatRoughness", label: "Coat rough.", min: 0, max: 1, step: 0.01, help: "Roughness of the lacquer layer." },
];

const DEFAULT_LAYOUT = { nameFontHeight: 0.05, nameBottom: 0.09 } as const;

interface OverrideRow {
  binding: BindingApi;
  box: HTMLInputElement;
  refresh(): void;
}

const hex = (c: string) => (/^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : "#bcbcb9");

/** Put an override checkbox in a binding's label cell. */
function withOverrideBox(binding: BindingApi, label: string, help: string): HTMLInputElement {
  const cell = binding.element.querySelector<HTMLElement>(".tp-lblv_l");
  const box = h("input.c3-ovr-box", { type: "checkbox", "aria-label": `Override ${label} (off: use the recipe value)` });
  const wrap = h("label.c3-ovr", { title: `${help}\nUnchecked: use the recipe value.` }, box, h("span", { text: label }));
  cell?.replaceChildren(wrap);
  return box;
}

export class AdvancedSection {
  private readonly rows: OverrideRow[] = [];
  private local = false;

  constructor(
    private readonly f: FolderApi,
    private readonly host: SectionHost,
  ) {
    host.add(f, note("Tick a field to override the value the recipe computes; unticked fields follow the Material section."));
    host.add(f, note("Body", "c3-cap"));
    for (const field of MATERIAL_FIELDS) this.rows.push(this.materialRow(field));

    host.add(f, note("Branding", "c3-cap"));
    this.rows.push(this.brandingRow());

    host.add(f, note("Name layout", "c3-cap"));
    this.rows.push(this.layoutRow("nameFontHeight", "Name size", "Cardholder name height (fraction of the card height)."));
    this.rows.push(this.layoutRow("nameBottom", "Name bottom", "Distance of the name's baseline from the bottom edge (fraction of the card height)."));

    host.add(
      f,
      buttonRow([
        {
          label: "Clear overrides",
          title: "Back to the recipe values and the default name layout",
          onClick: () => {
            const d = this.host.design;
            if (!d.materialOverride && !d.brandingOverride && !d.frontLayout) return;
            delete d.materialOverride;
            delete d.brandingOverride;
            delete d.frontLayout;
            this.host.changed("clear overrides");
            this.refresh();
          },
        },
      ]),
    );
    this.refresh();
  }

  refresh(): void {
    this.local = true;
    try {
      for (const r of this.rows) r.refresh();
    } finally {
      this.local = false;
    }
    const d = this.host.design;
    const n = Object.keys(d.materialOverride ?? {}).length + Object.keys(d.brandingOverride ?? {}).length + Object.keys(d.frontLayout ?? {}).length;
    this.f.title = n ? `Advanced material · ${n} override${n > 1 ? "s" : ""}` : "Advanced material";
  }

  private quiet = () => this.local || this.host.syncing();

  private recipeMaterial() {
    return resolveMaterial(recipeToMaterialConfig(this.host.design.recipe));
  }

  private materialRow(field: (typeof MATERIAL_FIELDS)[number]): OverrideRow {
    const proxy = { v: field.key === "color" ? "#bcbcb9" : (0 as number | string) };
    const binding =
      field.key === "color"
        ? this.f.addBinding(proxy, "v", { label: field.label, view: "color" })
        : this.f.addBinding(proxy, "v", { label: field.label, min: field.min, max: field.max, step: field.step, format: (v: number) => v.toFixed(2) });
    const box = withOverrideBox(binding, field.label, field.help);
    const get = () => this.host.design.materialOverride?.[field.key];
    const set = (raw: MaterialOverride[MaterialField] | undefined) => {
      const v = typeof raw === "number" ? Number(raw.toFixed(3)) : raw;
      const d = this.host.design;
      const next: MaterialOverride = { ...d.materialOverride };
      if (v === undefined) delete next[field.key];
      else (next as Record<string, unknown>)[field.key] = v;
      if (Object.keys(next).length) d.materialOverride = next;
      else delete d.materialOverride;
    };
    const refresh = () => {
      const own = get();
      const R = this.recipeMaterial();
      proxy.v = own ?? (field.key === "color" ? hex(R.color) : (R[field.key] as number));
      box.checked = own !== undefined;
      binding.disabled = own === undefined;
      binding.refresh();
    };
    box.addEventListener("change", () => {
      set(box.checked ? (proxy.v as never) : undefined);
      binding.disabled = !box.checked;
      this.host.changed(box.checked ? `override ${field.label.toLowerCase()}` : `${field.label.toLowerCase()} from recipe`);
      this.refresh();
    });
    binding.on("change", () => {
      if (this.quiet() || !box.checked) return;
      set(proxy.v as never);
      this.host.changed();
    });
    return { binding, box, refresh };
  }

  private brandingRow(): OverrideRow {
    const proxy = { v: "#ffffff" };
    const binding = this.f.addBinding(proxy, "v", { label: "Colour", view: "color" });
    const box = withOverrideBox(binding, "Colour", "Colour of the corner mark, name and bio (glows on the back).");
    const refresh = () => {
      const c = this.host.design.brandingOverride?.color;
      if (c) proxy.v = hex(c);
      box.checked = !!c;
      binding.disabled = !c;
      binding.refresh();
    };
    const set = (c: string | undefined) => {
      const d = this.host.design;
      const next = { ...d.brandingOverride };
      if (c) next.color = c;
      else delete next.color;
      if (Object.keys(next).length) d.brandingOverride = next;
      else delete d.brandingOverride;
    };
    box.addEventListener("change", () => {
      set(box.checked ? proxy.v : undefined);
      this.host.changed(box.checked ? "branding colour" : "branding colour from recipe");
      this.refresh();
    });
    binding.on("change", () => {
      if (this.quiet() || !box.checked) return;
      set(proxy.v);
      this.host.changed();
    });
    return { binding, box, refresh };
  }

  private layoutRow(key: keyof typeof LAYOUT_RANGES, label: string, help: string): OverrideRow {
    const [min, max] = LAYOUT_RANGES[key];
    const proxy = { v: DEFAULT_LAYOUT[key] as number };
    const binding = this.f.addBinding(proxy, "v", { label, min, max, step: 0.001, format: (v: number) => v.toFixed(3) });
    const box = withOverrideBox(binding, label, help);
    box.setAttribute("aria-label", `Override ${label} (off: the default layout)`);
    const set = (raw: number | undefined) => {
      const v = raw === undefined ? undefined : Number(raw.toFixed(4));
      const d = this.host.design;
      const next = { ...d.frontLayout };
      if (v === undefined) delete next[key];
      else next[key] = v;
      if (Object.keys(next).length) d.frontLayout = next;
      else delete d.frontLayout;
    };
    const refresh = () => {
      const own = this.host.design.frontLayout?.[key];
      proxy.v = own ?? DEFAULT_LAYOUT[key];
      box.checked = own !== undefined;
      binding.disabled = own === undefined;
      binding.refresh();
    };
    box.addEventListener("change", () => {
      set(box.checked ? proxy.v : undefined);
      this.host.changed(box.checked ? `override ${label.toLowerCase()}` : `default ${label.toLowerCase()}`);
      this.refresh();
    });
    binding.on("change", () => {
      if (this.quiet() || !box.checked) return;
      set(proxy.v);
      this.host.changed();
    });
    return { binding, box, refresh };
  }
}
