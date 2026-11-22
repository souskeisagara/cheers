import { optionalData, payload, request, webHeaders } from "./auth.js";
import { cover, coverSource, durationText, video } from "./recommendations.js";

const site = "https://api.bilibili.com";
const suggestOrigin = "https://s.search.bilibili.com";
const homeOrigin = "https://www.bilibili.com/";
const searchPageSize = 20;
const discoveryPageSize = 12;
const supportedKinds = ["all", "video", "creator", "series", "live"];
const liveDiscoveryKeyword = "\u76f4\u64ad";

const htmlEntities = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
  nbsp: " "
};

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function cleanMarkup(value) {
  const raw = text(value);
  if (!raw) return "";
  return raw
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, entity) => {
      if (entity.startsWith("#x") || entity.startsWith("#X")) {
        const cp = Number.parseInt(entity.slice(2), 16);
        return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
      }
      if (entity.startsWith("#")) {
        const cp = Number.parseInt(entity.slice(1), 10);
        return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
      }
      return htmlEntities[entity.toLowerCase()] ?? match;
    })
    .replace(/\s+/g, " ")
    .trim();
}

function pageIndex(cursor) {
  if (!cursor) return 1;
  const index = Number(cursor);
  if (!Number.isSafeInteger(index) || index < 1 || String(index) !== cursor) {
    throw { code: "permission" };
  }
  return index;
}

function nextIndex(index, hasMore) {
  return hasMore && index < Number.MAX_SAFE_INTEGER ? String(index + 1) : "";
}

function endpoint(base, path, params = {}) {
  return base + path + "?" + new URLSearchParams(params);
}

async function primeBuvid() {
  try {
    await fetch(homeOrigin, { method: "HEAD", headers: webHeaders, redirect: "error" });
  } catch {}
}

async function searchGet(path, params) {
  const url = endpoint(site, path, params);
  try {
    return await payload(await request(url));
  } catch (error) {
    if (error?.code !== "rateLimited") throw error;
    await primeBuvid();
    return payload(await request(url));
  }
}

function avatar(value, size = 96) {
  const source = coverSource(value);
  return source ? `${source}@${size}w_${size}h_1c.jpg` : undefined;
}

function searchVideoItem(row) {
  const id = text(row?.bvid);
  const title = cleanMarkup(row?.title);
  if (!/^BV[a-zA-Z0-9]+$/.test(id) || !title) return undefined;
  const source = coverSource(row.pic);
  const mid = String(row.mid ?? "");
  const author = cleanMarkup(row.author);
  const itemCreator = author && /^[1-9]\d*$/.test(mid)
    ? { id: mid, name: author, avatarURL: avatar(row.upic, 96) }
    : undefined;
  const seconds = typeof row.duration === "number" ? count(row.duration) : durationText(row.duration);
  return {
    ref: { kind: "video", id },
    title,
    subtitle: cleanMarkup(row.description) || undefined,
    creator: itemCreator,
    coverURL: source ? cover(source) : undefined,
    backdropURL: source ? source + "@1920w.jpg" : undefined,
    durationSeconds: seconds,
    views: count(row.play),
    category: cleanMarkup(row.typename) || undefined
  };
}

function searchSeriesItem(row) {
  const seasonID = count(row?.season_id ?? row?.pgc_season_id);
  const title = cleanMarkup(row?.title);
  if (!seasonID || !title) return undefined;
  const source = coverSource(row.cover);
  const badge = cleanMarkup(row.season_type_name) || cleanMarkup(row.badge) || cleanMarkup(row.badges?.[0]?.text) || undefined;
  const subtitle = cleanMarkup(row.index_show) || cleanMarkup(row.styles) || cleanMarkup(row.areas) || undefined;
  return {
    ref: { kind: "series", id: "ss" + seasonID },
    title,
    subtitle,
    coverURL: source ? cover(source) : undefined,
    backdropURL: source ? source + "@1920w.jpg" : undefined,
    category: cleanMarkup(row.styles) || cleanMarkup(row.season_type_name) || undefined,
    quality: badge
  };
}

function searchLiveItem(row) {
  const roomID = count(row?.roomid ?? row?.id);
  const title = cleanMarkup(row?.title);
  if (!roomID || !title) return undefined;
  const uid = String(row.uid ?? "");
  const uname = cleanMarkup(row.uname);
  const itemCreator = uname && /^[1-9]\d*$/.test(uid)
    ? { id: uid, name: uname, avatarURL: avatar(row.uface, 96) }
    : undefined;
  const source = coverSource(row.user_cover) || coverSource(row.cover) || coverSource(row.pic);
  return {
    ref: { kind: "live", id: String(roomID) },
    title,
    subtitle: cleanMarkup(row.cate_name) || undefined,
    creator: itemCreator,
    coverURL: source ? cover(source) : undefined,
    backdropURL: source ? source + "@1920w.jpg" : undefined,
    views: count(row.online),
    category: cleanMarkup(row.cate_name) || undefined,
    quality: "LIVE"
  };
}

function searchCreatorItem(row) {
  const id = String(row?.mid ?? "");
  const name = cleanMarkup(row?.uname ?? row?.name);
  if (!name || !/^[1-9]\d*$/.test(id)) return undefined;
  return {
    creator: { id, name, avatarURL: avatar(row.upic ?? row.face, 192) },
    description: cleanMarkup(row.usign) || cleanMarkup(row.official_verify?.desc) || undefined,
    followers: count(row.fans),
    videos: count(row.videos)
  };
}

function orderParam(sort) {
  switch (sort) {
    case "newest": return "pubdate";
    case "views": return "click";
    default: return "totalrank";
  }
}

function durationMatches(seconds, duration) {
  if (!duration || duration === "all") return true;
  if (typeof seconds !== "number") return false;
  switch (duration) {
    case "short": return seconds < 600;
    case "medium": return seconds >= 600 && seconds <= 1800;
    case "long": return seconds > 1800;
    default: return true;
  }
}

async function hotKeywords() {
  const data = await payload(await request(endpoint(site, "/x/web-interface/wbi/search/square", { limit: 10 })));
  const list = data?.trending?.list;
  if (!Array.isArray(list)) return [];
  return list
    .map(entry => text(entry?.keyword || entry?.show_name))
    .filter(Boolean)
    .slice(0, 10);
}

async function searchVideos(query, sort, duration, page) {
  const order = orderParam(sort);
  if (duration === "long") {
    const [midLong, veryLong] = await Promise.all([
      searchGet("/x/web-interface/search/type", {
        search_type: "video", keyword: query, order, duration: 3, page, page_size: 10
      }),
      searchGet("/x/web-interface/search/type", {
        search_type: "video", keyword: query, order, duration: 4, page, page_size: 10
      }).catch(error => optionalData(error, { result: [], numResults: 0, numPages: 0 }))
    ]);
    const listA = Array.isArray(midLong?.result) ? midLong.result : [];
    const listB = Array.isArray(veryLong?.result) ? veryLong.result : [];
    const seen = new Set();
    const items = [];
    const maxLen = Math.max(listA.length, listB.length);
    for (let i = 0; i < maxLen; i++) {
      for (const row of [listA[i], listB[i]]) {
        if (!row) continue;
        const item = searchVideoItem(row);
        if (!item || seen.has(item.ref.id)) continue;
        seen.add(item.ref.id);
        items.push(item);
      }
    }
    const total = (count(midLong?.numResults) ?? 0) + (count(veryLong?.numResults) ?? 0);
    const maxPages = Math.max(count(midLong?.numPages) ?? 0, count(veryLong?.numPages) ?? 0);
    return {
      items,
      total,
      nextCursor: nextIndex(page, items.length > 0 && page < maxPages),
      kinds: supportedKinds
    };
  }
  const durationCode = duration === "short" ? 1 : duration === "medium" ? 2 : 0;
  const data = await searchGet("/x/web-interface/search/type", {
    search_type: "video", keyword: query, order, duration: durationCode, page, page_size: searchPageSize
  });
  const list = Array.isArray(data?.result) ? data.result : [];
  const items = list.map(searchVideoItem).filter(Boolean);
  const total = count(data?.numResults) ?? items.length;
  const numPages = count(data?.numPages) ?? 0;
  return {
    items,
    total,
    nextCursor: nextIndex(page, items.length > 0 && page < numPages),
    kinds: supportedKinds
  };
}

async function searchCreators(query, sort, page) {
  const params = { search_type: "bili_user", keyword: query, page, page_size: searchPageSize };
  if (sort === "views") {
    params.order = "fans";
    params.order_sort = 0;
  }
  const data = await searchGet("/x/web-interface/search/type", params);
  const list = Array.isArray(data?.result) ? data.result : [];
  const creators = list.map(searchCreatorItem).filter(Boolean);
  const total = count(data?.numResults) ?? creators.length;
  const numPages = count(data?.numPages) ?? 0;
  return {
    creators,
    total,
    nextCursor: nextIndex(page, creators.length > 0 && page < numPages),
    kinds: supportedKinds
  };
}

async function searchSeries(query, page) {
  const [bangumi, ft] = await Promise.all([
    searchGet("/x/web-interface/search/type", { search_type: "media_bangumi", keyword: query, page, page_size: 10 })
      .catch(error => optionalData(error, { result: [], numResults: 0, numPages: 0 })),
    searchGet("/x/web-interface/search/type", { search_type: "media_ft", keyword: query, page, page_size: 10 })
      .catch(error => optionalData(error, { result: [], numResults: 0, numPages: 0 }))
  ]);
  const listA = Array.isArray(bangumi?.result) ? bangumi.result : [];
  const listB = Array.isArray(ft?.result) ? ft.result : [];
  const seen = new Set();
  const items = [];
  for (const row of [...listA, ...listB]) {
    const item = searchSeriesItem(row);
    if (!item || seen.has(item.ref.id)) continue;
    seen.add(item.ref.id);
    items.push(item);
  }
  const total = (count(bangumi?.numResults) ?? 0) + (count(ft?.numResults) ?? 0);
  const maxPages = Math.max(count(bangumi?.numPages) ?? 0, count(ft?.numPages) ?? 0);
  return {
    items,
    total,
    nextCursor: nextIndex(page, items.length > 0 && page < maxPages),
    kinds: supportedKinds
  };
}

async function searchLive(query, page) {
  const data = await searchGet("/x/web-interface/search/type", {
    search_type: "live_room", keyword: query, page, page_size: searchPageSize
  });
  const list = Array.isArray(data?.result) ? data.result : [];
  const items = list.map(searchLiveItem).filter(Boolean);
  const total = count(data?.numResults) ?? items.length;
  const numPages = count(data?.numPages) ?? 0;
  return {
    items,
    total,
    nextCursor: nextIndex(page, items.length > 0 && page < numPages),
    kinds: supportedKinds
  };
}

async function discovery(kind, sort, duration, page) {
  const hotPromise = page === 1
    ? hotKeywords().catch(error => optionalData(error, []))
    : Promise.resolve(undefined);

  if (kind === "series") {
    const [data, hot] = await Promise.all([
      payload(await request(endpoint(site, "/pgc/season/index/result", {
        season_type: 1, type: 1, page, pagesize: discoveryPageSize
      }))),
      hotPromise
    ]);
    const list = Array.isArray(data?.list) ? data.list : [];
    const items = list.map(searchSeriesItem).filter(Boolean);
    return {
      items,
      nextCursor: nextIndex(page, Boolean(data?.has_next) && items.length > 0),
      hotKeywords: hot,
      kinds: supportedKinds
    };
  }

  if (kind === "live") {
    const [result, hot] = await Promise.all([
      searchLive(liveDiscoveryKeyword, page),
      hotPromise
    ]);
    return { ...result, total: undefined, hotKeywords: hot };
  }

  const [data, hot] = await Promise.all([
    payload(await request(endpoint(site, "/x/web-interface/popular", { pn: page, ps: discoveryPageSize }))),
    hotPromise
  ]);
  if (!Array.isArray(data?.list)) throw { code: "plugin" };
  const rawList = data.list;

  if (kind === "creator") {
    const seen = new Set();
    const creators = [];
    for (const row of rawList) {
      const owner = row?.owner;
      const item = searchCreatorItem({ mid: owner?.mid, uname: owner?.name, upic: owner?.face, usign: row?.tname });
      if (!item || seen.has(item.creator.id)) continue;
      seen.add(item.creator.id);
      creators.push(item);
    }
    return {
      creators,
      nextCursor: nextIndex(page, !data.no_more && rawList.length > 0),
      hotKeywords: hot,
      kinds: supportedKinds
    };
  }

  let items = rawList.map(video).filter(item => item && durationMatches(item.durationSeconds, duration));
  if (sort === "views") {
    items = items.slice().sort((a, b) => (b.views ?? 0) - (a.views ?? 0));
  } else if (sort === "newest") {
    const byID = new Map(rawList.map(row => [text(row?.bvid), count(row?.pubdate) ?? 0]));
    items = items.slice().sort((a, b) => (byID.get(b.ref.id) ?? 0) - (byID.get(a.ref.id) ?? 0));
  }
  return {
    items,
    nextCursor: nextIndex(page, !data.no_more && rawList.length > 0),
    hotKeywords: hot,
    kinds: supportedKinds
  };
}

export async function search({ query = "", kind = "all", sort = "default", duration = "all", cursor = "" } = {}) {
  const keyword = text(query);
  const activeKind = kind || "all";
  const page = pageIndex(cursor);
  if (!keyword) {
    return discovery(activeKind, sort, duration, page);
  }
  switch (activeKind) {
    case "all":
    case "video":
      return searchVideos(keyword, sort, duration, page);
    case "creator":
      return searchCreators(keyword, sort, page);
    case "series":
      return searchSeries(keyword, page);
    case "live":
      return searchLive(keyword, page);
    default:
      throw { code: "unsupported" };
  }
}

export async function searchSuggest({ query = "" } = {}) {
  const term = text(query);
  if (!term) return { suggestions: [] };
  const response = await request(endpoint(suggestOrigin, "/main/suggest", { term, main_ver: "v1" }));
  const body = await response.json();
  const tags = body?.result?.tag;
  if (!Array.isArray(tags)) return { suggestions: [] };
  const lower = term.toLowerCase();
  const seen = new Set();
  const suggestions = [];
  for (const tag of tags) {
    const value = cleanMarkup(tag?.value || tag?.term || tag?.name);
    if (!value) continue;
    const key = value.toLowerCase();
    if (key === lower || seen.has(key)) continue;
    seen.add(key);
    suggestions.push(value);
    if (suggestions.length >= 8) break;
  }
  return { suggestions };
}
