/**
 * A native `<dialog>` shell: title bar with a close button, a body and a footer. Styling lives in
 * style.css (`.c3-dialog`).
 */
import { h } from "./dom.ts";

export interface DialogShell {
  dialog: HTMLDialogElement;
  body: HTMLDivElement;
  footer: HTMLDivElement;
  open(): void;
  close(): void;
}

export function createDialog(title: string, opts: { wide?: boolean; className?: string; onClose?: () => void } = {}): DialogShell {
  const dialog = h("dialog.c3-dialog", { "aria-label": title });
  if (opts.wide) dialog.classList.add("c3-dialog--wide");
  if (opts.className) dialog.classList.add(opts.className);
  const close = h("button.c3-dialog-x", { type: "button", "aria-label": "Close", title: "Close" }, "×");
  const head = h("header.c3-dialog-hd", {}, h("h2", { text: title }), close);
  const body = h("div.c3-dialog-bd");
  const footer = h("div.c3-dialog-ft");
  dialog.append(head, body, footer);
  close.addEventListener("click", () => dialog.close());
  // Click on the backdrop closes (the dialog element itself is the backdrop hit target).
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", () => opts.onClose?.());
  document.body.append(dialog);
  return {
    dialog,
    body,
    footer,
    open: () => {
      if (!dialog.open) dialog.showModal();
    },
    close: () => dialog.close(),
  };
}

export function button(label: string, onClick: () => void, variant: "primary" | "ghost" | "danger" | "" = ""): HTMLButtonElement {
  const b = h("button.c3-btn", { type: "button" }, label);
  if (variant) b.classList.add(`c3-btn--${variant}`);
  b.addEventListener("click", onClick);
  return b;
}

/** Briefly swap a button's label to confirm an action (wave3d's flashButtonSuccess). */
export function flash(el: HTMLElement, text: string, ms = 1400): void {
  const target = (el.querySelector(".tp-btnv_t") as HTMLElement | null) ?? el;
  const prev = target.dataset.label ?? target.textContent ?? "";
  target.dataset.label = prev;
  target.textContent = text;
  el.classList.add("c3-flash");
  window.setTimeout(() => {
    target.textContent = target.dataset.label ?? prev;
    delete target.dataset.label;
    el.classList.remove("c3-flash");
  }, ms);
}
