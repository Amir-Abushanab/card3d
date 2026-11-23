/**
 * "Effects" panel section: the add-on rigs (shine, vines), each with controls generated from
 * `EFFECT_CATALOG`. Every add-on's controls exist once and are shown while it is on.
 */
import type { FolderApi } from "tweakpane";
import type { AddonId, CardDesign } from "@card3d/core/model";
import { EFFECT_CATALOG, type EffectParamSpec } from "@card3d/core/editor";
import { addonOn, addonValue, setAddon, setAddonValue } from "../state/fx.ts";
import { note, type Block, type MountedBlock } from "./blocks.ts";
import { buildParamControls, type BindingApi, type ParamControls } from "./params.ts";

export interface SectionHost {
  readonly design: CardDesign;
  syncing(): boolean;
  /** Report an edit (`label` → a discrete history step). */
  changed(label?: string): void;
  add(folder: FolderApi, block: Block): MountedBlock;
}

export const isGlass = (d: CardDesign): boolean => d.recipe.material === "glass" || (d.materialOverride?.transmission ?? 0) > 0.5;

export class EffectsSection {
  private readonly addons = new Map<AddonId, { state: { on: boolean }; binding: BindingApi; params: ParamControls }>();

  constructor(
    private readonly f: FolderApi,
    private readonly host: SectionHost,
  ) {
    const d = () => host.design;
    const opts = { syncing: () => host.syncing(), onChange: () => host.changed() };

    host.add(f, note("Add-ons work on any card and layer over everything. Presets and Reset clear them; Randomize keeps them."));

    // ── add-ons ──
    host.add(f, note("Add-ons", "c3-cap"));
    for (const id of ["shine", "vines"] as const) {
      const entry = EFFECT_CATALOG[id];
      const state = { on: addonOn(d(), id) };
      const binding = f.addBinding(state, "on", { label: entry.label });
      binding.element.title = entry.description;
      host.add(f, note(entry.description));
      const params = buildParamControls(
        f,
        entry.params as readonly EffectParamSpec[],
        (k) => addonValue(d(), id, k),
        (k, v) => setAddonValue(d(), id, k, v),
        opts,
      );
      binding.on("change", (e) => {
        if (host.syncing()) return;
        setAddon(d(), id, e.value);
        host.changed(e.value ? `add ${entry.label.toLowerCase()}` : `remove ${entry.label.toLowerCase()}`);
        this.refresh();
      });
      this.addons.set(id, { state, binding, params });
    }

    this.refresh();
  }

  /** Re-read the design (after undo, presets, loads, or a material change). */
  refresh(): void {
    const d = this.host.design;
    for (const [id, a] of this.addons) {
      a.state.on = addonOn(d, id);
      a.binding.refresh();
      a.params.setHidden(!a.state.on);
    }
    const active = [...this.addons.keys()].filter((id) => addonOn(d, id)).map((id) => EFFECT_CATALOG[id].label);
    this.f.title = active.length ? `Effects · ${active.join(", ")}` : "Effects";
  }
}
