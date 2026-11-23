/**
 * The studio panel. Tweakpane provides the frame (folders, sliders, lists, buttons — the wave3d
 * studio's look and keyboard behaviour); the visual pickers (materials list, texture and
 * foil chips, colour grid, preset tiles, sticker library, artwork slots, drafts) are custom blocks
 * mounted inside its folders (blocks.ts), because Tweakpane has no views for them.
 *
 * The panel edits the live `CardDesign` in place and reports every change through `hooks.onChange`;
 * main.ts owns rebuilding the card and the undo history.
 */
import { Pane, type FolderApi } from "tweakpane";
import principleStashMarkUrl from "../assets/principle-stash.svg?inline";
import {
  CARD_PRESET_CATEGORIES,
  FOIL_COVERAGE_OPTIONS,
  FOIL_SCALE_RANGE,
  FOIL_TEXTURE_OPTIONS,
  RECIPE_MATERIALS,
  HOLO_STYLE_OPTIONS,
  PATTERN_OPTIONS,
  PERCENT_RANGE,
  TEXTURE_OPTIONS,
  CARD_FONTS,
  DEFAULT_CARD_FONT,
  isMissingUpload,
  loadCustomFont,
  loadedCustomFontFamily,
  LIGHTING_PRESETS,
  LOGO_SCALE_RANGE,
  lightingBackdropCss,
  type CardDesign,
  type CardFinishes,
  type CustomFontSource,
  type CardPreset,
  type LightingPresetId,
  type MarkFinish,
  type LogoPosition,
  type CardPresetCategory,
  type Quality,
  type Recipe,
  type Side,
} from "@card3d/core/model";
import type { ShaderError } from "@card3d/core/editor";
import { CAMERA_PATHS, CAMERA_EASINGS, getCameraPath, type CameraEasing, type CameraPathId } from "@card3d/core/engine";
import { EffectsSection, type SectionHost } from "./effects-section.ts";
import { AdvancedSection } from "./advanced-section.ts";
import { ShadersSection } from "./shaders-section.ts";
import { BodySection, FINISH_CHOICES } from "./body-section.ts";
import { TextLinesSection } from "./text-section.ts";
import { SceneSection } from "./scene-section.ts";
import { StickerSection, type StickerTools } from "./sticker-section.ts";
import type { Draft, LibrarySticker } from "../state/storage.ts";
import { COLOR_GRID } from "../state/randomize.ts";
import { SIZE_PRESETS, canRecord, type ClipFormat, type ImageFormat } from "../export/exporters.ts";
import type { ArtworkFit } from "../stickers/library.ts";
import { canEncodeWebp, h, modKey } from "../ui/dom.ts";
import { flash } from "../ui/dialog.ts";
import { HOLO_SWATCH, TEXTURE_SWATCH, buttonRow, chipGrid, colorGrid, mount, note, segmented, textArea, type Block, type MountedBlock } from "./blocks.ts";

/** The stage's page backdrop: the lighting preset's ("scene"), or a checkerboard (to judge transparency). */
export type Backdrop = "scene" | "checker";
type ExportBackground = "transparent" | "scene" | "color";

export interface StudioUi {
  quality: Quality;
  backdrop: Backdrop;
  spin: boolean;
  presetCategory: CardPresetCategory;
  activePreset: string | null;
  artworkFit: ArtworkFit;
  sizePreset: string;
  width: number;
  height: number;
  transparent: boolean;
  /** Export background: transparent, the lighting preset's backdrop, or `background`. */
  exportBackground: ExportBackground;
  background: string;
  imageFormat: ImageFormat;
  imageQuality: number;
  clipFormat: ClipFormat;
  clipSeconds: number;
  /** Camera path of video / GIF exports (and the preview), and its easing ("auto": the path's own). */
  clipPath: CameraPathId;
  clipEasing: CameraEasing | "auto";
  selectedSticker: string | null;
  assets: "reference" | "public";
  /** Randomize also rolls effects, add-ons and shader layers (opt-in). */
  randomizeFx: boolean;
}

interface PanelHooks {
  /** The design was edited in place. `label` set → a discrete action (commit now). */
  onChange(label?: string): void;
  onPreset(p: CardPreset): void;
  /** The preset category tab changed (thumbnails for it are then rendered first). */
  onPresetCategory?(category: CardPresetCategory): void;
  onRandomize(): void;
  onResetDesign(): void;
  onQuality(q: Quality): void;
  onBackdrop(b: Backdrop): void;
  onSpin(on: boolean): void;
  onFlip(): void;
  onResetView(): void;
  onAssets(a: "reference" | "public"): void;
  onLogoUpload(): void;
  onLogoRemove(): void;
  /** "Custom…" font: open the custom font dialog (on a tab, else the current font's source). */
  onFontCustom(tab?: CustomFontSource): void;
  /** Lighting preset picked (design.lighting already set). */
  onLighting(id: LightingPresetId): void;
  onArtworkUpload(side: Side): void;
  onArtworkRemove(side: Side): void;
  onDraw(side: Side): void;
  onStickerAdd(s: LibrarySticker): void;
  onStickerUpload(): void;
  onLibraryRemove(id: string): void;
  onStickerSelect(id: string | null): void;
  onStickerRemove(id: string): void;
  onStickersClear(): void;
  onExportImage(): Promise<void>;
  onExportClip(): Promise<void>;
  /** Play (or stop) the camera path on the live card. */
  onPreviewPath(): void;
  /** View in AR: Quick Look on iOS, Scene Viewer on Android, downloads and an explanation elsewhere. */
  onViewAr(): void;
  /** Export → Print files…: the production package for a card maker. */
  onExportPrint(): void;
  onExportCode(): void;
  onExportEmbed(): void;
  onExportGltf(): Promise<void>;
  onExportSpec(): void;
  onSaveJson(): void;
  onLoadJson(): void;
  onShare(): Promise<string>;
  onImportRecipe(): void;
  onDraftSave(): Promise<void>;
  onDraftLoad(id: string): void;
  onDraftDelete(id: string): void;
}

export interface PanelDeps {
  presets: readonly CardPreset[];
  /** Extra blocks at the end of Presets (dev: from the local plugin, src/local-plugin.ts). */
  presetsExtra?: Block[];
  hasReference: boolean;
  /** "Describe a finish…" (feature-flagged, src/describe/flag.ts): absent = no button. */
  describeFinish?: () => void;
  library(): LibrarySticker[];
  drafts(): Draft[];
  thumbs: Map<string, string>;
  resolveUrl(src: string): string;
  folds: Record<string, boolean>;
  onFold(title: string, expanded: boolean): void;
  hooks: PanelHooks;
  /** The selected sticker's picture tools (the on-card editor). */
  sticker: Omit<StickerTools, "resolveUrl">;
  shaders: {
    onAdd(): void;
    onEdit(index: number): void;
    errors(): { index: number; side: Side; errors: ShaderError[] }[];
    editing(): number | null;
  };
}

const SIDES: Side[] = ["front", "back"];
const sideLabel = (s: Side) => (s === "front" ? "Front" : "Back");

export class Panel {
  readonly pane: Pane;
  private readonly blocks: Block[] = [];
  private syncing = false;
  private presetGrid!: HTMLDivElement;
  private presetTabs!: Block;
  private libraryEl!: HTMLDivElement;
  private placedEl!: HTMLDivElement;
  private draftsEl!: HTMLDivElement;
  private holoFrontBlades: { hidden: boolean }[] = [];
  private holoBackBlades: { hidden: boolean }[] = [];
  private backFolder!: FolderApi;
  private artworkSlots = new Map<
    Side,
    { thumb: HTMLButtonElement; img: HTMLImageElement; remove: HTMLButtonElement; draw: HTMLButtonElement; info: HTMLElement }
  >();
  private customSize: { hidden: boolean }[] = [];
  private imageQualityBlade?: { hidden: boolean };
  private bgBlade?: { hidden: boolean };
  private effects?: EffectsSection;
  private shaders?: ShadersSection;
  private advanced?: AdvancedSection;
  private body?: BodySection;
  private textLines?: TextLinesSection;
  private scene?: SceneSection;
  private sticker?: StickerSection;
  private previewBtn?: { title: string; element: HTMLElement };

  constructor(
    container: HTMLElement,
    private readonly design: CardDesign,
    private readonly ui: StudioUi,
    private readonly deps: PanelDeps,
  ) {
    this.pane = new Pane({ container, title: "Card Studio" });
    this.decorateTitle(container);
    this.buildPresets();
    this.buildMaterial();
    this.buildHolo();
    const host: SectionHost = {
      design: this.design,
      syncing: () => this.syncing,
      changed: (label) => this.changed(label),
      add: (folder, block) => this.add(folder, block),
    };
    this.effects = new EffectsSection(this.folder("Effects", false), host);
    this.shaders = new ShadersSection(this.folder("Shaders", false), { ...host, ...this.deps.shaders });
    this.advanced = new AdvancedSection(this.folder("Advanced material", false), host);
    this.buildIdentity();
    this.textLines = new TextLinesSection(this.folder("Text lines", false), host);
    this.body = new BodySection(this.folder("Card body", false), host);
    this.buildArtwork();
    this.buildStickers();
    this.sticker = new StickerSection(this.folder("Sticker", true), host, { ...this.deps.sticker, resolveUrl: (src) => this.deps.resolveUrl(src) });
    this.buildStage();
    this.scene = new SceneSection(this.folder("Scene", false), host);
    this.buildExport();
    this.buildSave();
    // Studio credit, as in wave3d: like the nav on principlestash.com the mark IS the "P" of the name
    // (alt="P"), so the text beside it must not repeat the letter.
    const mark = h("img", { src: principleStashMarkUrl, alt: "P", width: 11, height: 15 });
    const credit = h(
      "p.c3-credit",
      {},
      h("a.c3-credit-ps", { href: "https://principlestash.com/", target: "_blank", rel: "noopener noreferrer" }, "A ", mark, "rinciple\u00A0Stash project"),
      " · ",
      h("a", { href: "https://github.com/Amir-Abushanab/card3d", target: "_blank", rel: "noopener noreferrer", text: "Source" }),
    );
    container.querySelector(".tp-rotv_c")?.append(credit);
    this.refresh();
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /** Re-read everything from the design/ui (after undo, presets, loads). */
  refresh(): void {
    this.syncing = true;
    try {
      this.pane.refresh();
      for (const b of this.blocks) b.refresh();
      this.refreshHoloVisibility();
      this.refreshArtwork();
      this.refreshPlaced();
      this.refreshPresetActive();
      this.effects?.refresh();
      this.shaders?.refresh();
      this.advanced?.refresh();
      this.body?.refresh();
      this.textLines?.refresh();
      this.scene?.refresh();
      this.sticker?.refresh();
    } finally {
      this.syncing = false;
    }
  }

  /** The selected sticker or its values changed (selection, a gesture on the card, crop mode). */
  refreshSticker(): void {
    this.sticker?.refreshQuietly();
  }

  /** The camera-path preview started or stopped (the button's label follows). */
  setPreviewing(on: boolean): void {
    if (this.previewBtn) this.previewBtn.title = on ? "■ Stop preview" : "▶ Preview path";
  }

  /** Shader layers changed outside the panel (picker, code editor). */
  refreshShaders(select?: number): void {
    this.syncing = true;
    try {
      if (select !== undefined) this.shaders?.select(select);
      else this.shaders?.refresh();
    } finally {
      this.syncing = false;
    }
  }

  /** The card's skipped-layer errors changed. */
  refreshShaderErrors(): void {
    this.shaders?.refreshErrors();
  }

  setThumb(id: string, url: string): void {
    const img = this.presetGrid?.querySelector<HTMLImageElement>(`[data-preset="${id}"] img`);
    if (img) {
      img.src = url;
      img.closest(".c3-tile")?.classList.add("has-thumb");
    }
  }

  refreshLibrary(): void {
    const items = this.deps.library();
    const tiles = items.map((s) => {
      const img = h("img", { src: this.deps.resolveUrl(s.src), alt: "", draggable: "false", loading: "lazy" });
      const tile = h("button.c3-lib", { type: "button", title: `Add “${s.name}” to the visible side` }, img);
      tile.addEventListener("click", () => this.deps.hooks.onStickerAdd(s));
      if (!s.builtin) {
        const x = h("span.c3-lib-x", { role: "button", "aria-label": `Remove ${s.name} from the library`, title: "Remove from library", text: "×" });
        x.addEventListener("click", (e) => {
          e.stopPropagation();
          this.deps.hooks.onLibraryRemove(s.id);
        });
        tile.append(x);
      }
      return tile;
    });
    const upload = h(
      "button.c3-lib c3-lib--add",
      { type: "button", title: "Upload stickers (PNG, WebP, JPEG, GIF, SVG)" },
      h("span", { text: "＋" }),
      h("small", { text: "Upload" }),
    );
    upload.addEventListener("click", () => this.deps.hooks.onStickerUpload());
    this.libraryEl.replaceChildren(...tiles, upload);
  }

  refreshPlaced(): void {
    this.sticker?.refreshQuietly();
    if (!this.placedEl) return;
    const decals = this.design.decals;
    if (!decals.length) {
      this.placedEl.replaceChildren(h("p.c3-empty", { text: "No stickers yet. Pick one from the library above." }));
      return;
    }
    const rows = decals.map((d, i) => {
      const on = d.id === this.ui.selectedSticker;
      const row = h(
        "div.c3-placed",
        { role: "button", tabindex: 0, "aria-pressed": String(on), title: "Select (then drag it on the card)" },
        h("img", { src: this.deps.resolveUrl(d.src), alt: "", draggable: "false" }),
        h("span.c3-placed-name", { text: `Sticker ${i + 1}` }),
        h("span.c3-placed-meta", { text: `${sideLabel(d.side)} · ${Math.round(d.rotation)}° · ×${(d.scale ?? 1).toFixed(2)}` }),
      );
      if (on) row.classList.add("is-on");
      const x = h("button.c3-icon-btn", { type: "button", title: "Remove sticker", "aria-label": `Remove sticker ${i + 1}`, text: "×" });
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        this.deps.hooks.onStickerRemove(d.id);
      });
      row.append(x);
      const select = () => this.deps.hooks.onStickerSelect(on ? null : d.id);
      row.addEventListener("click", select);
      row.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), select()));
      return row;
    });
    const clear = h("button.c3-mini c3-mini--danger", { type: "button", text: "Remove all stickers" });
    clear.addEventListener("click", () => this.deps.hooks.onStickersClear());
    this.placedEl.replaceChildren(...rows, clear);
  }

  refreshDrafts(): void {
    const drafts = this.deps.drafts();
    if (!drafts.length) {
      this.draftsEl.replaceChildren(h("p.c3-empty", { text: "Drafts are saved in this browser." }));
      return;
    }
    const fmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    this.draftsEl.replaceChildren(
      ...drafts.map((d) => {
        const open = h(
          "button.c3-draft",
          { type: "button", title: `Open “${d.name}”` },
          d.thumb ? h("img", { src: d.thumb, alt: "" }) : h("span.c3-draft-ph"),
          h("span.c3-draft-text", {}, h("span.c3-draft-name", { text: d.name }), h("small", { text: fmt.format(d.savedAt) })),
        );
        open.addEventListener("click", () => this.deps.hooks.onDraftLoad(d.id));
        const del = h("button.c3-icon-btn", { type: "button", title: "Delete draft", "aria-label": `Delete ${d.name}`, text: "×" });
        del.addEventListener("click", () => this.deps.hooks.onDraftDelete(d.id));
        return h("div.c3-draft-row", {}, open, del);
      }),
    );
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private folder(title: string, expanded: boolean, parent: FolderApi | Pane = this.pane): FolderApi {
    const f = parent.addFolder({ title, expanded: this.deps.folds[title] ?? expanded });
    if (parent === this.pane) f.element.classList.add("c3-section");
    f.on("fold", (e) => this.deps.onFold(title, e.expanded));
    return f;
  }

  private add(folder: FolderApi, block: Block): MountedBlock {
    const m = mount(folder, block);
    this.blocks.push(m);
    return m;
  }

  /** Edit notification from a Tweakpane binding (skipped while refreshing from the model). */
  private changed = (label?: string) => {
    if (!this.syncing) {
      this.ui.activePreset = null;
      this.refreshPresetActive();
      this.deps.hooks.onChange(label);
      // Sections that read the recipe (glass state, greyed recipe values) follow every edit.
      this.syncing = true;
      try {
        this.effects?.refresh();
        this.advanced?.refresh();
        this.body?.refresh();
        this.scene?.refresh();
      } finally {
        this.syncing = false;
      }
    }
  };

  private get recipe(): Recipe {
    return this.design.recipe;
  }

  private setRecipe<K extends keyof Recipe>(k: K, v: Recipe[K], label: string): void {
    if (this.recipe[k] === v) return;
    this.recipe[k] = v;
    this.changed(label);
    this.refreshHoloVisibility();
  }

  private decorateTitle(container: HTMLElement): void {
    const bar = container.querySelector<HTMLElement>(".tp-rotv_b");
    const text = bar?.querySelector<HTMLElement>(".tp-rotv_t");
    if (!bar || !text) return;
    bar.classList.add("c3-titlebar");
    const logo = h("span.c3-logo", { "aria-hidden": "true" });
    bar.insertBefore(logo, text);
  }

  // ── sections ──────────────────────────────────────────────────────────────

  private buildPresets(): void {
    const f = this.folder("Presets", true);
    this.add(
      f,
      buttonRow([
        {
          label: "🎲 Randomize",
          title: "A new finish. Keeps name, artwork, stickers, effects and shader layers (tick “Roll effects” to roll those too)",
          onClick: () => this.deps.hooks.onRandomize(),
          className: "c3-mini--accent",
        },
        {
          label: "↺ Reset",
          title: "Back to the studio default card (clears the finish, effects, shaders, artwork and stickers)",
          onClick: () => this.deps.hooks.onResetDesign(),
        },
        ...(this.deps.describeFinish
          ? [
              {
                label: "✎ Describe…",
                title: "Describe a finish in words and let a model design it",
                onClick: () => this.deps.describeFinish?.(),
                className: "c3-mini--describe",
              },
            ]
          : []),
      ]),
    );
    f.addBinding(this.ui, "randomizeFx", { label: "Roll effects" }).element.title =
      "Randomize also replaces effects, add-ons and shader layers (off: it only re-rolls the finish and keeps them)";
    const cats = CARD_PRESET_CATEGORIES.map((c) => ({ value: c.id, label: c.label }));
    this.presetTabs = chipGrid(
      cats,
      () => this.ui.presetCategory,
      (v) => {
        this.ui.presetCategory = v;
        this.renderPresetGrid();
        this.deps.hooks.onPresetCategory?.(v);
      },
      { columns: 4, className: "c3-tabs-chips", label: "Preset category" },
    );
    this.add(f, this.presetTabs);
    this.presetGrid = h("div.c3-tiles");
    this.add(f, { el: this.presetGrid, refresh: () => {} });
    this.renderPresetGrid();
    this.add(f, note("A preset sets the finish and clears add-ons and shader layers (Effects presets bring their own). Name, artwork and stickers stay."));

    for (const block of this.deps.presetsExtra ?? []) this.add(f, block);
  }

  private renderPresetGrid(): void {
    const list = this.deps.presets.filter((p) => p.category === this.ui.presetCategory);
    const tiles = list.map((p) => {
      const mat = RECIPE_MATERIALS.find((m) => m.id === (p.recipe.material ?? "silver"))!;
      const color = p.recipe.color ?? "#d9d6cc";
      const thumb = this.deps.thumbs.get(p.id);
      const img = h("img", { alt: "", draggable: "false" });
      if (thumb) img.src = thumb;
      const ph = h("span.c3-tile-ph", { "aria-hidden": "true" });
      ph.style.background =
        mat.id === "silver"
          ? `linear-gradient(135deg, rgba(0,0,0,.32), rgba(255,255,255,.45) 48%, rgba(0,0,0,.22)), ${color}`
          : `linear-gradient(135deg, ${mat.swatch.deep}, ${mat.swatch.mid} 40%, ${mat.swatch.light} 55%, ${mat.swatch.mid})`;
      const tile = h("button.c3-tile", { type: "button", "data-preset": p.id, title: p.name }, ph, img, h("span.c3-tile-name", { text: p.name }));
      if (thumb) tile.classList.add("has-thumb");
      tile.addEventListener("click", () => this.deps.hooks.onPreset(p));
      return tile;
    });
    this.presetGrid.replaceChildren(...tiles);
    this.presetTabs.refresh();
    this.refreshPresetActive();
  }

  private refreshPresetActive(): void {
    for (const t of this.presetGrid?.querySelectorAll<HTMLElement>(".c3-tile") ?? []) {
      t.classList.toggle("is-on", t.dataset.preset === this.ui.activePreset);
    }
  }

  private buildMaterial(): void {
    const f = this.folder("Material", true);
    // Materials list (names, notes and 2D swatches).
    const list = h("div.c3-materials", { role: "radiogroup", "aria-label": "Material" });
    const rows = RECIPE_MATERIALS.map((m) => {
      const sw = h("span.c3-mat-sw", { "aria-hidden": "true" });
      sw.style.background = `linear-gradient(115deg, ${m.swatch.deep} 0%, ${m.swatch.mid} 38%, ${m.swatch.light} 58%, ${m.swatch.flare} 66%, ${m.swatch.mid} 100%)`;
      const b = h(
        "button.c3-mat",
        { type: "button", role: "radio", "data-value": m.id, title: m.note },
        sw,
        h("span.c3-mat-text", {}, h("span.c3-mat-name", { text: m.name }), h("small", { text: m.note })),
      );
      b.addEventListener("click", () => {
        this.setRecipe("material", m.id, "material");
        refreshList();
      });
      list.append(b);
      return b;
    });
    const refreshList = () => {
      for (const b of rows) {
        const on = b.dataset.value === this.recipe.material;
        b.classList.toggle("is-on", on);
        b.setAttribute("aria-checked", String(on));
      }
    };
    this.add(f, { el: list, refresh: refreshList });

    this.add(f, note("Texture", "c3-cap"));
    this.add(
      f,
      chipGrid(
        TEXTURE_OPTIONS.map((o) => ({ ...o, swatch: TEXTURE_SWATCH[o.value] })),
        () => this.recipe.texture,
        (v) => this.setRecipe("texture", v, "texture"),
        { columns: 3, label: "Texture" },
      ),
    );
    this.add(
      f,
      segmented(
        "Pattern",
        PATTERN_OPTIONS,
        () => this.recipe.pattern,
        (v) => this.setRecipe("pattern", v, "pattern"),
      ),
    );

    this.add(f, note("Colour", "c3-cap"));
    const grid = colorGrid(
      COLOR_GRID,
      () => this.recipe.color,
      (c) => {
        this.setRecipe("color", c, "colour");
        this.pane.refresh();
      },
    );
    this.add(f, grid);
    f.addBinding(this.recipe, "color", { label: "Custom", view: "color" }).on("change", () => {
      grid.refresh();
      this.changed();
    });

    const range = (key: keyof Recipe, label: string) =>
      f.addBinding(this.recipe, key, { label, ...PERCENT_RANGE, format: (v: number) => v.toFixed(0) }).on("change", () => this.changed());
    range("grain", "Grain");
    range("polish", "Polish");
    range("relief", "Relief");
    range("spectrum", "Spectrum");
  }

  private buildHolo(): void {
    const f = this.folder("Holo foil", false);
    const front = this.holoControls(f, "front");
    this.holoFrontBlades = front;
    f.addBinding(this.recipe, "matchHoloSides", { label: "Match sides" }).on("change", () => {
      this.changed();
      this.refreshHoloVisibility();
    });
    this.backFolder = f.addFolder({ title: "Back foil", expanded: true });
    this.holoBackBlades = this.holoControls(this.backFolder, "back");
  }

  /** The foil editor for one side; returns the blades shown only while that side's foil is on. */
  private holoControls(f: FolderApi, side: Side): { hidden: boolean }[] {
    const k =
      side === "front"
        ? ({
            on: "frontHolo",
            style: "holoStyle",
            tex: "foilTexture",
            int: "foilIntensity",
            glare: "holoGlare",
            motion: "holoMotion",
            scale: "foilScale",
            cov: "foilCoverage",
          } as const)
        : ({
            on: "backHolo",
            style: "backHoloStyle",
            tex: "backFoilTexture",
            int: "backFoilIntensity",
            glare: "backHoloGlare",
            motion: "backHoloMotion",
            scale: "backFoilScale",
            cov: "backFoilCoverage",
          } as const);
    f.addBinding(this.recipe, k.on, { label: side === "front" ? "Foil on" : "Back foil on" }).on("change", () => {
      this.changed();
      this.refreshHoloVisibility();
    });
    const blades: { hidden: boolean }[] = [];
    blades.push(this.add(f, note("Style", "c3-cap")).blade);
    blades.push(
      this.add(
        f,
        chipGrid(
          HOLO_STYLE_OPTIONS.map((o) => ({ ...o, swatch: HOLO_SWATCH[o.value] })),
          () => this.recipe[k.style],
          (v) => this.setRecipe(k.style, v, side === "front" ? "foil style" : "back foil style"),
          { columns: 3, className: "c3-chips--holo", label: `${sideLabel(side)} foil style` },
        ),
      ).blade,
    );
    blades.push(
      this.add(
        f,
        segmented(
          "Foil",
          FOIL_TEXTURE_OPTIONS,
          () => this.recipe[k.tex],
          (v) => this.setRecipe(k.tex, v, "foil texture"),
        ),
      ).blade,
    );
    blades.push(
      this.add(
        f,
        segmented(
          "Coverage",
          FOIL_COVERAGE_OPTIONS,
          () => this.recipe[k.cov],
          (v) => this.setRecipe(k.cov, v, "foil coverage"),
        ),
      ).blade,
    );
    for (const [key, label, range] of [
      [k.int, "Intensity", PERCENT_RANGE],
      [k.glare, "Glare", PERCENT_RANGE],
      [k.scale, "Scale %", FOIL_SCALE_RANGE],
    ] as const) {
      blades.push(f.addBinding(this.recipe, key, { label, ...range, format: (v: number) => v.toFixed(0) }).on("change", () => this.changed()));
    }
    blades.push(f.addBinding(this.recipe, k.motion, { label: "Responds to tilt" }).on("change", () => this.changed()));
    return blades;
  }

  private refreshHoloVisibility(): void {
    const r = this.recipe;
    for (const b of this.holoFrontBlades) b.hidden = !r.frontHolo;
    if (this.backFolder) this.backFolder.hidden = r.matchHoloSides;
    for (const b of this.holoBackBlades) b.hidden = !r.backHolo;
  }

  private buildIdentity(): void {
    const f = this.folder("Identity", true);
    f.addBinding(this.design, "cardholderName", { label: "Name" }).on("change", () => this.changed());
    this.add(
      f,
      textArea(
        "Bio",
        () => this.design.cardholderBio,
        (v) => {
          this.design.cardholderBio = v;
          this.changed();
        },
        "A line or two (Enter for a new line)",
      ),
    );

    // Font: the self-hosted open fonts, each chip set in its own face.
    this.add(f, note("Font", "c3-cap"));
    const fonts = h("div.c3-fonts", { role: "radiogroup", "aria-label": "Name font" });
    const fontButtons = CARD_FONTS.map((font) => {
      const sample = h("span.c3-font-sample", { text: "Ag" });
      sample.style.fontFamily = `"${font.family}", sans-serif`;
      const b = h(
        "button.c3-font",
        { type: "button", role: "radio", "data-value": font.id, title: `${font.label} (SIL Open Font License)` },
        sample,
        h("span.c3-font-name", { text: font.label }),
      );
      b.addEventListener("click", () => {
        if ((this.design.font ?? DEFAULT_CARD_FONT) === font.id) return;
        if (font.id === DEFAULT_CARD_FONT) delete this.design.font;
        else this.design.font = font.id;
        refreshFonts();
        this.changed(`font ${font.label}`);
      });
      fonts.append(b);
      return b;
    });
    // "Custom…": an uploaded file, a Google Fonts family or a web font URL (ui/font-dialog.ts).
    const customSample = h("span.c3-font-sample", { text: "Ag" });
    const customName = h("span.c3-font-name", { text: "Custom…" });
    const customButton = h(
      "button.c3-font-more",
      { type: "button", role: "radio", "data-value": "custom", title: "Upload a font, or use a Google Font or a web font URL" },
      customSample,
      customName,
    );
    customButton.addEventListener("click", () => this.deps.hooks.onFontCustom());
    fonts.append(customButton);
    // What the custom font is, and whether it loaded (the card falls back to Inter when it can't).
    const customText = h("span.c3-font-custom-text");
    const customAction = h("button.c3-mini", { type: "button" });
    const customInfo = h("div.c3-font-custom", {}, customText, customAction);
    let infoBlade: { hidden: boolean } | null = null;
    let customAct: () => void = () => {};
    customAction.addEventListener("click", () => customAct());
    let fontCheck = 0;
    const refreshFonts = () => {
      const font = this.design.font;
      const custom = font && typeof font === "object" ? font : null;
      const v = custom ? "custom" : (font ?? DEFAULT_CARD_FONT);
      for (const b of [...fontButtons, customButton]) {
        const on = b.dataset.value === v;
        b.classList.toggle("is-on", on);
        b.setAttribute("aria-checked", String(on));
      }
      customName.textContent = custom ? custom.family : "Custom…";
      customButton.title = custom ? `${custom.family}: change the custom font` : "Upload a font, or use a Google Font or a web font URL";
      if (infoBlade) infoBlade.hidden = !custom;
      customInfo.classList.remove("is-warn");
      const loaded = custom && loadedCustomFontFamily(custom);
      customSample.style.fontFamily = loaded ? `"${loaded}", sans-serif` : "";
      if (!custom) return;
      const source =
        custom.source === "google" ? `Google Fonts${custom.weight ? ` · ${custom.weight}` : ""}` : custom.source === "url" ? "Web font" : "Uploaded";
      const describe = (warn?: string) => {
        customText.textContent = warn ?? `${custom.family} · ${source}`;
        customInfo.classList.toggle("is-warn", !!warn);
      };
      if (isMissingUpload(custom)) {
        describe(`“${custom.family}” is an uploaded font whose file isn't in this design (links leave it out): showing Inter.`);
        customAction.textContent = "Add the font file…";
        customAct = () => this.deps.hooks.onFontCustom("upload");
        return;
      }
      describe();
      customAction.textContent = "Change…";
      customAct = () => this.deps.hooks.onFontCustom();
      const mine = ++fontCheck;
      void loadCustomFont(custom).then((r) => {
        if (mine !== fontCheck) return;
        if (r.ok) customSample.style.fontFamily = `"${r.family}", sans-serif`;
        else describe(`Couldn't load “${custom.family}” (${r.error}): showing Inter.`);
      });
    };
    this.add(f, { el: fonts, refresh: refreshFonts });
    infoBlade = this.add(f, { el: customInfo, refresh: () => {} }).blade;
    refreshFonts();

    // Logo: replaces the corner mark; embossed like it.
    this.add(f, note("Logo", "c3-cap"));
    const logoImg = h("img", { alt: "" });
    const logoThumb = h(
      "button.c3-logo-thumb",
      { type: "button", title: "Upload a logo (SVG, PNG, WebP, JPEG)" },
      logoImg,
      h("span.c3-art-empty", { text: "＋ Upload logo" }),
    );
    logoThumb.addEventListener("click", () => this.deps.hooks.onLogoUpload());
    const logoRemove = h("button.c3-mini c3-mini--danger", { type: "button", text: "Remove" });
    logoRemove.addEventListener("click", () => this.deps.hooks.onLogoRemove());
    const logoHint = h("small.c3-logo-hint");
    this.add(f, {
      el: h("div.c3-logo-row", {}, logoThumb, h("div.c3-logo-side", {}, logoHint, logoRemove)),
      refresh: () => {
        const logo = this.design.logo;
        if (logo?.path && logo.viewBox) {
          const [vw, vh] = logo.viewBox;
          const [ox, oy] = logo.origin ?? [0, 0];
          const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${ox} ${oy} ${vw} ${vh}"><path fill="#e8e8ee" fill-rule="${logo.fillRule ?? "nonzero"}" d="${logo.path.replace(/"/g, "")}"/></svg>`;
          logoImg.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
        } else if (logo?.src) logoImg.src = logo.src;
        else logoImg.removeAttribute("src");
        logoThumb.classList.toggle("has-art", !!logo);
        logoThumb.title = logo ? "Replace the logo" : "Upload a logo (SVG, PNG, WebP, JPEG)";
        logoHint.textContent = logo ? (logo.path ? "Vector path" : "Image mask") : "Replaces the corner mark";
        logoRemove.disabled = !logo;
        for (const b of logoBlades) b.hidden = !logo;
      },
    });
    const logoBlades: { hidden: boolean }[] = [];
    const position = segmented<LogoPosition>(
      "",
      [
        { value: "corner", label: "Corner", title: "Logo top left, where the mark sits" },
        { value: "top-right", label: "Top right", title: "Logo top right" },
        { value: "center", label: "Centre", title: "Logo in the middle of the face" },
        { value: "bottom-right", label: "Bottom right", title: "Logo bottom right" },
      ],
      () => this.design.logo?.position ?? "corner",
      (v) => {
        if (!this.design.logo) return;
        if (v === "corner") delete this.design.logo.position;
        else this.design.logo.position = v;
        this.changed("logo position");
      },
    );
    logoBlades.push(this.add(f, position).blade);
    const scaleProxy = { scale: 1 };
    const scaleBinding = f
      .addBinding(scaleProxy, "scale", {
        label: "Logo size",
        min: LOGO_SCALE_RANGE.min,
        max: LOGO_SCALE_RANGE.max,
        step: 0.05,
        format: (v: number) => `${Math.round(v * 100)}%`,
      })
      .on("change", (e) => {
        if (this.syncing || !this.design.logo) return;
        const v = Math.round(e.value * 100) / 100;
        if (v === 1) delete this.design.logo.scale;
        else this.design.logo.scale = v;
        this.changed();
      });
    logoBlades.push(scaleBinding);
    this.blocks.push({
      el: scaleBinding.element,
      refresh: () => {
        scaleProxy.scale = this.design.logo?.scale ?? 1;
        scaleBinding.refresh();
      },
    });

    // Finish: how each mark is worked into the metal (normal maps from the same masks).
    this.add(f, note("Finish", "c3-cap"));
    const finishRow = (key: keyof CardFinishes, label: string) =>
      this.add(
        f,
        segmented<MarkFinish>(
          label,
          FINISH_CHOICES,
          () => this.design.finish?.[key] ?? "default",
          (v) => {
            const next: CardFinishes = { ...this.design.finish };
            if (v === "default") delete next[key];
            else next[key] = v;
            if (Object.keys(next).length) this.design.finish = next;
            else delete this.design.finish;
            this.changed(`${label.toLowerCase()} ${v}`);
          },
        ),
      );
    finishRow("name", "Name");
    finishRow("bio", "Bio");
    finishRow("logo", "Logo");
  }

  private buildArtwork(): void {
    const f = this.folder("Artwork", false);
    this.add(f, note("Full-face artwork per side. Inlay is lit metallic ink that shares the metal's relief; Printed shows pixels as authored."));
    for (const side of SIDES) {
      const img = h("img", { alt: "" });
      const thumb = h("button.c3-art-thumb", { type: "button", title: `Upload ${side} artwork` }, img, h("span.c3-art-empty", { text: "＋ Upload" }));
      thumb.addEventListener("click", () => this.deps.hooks.onArtworkUpload(side));
      const draw = h("button.c3-mini", { type: "button", text: "✎ Draw" });
      draw.addEventListener("click", () => this.deps.hooks.onDraw(side));
      const remove = h("button.c3-mini c3-mini--danger", { type: "button", text: "Remove" });
      remove.addEventListener("click", () => this.deps.hooks.onArtworkRemove(side));
      const treatment = segmented(
        "",
        [
          { value: "inlay", label: "Inlay" },
          { value: "printed", label: "Printed" },
        ] as const,
        () => this.design.surfaceTreatments[side] ?? "inlay",
        (v) => {
          this.design.surfaceTreatments[side] = v;
          this.changed(`${side} finish`);
        },
      );
      this.blocks.push(treatment);
      const info = h("div.c3-art-side", {}, h("strong", { text: sideLabel(side) }), treatment.el, h("div.c3-btnrow", {}, draw, remove));
      const el = h("div.c3-art", {}, thumb, info);
      this.artworkSlots.set(side, { thumb, img, remove, draw, info });
      this.add(f, { el, refresh: () => {} });
    }
    f.addBinding(this.ui, "artworkFit", {
      label: "Upload fit",
      options: [
        { text: "Cover (crop)", value: "cover" },
        { text: "Contain", value: "contain" },
        { text: "Stretch", value: "stretch" },
      ],
    });
  }

  private refreshArtwork(): void {
    for (const [side, s] of this.artworkSlots) {
      const src = this.design.surfaceSources[side];
      if (src) s.img.src = this.deps.resolveUrl(src);
      else s.img.removeAttribute("src");
      s.thumb.classList.toggle("has-art", !!src);
      s.thumb.title = src ? `Replace ${side} artwork` : `Upload ${side} artwork`;
      s.remove.disabled = !src;
    }
  }

  private buildStickers(): void {
    const f = this.folder("Stickers", false);
    this.add(
      f,
      note(
        `Click a sticker to place it on the side facing you. On the card: drag to move; corner handles resize, edge handles stretch (Shift keeps proportions), the top handle rotates (Shift snaps to 15°); double-click to crop. Arrow keys nudge, Delete removes, Esc deselects. The Sticker section below has the picture tools.`,
      ),
    );
    this.libraryEl = h("div.c3-library");
    this.add(f, { el: this.libraryEl, refresh: () => {} });
    this.refreshLibrary();
    this.add(f, note("On this card", "c3-cap"));
    this.placedEl = h("div.c3-placed-list");
    this.add(f, { el: this.placedEl, refresh: () => this.refreshPlaced() });
  }

  private buildStage(): void {
    const f = this.folder("Stage", false);
    f.addBinding(this.ui, "quality", {
      label: "Quality",
      options: [
        { text: "Performance", value: "performance" },
        { text: "Full", value: "full" },
      ],
    }).on("change", (e) => !this.syncing && this.deps.hooks.onQuality(e.value));
    this.add(f, note("Lighting", "c3-cap"));
    this.add(
      f,
      chipGrid(
        LIGHTING_PRESETS.map((p) => ({ value: p.id, label: p.label, title: p.description, swatch: lightingBackdropCss(p.id) })),
        () => this.design.lighting ?? "studio",
        (v) => {
          if ((this.design.lighting ?? "studio") === v) return;
          if (v === "studio") delete this.design.lighting;
          else this.design.lighting = v;
          this.deps.hooks.onLighting(v);
          this.changed(`lighting ${LIGHTING_PRESETS.find((p) => p.id === v)?.label ?? v}`);
        },
        { columns: 3, className: "c3-chips--light", label: "Lighting" },
      ),
    );
    f.addBinding(this.ui, "backdrop", {
      label: "Backdrop",
      options: [
        { text: "Lighting's", value: "scene" },
        { text: "Checker", value: "checker" },
      ],
    }).on("change", (e) => !this.syncing && this.deps.hooks.onBackdrop(e.value));
    f.addBinding(this.ui, "spin", { label: "Turntable" }).on("change", (e) => !this.syncing && this.deps.hooks.onSpin(e.value));
    this.add(
      f,
      buttonRow([
        { label: "⇋ Flip", title: "Flip the card (click the card, or Enter)", onClick: () => this.deps.hooks.onFlip() },
        { label: "⟲ Reset view", title: "Reset the pose (double-click the card, or Esc)", onClick: () => this.deps.hooks.onResetView() },
      ]),
    );
    if (this.deps.hasReference) {
      f.addBinding(this.ui, "assets", {
        label: "Assets (dev)",
        options: [
          { text: "Local pack", value: "reference" },
          { text: "Public", value: "public" },
        ],
      }).on("change", (e) => !this.syncing && this.deps.hooks.onAssets(e.value));
    }
  }

  private buildExport(): void {
    const f = this.folder("Export", true);
    const sizeOptions = [...Object.keys(SIZE_PRESETS).map((k) => ({ text: k, value: k })), { text: "Custom…", value: "custom" }];
    f.addBinding(this.ui, "sizePreset", { label: "Size", options: sizeOptions }).on("change", (e) => {
      if (this.syncing) return;
      const s = SIZE_PRESETS[e.value];
      if (s) [this.ui.width, this.ui.height] = s;
      this.refreshOutput();
    });
    this.customSize = [
      f.addBinding(this.ui, "width", { label: "Width", min: 64, max: 4096, step: 1 }),
      f.addBinding(this.ui, "height", { label: "Height", min: 64, max: 4096, step: 1 }),
    ];
    f.addBinding(this.ui, "exportBackground", {
      label: "Background",
      options: [
        { text: "Transparent", value: "transparent" },
        { text: "Lighting backdrop", value: "scene" },
        { text: "Colour", value: "color" },
      ],
    }).on("change", () => this.refreshOutput());
    this.bgBlade = f.addBinding(this.ui, "background", { label: "Colour", view: "color" });

    // IMAGE: format + export (one row), quality beneath.
    const imageOptions = [{ text: "PNG", value: "png" }, ...(canEncodeWebp() ? [{ text: "WebP", value: "webp" }] : []), { text: "JPEG", value: "jpeg" }];
    const fmt = f.addBinding(this.ui, "imageFormat", { label: "format", options: imageOptions }).on("change", () => this.refreshOutput());
    const imgBtn = f.addButton({ title: "📷 Export image" });
    imgBtn.on("click", () => this.run(imgBtn.element, "Saved", () => this.deps.hooks.onExportImage()));
    this.imageQualityBlade = f.addBinding(this.ui, "imageQuality", { label: "quality", min: 0.4, max: 1, step: 0.01 });
    this.group("IMAGE", [fmt.element, imgBtn.element], [(this.imageQualityBlade as unknown as { element: HTMLElement }).element]);

    // TURNTABLE: format + record (one row), duration beneath.
    const clipOptions = [
      ...(canRecord("webm") ? [{ text: "WebM", value: "webm" }] : []),
      ...(canRecord("mp4") ? [{ text: "MP4", value: "mp4" }] : []),
      { text: "GIF", value: "gif" },
    ];
    if (!clipOptions.some((o) => o.value === this.ui.clipFormat)) this.ui.clipFormat = clipOptions[0].value as ClipFormat;
    const path = f.addBinding(this.ui, "clipPath", { label: "path", options: CAMERA_PATHS.map((p) => ({ text: p.label, value: p.id })) });
    path.element.title = "The camera move of the video / GIF (Spin: the card turns on a turntable)";
    path.on("change", (e) => {
      if (this.syncing) return;
      this.ui.clipSeconds = getCameraPath(e.value).seconds;
      clipBtn.title = `🎬 Record ${getCameraPath(e.value).label.toLowerCase()}`;
      this.pane.refresh();
    });
    const cfmt = f.addBinding(this.ui, "clipFormat", { label: "format", options: clipOptions });
    const clipBtn = f.addButton({ title: `🎬 Record ${getCameraPath(this.ui.clipPath).label.toLowerCase()}` });
    clipBtn.on("click", () => this.run(clipBtn.element, "Saved", () => this.deps.hooks.onExportClip()));
    const easing = f.addBinding(this.ui, "clipEasing", {
      label: "easing",
      options: [{ text: "Path's own", value: "auto" }, ...CAMERA_EASINGS.map((e) => ({ text: e.label, value: e.id }))],
    });
    const secs = f.addBinding(this.ui, "clipSeconds", { label: "seconds", min: 2, max: 12, step: 0.5 });
    const preview = f.addButton({ title: "▶ Preview path" });
    preview.element.classList.add("c3-preview-path");
    preview.on("click", () => this.deps.hooks.onPreviewPath());
    this.previewBtn = preview as unknown as { title: string; element: HTMLElement };
    this.group("VIDEO / GIF", [cfmt.element, clipBtn.element], [path.element, easing.element, secs.element, preview.element]);

    const code = f.addButton({ title: "⟨⟩ Export code…" });
    code.on("click", () => this.deps.hooks.onExportCode());
    const embed = f.addButton({ title: "⧉ Embed…" });
    embed.on("click", () => this.deps.hooks.onExportEmbed());
    const print = f.addButton({ title: "🖨 Print files…" });
    print.element.classList.add("c3-print-files");
    print.on("click", () => this.deps.hooks.onExportPrint());
    const ar = f.addButton({ title: "📱 View in AR…" });
    ar.element.classList.add("c3-view-ar");
    ar.on("click", () => this.deps.hooks.onViewAr());
    const gltf = f.addButton({ title: "🧊 Export glTF (.glb)" });
    gltf.on("click", () => this.run(gltf.element, "Saved", () => this.deps.hooks.onExportGltf()));
    const spec = f.addButton({ title: "📄 Export recipe spec (.json)" });
    spec.on("click", () => this.run(spec.element, "Saved", () => this.deps.hooks.onExportSpec()));
    this.refreshOutput();
  }

  private refreshOutput(): void {
    const custom = this.ui.sizePreset === "custom";
    for (const b of this.customSize) b.hidden = !custom;
    const lossy = this.ui.imageFormat !== "png";
    if (this.imageQualityBlade) this.imageQualityBlade.hidden = !lossy;
    this.ui.transparent = this.ui.exportBackground === "transparent";
    if (this.bgBlade) this.bgBlade.hidden = this.ui.exportBackground !== "color";
  }

  private buildSave(): void {
    const f = this.folder("Save & share", true);
    const link = f.addButton({ title: "🔗 Copy share link" });
    link.on("click", async () => flash(link.element, await this.deps.hooks.onShare()));
    f.addButton({ title: "💾 Save design (.json)" }).on("click", () => this.deps.hooks.onSaveJson());
    f.addButton({ title: "📂 Open design (.json)" }).on("click", () => this.deps.hooks.onLoadJson());
    f.addButton({ title: "⇪ Import recipe…" }).on("click", () => this.deps.hooks.onImportRecipe());
    const drafts = this.folder("Drafts", true, f);
    const save = drafts.addButton({ title: "＋ Save as draft" });
    save.on("click", () => this.run(save.element, "Saved", () => this.deps.hooks.onDraftSave()));
    this.draftsEl = h("div.c3-drafts");
    this.add(drafts, { el: this.draftsEl, refresh: () => {} });
    this.refreshDrafts();
    this.add(f, note(`Undo ${modKey}Z · Redo ${modKey === "⌘" ? "⇧⌘Z" : "Ctrl+Y"}. Your work autosaves in this browser.`));
  }

  /** Box rows into a captioned group (wave3d's IMAGE / RECORD groups). */
  private group(caption: string, inline: HTMLElement[], stacked: HTMLElement[] = []): void {
    const anchor = inline[0];
    const box = h("div.c3-group", {}, h("div.c3-group-cap", { text: caption }));
    anchor.parentElement?.insertBefore(box, anchor);
    const row = h("div.c3-group-row");
    for (const el of inline) row.append(el);
    box.append(row, ...stacked);
  }

  /** Run an async action from a button, flashing the outcome on it. */
  private async run(el: HTMLElement, ok: string, fn: () => unknown): Promise<void> {
    el.classList.add("is-busy");
    try {
      await fn();
      flash(el, ok);
    } catch (err) {
      if ((err as Error)?.name !== "AbortError") {
        flash(el, "Failed");
        console.error(err);
      }
    } finally {
      el.classList.remove("is-busy");
    }
  }
}
