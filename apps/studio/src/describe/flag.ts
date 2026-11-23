/**
 * The "Describe a finish…" feature flag. Off by default, in dev and in every build.
 *
 * - Build time: `VITE_DESCRIBE_FINISH=1 pnpm build` turns it on for everyone who loads that build.
 * - Local override (dev server and local previews only, never on a deployed origin):
 *   `?describe-finish=1` turns it on and remembers that in localStorage, `?describe-finish=0`
 *   forgets it. See DEPLOY.md "Describe a finish (feature flag)".
 */
const FLAG_PARAM = "describe-finish";
const FLAG_STORAGE_KEY = "card-studio.describe-finish";

export interface FlagInputs {
  /** `import.meta.env.VITE_DESCRIBE_FINISH`. */
  env: string | undefined;
  /** `location.search`. */
  search: string;
  /** The remembered override (localStorage), or null. */
  stored: string | null;
  /** `import.meta.env.DEV`. */
  dev: boolean;
  hostname: string;
}

const ON = /^(1|true|on|yes)$/i;
const OFF = /^(0|false|off|no)$/i;

/** Hosts where the local override is honoured. */
const isLocalHost = (h: string): boolean => h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".localhost");

/** Pure: whether the flag is on, and what to remember (`store`: a value to save, null to clear, undefined to leave). */
export function resolveDescribeFlag(i: FlagInputs): { enabled: boolean; store?: string | null } {
  const built = !!i.env && ON.test(i.env);
  if (!(i.dev || isLocalHost(i.hostname))) return { enabled: built };
  const param = new URLSearchParams(i.search).get(FLAG_PARAM);
  if (param !== null && ON.test(param || "1")) return { enabled: true, store: "1" };
  if (param !== null && OFF.test(param)) return { enabled: built, store: null };
  return { enabled: built || i.stored === "1" };
}

/** The flag for this page (reads and updates the remembered override). */
export function describeFinishEnabled(): boolean {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(FLAG_STORAGE_KEY);
  } catch {
    /* storage unavailable */
  }
  const r = resolveDescribeFlag({
    env: import.meta.env.VITE_DESCRIBE_FINISH,
    search: location.search,
    stored,
    dev: import.meta.env.DEV,
    hostname: location.hostname,
  });
  try {
    if (r.store === null) localStorage.removeItem(FLAG_STORAGE_KEY);
    else if (r.store) localStorage.setItem(FLAG_STORAGE_KEY, r.store);
  } catch {
    /* storage unavailable */
  }
  return r.enabled;
}
