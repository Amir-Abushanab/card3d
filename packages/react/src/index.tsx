"use client";

/**
 * @card3d/react: `<MetalCard>`, a thin React wrapper around the `<metal-card>` custom element
 * (@card3d/element). Every prop maps onto an attribute, except `design`, which is set as the element's
 * property (an object never round-trips through JSON in the DOM). SSR renders the bare element; the
 * card starts on the client once it scrolls into view.
 */
import { createElement, forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { CSSProperties, ForwardedRef, ReactElement } from "react";
import "@card3d/element";
import type { CardDesign, Interaction, MetalCardElement, MetalCardReadyDetail } from "@card3d/element";

export interface MetalCardProps {
  /**
   * The design: an object (a `CardDesign`, or anything Card Studio can open, e.g. its "Design JSON"
   * export) or that JSON as a string. Wins over `share`, `src` and `preset`.
   */
  design?: CardDesign | Record<string, unknown> | string | null;
  /** A Card Studio share link, its `#d=…` hash, or the bare token. */
  share?: string;
  /** URL of a design JSON. */
  src?: string;
  /** A `CARD_PRESETS` id, e.g. "brass-orbit-guilloche". */
  preset?: string;
  /** Convenience overrides applied over the design. */
  material?: string;
  texture?: string;
  pattern?: string;
  color?: string;
  name?: string;
  bio?: string;
  /** A font id, `google:<Family>[@weight]`, or with `fontUrl` the family name of that file. */
  font?: string;
  /** A web font file (https or same-origin woff2 / woff / ttf / otf), named by `font`. */
  fontUrl?: string;
  lighting?: string;
  /** drag (default): turn and flip; turntable: spin about the vertical axis; none: static. */
  interaction?: Interaction;
  /** Spin continuously: `true` (20°/s) or degrees per second. Off under prefers-reduced-motion. */
  autoRotate?: boolean | number;
  quality?: "full" | "performance";
  /** contain (default): the card fills the box with a small margin; studio: Card Studio's camera. */
  fit?: "contain" | "studio";
  /** Start only near the viewport (default true). */
  lazy?: boolean;
  paused?: boolean;
  /** Accessible name (default "<cardholder name>, 3D metal card"). */
  label?: string;
  /** Paint the lighting preset's backdrop behind the card. */
  backdrop?: boolean;
  id?: string;
  className?: string;
  style?: CSSProperties;
  /** A design is on screen. */
  onReady?: (detail: MetalCardReadyDetail) => void;
  /** An input couldn't be used (bad JSON, unknown preset, …); the card falls back. */
  onError?: (detail: { message: string }) => void;
}

const str = (v: string | undefined) => (v === undefined || v === "" ? undefined : v);
const flag = (v: boolean | undefined) => (v ? "" : undefined);

function MetalCardImpl(props: MetalCardProps, ref: ForwardedRef<MetalCardElement | null>): ReactElement {
  const el = useRef<MetalCardElement | null>(null);
  useImperativeHandle(ref, () => el.current!, []);

  // Latest callbacks in a ref, so changing them never re-attaches listeners.
  const cb = useRef(props);
  // oxlint-disable-next-line react/refs -- the latest-props ref: read only in the event listeners below, never during render
  cb.current = props;
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const ready = (e: Event) => cb.current.onReady?.((e as CustomEvent<MetalCardReadyDetail>).detail);
    const error = (e: Event) => cb.current.onError?.((e as CustomEvent<{ message: string }>).detail);
    node.addEventListener("metal-card-ready", ready);
    node.addEventListener("metal-card-error", error);
    return () => {
      node.removeEventListener("metal-card-ready", ready);
      node.removeEventListener("metal-card-error", error);
    };
  }, []);

  // Object designs go through the property; string designs through the attribute.
  const objectDesign = props.design && typeof props.design === "object" ? props.design : null;
  const designKey = objectDesign ? JSON.stringify(objectDesign) : "";
  // Keyed on the serialised design: a new object with the same content doesn't rebuild the card.
  // oxlint-disable-next-line react/exhaustive-effect-dependencies -- designKey stands for objectDesign
  useEffect(() => {
    if (el.current) el.current.design = objectDesign;
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- designKey stands for objectDesign
  }, [designKey]);

  const { autoRotate } = props;
  // oxlint-disable-next-line react/refs -- false positive: the ref object is handed to the element, not read
  return createElement("metal-card", {
    ref: el,
    id: props.id,
    className: props.className,
    style: props.style,
    design: typeof props.design === "string" ? props.design : undefined,
    share: str(props.share),
    src: str(props.src),
    preset: str(props.preset),
    material: str(props.material),
    texture: str(props.texture),
    pattern: str(props.pattern),
    color: str(props.color),
    name: props.name,
    bio: props.bio,
    font: str(props.font),
    "font-url": str(props.fontUrl),
    lighting: str(props.lighting),
    interaction: props.interaction,
    "auto-rotate": autoRotate === true ? "" : typeof autoRotate === "number" ? String(autoRotate) : undefined,
    quality: props.quality,
    fit: props.fit,
    lazy: props.lazy === false ? "false" : undefined,
    paused: flag(props.paused),
    label: str(props.label),
    backdrop: flag(props.backdrop),
  });
}

/** A 3D metal card. Size it with CSS (`className` / `style`); the default is 360 px wide at 8:5. */
export const MetalCard = forwardRef<MetalCardElement | null, MetalCardProps>(MetalCardImpl);
MetalCard.displayName = "MetalCard";

export default MetalCard;
export type { CardDesign, Interaction, MetalCardElement, MetalCardReadyDetail } from "@card3d/element";
