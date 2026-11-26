// Session-scoped read cache backed by host.cache (MikuTV >= 0.1.5).
// Older hosts lack host.cache, so every helper degrades to a no-op miss.
// The host clears this cache on account switch and entry close.

const prefix = "cheers:v1:";

function store() {
  try {
    if (typeof host !== "undefined" && host.cache && typeof host.cache.get === "function") {
      return host.cache;
    }
  } catch {}
  return null;
}

export function cacheGetJSON(key) {
  const cache = store();
  if (!cache) return undefined;
  let raw;
  try {
    raw = cache.get(prefix + key);
  } catch {
    return undefined;
  }
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function cacheSetJSON(key, value, ttlSeconds) {
  const cache = store();
  if (!cache || typeof cache.set !== "function" || value === undefined) return;
  try {
    // Oversized entries are rejected by the host; the read simply stays uncached.
    cache.set(prefix + key, JSON.stringify(value), ttlSeconds);
  } catch {}
}

export function cacheDelete(key) {
  const cache = store();
  if (!cache || typeof cache.delete !== "function") return;
  try {
    cache.delete(prefix + key);
  } catch {}
}

// Returns the cached value for key, or runs load() and stores its result when
// accept(result) allows. Errors thrown by load() propagate and are never cached.
export async function cached(key, ttlSeconds, load, accept = value => value != null) {
  const hit = cacheGetJSON(key);
  if (hit !== undefined) return hit;
  const value = await load();
  if (accept(value)) cacheSetJSON(key, value, typeof ttlSeconds === "function" ? ttlSeconds(value) : ttlSeconds);
  return value;
}

// Generation tokens let one mutation invalidate a family of keys whose members
// cannot be enumerated (for example every entry embedding a follow state).
// A missing token is replaced by a fresh unique one, so eviction is also safe.
export function cacheGeneration(name) {
  const cache = store();
  if (!cache) return "0";
  const key = prefix + "gen:" + name;
  try {
    const current = cache.get(key);
    if (typeof current === "string" && current) return current;
    const next = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    cache.set(key, next, 0);
    return next;
  } catch {
    return "0";
  }
}

export function bumpCacheGeneration(name) {
  cacheDelete("gen:" + name);
}

// Follow state for creators is embedded in season, course and creator card
// payloads; every follow/unfollow bumps this generation.
export const relationGeneration = "relation";
