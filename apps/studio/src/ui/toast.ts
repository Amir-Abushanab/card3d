/**
 * One transient toast at a time, docked bottom-centre, with an optional action ("Undo", "Copy").
 * The auto-dismiss pauses while hovered so the action stays reachable (wave3d's Toast).
 */
export interface ToastOptions {
  message: string;
  tone?: "info" | "warn" | "error";
  actionLabel?: string;
  onAction?: () => void;
  duration?: number;
}

let current: HTMLElement | undefined;
let timer = 0;

export function showToast(opts: ToastOptions | string): void {
  const o = typeof opts === "string" ? { message: opts } : opts;
  dismissToast();
  const el = document.createElement("div");
  el.className = `c3-toast c3-toast--${o.tone ?? "info"}`;
  el.setAttribute("role", o.tone === "error" ? "alert" : "status");
  const msg = document.createElement("span");
  msg.textContent = o.message;
  el.append(msg);
  if (o.actionLabel && o.onAction) {
    const run = o.onAction;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = o.actionLabel;
    btn.addEventListener("click", () => {
      run();
      dismissToast();
    });
    el.append(btn);
  }
  el.addEventListener("mouseenter", () => clearTimeout(timer));
  el.addEventListener("mouseleave", () => (timer = window.setTimeout(dismissToast, 2500)));
  document.body.append(el);
  current = el;
  requestAnimationFrame(() => el.classList.add("is-in"));
  timer = window.setTimeout(dismissToast, o.duration ?? (o.tone === "warn" || o.tone === "error" ? 8000 : 4500));
}

export function dismissToast(): void {
  clearTimeout(timer);
  const el = current;
  current = undefined;
  if (!el) return;
  el.classList.remove("is-in");
  setTimeout(() => el.remove(), 220);
}
