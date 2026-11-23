/**
 * "View in AR" dialog. The model is baked from the current design (core `loadCardAr()`, loaded only
 * when this opens) at its real size:
 * - iOS / iPadOS: an AR Quick Look link (`<a rel="ar">` around an image) to the USDZ, made in the page;
 * - Android: Scene Viewer opens a GLB from a public https link only (it downloads the file itself), so
 *   the dialog offers the GLB and opens Scene Viewer on a link to a hosted copy;
 * - desktop: no AR; the USDZ and GLB as downloads, and where to open them.
 */
import { arSupport, sceneViewerUrl } from "@card3d/core/model";
import { button, createDialog } from "./dialog.ts";
import { downloadBlob, h } from "./dom.ts";

export interface ArDialogDeps {
  usdz(): Promise<Blob>;
  glb(): Promise<Blob>;
  /** Download file name without extension. */
  fileBase(): string;
  /** A short name for Scene Viewer's title bar. */
  title(): string;
}

const LIMITS =
  "Real size: 85.6 × 54 × 0.76 mm (portrait and card shapes included), lying face up. Holo foils and face shaders are baked into a static texture (their look face-on), animated cards export the frame on screen, and glass exports semi-transparent.";

export class ArDialog {
  private readonly shell = createDialog("View in AR", { className: "c3-ar-dialog" });
  private readonly status: HTMLParagraphElement;
  private readonly actions: HTMLDivElement;
  private usdzUrl: string | null = null;
  private token = 0;

  constructor(private readonly deps: ArDialogDeps) {
    this.status = h("p.c3-muted", { role: "status" });
    this.actions = h("div.c3-ar-actions");
    this.shell.body.append(this.status, this.actions, h("p.c3-note", { text: LIMITS }));
    this.shell.dialog.addEventListener("close", () => this.release());
  }

  async open(): Promise<void> {
    const mine = ++this.token;
    this.release();
    this.actions.replaceChildren();
    this.shell.open();
    const support = arSupport();
    if (support.quickLook) return this.quickLook(mine);
    if (support.sceneViewer) return this.sceneViewer();
    this.desktop();
  }

  private async quickLook(mine: number): Promise<void> {
    this.status.textContent = "Preparing the model…";
    try {
      const blob = await this.deps.usdz();
      if (mine !== this.token) return;
      this.usdzUrl = URL.createObjectURL(blob);
      // Quick Look takes over a tap on a rel="ar" link that wraps an image.
      const link = h(
        "a.c3-btn c3-btn--primary c3-ar-link",
        { rel: "ar", href: `${this.usdzUrl}#allowsContentScaling=0` },
        h("img", { alt: "", width: 1, height: 1 }),
        "Open in AR",
      );
      this.status.textContent = "Tap Open in AR to place the card on a table at its real size.";
      this.actions.replaceChildren(link, this.download("usdz"));
    } catch (err) {
      this.status.textContent = `Couldn't make the model: ${(err as Error).message}`;
    }
  }

  private sceneViewer(): void {
    this.status.textContent =
      "Scene Viewer opens a model from a public link only. Download the .glb, put it on any https host, paste its link and open it in AR.";
    const input = h("input.c3-input", { type: "url", placeholder: "https://…/card.glb", "aria-label": "Link to the hosted .glb" });
    const open = button(
      "Open in Scene Viewer",
      () => {
        const url = input.value.trim();
        if (!/^https:\/\/\S+$/i.test(url)) {
          this.status.textContent = "Scene Viewer needs an https link to the .glb.";
          return;
        }
        location.href = sceneViewerUrl(url, { title: this.deps.title(), fallbackUrl: location.href });
      },
      "primary",
    );
    this.actions.replaceChildren(this.download("glb"), h("div.c3-ar-link-row", {}, input, open));
  }

  private desktop(): void {
    this.status.textContent =
      "AR needs a phone or tablet. On an iPhone or iPad, open this page in Safari and choose View in AR: the card appears on your table at its real size. On Android, Scene Viewer opens the .glb from a public link. Here, download the models: the .usdz opens in Quick Look on a Mac (select it and press Space) and in Reality Composer, the .glb in any glTF viewer.";
    this.actions.replaceChildren(this.download("usdz"), this.download("glb"));
  }

  private download(kind: "usdz" | "glb"): HTMLButtonElement {
    const b = button(`Download .${kind}`, async () => {
      b.disabled = true;
      const label = b.textContent;
      b.textContent = "Preparing…";
      try {
        const blob = await (kind === "usdz" ? this.deps.usdz() : this.deps.glb());
        downloadBlob(blob, `${this.deps.fileBase()}-ar.${kind}`);
      } catch (err) {
        this.status.textContent = `Couldn't make the model: ${(err as Error).message}`;
      } finally {
        b.disabled = false;
        b.textContent = label;
      }
    });
    b.dataset.kind = kind;
    return b;
  }

  private release(): void {
    if (this.usdzUrl) URL.revokeObjectURL(this.usdzUrl);
    this.usdzUrl = null;
  }
}
