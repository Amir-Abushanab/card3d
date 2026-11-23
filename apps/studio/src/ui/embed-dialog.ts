/**
 * "Embed" dialog: the current design as a drop-in `<metal-card>` (CDN or npm) or React `<MetalCard>`
 * snippet (export/embed.ts), with Copy / Download and what happened to uploaded images.
 */
import type { CardDesign } from "@card3d/core/model";
import { EMBED_INLINE_LIMIT, EMBED_TARGETS, generateEmbed, type EmbedMedia, type EmbedTarget } from "../export/embed.ts";
import { button, createDialog, flash } from "./dialog.ts";
import { downloadText, h } from "./dom.ts";

const kb = (chars: number) => `${Math.max(1, Math.round(chars / 1024))} KB`;

export class EmbedDialog {
  private readonly shell = createDialog("Embed", { wide: true, className: "c3-embed-dialog" });
  private readonly tabs: HTMLDivElement;
  private readonly pre: HTMLPreElement;
  private readonly info: HTMLParagraphElement;
  private readonly warn: HTMLParagraphElement;
  private readonly compact: HTMLInputElement;
  private target: EmbedTarget = "cdn";
  private renderToken = 0;

  constructor(private readonly getDesign: () => CardDesign) {
    this.tabs = h("div.c3-tabs", { role: "tablist", "aria-label": "Embed with" });
    for (const t of EMBED_TARGETS) {
      const b = h("button.c3-tab", { type: "button", role: "tab", "data-id": t.id }, t.label);
      b.addEventListener("click", () => {
        this.target = t.id;
        void this.render();
      });
      this.tabs.append(b);
    }
    this.compact = h("input", { type: "checkbox" });
    this.compact.addEventListener("change", () => void this.render());
    this.pre = h("pre.c3-code", { "aria-label": "Embed snippet" });
    this.info = h("p.c3-muted");
    this.warn = h("p.c3-note", { role: "status" });
    this.shell.body.append(
      h("p.c3-muted", {
        text: 'Put this card on any page. The snippet carries the design; size the card with CSS. Drag to turn, click to flip; add auto-rotate, interaction="turntable", lazy, quality… (see the @card3d/element README).',
      }),
      this.tabs,
      h("div.c3-code-wrap", {}, this.pre),
      h("label.c3-check", {}, this.compact, " Compact: the design as a share token (shorter; leaves uploaded artwork, stickers and font files out)"),
      this.warn,
      this.info,
    );
    const copy = button(
      "Copy",
      async () => {
        try {
          await navigator.clipboard.writeText(this.pre.textContent ?? "");
          flash(copy, "Copied");
        } catch {
          flash(copy, "Select & copy");
        }
      },
      "primary",
    );
    const dl = button("Download file", () => {
      const t = EMBED_TARGETS.find((x) => x.id === this.target)!;
      downloadText(this.pre.textContent ?? "", t.file);
    });
    this.shell.footer.append(
      h("span.c3-grow", {}, h("small.c3-muted", { text: "The @card3d packages aren't on npm yet: these snippets use the names and CDN URL they will have." })),
      dl,
      copy,
    );
  }

  open(): void {
    void this.render();
    this.shell.open();
  }

  private async render(): Promise<void> {
    const mine = ++this.renderToken;
    for (const b of this.tabs.querySelectorAll<HTMLElement>(".c3-tab")) {
      const on = b.dataset.id === this.target;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-selected", String(on));
    }
    const { code, media, stripped } = await generateEmbed(this.getDesign(), this.target, { compact: this.compact.checked });
    if (mine !== this.renderToken) return;
    this.pre.textContent = code;
    const { warn, info } = describeMedia(media, this.compact.checked ? stripped : 0);
    this.warn.textContent = warn;
    this.warn.hidden = !warn;
    this.info.textContent = `${info}Snippet: ${kb(code.length)}.`;
  }
}

/** What the snippet did with the uploads: a warning for the ones left out, a note for the inlined ones. */
export function describeMedia(media: EmbedMedia[], stripped: number): { warn: string; info: string } {
  if (stripped) {
    const font = media.some((m) => m.what === "Font" && !m.inlined);
    const images = stripped - (font ? 1 : 0);
    const what = [
      images ? `${images} uploaded image${images > 1 ? "s" : ""} (artwork / stickers)` : "",
      font ? "the uploaded font file (the card shows Inter)" : "",
    ]
      .filter(Boolean)
      .join(" and ");
    return { warn: `⚠ The share token leaves out ${what}. Untick Compact to inline ${stripped > 1 ? "them" : "it"}.`, info: "" };
  }
  const out = media.filter((m) => !m.inlined);
  const inl = media.filter((m) => m.inlined);
  const warn = out.length
    ? `⚠ Too large to inline (over ${kb(EMBED_INLINE_LIMIT)} of uploads in total): ${out.map((m) => `${m.what} (${kb(m.chars)}) → ${m.placeholder}`).join(", ")}. Export ${out.length > 1 ? "them" : "it"} from the studio, host ${out.length > 1 ? "them" : "it"} at ${out.length > 1 ? "those paths" : "that path"}, or edit the path${out.length > 1 ? "s" : ""}.`
    : "";
  const info = inl.length ? `Inlined as data URLs: ${inl.map((m) => `${m.what} (${kb(m.chars)})`).join(", ")}. ` : "";
  return { warn, info };
}
