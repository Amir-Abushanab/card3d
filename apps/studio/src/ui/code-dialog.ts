/**
 * "Export code" dialog: framework tabs, the snippet, Copy / Download. (wave3d's CodeExportDialog,
 * minus syntax highlighting.)
 */
import type { CardDesign } from "@card3d/core/model";
import { CODE_TARGETS, generateSnippet, type CodeTarget } from "../export/code.ts";
import { button, createDialog, flash } from "./dialog.ts";
import { downloadText, h } from "./dom.ts";

export class CodeDialog {
  private readonly shell = createDialog("Export code", { wide: true });
  private readonly tabs: HTMLDivElement;
  private readonly pre: HTMLPreElement;
  private readonly note: HTMLParagraphElement;
  private target: CodeTarget = "vanilla";

  constructor(private readonly getDesign: () => CardDesign) {
    this.tabs = h("div.c3-tabs", { role: "tablist" });
    for (const t of CODE_TARGETS) {
      const b = h("button.c3-tab", { type: "button", role: "tab", "data-id": t.id }, t.label);
      b.addEventListener("click", () => {
        this.target = t.id;
        this.render();
      });
      this.tabs.append(b);
    }
    this.pre = h("pre.c3-code");
    this.note = h("p.c3-note");
    this.shell.body.append(this.tabs, h("div.c3-code-wrap", {}, this.pre), this.note);
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
      const t = CODE_TARGETS.find((x) => x.id === this.target)!;
      downloadText(this.pre.textContent ?? "", t.file);
    });
    this.shell.footer.append(
      h(
        "span.c3-grow",
        {},
        h("small.c3-muted", { text: "Uses the card engine's createEngineStage API. For a drop-in element or React component, use Embed…" }),
      ),
      dl,
      copy,
    );
  }

  open(): void {
    this.render();
    this.shell.open();
  }

  private render(): void {
    for (const b of this.tabs.querySelectorAll<HTMLElement>(".c3-tab")) {
      const on = b.dataset.id === this.target;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-selected", String(on));
    }
    const { code, placeholders } = generateSnippet(this.getDesign(), this.target);
    this.pre.textContent = code;
    this.note.textContent = placeholders.length
      ? `⚠ ${placeholders.length} uploaded image${placeholders.length > 1 ? "s were" : " was"} replaced with placeholder paths — export them from the Artwork/Stickers sections and host them yourself.`
      : "";
    this.note.hidden = !placeholders.length;
  }
}
