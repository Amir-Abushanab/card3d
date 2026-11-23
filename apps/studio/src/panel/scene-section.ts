/**
 * "Scene" panel section: product-shot staging (`design.scene`): an HDRI environment (lazy-loaded when
 * picked), its brightness and turn, a backdrop (sweep, gradient, the blurred environment) and a
 * reflective floor with a contact shadow. Every control removes its field again at the default, so a
 * card without a scene stays exactly the studio's.
 */
import type { FolderApi } from "tweakpane";
import { getLightingPreset, lightingBackdropCss, type CardFloor, type CardScene, type SceneBackdrop } from "@card3d/core/model";
import { SCENE_DEFAULTS, SCENE_ENVIRONMENTS, SCENE_RANGES } from "@card3d/core/editor";
import type { BindingApi } from "./params.ts";
import { chipGrid, note, segmented, type MountedBlock } from "./blocks.ts";
import type { SectionHost } from "./effects-section.ts";

const BACKDROPS: readonly { value: SceneBackdrop; label: string; title: string }[] = [
  { value: "none", label: "None", title: "Transparent: the page (or the export background) shows behind the card" },
  { value: "sweep", label: "Sweep", title: "A seamless cyclorama: the floor curves up into a wall, under a soft pool of light" },
  { value: "gradient", label: "Gradient", title: "A radial gradient in the backdrop colour" },
  { value: "environment", label: "Environment", title: "The HDRI itself, blurred like a shallow depth of field" },
];

export class SceneSection {
  private readonly bindings: { binding: BindingApi; read(): void }[] = [];
  private readonly colorBlades: { hidden: boolean }[] = [];
  private readonly blurBlades: { hidden: boolean }[] = [];
  private readonly floorBlades: { hidden: boolean }[] = [];
  private readonly envNote: MountedBlock;
  private readonly alphaNote: MountedBlock;
  private readonly proxy = {
    intensity: 1,
    rotation: 0,
    color: "#3a3d4d",
    blur: SCENE_DEFAULTS.backdropBlur as number,
    floor: false,
    reflectivity: SCENE_DEFAULTS.floor.reflectivity as number,
    shadow: SCENE_DEFAULTS.floor.shadow as number,
    floorBlur: SCENE_DEFAULTS.floor.blur as number,
  };
  private refreshing = false;

  constructor(
    f: FolderApi,
    private readonly host: SectionHost,
  ) {
    const d = () => host.design;
    const scene = () => d().scene ?? {};
    host.add(
      f,
      note("Stage the card for product shots: an HDRI environment, a backdrop and a reflective floor. Shared links, embeds and exports carry the scene."),
    );

    // ── environment ──
    host.add(f, note("Environment", "c3-cap"));
    host.add(
      f,
      chipGrid(
        [
          {
            value: "studio",
            label: "Studio",
            title: "The built-in light rig every card is tuned in (follows the lighting preset)",
            swatch: lightingBackdropCss(d().lighting),
          },
          ...SCENE_ENVIRONMENTS.map((e) => ({ value: e.id, label: e.label, title: `${e.description} (${e.source.title}, CC0, Poly Haven)`, swatch: e.swatch })),
        ],
        () => scene().environment ?? "studio",
        (v) => this.set({ environment: v === "studio" ? undefined : v }, `environment ${v}`),
        { columns: 3, className: "c3-chips--env", label: "Environment" },
      ),
    );
    this.slider(
      f,
      "intensity",
      "Brightness",
      SCENE_RANGES.environmentIntensity,
      0.05,
      (v) => this.set({ environmentIntensity: v === 1 ? undefined : v }),
      () => scene().environmentIntensity ?? 1,
      (v) => `${v.toFixed(2)}×`,
    );
    this.slider(
      f,
      "rotation",
      "Turn",
      SCENE_RANGES.environmentRotation,
      1,
      (v) => this.set({ environmentRotation: v ? v : undefined }),
      () => scene().environmentRotation ?? 0,
      (v) => `${Math.round(v)}°`,
    );
    this.envNote = host.add(f, note("The environment backdrop needs an HDRI; with Studio it shows the gradient.", "c3-hint c3-hint--warn"));

    // ── backdrop ──
    host.add(f, note("Backdrop", "c3-cap"));
    host.add(
      f,
      segmented<SceneBackdrop>(
        "",
        BACKDROPS,
        () => scene().backdrop ?? "none",
        (v) => this.set({ backdrop: v === "none" ? undefined : v }, `backdrop ${v}`),
      ),
    );
    const color = f.addBinding(this.proxy, "color", { label: "Colour", view: "color" });
    color.on("change", (e) => {
      if (host.syncing() || this.refreshing) return;
      this.set({ backdropColor: String(e.value).toLowerCase() });
    });
    this.colorBlades.push(color);
    this.bindings.push({ binding: color, read: () => (this.proxy.color = scene().backdropColor ?? getLightingPreset(d().lighting).backdrop.inner) });
    this.blurBlades.push(
      this.slider(
        f,
        "blur",
        "Blur",
        SCENE_RANGES.backdropBlur,
        0.01,
        (v) => this.set({ backdropBlur: v }),
        () => scene().backdropBlur ?? SCENE_DEFAULTS.backdropBlur,
        (v) => (v < 0.005 ? "Sharp" : `${Math.round(v * 100)}%`),
      ),
    );

    // ── floor ──
    host.add(f, note("Floor", "c3-cap"));
    const floor = f.addBinding(this.proxy, "floor", { label: "Reflective floor" });
    floor.element.title = "A glossy floor under the card: its reflection and a soft contact shadow, both fading out";
    floor.on("change", (e) => {
      if (host.syncing() || this.refreshing) return;
      this.set({ floor: e.value ? (scene().floor ?? {}) : undefined }, e.value ? "floor on" : "floor off");
    });
    this.bindings.push({ binding: floor, read: () => (this.proxy.floor = !!scene().floor) });
    const floorSlider = (key: "reflectivity" | "shadow" | "floorBlur", label: string, field: keyof CardFloor) =>
      this.floorBlades.push(
        this.slider(
          f,
          key,
          label,
          [0, 1],
          0.01,
          (v) => this.setFloor({ [field]: v }),
          () => scene().floor?.[field] ?? SCENE_DEFAULTS.floor[field],
          (v) => `${Math.round(v * 100)}%`,
        ),
      );
    floorSlider("reflectivity", "Reflection", "reflectivity");
    floorSlider("shadow", "Shadow", "shadow");
    floorSlider("floorBlur", "Gloss blur", "blur");
    this.alphaNote = host.add(
      f,
      note("Backdrops are opaque. For a transparent PNG choose Backdrop: None — the floor's reflection and shadow keep their transparency.", "c3-hint"),
    );
    this.refresh();
  }

  private slider(
    f: FolderApi,
    key: keyof SceneSection["proxy"],
    label: string,
    range: readonly [number, number],
    step: number,
    set: (v: number) => void,
    get: () => number,
    format: (v: number) => string,
  ): BindingApi {
    const b = f.addBinding(this.proxy, key, { label, min: range[0], max: range[1], step, format });
    b.on("change", (e) => {
      if (this.host.syncing() || this.refreshing) return;
      set(Math.round(Number(e.value) * 1000) / 1000);
    });
    this.bindings.push({ binding: b, read: () => ((this.proxy as Record<string, unknown>)[key] = get()) });
    return b;
  }

  private set(patch: Partial<CardScene>, label?: string): void {
    const d = this.host.design;
    const next: CardScene = { ...d.scene };
    for (const [k, v] of Object.entries(patch) as [keyof CardScene, unknown][]) {
      if (v === undefined) delete next[k];
      else (next as Record<string, unknown>)[k] = v;
    }
    if (next.backdropBlur === SCENE_DEFAULTS.backdropBlur) delete next.backdropBlur;
    if (Object.keys(next).length) d.scene = next;
    else delete d.scene;
    this.refresh();
    this.host.changed(label);
  }

  private setFloor(patch: Partial<CardFloor>): void {
    const floor: CardFloor = { ...this.host.design.scene?.floor, ...patch };
    for (const k of Object.keys(floor) as (keyof CardFloor)[]) if (floor[k] === SCENE_DEFAULTS.floor[k]) delete floor[k];
    this.set({ floor });
  }

  refresh(): void {
    const s = this.host.design.scene ?? {};
    const backdrop = s.backdrop ?? "none";
    for (const b of this.colorBlades) b.hidden = backdrop !== "sweep" && backdrop !== "gradient";
    for (const b of this.blurBlades) b.hidden = backdrop !== "environment" || !s.environment;
    for (const b of this.floorBlades) b.hidden = !s.floor;
    this.envNote.blade.hidden = !(backdrop === "environment" && !s.environment);
    this.alphaNote.blade.hidden = backdrop === "none";
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
