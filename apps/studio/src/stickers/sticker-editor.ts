/**
 * Direct manipulation of stickers on the 3D card, PowerPoint style. Pointer rays (from the card
 * engine's view: `EngineStage.view`) are cast against the stickers' quads in card-local space (each on
 * its own plane, which `EngineStage.setSticker` reports), then solved in the sticker's own frame
 * (transform.ts), and written back to the Decal model: x/y/width in percent of the card face, rotation
 * in degrees, aspect, crop.
 *
 * - Selection: a frame with corner and edge handles (corners keep the aspect ratio, Shift keeps it on
 *   an edge too, Alt resizes about the centre), a rotate handle above (Shift snaps to 15°) and a mini
 *   toolbar (Crop, Delete). Drag the sticker to move it; arrows nudge (Shift: more), Delete removes,
 *   Esc deselects.
 * - Crop mode (Crop, or double-click): the whole picture shows, dimmed outside the crop; black handles
 *   set the crop, dragging the picture moves it under the crop, aspect presets on the toolbar. Enter
 *   or a click outside applies, Esc cancels. The crop is stored as a normalized source rect.
 *
 * While a gesture runs the engine shows the sticker where it is (`setSticker`, no rebuild); the design
 * is committed once on release. The overlay is an SVG (plus two small HTML toolbars) tracking the
 * projected sticker.
 */
import { resetDecalPicture, type CardDesign, type Decal } from "@card3d/core/model";
import { cardFrameSize } from "@card3d/core/editor";
import type { EngineStage, EngineStickerPose, EngineView } from "@card3d/core/engine";
import { V2, cardRay, facesCamera, hitPlane, projectCardPoint, rayDistance } from "./view.ts";
import { isTyping } from "../ui/dom.ts";
import {
  CROP_ASPECTS,
  aspectRatio,
  cropDrag,
  cropFit,
  cropFrame,
  cropPan,
  cropToSource,
  placement,
  resizeBox,
  type CropAspectId,
  type CropFrame,
  type Rect,
} from "./transform.ts";

const SVG_NS = "http://www.w3.org/2000/svg";
const DEG = 180 / Math.PI;
/** Smallest sticker side while resizing / cropping, card units (≈ 2.5 mm). */
const MIN_SIDE = 0.1;
const MIN_CROP = 0.06;

export interface StickerEditorHooks {
  getDesign(): CardDesign;
  /** The selection changed (id or null). */
  onSelect(id: string | null): void;
  /** A gesture finished: commit the design (rebuild + history). */
  onCommit(label: string): void;
  onRemove(id: string): void;
  /** The selected sticker changed during a gesture (the panel's fields follow). */
  onLive?(): void;
  /** Crop mode started or ended. */
  onCropMode?(on: boolean): void;
  /** Counts the card's rebuilds (a rebuild shows the design's stickers again). */
  generation(): number;
}

/** A sticker's frame in card-local space: centre, unit axes (its local x / y) and size. */
interface Frame {
  c: V2;
  ex: V2;
  ey: V2;
  w: number;
  h: number;
}

const toLocal = (f: Pick<Frame, "c" | "ex" | "ey">, p: V2) => {
  const dx = p.x - f.c.x;
  const dy = p.y - f.c.y;
  return { x: dx * f.ex.x + dy * f.ex.y, y: dx * f.ey.x + dy * f.ey.y };
};
const toParent = (f: Pick<Frame, "c" | "ex" | "ey">, x: number, y: number) => new V2(f.c.x + f.ex.x * x + f.ey.x * y, f.c.y + f.ex.y * x + f.ey.y * y);

/** A sticker the card shows: its decal index and the plane its quad lies on (card space). */
interface Shown {
  index: number;
  z: number;
}

type Gesture =
  | { kind: "move"; id: string; pointerId: number; offset: V2; moved: boolean }
  | { kind: "rotate"; id: string; pointerId: number; startAngle: number; startRotation: number }
  | { kind: "resize"; id: string; pointerId: number; hx: number; hy: number; frame: Frame; start: Decal; moved: boolean }
  | { kind: "crop"; pointerId: number; hx: number; hy: number; start: Rect }
  | { kind: "pan"; pointerId: number; from: V2; start: Rect; startC: V2 };

interface CropState extends CropFrame {
  id: string;
  /** The whole picture's frame (its centre moves when the picture is panned). */
  frame: Frame;
  ratio: number | null;
  aspect: CropAspectId;
}

/** Resize handles: (hx, hy) in the sticker's frame (y up). */
const HANDLES: [number, number][] = [
  [-1, 1],
  [0, 1],
  [1, 1],
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, -1],
  [-1, 0],
];
const CURSORS = ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"];
/** A resize cursor for a handle pointing along screen direction `v`. */
const cursorFor = (v: V2) => CURSORS[Math.round(((Math.atan2(v.y, v.x) * DEG + 360) % 180) / 45) % 4];

export class StickerEditor {
  selected: string | null = null;
  private gesture: Gesture | null = null;
  private crop: CropState | null = null;
  private readonly svg: SVGSVGElement;
  private readonly selG: SVGGElement;
  private readonly outline: SVGPolygonElement;
  private readonly stem: SVGLineElement;
  private readonly rotateH: SVGGElement;
  private readonly resizeH: SVGGElement[];
  private readonly cropG: SVGGElement;
  private readonly dim: SVGPathElement;
  private readonly fullOutline: SVGPolygonElement;
  private readonly cropOutline: SVGPolygonElement;
  private readonly cropH: SVGGElement[];
  private readonly bar: HTMLDivElement;
  private readonly cropBar: HTMLDivElement;
  private frame = 0;
  /** What the mesh shows in crop mode (so it is redrawn only when that changes). */
  private cropMeshKey = "";
  private readonly cleanup: (() => void)[] = [];

  constructor(
    private readonly stage: EngineStage,
    private readonly element: HTMLElement,
    private readonly hooks: StickerEditorHooks,
  ) {
    const el = <K extends keyof SVGElementTagNameMap>(tag: K, cls: string) => {
      const n = document.createElementNS(SVG_NS, tag);
      n.setAttribute("class", cls);
      return n;
    };
    this.svg = el("svg", "c3-sticker-overlay");
    this.svg.setAttribute("aria-hidden", "true");
    // Selection: outline, rotate stem + knob, eight resize handles.
    this.selG = el("g", "c3-sticker-sel");
    this.outline = el("polygon", "c3-sticker-outline");
    this.stem = el("line", "c3-sticker-stem");
    this.rotateH = this.handle("rotate", "Rotate (Shift snaps to 15°)");
    this.rotateH.innerHTML +=
      '<circle r="12" class="c3-knob"/><g class="c3-ico"><path d="M-4.5 -1.5a5 5 0 1 1 1.4 5.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M-6.5 -4.2l2 2.9 2.9-2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></g>';
    this.resizeH = HANDLES.map(([hx, hy]) => {
      const g = this.handle(
        "resize",
        hx && hy ? "Resize (keeps proportions; Alt: from the centre)" : "Stretch (Shift keeps proportions; Alt: from the centre)",
      );
      g.dataset.hx = String(hx);
      g.dataset.hy = String(hy);
      g.innerHTML += '<circle r="11" class="c3-hit"/><circle r="5.5" class="c3-dot"/>';
      return g;
    });
    this.selG.append(this.outline, this.stem, this.rotateH, ...this.resizeH);
    // Crop mode: the picture dimmed outside the crop, its outline, the crop and its black handles.
    this.cropG = el("g", "c3-crop");
    this.dim = el("path", "c3-crop-dim");
    this.dim.setAttribute("fill-rule", "evenodd");
    this.fullOutline = el("polygon", "c3-crop-full");
    this.cropOutline = el("polygon", "c3-crop-rect");
    this.cropH = HANDLES.map(([hx, hy]) => {
      const g = this.handle("crop", "Crop");
      g.dataset.hx = String(hx);
      g.dataset.hy = String(hy);
      g.innerHTML += '<path class="c3-hit"/><path class="c3-crop-mark-bg"/><path class="c3-crop-mark"/>';
      return g;
    });
    this.cropG.append(this.dim, this.fullOutline, this.cropOutline, ...this.cropH);
    this.svg.append(this.cropG, this.selG);
    this.svg.style.display = "none";

    // Mini toolbar (selection) and crop toolbar (aspect presets, apply / cancel).
    this.bar = document.createElement("div");
    this.bar.className = "c3-sticker-bar c3-sticker-ui";
    this.bar.setAttribute("role", "toolbar");
    this.bar.setAttribute("aria-label", "Sticker");
    this.bar.append(
      this.barButton("Crop", "Crop (double-click the sticker)", () => this.enterCrop(), "crop"),
      this.barButton("Delete", "Remove the sticker (Delete)", () => this.removeSelected(), "delete"),
    );
    this.cropBar = document.createElement("div");
    this.cropBar.className = "c3-sticker-bar c3-crop-bar c3-sticker-ui";
    this.cropBar.setAttribute("role", "toolbar");
    this.cropBar.setAttribute("aria-label", "Crop");
    const aspects = document.createElement("div");
    aspects.className = "c3-crop-aspects";
    aspects.setAttribute("role", "radiogroup");
    aspects.setAttribute("aria-label", "Crop aspect ratio");
    for (const a of CROP_ASPECTS) {
      const b = this.barButton(
        a.label,
        a.id === "original" ? "The picture's own proportions" : a.id === "free" ? "Any proportions" : `${a.label} (follows the crop's orientation)`,
        () => this.setCropAspect(a.id),
        `aspect-${a.id.replace(":", "x")}`,
      );
      b.setAttribute("role", "radio");
      b.dataset.aspect = a.id;
      aspects.append(b);
    }
    this.cropBar.append(
      aspects,
      this.barButton("Cancel", "Cancel (Esc)", () => this.cancelCrop(), "cancel"),
      this.barButton("Done", "Apply the crop (Enter)", () => this.commitCrop(), "done"),
    );
    this.bar.hidden = true;
    this.cropBar.hidden = true;
    element.append(this.svg, this.bar, this.cropBar);

    const on = <K extends keyof HTMLElementEventMap>(
      t: EventTarget,
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
      opts?: AddEventListenerOptions | boolean,
    ) => {
      t.addEventListener(type, fn as EventListener, opts);
      this.cleanup.push(() => t.removeEventListener(type, fn as EventListener, opts));
    };
    // Capture phase: runs before the card interaction (a bubble listener on the same element), so a
    // sticker hit can claim the gesture.
    on(element, "pointerdown", (e) => this.onPointerDown(e), true);
    // Double-clicking a sticker crops it (and doesn't also reset the card's pose).
    on(element, "dblclick", (e) => this.onDoubleClick(e as MouseEvent), true);
    on(element, "pointermove", (e) => this.onHover(e));
    on(window, "pointermove", (e) => this.onDrag(e));
    on(window, "pointerup", (e) => this.onUp(e));
    on(window, "pointercancel", (e) => this.onUp(e));
    // Capture: Enter / Esc must reach crop mode before the card's own keys (flip, reset view).
    on(window, "keydown", (e) => this.onKey(e), true);
    for (const h of [this.rotateH, ...this.resizeH, ...this.cropH]) on(h as unknown as HTMLElement, "pointerdown", (e) => this.onHandleDown(e, h));
  }

  // ── public ──────────────────────────────────────────────────────────────

  select(id: string | null): void {
    if (id === this.selected) return;
    if (this.crop) this.commitCrop();
    this.selected = id;
    this.hooks.onSelect(id);
    if (id) this.loop();
    else this.hide();
  }

  /** Call after the design changes (undo, preset…): a vanished sticker drops its selection; crop mode ends. */
  sync(): void {
    if (this.crop) this.endCrop();
    if (this.selected && !this.hooks.getDesign().decals.some((d) => d.id === this.selected)) this.select(null);
  }

  get cropping(): boolean {
    return this.crop !== null;
  }

  /** Show the selected sticker's current values on its mesh (panel edits, without a rebuild). */
  live(): void {
    const found = this.decal(this.selected);
    if (found && !this.crop) this.applyToMesh(found.d, found.index);
  }

  /** The selected sticker's image's own aspect (width / height), when the card shows it. */
  naturalAspect(): number | null {
    const found = this.decal(this.selected);
    return (found && this.stage.setSticker(found.index)?.aspect) || null;
  }

  /** Which face the camera currently sees. */
  visibleSide(): "front" | "back" {
    const v = this.stage.view();
    if (!v) return "front";
    return facesCamera(v, [0, 0, 0], [0, 0, 1]) ? "front" : "back";
  }

  /** Crop mode on the selected sticker. */
  enterCrop(): void {
    const found = this.decal(this.selected);
    if (!found || this.crop || !this.mesh(found.index)) return;
    const d = found.d;
    const vis = this.frameOf(d);
    const cf = cropFrame(d, vis.w, vis.h);
    const c = toParent(vis, -cf.offset.x, -cf.offset.y);
    this.crop = { ...cf, id: d.id, frame: { ...vis, c, w: cf.w, h: cf.h }, ratio: null, aspect: "free" };
    this.cropMeshKey = "";
    this.element.classList.add("is-cropping");
    this.refreshCropBar();
    this.hooks.onCropMode?.(true);
    this.loop();
  }

  /** Apply the crop: the visible part becomes the sticker (same place on the card). */
  commitCrop(): void {
    const cs = this.crop;
    const found = cs && this.decal(cs.id);
    if (!cs || !found) return this.endCrop();
    const d = found.d;
    const before = JSON.stringify([d.crop, d.width, d.x, d.y]);
    const crop = cropToSource(cs);
    if (crop) d.crop = crop;
    else delete d.crop;
    const r = cs.rect;
    const size = this.size();
    const c = toParent(cs.frame, (r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2);
    d.width = round2(((r.x1 - r.x0) / (size.width * (d.scale ?? 1))) * 100);
    this.setCentre(d, c);
    this.endCrop();
    this.applyToMesh(d, found.index);
    if (JSON.stringify([d.crop, d.width, d.x, d.y]) !== before) this.hooks.onCommit("crop sticker");
  }

  cancelCrop(): void {
    this.endCrop();
  }

  /** Reset crop: the whole picture again, at the same scale and where it was on the card. */
  resetCrop(): void {
    const found = this.decal(this.selected);
    if (!found) return;
    this.endCrop();
    if (!found.d.crop) return;
    this.uncrop(found.d);
    this.applyToMesh(found.d, found.index);
    this.hooks.onCommit("reset crop");
  }

  /** Reset picture: no crop, flip, colour, corrections or opacity, and the image's own proportions. */
  resetPicture(): void {
    const found = this.decal(this.selected);
    if (!found) return;
    this.endCrop();
    const d = found.d;
    const before = JSON.stringify(d);
    const natural = this.naturalAspect();
    this.uncrop(d);
    resetDecalPicture(d);
    if (natural && Math.abs(natural / d.aspect - 1) > 0.002) d.aspect = round4(natural);
    this.applyToMesh(d, found.index);
    if (JSON.stringify(d) !== before) this.hooks.onCommit("reset picture");
  }

  /** Mirror the selected sticker left ↔ right (h) or top ↔ bottom (v). */
  flip(axis: "h" | "v"): void {
    const found = this.decal(this.selected);
    if (!found) return;
    this.endCrop();
    const d = found.d;
    const next = { ...d.flip, [axis]: !d.flip?.[axis] };
    if (!next.h) delete next.h;
    if (!next.v) delete next.v;
    if (next.h || next.v) d.flip = next;
    else delete d.flip;
    this.applyToMesh(d, found.index);
    this.hooks.onCommit(axis === "h" ? "flip sticker horizontally" : "flip sticker vertically");
  }

  private uncrop(d: Decal): void {
    if (!d.crop) return;
    const vis = this.frameOf(d);
    const cf = cropFrame(d, vis.w, vis.h);
    const c = toParent(vis, -cf.offset.x, -cf.offset.y);
    d.width = round2(d.width / d.crop.w);
    delete d.crop;
    this.setCentre(d, c);
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.cleanup.forEach((f) => f());
    this.svg.remove();
    this.bar.remove();
    this.cropBar.remove();
  }

  // ── geometry helpers ────────────────────────────────────────────────────

  /** The card's print area (portrait shapes stand it up). */
  private size() {
    return cardFrameSize(this.hooks.getDesign());
  }

  private decal(id: string | null): { d: Decal; index: number } | null {
    if (!id) return null;
    const decals = this.hooks.getDesign().decals;
    const index = decals.findIndex((d) => d.id === id);
    return index < 0 ? null : { d: decals[index], index };
  }

  /** Sticker `index` as the card shows it (null when it doesn't: no picture yet, or no card). */
  private mesh(index: number): Shown | null {
    const info = this.stage.setSticker(index);
    return info ? { index, z: info.z } : null;
  }

  private stickerMeshes(): Shown[] {
    return this.hooks.getDesign().decals.flatMap((_, i) => this.mesh(i) ?? []);
  }

  /** The sticker's visible frame in card-local space (its rotation: θ about z, mirrored on the back). */
  private frameOf(d: Decal): Frame {
    const p = placement(d, this.size());
    // Euler XYZ (0, back ? π : 0, θ): x' = Ry · Rz · x.
    const [c, s] = [Math.cos(p.theta), Math.sin(p.theta)];
    const m = d.side === "back" ? -1 : 1;
    return { c: new V2(p.x, p.y), ex: new V2(m * c, s).normalize(), ey: new V2(-m * s, c).normalize(), w: p.width, h: p.height };
  }

  /** Write a card-local centre into the decal (clamped like the renderer, so the box stays on the card). */
  private setCentre(d: Decal, c: V2): void {
    const size = this.size();
    const p = placement({ ...d, x: (c.x / size.width + 0.5) * 100, y: (0.5 - c.y / size.height) * 100 }, size);
    d.x = round2(p.px);
    d.y = round2(p.py);
  }

  /** The pointer's ray in the card's space, with the view it was cast in (null before the first card). */
  private ray(e: { clientX: number; clientY: number }): { view: EngineView; origin: [number, number, number]; dir: [number, number, number] } | null {
    const view = this.stage.view();
    if (!view) return null;
    const r = this.stage.canvas.getBoundingClientRect();
    const ray = cardRay(view, ((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    return { view, ...ray };
  }

  /** Pointer → point on the sticker plane, in the sticker's parent space (card-local units). */
  private planePoint(e: { clientX: number; clientY: number }, mesh: Shown): V2 | null {
    const ray = this.ray(e);
    return ray && hitPlane(ray, mesh.z);
  }

  /** Show the decal's placement and picture on the card (live, no rebuild). */
  private applyToMesh(d: Decal, index: number): void {
    const p = placement(d, this.size());
    this.placeMesh(index, d, p.x, p.y, p.width, p.height);
  }

  private placeMesh(index: number, d: Decal, x: number, y: number, width: number, height: number, look: Pick<Decal, "crop"> = d): void {
    const tint = d.tint && d.tint.amount > 0 ? d.tint : null;
    const n = tint ? parseInt(tint.color.slice(1), 16) : 0;
    const pose: EngineStickerPose = {
      x,
      y,
      width,
      height,
      rotation: d.rotation ?? 0,
      crop: look.crop ?? undefined,
      flip: d.flip,
      opacity: d.opacity ?? 1,
      tint: tint ? { rgb: [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255], amount: tint.amount } : undefined,
      adjust: d.adjust,
    };
    this.stage.setSticker(index, pose);
  }

  /** Crop mode: the card shows the whole picture (keeping its flip, colour and opacity). */
  private applyCropMesh(cs: CropState, d: Decal, index: number): void {
    if (!this.mesh(index)) return;
    const key = `${this.hooks.generation()} ${cs.frame.c.x} ${cs.frame.c.y}`;
    if (key === this.cropMeshKey) return;
    this.cropMeshKey = key;
    this.placeMesh(index, d, cs.frame.c.x, cs.frame.c.y, cs.w, cs.h, { crop: undefined });
  }

  // ── pointer ─────────────────────────────────────────────────────────────

  /** The sticker under the pointer: the nearest quad hit on its front (as three's raycaster picked them). */
  private pick(e: { clientX: number; clientY: number }): { id: string; mesh: Shown } | null {
    const meshes = this.stickerMeshes();
    if (!meshes.length) return null;
    const ray = this.ray(e);
    if (!ray) return null;
    const decals = this.hooks.getDesign().decals;
    let best: { id: string; mesh: Shown; t: number } | null = null;
    for (const m of meshes) {
      const d = decals[m.index];
      const pt = d && hitPlane(ray, m.z);
      if (!d || !pt) continue;
      const f = this.frameOf(d);
      const l = toLocal(f, pt);
      if (Math.abs(l.x) > f.w / 2 || Math.abs(l.y) > f.h / 2) continue;
      if (!facesCamera(ray.view, [pt.x, pt.y, m.z], [0, 0, d.side === "back" ? -1 : 1])) continue;
      const t = rayDistance(ray, [pt.x, pt.y, m.z]);
      if (!best || t < best.t) best = { id: d.id, mesh: m, t };
    }
    return best && { id: best.id, mesh: best.mesh };
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0 || (e.target as Element).closest?.(".c3-sticker-ui")) return;
    const cs = this.crop;
    if (cs) {
      e.stopPropagation();
      e.preventDefault();
      const found = this.decal(cs.id);
      const mesh = found && this.mesh(found.index);
      const pt = mesh && this.planePoint(e, mesh);
      const l = pt && toLocal(cs.frame, pt);
      // On the picture: move it under the crop. Anywhere else: apply the crop.
      if (pt && l && Math.abs(l.x) <= cs.w / 2 && Math.abs(l.y) <= cs.h / 2) {
        this.gesture = { kind: "pan", pointerId: e.pointerId, from: pt, start: { ...cs.rect }, startC: cs.frame.c.clone() };
        this.element.classList.add("is-sticker-drag");
      } else this.commitCrop();
      return;
    }
    const hit = this.pick(e);
    if (!hit) {
      if (this.selected) {
        // First click off a sticker only deselects: it neither turns nor flips the card.
        e.stopPropagation();
        e.preventDefault();
        this.select(null);
      }
      return;
    }
    e.stopPropagation();
    e.preventDefault();
    this.select(hit.id);
    const found = this.decal(hit.id)!;
    const pt = this.planePoint(e, hit.mesh);
    if (!pt) return;
    const p = placement(found.d, this.size());
    this.gesture = { kind: "move", id: hit.id, pointerId: e.pointerId, offset: new V2(pt.x - p.x, pt.y - p.y), moved: false };
    this.element.classList.add("is-sticker-drag");
  }

  private onDoubleClick(e: MouseEvent): void {
    if ((e.target as Element).closest?.(".c3-sticker-ui")) return e.stopPropagation();
    if (this.crop) return e.stopPropagation();
    const hit = this.pick(e);
    if (!hit) return;
    e.stopPropagation();
    this.select(hit.id);
    this.enterCrop();
  }

  private onHandleDown(e: PointerEvent, h: SVGGElement): void {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const hx = Number(h.dataset.hx ?? 0);
    const hy = Number(h.dataset.hy ?? 0);
    if (h.classList.contains("c3-sticker-handle--crop")) {
      if (this.crop) this.gesture = { kind: "crop", pointerId: e.pointerId, hx, hy, start: { ...this.crop.rect } };
      this.element.classList.add("is-sticker-drag");
      return;
    }
    const found = this.decal(this.selected);
    if (!found) return;
    const d = found.d;
    if (h === this.rotateH) {
      const mesh = this.mesh(found.index);
      const pt = mesh && this.planePoint(e, mesh);
      if (!pt) return;
      const p = placement(d, this.size());
      this.gesture = { kind: "rotate", id: d.id, pointerId: e.pointerId, startAngle: Math.atan2(pt.y - p.y, pt.x - p.x), startRotation: d.rotation };
    } else {
      this.gesture = { kind: "resize", id: d.id, pointerId: e.pointerId, hx, hy, frame: this.frameOf(d), start: { ...d }, moved: false };
    }
    this.element.classList.add("is-sticker-drag");
  }

  private onDrag(e: PointerEvent): void {
    const g = this.gesture;
    if (!g || e.pointerId !== g.pointerId) return;
    if (g.kind === "crop" || g.kind === "pan") return this.onCropDrag(e, g);
    const found = this.decal(g.id);
    const mesh = found && this.mesh(found.index);
    if (!found || !mesh) return;
    const pt = this.planePoint(e, mesh);
    if (!pt) return;
    const d = found.d;
    const size = this.size();
    if (g.kind === "move") {
      this.setCentre(d, pt.clone().sub(g.offset));
      g.moved = true;
    } else if (g.kind === "rotate") {
      const p = placement(d, size);
      // Front: +rotation is clockwise on screen (mesh θ = −rotation). The back face is mirrored.
      const sign = d.side === "back" ? 1 : -1;
      let deg = g.startRotation + sign * (Math.atan2(pt.y - p.y, pt.x - p.x) - g.startAngle) * DEG;
      deg = ((((deg + 180) % 360) + 360) % 360) - 180;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      d.rotation = round2(deg);
    } else {
      const f = g.frame;
      const keep = (g.hx !== 0 && g.hy !== 0) || e.shiftKey;
      const r = resizeBox(f.w, f.h, g.hx, g.hy, toLocal(f, pt), { keep, fromCenter: e.altKey, min: MIN_SIDE });
      const W = Math.min(r.w, size.width * 3);
      const s = g.start;
      d.width = round2((W / (size.width * (s.scale ?? 1))) * 100);
      const crop = s.crop ?? { w: 1, h: 1 };
      // Corners (and Shift) keep the proportions exactly; a free edge stretches the picture.
      d.aspect = keep ? s.aspect : round4((W / r.h) * (crop.h / crop.w));
      this.setCentre(d, toParent(f, r.dx, r.dy));
      g.moved = true;
    }
    this.applyToMesh(d, found.index);
    this.hooks.onLive?.();
  }

  private onCropDrag(e: PointerEvent, g: Extract<Gesture, { kind: "crop" | "pan" }>): void {
    const cs = this.crop;
    const found = cs && this.decal(cs.id);
    const mesh = found && this.mesh(found.index);
    const pt = mesh && this.planePoint(e, mesh);
    if (!cs || !pt) return;
    if (g.kind === "crop") {
      cs.rect = cropDrag(g.start, cs, g.hx, g.hy, toLocal(cs.frame, pt), cs.ratio, Math.min(MIN_CROP, cs.w / 2, cs.h / 2));
    } else {
      const v = pt.clone().sub(g.from);
      const m = cropPan(g.start, cs, { x: v.x * cs.frame.ex.x + v.y * cs.frame.ex.y, y: v.x * cs.frame.ey.x + v.y * cs.frame.ey.y });
      cs.rect = m.rect;
      cs.frame.c = toParent({ ...cs.frame, c: g.startC }, m.dx, m.dy);
    }
  }

  private onUp(e: PointerEvent): void {
    const g = this.gesture;
    if (!g || e.pointerId !== g.pointerId) return;
    this.gesture = null;
    this.element.classList.remove("is-sticker-drag");
    if (g.kind === "crop" || g.kind === "pan") return;
    if ((g.kind === "move" || g.kind === "resize") && !g.moved) return;
    this.hooks.onCommit(g.kind === "move" ? "move sticker" : g.kind === "rotate" ? "rotate sticker" : g.hx && g.hy ? "resize sticker" : "stretch sticker");
  }

  private onHover(e: PointerEvent): void {
    if (this.gesture || e.buttons || this.crop) return;
    const over = !!this.pick(e);
    this.element.classList.toggle("is-over-sticker", over);
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.selected || isTyping(e.target) || e.metaKey || e.ctrlKey || document.querySelector("dialog[open]")) return;
    if (this.crop) {
      if (e.key === "Enter" || e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Enter") this.commitCrop();
        else this.cancelCrop();
      }
      return;
    }
    // Other keys meant for the panel's own controls stay there.
    if ((e.target as Element | null)?.closest?.("#panel, .c3-drawer")) return;
    const found = this.decal(this.selected);
    if (!found) return;
    const d = found.d;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      e.stopPropagation();
      this.removeSelected();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.select(null);
      return;
    }
    const step = e.shiftKey ? 2 : 0.5;
    const mirror = d.side === "back" ? -1 : 1;
    const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
    const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
    if (!dx && !dy) return;
    e.preventDefault();
    e.stopPropagation();
    const p = placement({ ...d, x: d.x + dx * mirror, y: d.y + dy }, this.size());
    d.x = round2(p.px);
    d.y = round2(p.py);
    this.applyToMesh(d, found.index);
    this.hooks.onCommit("nudge sticker");
  }

  private removeSelected(): void {
    const id = this.selected;
    if (!id) return;
    this.select(null);
    this.hooks.onRemove(id);
  }

  // ── crop mode ───────────────────────────────────────────────────────────

  private setCropAspect(id: CropAspectId): void {
    const cs = this.crop;
    if (!cs) return;
    cs.aspect = id;
    cs.ratio = aspectRatio(id, cs);
    if (cs.ratio) cs.rect = cropFit(cs.rect, cs, cs.ratio);
    this.refreshCropBar();
  }

  private refreshCropBar(): void {
    for (const b of this.cropBar.querySelectorAll<HTMLButtonElement>("[data-aspect]")) {
      const on = b.dataset.aspect === this.crop?.aspect;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-checked", String(on));
    }
  }

  /** Leave crop mode without changing the design (the mesh goes back to the decal as it is). */
  private endCrop(): void {
    const cs = this.crop;
    if (!cs) return;
    this.crop = null;
    if (this.gesture?.kind === "crop" || this.gesture?.kind === "pan") this.gesture = null;
    this.element.classList.remove("is-cropping", "is-sticker-drag");
    const found = this.decal(cs.id);
    if (found) this.applyToMesh(found.d, found.index);
    this.hooks.onCropMode?.(false);
  }

  // ── overlay ─────────────────────────────────────────────────────────────

  private handle(kind: string, title: string): SVGGElement {
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("class", `c3-sticker-handle c3-sticker-ui c3-sticker-handle--${kind}`);
    const t = document.createElementNS(SVG_NS, "title");
    t.textContent = title;
    g.append(t);
    return g;
  }

  private barButton(label: string, title: string, onClick: () => void, name: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `c3-sticker-bar-btn c3-sticker-bar-btn--${name}`;
    b.textContent = label;
    b.title = title;
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  private hide(): void {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.svg.style.display = "none";
    this.bar.hidden = true;
    this.cropBar.hidden = true;
  }

  private loop = (): void => {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(this.loop);
    this.drawOverlay();
  };

  private drawOverlay(): void {
    const found = this.decal(this.selected);
    if (!found) {
      this.select(null);
      return;
    }
    const cs = this.crop;
    // Keep the live mesh in step with the gesture / crop even if a rebuild swapped it.
    if (cs) this.applyCropMesh(cs, found.d, found.index);
    else if (this.gesture) this.applyToMesh(found.d, found.index);
    const mesh = this.mesh(found.index);
    const view = this.stage.view();
    if (!mesh || !view) return this.hideOverlay();
    const z = mesh.z;
    const centre0 = cs ? cs.frame.c : placementCentre(placement(found.d, this.size()));
    if (!facesCamera(view, [centre0.x, centre0.y, z], [0, 0, found.d.side === "back" ? -1 : 1])) return this.hideOverlay();
    const cr = this.stage.canvas.getBoundingClientRect();
    const er = this.element.getBoundingClientRect();
    const toScreen = (p: V2) => {
      const v = projectCardPoint(view, [p.x, p.y, z]);
      return new V2(cr.left - er.left + ((v.x + 1) / 2) * cr.width, cr.top - er.top + ((1 - v.y) / 2) * cr.height);
    };
    const pts = (f: Pick<Frame, "c" | "ex" | "ey">, r: Rect) =>
      [toParent(f, r.x0, r.y1), toParent(f, r.x1, r.y1), toParent(f, r.x1, r.y0), toParent(f, r.x0, r.y0)].map(toScreen);
    const poly = (p: V2[]) => p.map((q) => `${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(" ");
    this.svg.style.display = "";
    this.selG.style.display = cs ? "none" : "";
    this.cropG.style.display = cs ? "" : "none";
    if (cs) {
      const full = pts(cs.frame, { x0: -cs.w / 2, x1: cs.w / 2, y0: -cs.h / 2, y1: cs.h / 2 });
      const crop = pts(cs.frame, cs.rect);
      this.dim.setAttribute("d", `M${poly(full).replace(/ /g, "L")}Z M${poly(crop).replace(/ /g, "L")}Z`);
      this.fullOutline.setAttribute("points", poly(full));
      this.cropOutline.setAttribute("points", poly(crop));
      // Screen directions of the crop's x axis and of "down" its y axis, for the L-shaped marks.
      const ux = crop[1].clone().sub(crop[0]).normalize();
      const down = crop[3].clone().sub(crop[0]).normalize();
      const centre = crop[0].clone().add(crop[2]).multiplyScalar(0.5);
      const r = cs.rect;
      const L = 15;
      this.cropH.forEach((h, i) => {
        const [hx, hy] = HANDLES[i];
        const at = toScreen(toParent(cs.frame, hx < 0 ? r.x0 : hx > 0 ? r.x1 : (r.x0 + r.x1) / 2, hy < 0 ? r.y0 : hy > 0 ? r.y1 : (r.y0 + r.y1) / 2));
        let d: string;
        if (hx && hy) {
          const a = at.clone().addScaledVector(ux, -hx * L);
          const b = at.clone().addScaledVector(down, hy * L);
          d = `M${a.x.toFixed(1)},${a.y.toFixed(1)}L${at.x.toFixed(1)},${at.y.toFixed(1)}L${b.x.toFixed(1)},${b.y.toFixed(1)}`;
        } else {
          const along = hx ? down : ux;
          const a = at.clone().addScaledVector(along, -L / 2 - 2);
          const b = at.clone().addScaledVector(along, L / 2 + 2);
          d = `M${a.x.toFixed(1)},${a.y.toFixed(1)}L${b.x.toFixed(1)},${b.y.toFixed(1)}`;
        }
        for (const p of h.querySelectorAll("path")) p.setAttribute("d", d);
        h.style.cursor = cursorFor(at.clone().sub(centre));
      });
      this.bar.hidden = true;
      this.cropBar.hidden = false;
      this.placeBar(this.cropBar, full);
    } else {
      const f = this.frameOf(found.d);
      const r = { x0: -f.w / 2, x1: f.w / 2, y0: -f.h / 2, y1: f.h / 2 };
      const q = pts(f, r);
      this.outline.setAttribute("points", poly(q));
      const centre = toScreen(f.c);
      this.resizeH.forEach((h, i) => {
        const [hx, hy] = HANDLES[i];
        const at = toScreen(toParent(f, (hx * f.w) / 2, (hy * f.h) / 2));
        h.setAttribute("transform", `translate(${at.x.toFixed(1)} ${at.y.toFixed(1)})`);
        h.style.cursor = cursorFor(at.clone().sub(centre));
      });
      const top = toScreen(toParent(f, 0, f.h / 2));
      const up = top.clone().sub(centre);
      const knob = top.clone().add(up.lengthSq() > 1e-6 ? up.normalize().multiplyScalar(28) : new V2(0, -28));
      this.stem.setAttribute("x1", top.x.toFixed(1));
      this.stem.setAttribute("y1", top.y.toFixed(1));
      this.stem.setAttribute("x2", knob.x.toFixed(1));
      this.stem.setAttribute("y2", knob.y.toFixed(1));
      this.rotateH.setAttribute("transform", `translate(${knob.x.toFixed(1)} ${knob.y.toFixed(1)})`);
      this.cropBar.hidden = true;
      this.bar.hidden = !!this.gesture;
      if (!this.bar.hidden) this.placeBar(this.bar, [...q, knob]);
    }
  }

  /** Put a toolbar under the projected shape (above it when there is no room), inside the stage. */
  private placeBar(bar: HTMLElement, shape: V2[]): void {
    const er = this.element.getBoundingClientRect();
    const xs = shape.map((p) => p.x);
    const ys = shape.map((p) => p.y);
    const bw = bar.offsetWidth;
    const bh = bar.offsetHeight;
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    let y = Math.max(...ys) + 16;
    if (y + bh > er.height - 8) y = Math.min(...ys) - bh - 16;
    const x = Math.min(Math.max(8, cx - bw / 2), Math.max(8, er.width - bw - 8));
    bar.style.transform = `translate(${Math.round(x)}px, ${Math.round(Math.max(8, Math.min(y, er.height - bh - 8)))}px)`;
  }

  private hideOverlay(): void {
    this.svg.style.display = "none";
    this.bar.hidden = true;
    this.cropBar.hidden = true;
  }
}

const placementCentre = (p: { x: number; y: number }) => new V2(p.x, p.y);
const round2 = (v: number) => Math.round(v * 100) / 100;
const round4 = (v: number) => Math.round(v * 1e4) / 1e4;
