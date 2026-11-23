/**
 * "Text lines" panel section: up to three extra lines of text (a card number, a validity date, a
 * title) rendered like the cardholder name, each with its own font, size, letter spacing, alignment
 * and placement. Quick-add buttons start from typical lines. The lines take the name's finish
 * (Identity → Finish).
 */
import type { FolderApi } from "tweakpane";
import { CARD_FONTS, TEXT_LINE_RANGES, type CardTextLine, type TextLinePlacement } from "@card3d/core/model";
import { buttonRow, note, segmented, type MountedBlock } from "./blocks.ts";
import type { SectionHost } from "./effects-section.ts";

const PLACEMENTS: { text: string; value: TextLinePlacement }[] = [
  { text: "Above the name", value: "bottom-left" },
  { text: "Bottom right", value: "bottom-right" },
  { text: "Centre", value: "center" },
  { text: "Top", value: "top" },
];

/** Typical lines (quick add). */
const LINE_TEMPLATES: { label: string; title: string; line: CardTextLine }[] = [
  { label: "＋ Card number", title: "A masked card number above the name", line: { text: "•••• 4242", size: 0.9, tracking: 0.12 } },
  { label: "＋ Valid thru", title: "An expiry date, bottom right", line: { text: "Valid thru 12/30", size: 0.55, tracking: 0.06, placement: "bottom-right" } },
  { label: "＋ Line", title: "An empty line", line: { text: "", size: 0.8 } },
];

type LineProxy = { text: string; font: string; size: number; tracking: number; placement: TextLinePlacement };

export class TextLinesSection {
  private folders: FolderApi[] = [];
  private blocks: MountedBlock[] = [];
  /** The lines as last rendered or written here (JSON), to spot outside changes (undo, loads). */
  private key = "";
  private readonly addRow: MountedBlock;
  private readonly addButtons: HTMLButtonElement[];

  constructor(
    private readonly f: FolderApi,
    private readonly host: SectionHost,
  ) {
    host.add(
      f,
      note(`Up to ${TEXT_LINE_RANGES.maxLines} extra lines, set like the name (upper case, the name's finish). Lines that share a placement stack in order.`),
    );
    const row = buttonRow(
      LINE_TEMPLATES.map((t) => ({
        label: t.label,
        title: t.title,
        onClick: () => this.addLine({ ...t.line }, t.label.replace("＋ ", "").toLowerCase()),
      })),
    );
    this.addRow = host.add(f, row);
    this.addButtons = [...row.el.querySelectorAll("button")];
    this.refresh();
  }

  private get lines(): CardTextLine[] {
    return this.host.design.textLines ?? [];
  }

  private addLine(line: CardTextLine, what: string): void {
    const d = this.host.design;
    if ((d.textLines?.length ?? 0) >= TEXT_LINE_RANGES.maxLines) return;
    d.textLines = [...(d.textLines ?? []), line];
    this.render();
    this.host.changed(`add ${what}`);
  }

  private removeLine(i: number): void {
    const d = this.host.design;
    const next = this.lines.filter((_, k) => k !== i);
    if (next.length) d.textLines = next;
    else delete d.textLines;
    this.render();
    this.host.changed("remove text line");
  }

  /** Writes a proxy back to line `i`, leaving defaults out. */
  private write(i: number, p: LineProxy, label?: string): void {
    const cur = this.lines[i];
    if (!cur) return;
    const line: CardTextLine = { text: p.text.replace(/[\r\n]+/g, " ").slice(0, TEXT_LINE_RANGES.maxChars) };
    if (p.font) line.font = p.font;
    if (Math.abs(p.size - 0.8) > 1e-3) line.size = Math.round(p.size * 100) / 100;
    if (Math.abs(p.tracking) > 1e-4) line.tracking = Math.round(p.tracking * 1000) / 1000;
    if (cur.align) line.align = cur.align;
    if (p.placement !== "bottom-left") line.placement = p.placement;
    const lines = [...this.lines];
    lines[i] = line;
    this.host.design.textLines = lines;
    this.key = JSON.stringify(lines);
    this.host.changed(label);
  }

  /** Rebuild the per-line folders (after an add / remove / undo). */
  private render(): void {
    for (const f of this.folders) f.dispose();
    this.folders = [];
    for (const b of this.blocks) b.blade.hidden = true;
    this.blocks = [];
    const lines = this.lines;
    this.key = JSON.stringify(lines);
    lines.forEach((line, i) => {
      const f = this.f.addFolder({ title: `Line ${i + 1}${line.text.trim() ? ` · ${line.text.trim().slice(0, 18)}` : ""}`, expanded: true });
      this.folders.push(f);
      const p: LineProxy = {
        text: line.text,
        font: line.font ?? "",
        size: line.size ?? 0.8,
        tracking: line.tracking ?? 0,
        placement: line.placement ?? "bottom-left",
      };
      const sync = (label?: string) => {
        if (!this.host.syncing()) this.write(i, p, label);
      };
      f.addBinding(p, "text", { label: "Text" }).on("change", () => {
        sync();
        f.title = `Line ${i + 1}${p.text.trim() ? ` · ${p.text.trim().slice(0, 18)}` : ""}`;
      });
      f.addBinding(p, "font", {
        label: "Font",
        options: [{ text: "Name's font", value: "" }, ...CARD_FONTS.map((x) => ({ text: x.label, value: x.id }))],
      }).on("change", () => sync("line font"));
      f.addBinding(p, "size", {
        label: "Size",
        min: TEXT_LINE_RANGES.size[0],
        max: TEXT_LINE_RANGES.size[1],
        step: 0.05,
        format: (v: number) => `${Math.round(v * 100)}%`,
      }).on("change", () => sync());
      f.addBinding(p, "tracking", {
        label: "Tracking",
        min: TEXT_LINE_RANGES.tracking[0],
        max: TEXT_LINE_RANGES.tracking[1],
        step: 0.01,
        format: (v: number) => `${v.toFixed(2)} em`,
      }).on("change", () => sync());
      f.addBinding(p, "placement", { label: "Place", options: PLACEMENTS }).on("change", () => sync("line placement"));
      this.blocks.push(
        this.host.add(
          f,
          segmented<NonNullable<CardTextLine["align"]> | "auto">(
            "Align",
            [
              { value: "auto", label: "Auto", title: "By placement: left above the name, centred in the middle, right otherwise" },
              { value: "left", label: "Left" },
              { value: "center", label: "Centre" },
              { value: "right", label: "Right" },
            ],
            () => this.lines[i]?.align ?? "auto",
            (v) => {
              const lines = [...this.lines];
              const cur = lines[i];
              if (!cur) return;
              const next = { ...cur };
              if (v === "auto") delete next.align;
              else next.align = v;
              lines[i] = next;
              this.host.design.textLines = lines;
              this.key = JSON.stringify(lines);
              this.host.changed(`align ${v}`);
            },
          ),
        ),
      );
      this.blocks.push(this.host.add(f, buttonRow([{ label: "Remove line", className: "c3-mini--danger", onClick: () => this.removeLine(i) }])));
    });
    for (const b of this.addButtons) b.disabled = lines.length >= TEXT_LINE_RANGES.maxLines;
    this.addRow.blade.hidden = false;
  }

  refresh(): void {
    // Rebuild when the lines changed outside (undo, load, preset); edits made here keep their folders.
    if (JSON.stringify(this.lines) !== this.key) this.render();
    else for (const b of this.blocks) b.refresh();
  }
}
