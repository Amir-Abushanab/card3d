/**
 * "Import recipe" dialog: paste recipe JSON (a bare recipe, or `{ recipe, … }`, or a
 * full design) and apply it. Finish-only recipes keep the current identity, artwork and stickers.
 */
import { DEFAULT_RECIPE, type CardDesign } from "@card3d/core/model";
import { cloneDesign, ensureDesign } from "../state/design.ts";
import { button, createDialog } from "./dialog.ts";
import { h, pickFiles } from "./dom.ts";

const EXAMPLE = JSON.stringify({ ...DEFAULT_RECIPE, material: "brass", color: "#e39a4a", texture: "guilloche", pattern: "orbit" }, null, 2);

export class ImportDialog {
  private readonly shell = createDialog("Import recipe", { wide: true });
  private readonly area: HTMLTextAreaElement;
  private readonly error: HTMLParagraphElement;
  private readonly keep: HTMLInputElement;

  constructor(
    private readonly getDesign: () => CardDesign,
    private readonly apply: (d: CardDesign) => void,
  ) {
    this.area = h("textarea.c3-textarea", {
      spellcheck: "false",
      rows: 16,
      placeholder: `Paste a recipe or card design JSON, e.g.\n${EXAMPLE}`,
      "aria-label": "Recipe JSON",
    });
    this.error = h("p.c3-error", { role: "alert" });
    this.keep = h("input", { type: "checkbox", checked: true });
    this.shell.body.append(
      h("p.c3-muted", {
        text: "Accepts a bare recipe ({ material, color, grain, … }), a { recipe, cardholderName, decals, … } document, or a saved .card.json.",
      }),
      this.area,
      h("label.c3-check", {}, this.keep, " Keep my name, artwork and stickers when the JSON only has a recipe"),
      this.error,
    );
    const fromFile = button(
      "Open file…",
      async () => {
        const [file] = await pickFiles("application/json,.json");
        if (file) this.area.value = await file.text();
      },
      "ghost",
    );
    this.shell.footer.append(
      fromFile,
      h("span.c3-grow"),
      button("Cancel", () => this.shell.close()),
      button("Import", () => this.submit(), "primary"),
    );
    this.area.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") this.submit();
    });
  }

  open(): void {
    this.error.textContent = "";
    this.shell.open();
    this.area.focus();
  }

  private submit(): void {
    try {
      const raw = JSON.parse(this.area.value) as Record<string, unknown>;
      const parsed = ensureDesign(raw);
      const recipeOnly = !("cardholderName" in raw) && !("decals" in raw) && !("surfaceSources" in raw);
      let next = parsed;
      if (recipeOnly && this.keep.checked) {
        next = cloneDesign(this.getDesign());
        next.recipe = parsed.recipe;
      }
      this.apply(next);
      this.shell.close();
    } catch (err) {
      this.error.textContent = err instanceof SyntaxError ? `That isn't valid JSON: ${err.message}` : String((err as Error).message ?? err);
    }
  }
}
