/**
 * The marquee's page-side helpers (`mount.ts`; the three.js marquee, now in the local archive, used
 * them too): the intro phases and the page-wide pointer lock.
 */

export type IntroPhase = "arrive" | "settle" | "done";

/** Single-owner pointer lock shared by every marquee on the page. */
const pointerLock: { owner: unknown; id: number } = { owner: null, id: -1 };
export const marqueePointerLock = {
  held: () => pointerLock.owner !== null,
  claim(owner: unknown, id: number): boolean {
    if (pointerLock.owner !== null && pointerLock.owner !== owner) return false;
    pointerLock.owner = owner;
    pointerLock.id = id;
    return true;
  },
  release(owner: unknown, id: number): boolean {
    if (pointerLock.owner !== owner || pointerLock.id !== id) return false;
    pointerLock.owner = null;
    pointerLock.id = -1;
    return true;
  },
};
