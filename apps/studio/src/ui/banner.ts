/**
 * A persistent notice docked at the top of the stage, with actions (e.g. the untrusted-code gate:
 * "This design contains custom shader code — Run it"). One at a time; stays until acted on or closed.
 */
import { h } from "./dom.ts";

export interface BannerOptions {
  message: string;
  detail?: string;
  actions: { label: string; primary?: boolean; /** Keep the banner after this action. */ keep?: boolean; onClick: () => void }[];
  onDismiss?: () => void;
}

let current: HTMLElement | null = null;

export function showBanner(host: HTMLElement, o: BannerOptions): void {
  hideBanner();
  const close = h("button.c3-banner-x", { type: "button", "aria-label": "Dismiss", title: "Dismiss" }, "×");
  const el = h(
    "div.c3-banner",
    { role: "alert" },
    h("span.c3-banner-icon", { "aria-hidden": "true", text: "⚠" }),
    h("span.c3-banner-text", {}, h("strong", { text: o.message }), o.detail ? h("small", { text: o.detail }) : null),
    ...o.actions.map((a) => {
      const b = h("button.c3-banner-btn", { type: "button" }, a.label);
      if (a.primary) b.classList.add("is-primary");
      b.addEventListener("click", () => {
        if (!a.keep) hideBanner();
        a.onClick();
      });
      return b;
    }),
    close,
  );
  close.addEventListener("click", () => {
    hideBanner();
    o.onDismiss?.();
  });
  host.append(el);
  current = el;
}

export function hideBanner(): void {
  current?.remove();
  current = null;
}
