/**
 * Export → Print files…: the production package dialog (export/print/). Vendor profile, mode (payment
 * card program / non-payment card), resolution, bleed, safe zone, masks, the non-payment confirmations;
 * a preview of both sides with the dieline's guides and the preflight list, re-run as options change
 * (a quick bake at preview resolution); then the full package as a zip. Loaded on first use, with the
 * whole print export (pdf-lib included).
 */
import type { CardDesign } from "@card3d/core/model";
import { button, createDialog } from "./dialog.ts";
import { downloadBlob, h } from "./dom.ts";
import { PRINT_PRESETS, getPreset, type PrintMode } from "../export/print/vendors.ts";
import { defaultPrintOptions, type PreflightIssue, type PrintOptions } from "../export/print/preflight.ts";
import { analysePrint, buildPrintPackage, previewCanvas, type PrintAnalysis, type PrintDeps } from "../export/print/package.ts";

const PREVIEW_DPI = 100;

export interface PrintDialogDeps {
  design(): CardDesign;
  printDeps(): PrintDeps;
}

export class PrintDialog {
  private readonly shell = createDialog("Print files", { wide: true, className: "c3-print-dialog" });
  private options: PrintOptions = defaultPrintOptions(getPreset(null));
  private readonly form: HTMLDivElement;
  private readonly previews: HTMLDivElement;
  private readonly issues: HTMLUListElement;
  private readonly summary: HTMLParagraphElement;
  private readonly status: HTMLParagraphElement;
  private readonly presetInfo: HTMLDivElement;
  private readonly exportBtn: HTMLButtonElement;
  private analysis: PrintAnalysis | null = null;
  private token = 0;
  private timer = 0;
  private busy = false;
  private ctrl: AbortController | null = null;

  constructor(private readonly deps: PrintDialogDeps) {
    this.form = h("div.c3-print-form");
    this.previews = h("div.c3-print-previews", { "aria-label": "Preview with the dieline" });
    this.issues = h("ul.c3-print-issues", { "aria-label": "Preflight" });
    this.summary = h("p.c3-muted");
    this.status = h("p.c3-muted", { role: "status" });
    this.presetInfo = h("div.c3-print-preset");
    this.shell.body.append(
      h("p.c3-muted", {
        text: "Production artwork for a card maker: the flat artwork with bleed, one plate per process (engrave, etch, emboss, foil, spot UV…) as 1-bit PNG and SVG, the dieline with the ISO corners, cutouts and keep-outs, a print-ready PDF, a proof and spec.json.",
      }),
      h("div.c3-print-grid", {}, h("div.c3-print-left", {}, this.form, this.presetInfo), h("div.c3-print-right", {}, this.previews, this.summary, this.issues)),
    );
    this.exportBtn = button("Export print files", () => void this.export(), "primary");
    this.exportBtn.dataset.action = "export-print";
    this.shell.footer.append(
      h("span.c3-grow", {}, this.status),
      button("Close", () => this.shell.close()),
      this.exportBtn,
    );
    this.shell.dialog.addEventListener("close", () => this.ctrl?.abort());
    this.buildForm();
  }

  open(): void {
    this.shell.open();
    this.buildForm();
    this.schedule(0);
  }

  private set<K extends keyof PrintOptions>(key: K, value: PrintOptions[K]): void {
    this.options = { ...this.options, [key]: value };
    this.schedule();
  }

  private buildForm(): void {
    const o = this.options;
    const preset = getPreset(o.presetId);
    const font = this.deps.design().font;
    const customFont = !!font && typeof font === "object" && font.source !== "google";
    const select = (name: string, label: string, items: Array<[string, string]>, value: string, on: (v: string) => void) => {
      const s = h("select.c3-input", { name, "aria-label": label });
      for (const [v, t] of items) s.append(h("option", { value: v, text: t, ...(v === value ? { selected: true } : {}) }));
      s.addEventListener("change", () => on(s.value));
      return h("label.c3-field", {}, label, s);
    };
    const numberField = (name: string, label: string, value: number, min: number, max: number, on: (v: number) => void) => {
      const i = h("input.c3-input", { name, type: "number", min, max, step: 0.025, value: String(value), "aria-label": label });
      i.addEventListener("change", () => {
        const v = Math.min(max, Math.max(min, parseFloat(i.value)));
        if (Number.isFinite(v)) on(v);
      });
      return h("label.c3-field", {}, label, i);
    };
    const check = (name: string, label: string, value: boolean, on: (v: boolean) => void, hidden = false) => {
      const c = h("input", { type: "checkbox", name, ...(value ? { checked: true } : {}) });
      c.addEventListener("change", () => on(c.checked));
      return h("label.c3-check", hidden ? { hidden: true } : {}, c, label);
    };
    const mode = h("div.c3-print-mode", { role: "radiogroup", "aria-label": "Card type" });
    for (const [v, t, sub] of [
      ["payment", "Payment card program", "Strict ISO layout; for an issuer's printer (Stripe, Highnote…)."],
      ["non-payment", "Non-payment card", "Membership, NFC, gift or business cards: nothing that reads as a payment card."],
    ] as const) {
      const r = h("input", { type: "radio", name: "print-mode", value: v, ...(o.mode === v ? { checked: true } : {}) });
      r.addEventListener("change", () => {
        this.options = { ...this.options, mode: v as PrintMode, magstripe: v === "payment" && getPreset(this.options.presetId).magstripe };
        this.buildForm();
        this.schedule();
      });
      mode.append(h("label.c3-print-radio", {}, r, h("span", {}, h("b", { text: t }), h("small.c3-muted", { text: sub }))));
    }
    const np = o.mode === "non-payment";
    this.form.replaceChildren(
      select(
        "preset",
        "Vendor profile",
        PRINT_PRESETS.map((p) => [p.id, `${p.name}${p.status === "todo" ? " (specs not public)" : ""}`]),
        o.presetId,
        (id) => {
          const p = getPreset(id);
          this.options = {
            ...defaultPrintOptions(p),
            noNetworkMarks: this.options.noNetworkMarks,
            decorativeChip: this.options.decorativeChip,
            fontRights: this.options.fontRights,
            strip: this.options.strip,
          };
          this.buildForm();
          this.schedule();
        },
      ),
      mode,
      h(
        "div.c3-print-row",
        {},
        select(
          "dpi",
          "Resolution",
          [
            ["600", "600 dpi"],
            ["1200", "1200 dpi"],
            ["300", "300 dpi (draft)"],
          ],
          String(o.dpi),
          (v) => this.set("dpi", Number(v)),
        ),
        select(
          "masks",
          "Masks",
          [
            ["1", "1-bit"],
            ["8", "8-bit grey"],
          ],
          String(o.maskBits),
          (v) => this.set("maskBits", Number(v) as 1 | 8),
        ),
      ),
      h(
        "div.c3-print-row",
        {},
        numberField("bleed", "Bleed (mm)", o.bleedMm, 0, 6, (v) => this.set("bleedMm", v)),
        numberField("safe", "Safe zone (mm)", o.safeMm, 0, 8, (v) => this.set("safeMm", v)),
      ),
      check("magstripe", "Magnetic stripe on the back (ISO/IEC 7811-6)", o.magstripe, (v) => this.set("magstripe", v)),
      ...(np
        ? [
            check(
              "strip",
              "Leave payment-card features out of the files (contactless indicator, card numbers, expiry and security labels, network names)",
              o.strip,
              (v) => this.set("strip", v),
            ),
            check("decorative-chip", "The chip is a decorative or NFC module (not a payment chip)", o.decorativeChip, (v) => this.set("decorativeChip", v)),
            check("no-network-marks", "My logo, artwork and stickers show no payment network or bank marks", o.noNetworkMarks, (v) =>
              this.set("noNetworkMarks", v),
            ),
          ]
        : []),
      check(
        "font-rights",
        "I have the right to use my uploaded / linked font in printed products",
        o.fontRights,
        (v) => this.set("fontRights", v),
        !customFont,
      ),
    );
    this.presetInfo.replaceChildren(
      h("p.c3-muted", {
        text: `${preset.name}: ${preset.status === "published" ? "from the vendor's published specs" : preset.status === "partial" ? "partly from published specs" : "specs not public: generic values"}.`,
      }),
      ...preset.notes.map((n) => h("p.c3-muted", { text: `· ${n}` })),
      ...preset.todo.map((t) => h("p.c3-note", { text: `TODO: ${t}` })),
      h(
        "details",
        {},
        h("summary.c3-muted", { text: "Sources" }),
        ...preset.sources.map((s) =>
          h("p.c3-muted", {}, `[${s.grade}] `, s.url ? h("a", { href: s.url, target: "_blank", rel: "noopener", text: s.label }) : s.label),
        ),
      ),
    );
  }

  private schedule(ms = 250): void {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.analyse(), ms);
  }

  private async analyse(): Promise<void> {
    if (this.busy) return this.schedule(200);
    const mine = ++this.token;
    this.exportBtn.disabled = true;
    this.status.textContent = "Checking…";
    try {
      const a = await analysePrint(this.deps.design(), this.options, this.deps.printDeps(), PREVIEW_DPI);
      if (mine !== this.token) return;
      this.analysis = a;
      this.render(a);
    } catch (err) {
      if (mine !== this.token) return;
      this.status.textContent = `Couldn't prepare the preview: ${(err as Error).message}`;
    }
  }

  private render(a: PrintAnalysis): void {
    this.previews.replaceChildren(
      ...(["front", "back"] as const).map((side) => {
        const c = previewCanvas(a, side, 360);
        return h(
          "figure.c3-print-preview",
          { "data-side": side },
          c ?? "",
          h("figcaption.c3-muted", { text: side === "front" ? "Front" : "Back (seen from the back)" }),
        );
      }),
    );
    const n = (lv: PreflightIssue["level"]) => a.issues.filter((i) => i.level === lv).length;
    this.summary.textContent = `Preflight: ${n("error")} error${n("error") === 1 ? "" : "s"}, ${n("warning")} warning${n("warning") === 1 ? "" : "s"}, ${n("info")} note${n("info") === 1 ? "" : "s"}.${a.options.mode === "non-payment" ? ` Payment look-alike score ${a.lookalike.score.toFixed(2)}.` : ""}`;
    this.issues.replaceChildren(
      ...a.issues.map((i) =>
        h(
          "li",
          { "data-level": i.level, "data-rule": i.rule, ...(i.blocking ? { "data-blocking": "" } : {}) },
          h("span.c3-print-level", { text: i.blocking ? "Blocked" : i.level === "error" ? "Error" : i.level === "warning" ? "Warning" : "Note" }),
          i.message,
        ),
      ),
    );
    this.exportBtn.disabled = a.blocked || this.busy;
    this.status.textContent = a.blocked ? "Fix the blocked items (or change the options) to export." : "";
  }

  private async export(): Promise<void> {
    if (this.busy || !this.analysis || this.analysis.blocked) return;
    this.busy = true;
    this.exportBtn.disabled = true;
    this.ctrl = new AbortController();
    try {
      const deps = {
        ...this.deps.printDeps(),
        signal: this.ctrl.signal,
        onProgress: (f: number, label: string) => (this.status.textContent = `${label}… ${Math.round(f * 100)} %`),
      };
      const pkg = await buildPrintPackage(this.deps.design(), this.options, deps);
      downloadBlob(new Blob([pkg.zip], { type: "application/zip" }), pkg.name);
      this.status.textContent = `Saved ${pkg.name} (${Object.keys(pkg.files).length} files, ${(pkg.zip.byteLength / 1048576).toFixed(1)} MB).`;
      this.shell.dialog.dataset.exported = String(Object.keys(pkg.files).length);
    } catch (err) {
      this.status.textContent = (err as Error).name === "AbortError" ? "Cancelled." : `Export failed: ${(err as Error).message}`;
      console.error(err);
    } finally {
      this.busy = false;
      this.ctrl = null;
      this.exportBtn.disabled = !!this.analysis?.blocked;
    }
  }
}
