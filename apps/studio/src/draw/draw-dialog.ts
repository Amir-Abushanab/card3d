/**
 * The drawing layer: a card-shaped canvas (the face's 0..1 UV space, 1280×804) with pens, a marker
 * and an eraser. "Apply" flattens the strokes over the side's current artwork into one image that
 * becomes that side's surface source (CardDesign.surfaceSources).
 *
 * Strokes are kept as point lists, so undo is a replay rather than a stack of bitmaps.
 */
import type { Side } from "@card3d/core/model";
import { ISO_7811_AREAS, ISO_CHIP_PLATE, ISO_CHIP_PLATE_MM } from "@card3d/core/editor";
import { button, createDialog } from "../ui/dialog.ts";
import { canEncodeWebp, h, loadImage } from "../ui/dom.ts";

export const FACE_W = 1280;
export const FACE_H = 804; // 1280 × 540/860

const PEN_COLORS: { name: string; value: string }[] = [
  { name: "Ink", value: "#141414" },
  { name: "White", value: "#ffffff" },
  { name: "Lime", value: "#e4f222" },
  { name: "Coral", value: "#ff5a36" },
  { name: "Sky", value: "#2f9bff" },
  { name: "Violet", value: "#7a5cff" },
  { name: "Gold", value: "#d9a441" },
  { name: "Pink", value: "#ff6fcf" },
];

type Tool = "pen" | "marker" | "eraser";
interface Stroke {
  tool: Tool;
  color: string;
  size: number;
  points: { x: number; y: number; p: number }[];
}

export interface DrawResult {
  dataUrl: string;
}

export class DrawDialog {
  private readonly shell = createDialog("Draw on the card", { wide: true, className: "c3-draw" });
  private readonly view: HTMLCanvasElement;
  private readonly vctx: CanvasRenderingContext2D;
  private readonly ink = document.createElement("canvas");
  private readonly ictx: CanvasRenderingContext2D;
  /** Committed strokes, cached so a live stroke only redraws itself. */
  private readonly committed = document.createElement("canvas");
  private readonly cctx: CanvasRenderingContext2D;
  private base: HTMLImageElement | null = null;
  private keepBase = true;
  private strokes: Stroke[] = [];
  private redoStack: Stroke[] = [];
  private live: Stroke | null = null;
  private tool: Tool = "pen";
  private color = PEN_COLORS[0].value;
  private size = 8;
  private side: Side = "front";
  private resolve: ((r: DrawResult | null) => void) | null = null;
  private readonly title: HTMLHeadingElement;
  private readonly keepToggle: HTMLLabelElement;
  private readonly undoBtn: HTMLButtonElement;
  private readonly redoBtn: HTMLButtonElement;

  constructor() {
    this.view = h("canvas.c3-draw-canvas", { width: FACE_W, height: FACE_H, "aria-label": "Drawing surface" });
    this.vctx = this.view.getContext("2d")!;
    this.ink.width = FACE_W;
    this.ink.height = FACE_H;
    this.ictx = this.ink.getContext("2d")!;
    this.committed.width = FACE_W;
    this.committed.height = FACE_H;
    this.cctx = this.committed.getContext("2d")!;
    this.title = this.shell.dialog.querySelector("h2")!;

    // Toolbar: tools · colours · size · undo/redo/clear
    const tools = h("div.c3-seg", { role: "radiogroup", "aria-label": "Tool" });
    for (const [id, label] of [
      ["pen", "Pen"],
      ["marker", "Marker"],
      ["eraser", "Eraser"],
    ] as const) {
      const b = h("button.c3-seg-btn", { type: "button", role: "radio", "data-tool": id }, label);
      b.addEventListener("click", () => this.setTool(id));
      tools.append(b);
    }
    const swatches = h("div.c3-pens", { role: "radiogroup", "aria-label": "Pen colour" });
    for (const c of PEN_COLORS) {
      const b = h("button.c3-pen", { type: "button", role: "radio", title: c.name, "aria-label": c.name, "data-color": c.value });
      b.style.setProperty("--pen", c.value);
      b.addEventListener("click", () => this.setColor(c.value));
      swatches.append(b);
    }
    const custom = h("input.c3-pen-custom", { type: "color", value: "#ff9eed", title: "Custom colour", "aria-label": "Custom colour" });
    custom.addEventListener("input", () => this.setColor(custom.value));
    swatches.append(custom);
    const size = h("input", { type: "range", min: 1, max: 80, value: this.size, "aria-label": "Brush size" });
    const sizeOut = h("output.c3-size-out", { text: `${this.size}px` });
    size.addEventListener("input", () => {
      this.size = Number(size.value);
      sizeOut.textContent = `${this.size}px`;
    });
    this.undoBtn = button("Undo", () => this.undo(), "ghost");
    this.redoBtn = button("Redo", () => this.redo(), "ghost");
    const clear = button(
      "Clear",
      () => {
        if (!this.strokes.length) return;
        this.redoStack = [...this.strokes].reverse();
        this.strokes = [];
        this.replay();
      },
      "ghost",
    );

    const keep = h("input", { type: "checkbox", checked: true });
    keep.addEventListener("change", () => {
      this.keepBase = keep.checked;
      this.paint();
    });
    this.keepToggle = h("label.c3-check", {}, keep, " Draw over the current artwork");

    this.shell.body.append(
      h("div.c3-draw-bar", {}, tools, swatches, h("label.c3-size", {}, "Size", size, sizeOut), h("span.c3-grow"), this.undoBtn, this.redoBtn, clear),
      h("div.c3-draw-stage", {}, this.view),
      this.keepToggle,
    );
    this.shell.footer.append(
      h("span.c3-grow", {}, h("small.c3-muted", { text: "The drawing is flattened into this side's artwork when you apply it." })),
      button("Cancel", () => this.shell.close()),
      button("Apply to card", () => this.finish(), "primary"),
    );
    this.shell.dialog.addEventListener("close", () => this.settle(null));
    this.shell.dialog.addEventListener("keydown", (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) this.redo();
      else this.undo();
    });
    this.bindPointer();
    this.setTool("pen");
    this.setColor(this.color);
  }

  /** Open for a side; resolves with the flattened image, or null when cancelled. */
  async open(side: Side, currentArtwork: string | undefined): Promise<DrawResult | null> {
    this.side = side;
    this.title.textContent = `Draw on the ${side}`;
    this.strokes = [];
    this.redoStack = [];
    this.base = null;
    if (currentArtwork) {
      try {
        this.base = await loadImage(currentArtwork);
      } catch {
        this.base = null;
      }
    }
    this.keepToggle.hidden = !this.base;
    this.replay();
    this.shell.open();
    return new Promise((r) => (this.resolve = r));
  }

  private settle(r: DrawResult | null): void {
    const fn = this.resolve;
    this.resolve = null;
    fn?.(r);
  }

  private finish(): void {
    const out = document.createElement("canvas");
    out.width = FACE_W;
    out.height = FACE_H;
    const ctx = out.getContext("2d")!;
    const withBase = this.base && this.keepBase;
    if (withBase) ctx.drawImage(this.base!, 0, 0, FACE_W, FACE_H);
    ctx.drawImage(this.ink, 0, 0);
    // Photos compress far better as WebP; a bare drawing is mostly transparent, so PNG stays small.
    const dataUrl = withBase && canEncodeWebp() ? out.toDataURL("image/webp", 0.92) : out.toDataURL("image/png");
    this.settle({ dataUrl });
    this.shell.close();
  }

  private setTool(t: Tool): void {
    this.tool = t;
    for (const b of this.shell.body.querySelectorAll<HTMLElement>("[data-tool]")) {
      const on = b.dataset.tool === t;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-checked", String(on));
    }
    this.view.dataset.tool = t;
  }

  private setColor(c: string): void {
    this.color = c;
    if (this.tool === "eraser") this.setTool("pen");
    for (const b of this.shell.body.querySelectorAll<HTMLElement>("[data-color]")) {
      const on = b.dataset.color === c;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-checked", String(on));
    }
  }

  private undo(): void {
    const s = this.strokes.pop();
    if (s) this.redoStack.push(s);
    this.replay();
  }

  private redo(): void {
    const s = this.redoStack.pop();
    if (s) this.strokes.push(s);
    this.replay();
  }

  private bindPointer(): void {
    const pos = (e: PointerEvent) => {
      const r = this.view.getBoundingClientRect();
      return {
        x: ((e.clientX - r.left) / r.width) * FACE_W,
        y: ((e.clientY - r.top) / r.height) * FACE_H,
        p: e.pointerType === "pen" ? Math.max(0.15, e.pressure || 0.5) : 1,
      };
    };
    this.view.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      this.view.setPointerCapture(e.pointerId);
      this.live = { tool: this.tool, color: this.color, size: this.size, points: [pos(e)] };
      this.redoStack = [];
      this.drawStroke(this.ictx, this.live, true);
      this.paint();
    });
    this.view.addEventListener("pointermove", (e) => {
      if (!this.live) return;
      const evs = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [e];
      for (const ce of evs.length ? evs : [e]) this.live.points.push(pos(ce));
      this.ictx.clearRect(0, 0, FACE_W, FACE_H);
      this.ictx.drawImage(this.committed, 0, 0);
      this.drawStroke(this.ictx, this.live, true);
      this.paint();
    });
    const end = () => {
      if (!this.live) return;
      this.strokes.push(this.live);
      this.live = null;
      this.replay();
    };
    this.view.addEventListener("pointerup", end);
    this.view.addEventListener("pointercancel", end);
  }

  private drawStroke(ctx: CanvasRenderingContext2D, s: Stroke, _live: boolean): void {
    const pts = s.points;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.globalCompositeOperation = s.tool === "eraser" ? "destination-out" : "source-over";
    ctx.strokeStyle = s.tool === "eraser" ? "#000" : s.color;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.globalAlpha = s.tool === "marker" ? 0.45 : 1;
    const width = (p: number) => (s.tool === "marker" ? s.size * 2.2 : s.size) * p;
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, width(pts[0].p) / 2, 0, Math.PI * 2);
      ctx.fill();
    } else if (s.tool === "marker") {
      // One path so overlapping segments don't stack alpha.
      ctx.lineWidth = width(1);
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i].x + pts[i + 1].x) / 2;
        const my = (pts[i].y + pts[i + 1].y) / 2;
        ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
      }
      ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
      ctx.stroke();
    } else {
      // Segment by segment so pen pressure can vary the width along the stroke.
      let prev = pts[0];
      let prevMid = pts[0];
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i];
        const mid = { x: (prev.x + p.x) / 2, y: (prev.y + p.y) / 2, p: (prev.p + p.p) / 2 };
        ctx.lineWidth = width(mid.p);
        ctx.beginPath();
        ctx.moveTo(prevMid.x, prevMid.y);
        ctx.quadraticCurveTo(prev.x, prev.y, mid.x, mid.y);
        ctx.stroke();
        prevMid = mid;
        prev = p;
      }
      ctx.lineWidth = width(prev.p);
      ctx.beginPath();
      ctx.moveTo(prevMid.x, prevMid.y);
      ctx.lineTo(prev.x, prev.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Re-render the ink layer from the committed strokes. */
  private replay(paint = true): void {
    this.cctx.clearRect(0, 0, FACE_W, FACE_H);
    for (const s of this.strokes) this.drawStroke(this.cctx, s, false);
    this.ictx.clearRect(0, 0, FACE_W, FACE_H);
    this.ictx.drawImage(this.committed, 0, 0);
    this.undoBtn.disabled = !this.strokes.length;
    this.redoBtn.disabled = !this.redoStack.length;
    if (paint) this.paint();
  }

  /** Compose the visible canvas: metal-ish backdrop, artwork, ink, then guides. */
  private paint(): void {
    const c = this.vctx;
    c.clearRect(0, 0, FACE_W, FACE_H);
    const g = c.createLinearGradient(0, 0, FACE_W, FACE_H);
    g.addColorStop(0, "#9ea3a6");
    g.addColorStop(0.5, "#d9dcdc");
    g.addColorStop(1, "#8e9396");
    c.fillStyle = g;
    c.fillRect(0, 0, FACE_W, FACE_H);
    if (this.base && this.keepBase) c.drawImage(this.base, 0, 0, FACE_W, FACE_H);
    c.drawImage(this.ink, 0, 0);
    this.paintGuides(c);
  }

  private paintGuides(c: CanvasRenderingContext2D): void {
    c.save();
    c.setLineDash([10, 8]);
    c.lineWidth = 2;
    c.strokeStyle = "rgba(20, 22, 26, 0.35)";
    if (this.side === "front") {
      // The public card's layout (ISO): the chip plate on the ISO/IEC 7816-2 contacts, the corner mark,
      // and ISO/IEC 7811-1's number and name areas. mm → px over the 85.60 × 53.98 mm face.
      const sx = FACE_W / 85.6;
      const sy = FACE_H / 53.98;
      const P = ISO_CHIP_PLATE_MM;
      roundRect(c, P.x0 * sx, P.y0 * sy, (P.x1 - P.x0) * sx, (P.y1 - P.y0) * sy, ISO_CHIP_PLATE.cornerRadius * sx);
      c.stroke();
      roundRect(c, 0.055 * FACE_W, 0.075 * FACE_H, 0.08 * FACE_W, 0.11 * FACE_H, 8);
      c.stroke();
      for (const a of [ISO_7811_AREAS.number, ISO_7811_AREAS.name]) {
        c.strokeRect(a.x0 * sx, a.y0 * sy, (a.x1 - a.x0) * sx, (a.y1 - a.y0) * sy);
      }
    }
    c.restore();
  }
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  c.beginPath();
  c.roundRect(x, y, w, h, r);
}
