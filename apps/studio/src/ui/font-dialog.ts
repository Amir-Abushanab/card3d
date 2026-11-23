/**
 * "Custom font…": the card font from outside the catalog, from one of three sources: an uploaded
 * file (embedded in the design), any Google Fonts family by name, or a web font URL. The preview
 * loads the font through @card3d/core's `loadCustomFont`, the cache the card itself uses, so Apply
 * shows it at once; an upload is accepted only once the browser has actually loaded it.
 */
import {
  CUSTOM_FONT_LIMITS,
  CUSTOM_FONT_WEIGHT,
  familyFromFileName,
  loadCustomFont,
  sanitizeCustomFont,
  sanitizeFontLabel,
  sanitizeFontUrl,
  sanitizeGoogleFamily,
  type CardCustomFont,
  type CustomFontSource,
} from "@card3d/core/model";
import { button, createDialog } from "./dialog.ts";
import { h, pickFiles } from "./dom.ts";

const TABS: { id: CustomFontSource; label: string }[] = [
  { id: "upload", label: "Upload" },
  { id: "google", label: "Google Fonts" },
  { id: "url", label: "URL" },
];
const SOURCE_LABEL: Record<CustomFontSource, string> = { upload: "uploaded file", google: "Google Fonts", url: "web font" };
const WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900];
const RIGHTS = "Only use a font you have the right to use: check its licence.";
const FONT_FILE_ACCEPT = ".woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf";

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** The file's format from its first bytes (woff2, woff, TrueType, OpenType / CFF), or null. */
function sniffFont(bytes: Uint8Array): "woff2" | "woff" | "ttf" | "otf" | null {
  const tag = String.fromCharCode(...bytes.subarray(0, 4));
  if (tag === "wOF2") return "woff2";
  if (tag === "wOFF") return "woff";
  if (tag === "OTTO") return "otf";
  if (tag === "true" || (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0)) return "ttf";
  return null;
}

function base64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * An uploaded font file as a `CardCustomFont` (its data URL), after checking its size and format and
 * loading it with the FontFace API. Throws a message for the user when the file can't be used.
 */
async function fontFromFile(file: File, family?: string): Promise<CardCustomFont> {
  if (file.size > CUSTOM_FONT_LIMITS.uploadBytes) {
    throw new Error(
      `${file.name} is ${kb(file.size)}: a font embedded in a design can be up to ${kb(CUSTOM_FONT_LIMITS.uploadBytes)}. Try its woff2 version, or host it and use a URL.`,
    );
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const format = sniffFont(bytes);
  if (!format) throw new Error(`${file.name} isn't a font file (woff2, woff, ttf or otf).`);
  const font = sanitizeCustomFont({
    source: "upload",
    family: sanitizeFontLabel(family) ?? familyFromFileName(file.name),
    src: `data:font/${format};base64,${base64(bytes)}`,
  });
  if (!font?.src) throw new Error(`${file.name} couldn't be read as a font.`);
  const r = await loadCustomFont(font);
  if (!r.ok) throw new Error(`${file.name} isn't a font this browser can load.`);
  return font;
}

export class FontDialog {
  private readonly shell = createDialog("Custom font", { className: "c3-font-dialog", onClose: () => this.settle(null) });
  private readonly tabs: HTMLDivElement;
  private readonly panes: Record<CustomFontSource, HTMLDivElement>;
  private readonly rights: HTMLParagraphElement;
  private readonly preview: HTMLDivElement;
  private readonly previewName: HTMLDivElement;
  private readonly status: HTMLParagraphElement;
  private readonly apply: HTMLButtonElement;
  // Upload
  private readonly fileLabel: HTMLSpanElement;
  private readonly uploadFamily: HTMLInputElement;
  private upload: CardCustomFont | null = null;
  // Google Fonts
  private readonly googleFamily: HTMLInputElement;
  private readonly googleWeight: HTMLSelectElement;
  // URL
  private readonly url: HTMLInputElement;
  private readonly urlFamily: HTMLInputElement;
  private urlFamilyEdited = false;

  private tab: CustomFontSource = "google";
  private candidate: CardCustomFont | null = null;
  private seq = 0;
  private timer = 0;
  private resolve: ((f: CardCustomFont | null) => void) | null = null;

  constructor(private readonly sampleText: () => string) {
    this.tabs = h("div.c3-tabs", { role: "tablist", "aria-label": "Font source" });
    for (const t of TABS) {
      const b = h("button.c3-tab", { type: "button", role: "tab", "data-id": t.id }, t.label);
      b.addEventListener("click", () => this.show(t.id));
      this.tabs.append(b);
    }

    // Upload
    this.fileLabel = h("span.c3-muted", { text: "woff2, woff, ttf or otf, up to " + kb(CUSTOM_FONT_LIMITS.uploadBytes) });
    const choose = button("Choose font file…", () => void this.chooseFile());
    this.uploadFamily = input("Family name", "e.g. Brand Sans");
    this.uploadFamily.addEventListener("input", () => {
      if (!this.upload) return;
      this.upload = { ...this.upload, family: sanitizeFontLabel(this.uploadFamily.value) ?? this.upload.family };
      if (this.tab === "upload") void this.check();
    });
    const uploadPane = h("div.c3-font-pane", {}, h("div.c3-font-file", {}, choose, this.fileLabel), field("Name", this.uploadFamily));

    // Google Fonts
    this.googleFamily = input("Google Fonts family", "e.g. Fraunces");
    this.googleWeight = h("select.c3-input", { "aria-label": "Weight" });
    for (const w of WEIGHTS) this.googleWeight.append(h("option", { value: String(w), text: String(w) }));
    this.googleWeight.value = String(CUSTOM_FONT_WEIGHT);
    for (const el of [this.googleFamily, this.googleWeight]) el.addEventListener("input", () => this.schedule());
    const googlePane = h(
      "div.c3-font-pane",
      {},
      h("div.c3-font-row", {}, field("Family", this.googleFamily), field("Weight", this.googleWeight)),
      h(
        "p.c3-muted",
        {},
        "The family's name as ",
        h("a", { href: "https://fonts.google.com/", target: "_blank", rel: "noopener noreferrer", text: "fonts.google.com" }),
        " lists it. Google Fonts are open-licensed; the card loads it from fonts.googleapis.com when it's shown.",
      ),
    );

    // URL
    this.url = input("Font URL", "https://example.com/fonts/brand.woff2");
    this.url.type = "url";
    this.urlFamily = input("Family name", "e.g. Brand Sans");
    this.url.addEventListener("input", () => {
      if (!this.urlFamilyEdited) {
        const src = sanitizeFontUrl(this.url.value);
        this.urlFamily.value = src ? familyFromFileName(src) : "";
      }
      this.schedule();
    });
    this.urlFamily.addEventListener("input", () => {
      this.urlFamilyEdited = !!this.urlFamily.value.trim();
      this.schedule();
    });
    const urlPane = h(
      "div.c3-font-pane",
      {},
      field("URL", this.url),
      field("Name", this.urlFamily),
      h("p.c3-muted", { text: "An https link to a woff2, woff, ttf or otf file. Its server must allow cross-origin requests (CORS)." }),
    );

    this.panes = { upload: uploadPane, google: googlePane, url: urlPane };
    this.rights = h("p.c3-muted.c3-font-rights", { text: RIGHTS });
    this.previewName = h("div.c3-font-preview-name");
    this.preview = h("div.c3-font-preview", { "aria-live": "polite" }, this.previewName, h("div.c3-font-preview-sample", { text: "Aa Bb Cc 0123 &?" }));
    this.status = h("p.c3-muted.c3-font-status", { role: "status" });
    this.shell.body.append(this.tabs, uploadPane, googlePane, urlPane, this.rights, this.preview, this.status);
    this.apply = button("Use this font", () => this.candidate && this.settle(this.candidate), "primary");
    this.shell.footer.append(
      h("span.c3-grow"),
      button("Cancel", () => this.shell.close()),
      this.apply,
    );
    for (const el of [this.googleFamily, this.url, this.urlFamily]) {
      el.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        clearTimeout(this.timer);
        void this.check().then(() => this.candidate && this.settle(this.candidate));
      });
    }
  }

  /** Resolves with the chosen font, or null when cancelled. Starts on `current`'s source (or `tab`). */
  open(current: CardCustomFont | null, tab?: CustomFontSource): Promise<CardCustomFont | null> {
    this.resolve?.(null);
    this.upload = current?.source === "upload" && current.src ? current : null;
    this.uploadFamily.value = current?.source === "upload" ? current.family : "";
    this.fileLabel.textContent = this.upload
      ? `Current file (${kb(Math.round(((this.upload.src?.length ?? 0) * 3) / 4))})`
      : current?.source === "upload"
        ? "The file isn't in this design (links leave uploads out): choose it again."
        : `woff2, woff, ttf or otf, up to ${kb(CUSTOM_FONT_LIMITS.uploadBytes)}`;
    if (current?.source === "google") {
      this.googleFamily.value = current.family;
      this.googleWeight.value = String(current.weight ?? CUSTOM_FONT_WEIGHT);
    }
    if (current?.source === "url") {
      this.url.value = current.src ?? "";
      this.urlFamily.value = current.family;
      this.urlFamilyEdited = true;
    }
    this.previewName.textContent = this.sampleName();
    this.shell.open();
    this.show(tab ?? current?.source ?? this.tab);
    return new Promise((resolve) => (this.resolve = resolve));
  }

  private settle(font: CardCustomFont | null): void {
    const r = this.resolve;
    this.resolve = null;
    clearTimeout(this.timer);
    this.seq++;
    if (this.shell.dialog.open) this.shell.close();
    r?.(font);
  }

  private sampleName(): string {
    return (this.sampleText().trim() || "Ada Lovelace").toLocaleUpperCase();
  }

  private show(tab: CustomFontSource): void {
    this.tab = tab;
    for (const b of this.tabs.querySelectorAll<HTMLElement>(".c3-tab")) {
      const on = b.dataset.id === tab;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-selected", String(on));
    }
    for (const [id, pane] of Object.entries(this.panes)) pane.hidden = id !== tab;
    this.rights.hidden = tab === "google";
    void this.check();
    (tab === "google" ? this.googleFamily : tab === "url" ? this.url : null)?.focus();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.candidate = null;
    this.apply.disabled = true;
    this.timer = window.setTimeout(() => void this.check(), 450);
  }

  /** The font the active tab describes, or a reason it can't be used yet. */
  private wanted(): CardCustomFont | string {
    if (this.tab === "upload") return this.upload ?? "";
    if (this.tab === "google") {
      if (!this.googleFamily.value.trim()) return "";
      const family = sanitizeGoogleFamily(this.googleFamily.value);
      if (!family) return "Google Fonts family names have letters, digits and spaces only.";
      return sanitizeCustomFont({ source: "google", family, weight: Number(this.googleWeight.value) }) ?? "";
    }
    if (!this.url.value.trim()) return "";
    const src = sanitizeFontUrl(this.url.value);
    if (!src) return "Use an https link (no user name or password in it).";
    return sanitizeCustomFont({ source: "url", family: this.urlFamily.value, src }) ?? "";
  }

  /** Load the active tab's font and show it (or why it failed). */
  private async check(): Promise<void> {
    const mine = ++this.seq;
    this.candidate = null;
    this.apply.disabled = true;
    this.preview.style.fontFamily = "";
    this.preview.classList.remove("is-loaded");
    const want = this.wanted();
    if (typeof want === "string") {
      this.status.textContent = want;
      this.status.classList.toggle("is-error", !!want);
      return;
    }
    this.status.classList.remove("is-error");
    this.status.textContent = `Loading ${want.family}…`;
    const r = await loadCustomFont(want);
    if (mine !== this.seq) return;
    if (!r.ok) {
      this.status.textContent = `Couldn't load ${want.family}: ${r.error}.`;
      this.status.classList.add("is-error");
      return;
    }
    this.preview.style.fontFamily = `"${r.family}", sans-serif`;
    this.preview.classList.add("is-loaded");
    this.status.textContent = `${want.family} · ${SOURCE_LABEL[want.source]}${want.weight ? ` · ${want.weight}` : ""}`;
    this.candidate = want;
    this.apply.disabled = false;
  }

  private async chooseFile(): Promise<void> {
    const [file] = await pickFiles(FONT_FILE_ACCEPT);
    if (!file) return;
    const mine = ++this.seq;
    this.status.classList.remove("is-error");
    this.status.textContent = `Reading ${file.name}…`;
    try {
      const font = await fontFromFile(file, this.uploadFamily.value);
      if (mine !== this.seq) return;
      this.upload = font;
      this.uploadFamily.value = font.family;
      this.fileLabel.textContent = `${file.name} (${kb(file.size)})`;
      await this.check();
    } catch (err) {
      if (mine !== this.seq) return;
      this.upload = null;
      this.candidate = null;
      this.apply.disabled = true;
      this.status.textContent = (err as Error).message;
      this.status.classList.add("is-error");
    }
  }
}

function input(label: string, placeholder: string): HTMLInputElement {
  return h("input.c3-input", { type: "text", "aria-label": label, placeholder, spellcheck: "false", autocomplete: "off" });
}

function field(label: string, control: HTMLElement): HTMLLabelElement {
  return h("label.c3-field", {}, h("span", { text: label }), control);
}
