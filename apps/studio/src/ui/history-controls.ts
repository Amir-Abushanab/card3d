/**
 * Floating undo/redo cluster with a version list (bottom-left of the stage), after wave3d's
 * HistoryControls. A pure view: renders a `HistoryState`, reports intents through hooks.
 */
import type { HistoryState } from "../state/history.ts";
import { h, isMac } from "./dom.ts";

export interface HistoryHooks {
  onUndo(): void;
  onRedo(): void;
  onJump(id: number): void;
  onClear(): void;
}

const ICON = {
  undo: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>',
  redo: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/></svg>',
  list: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
};

function relTime(t: number): string {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 5) return "now";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`;
}

export class HistoryControls {
  readonly el: HTMLDivElement;
  private readonly undoBtn: HTMLButtonElement;
  private readonly redoBtn: HTMLButtonElement;
  private readonly listBtn: HTMLButtonElement;
  private readonly panel: HTMLDivElement;
  private readonly list: HTMLUListElement;
  private state: HistoryState = { canUndo: false, canRedo: false, entries: [] };
  private tick = 0;

  constructor(host: HTMLElement, hooks: HistoryHooks) {
    const mk = (icon: string, label: string, tip: string) => {
      const b = h("button.c3-hist-btn", { type: "button", "aria-label": label, title: tip, html: icon });
      return b;
    };
    this.undoBtn = mk(ICON.undo, "Undo", isMac ? "Undo · ⌘Z" : "Undo · Ctrl+Z");
    this.redoBtn = mk(ICON.redo, "Redo", isMac ? "Redo · ⇧⌘Z" : "Redo · Ctrl+Y");
    this.listBtn = mk(ICON.list, "History", "Version history");
    this.listBtn.setAttribute("aria-expanded", "false");
    this.list = h("ul.c3-hist-list");
    const clear = h("button.c3-hist-clear", { type: "button" }, "Clear");
    this.panel = h("div.c3-hist-panel", { hidden: true }, h("div.c3-hist-head", {}, h("span", { text: "History" }), clear), this.list);
    this.el = h("div.c3-hist", {}, this.panel, h("div.c3-hist-bar", {}, this.undoBtn, this.redoBtn, this.listBtn));
    host.append(this.el);

    this.undoBtn.addEventListener("click", () => hooks.onUndo());
    this.redoBtn.addEventListener("click", () => hooks.onRedo());
    clear.addEventListener("click", () => hooks.onClear());
    this.listBtn.addEventListener("click", () => this.toggle());
    this.list.addEventListener("click", (e) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>("[data-id]");
      if (li) hooks.onJump(Number(li.dataset.id));
    });
    document.addEventListener("pointerdown", (e) => {
      if (!this.panel.hidden && !this.el.contains(e.target as Node)) this.toggle(false);
    });
    this.tick = window.setInterval(() => !this.panel.hidden && this.render(), 15000);
  }

  update(state: HistoryState): void {
    this.state = state;
    this.undoBtn.disabled = !state.canUndo;
    this.redoBtn.disabled = !state.canRedo;
    if (!this.panel.hidden) this.render();
  }

  private toggle(open: boolean = this.panel.hidden === true): void {
    this.panel.hidden = !open;
    this.listBtn.setAttribute("aria-expanded", String(open));
    this.listBtn.classList.toggle("is-on", open);
    if (open) this.render();
  }

  private render(): void {
    const items = [...this.state.entries]
      .reverse()
      .map((e) =>
        h(
          "li",
          { "data-id": e.id, class: e.current ? "is-current" : undefined, tabindex: 0, role: "button" },
          h("span.c3-hist-label", { text: e.label }),
          h("time", { text: relTime(e.time) }),
        ),
      );
    this.list.replaceChildren(...items);
  }

  dispose(): void {
    clearInterval(this.tick);
    this.el.remove();
  }
}
