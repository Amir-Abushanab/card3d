/**
 * Persistent thumbnail cache (IndexedDB): finished preset / shader-picker thumbnails, keyed by
 * `thumbCacheKey` (design hash + size + renderer/app version), so later visits render none. Storage
 * can be missing, blocked or full (private mode, site data off, quota): every call degrades to a miss
 * or a no-op, and the studio renders the thumbnail instead.
 */

const DB = "card-studio-thumbs";
const STORE = "thumbs";
/** Entries kept; the oldest are dropped when a visit starts above this. Each is a ~5–15 KB data URL. */
const MAX_ENTRIES = 400;

interface Entry {
  key: string;
  url: string;
  at: number;
}

export interface ThumbCache {
  /** The cached data URLs among `keys` (misses are absent). Never rejects. */
  getMany(keys: readonly string[]): Promise<Map<string, string>>;
  /** Store one (fire and forget). */
  put(key: string, url: string): void;
}

export function openThumbCache(): ThumbCache {
  let db: Promise<IDBDatabase | null> | null = null;
  const open = () =>
    (db ??= new Promise<IDBDatabase | null>((resolve) => {
      try {
        if (typeof indexedDB === "undefined") return resolve(null);
        const req = indexedDB.open(DB, 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "key" });
        };
        req.onsuccess = () => {
          const d = req.result;
          d.onversionchange = () => d.close();
          prune(d);
          resolve(d);
        };
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    }));

  return {
    async getMany(keys) {
      const out = new Map<string, string>();
      if (!keys.length) return out;
      const d = await open();
      if (!d) return out;
      return new Promise((resolve) => {
        try {
          const tx = d.transaction(STORE, "readonly");
          const store = tx.objectStore(STORE);
          for (const key of keys) {
            const r = store.get(key);
            r.onsuccess = () => {
              const e = r.result as Entry | undefined;
              if (e && typeof e.url === "string" && e.url.startsWith("data:image/")) out.set(key, e.url);
            };
          }
          tx.oncomplete = () => resolve(out);
          tx.onerror = () => resolve(out);
          tx.onabort = () => resolve(out);
        } catch {
          resolve(out);
        }
      });
    },
    put(key, url) {
      void open().then((d) => {
        if (!d) return;
        try {
          const tx = d.transaction(STORE, "readwrite");
          tx.objectStore(STORE).put({ key, url, at: Date.now() } satisfies Entry);
          tx.onerror = (e) => e.preventDefault(); // quota: just don't cache
        } catch {
          /* storage unavailable */
        }
      });
    },
  };
}

/** Drop the oldest entries beyond `MAX_ENTRIES` (old keys from earlier versions accumulate otherwise). */
function prune(d: IDBDatabase): void {
  try {
    const tx = d.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const count = store.count();
    count.onsuccess = () => {
      if (count.result <= MAX_ENTRIES) return;
      const all = store.getAll();
      all.onsuccess = () => {
        const entries = (all.result as Entry[]).sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
        for (const e of entries.slice(0, entries.length - MAX_ENTRIES)) store.delete(e.key);
      };
    };
  } catch {
    /* storage unavailable */
  }
}
