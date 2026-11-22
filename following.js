import { optionalData, payload, webHeaders } from "./auth.js";
import { cover, coverSource, durationText } from "./recommendations.js";

const site = "https://api.bilibili.com";
const liveSite = "https://api.live.bilibili.com";
const homeOrigin = "https://www.bilibili.com/";
const creatorsPageSize = 50;
const livePageSize = 20;

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function positiveID(value) {
  const id = String(value ?? "");
  return /^[1-9]\d*$/.test(id) ? id : undefined;
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function parsePlayCount(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  const raw = text(value).replace(/,/g, "");
  if (!raw) return undefined;
  const match = /^(\d+(?:\.\d+)?)\s*(\u4e07|\u4ebf)?$/.exec(raw);
  if (!match) return undefined;
  const base = Number(match[1]);
  if (!Number.isFinite(base) || base < 0) return undefined;
  const multiplier = match[2] === "\u4ebf" ? 100000000 : match[2] === "\u4e07" ? 10000 : 1;
  return Math.round(base * multiplier);
}

function avatar(value, size = 192) {
  const source = coverSource(value);
  return source ? `${source}@${size}w_${size}h_1c.jpg` : undefined;
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

async function primeBuvid() {
  try {
    await fetch(homeOrigin, { method: "HEAD", headers: webHeaders, redirect: "error" });
  } catch {}
}

async function apiGet(base, path, params = {}, extraHeaders = {}) {
  const query = new URLSearchParams(params).toString();
  const url = base + path + (query ? "?" + query : "");
  const headers = { ...webHeaders, ...extraHeaders };
  const run = async () => {
    let response;
    try {
      response = await fetch(url, { headers, redirect: "error" });
    } catch {
      throw { code: "network" };
    }
    if (response.status === 412 || response.status === 429) throw { code: "rateLimited" };
    if (!response.ok) throw { code: "network" };
    const body = await response.json();
    if (body?.code === -352) throw { code: "rateLimited" };
    return payload(response, () => body);
  };
  try {
    return await run();
  } catch (error) {
    if (error?.code !== "rateLimited") throw error;
    await primeBuvid();
    return run();
  }
}

async function fetchCreators(owner, cursor) {
  const page = pageIndex(cursor);
  const data = await apiGet(site, "/x/relation/followings", {
    vmid: owner, pn: page, ps: creatorsPageSize, order: "desc"
  }, { Referer: `https://space.bilibili.com/${owner}/fans/follow` });
  const list = Array.isArray(data?.list) ? data.list : [];
  const creators = list.map(row => {
    const id = positiveID(row?.mid);
    const name = text(row?.uname);
    if (!id || !name) return undefined;
    return {
      creator: {
        id,
        name,
        avatarURL: avatar(row.face, 192),
        following: true
      },
      bio: text(row.sign) || undefined
    };
  }).filter(Boolean);
  const total = count(data?.total) ?? 0;
  return {
    creators,
    creatorsCursor: nextIndex(page, creators.length > 0 && page * creatorsPageSize < total)
  };
}

function parseUpdateCursor(cursor) {
  if (!cursor) return { page: 1, offset: "" };
  const idx = cursor.indexOf(":");
  if (idx > 0) {
    const page = Number(cursor.slice(0, idx));
    const offset = cursor.slice(idx + 1).trim();
    if (Number.isSafeInteger(page) && page >= 1 && offset) {
      return { page, offset };
    }
    throw { code: "permission" };
  }
  return { page: 2, offset: cursor };
}

function dynamicArchiveItem(entry) {
  if (!entry || entry.visible === false) return undefined;
  const modules = entry.modules ?? {};
  const major = modules.module_dynamic?.major;
  if (major?.type !== "MAJOR_TYPE_ARCHIVE") return undefined;
  const archive = major.archive;
  const id = text(archive?.bvid);
  const title = text(archive?.title);
  if (!/^BV[a-zA-Z0-9]+$/.test(id) || !title) return undefined;
  const author = modules.module_author ?? {};
  const mid = positiveID(author.mid);
  const name = text(author.name);
  const source = coverSource(archive.cover);
  return {
    ref: { kind: "video", id },
    title,
    subtitle: text(archive.desc) || undefined,
    creator: mid && name ? { id: mid, name, avatarURL: avatar(author.face, 96), following: true } : undefined,
    coverURL: source ? cover(source) : undefined,
    backdropURL: source ? source + "@1920w.jpg" : undefined,
    durationSeconds: durationText(archive.duration_text),
    views: parsePlayCount(archive.stat?.play)
  };
}

async function fetchUpdates(cursor) {
  const parsed = parseUpdateCursor(cursor);
  const params = { type: "video", page: parsed.page, features: "itemOpusStyle" };
  if (parsed.offset) params.offset = parsed.offset;
  const data = await apiGet(site, "/x/polymer/web-dynamic/v1/feed/all", params, {
    Referer: "https://t.bilibili.com/"
  });
  const raw = Array.isArray(data?.items) ? data.items : [];
  const updates = raw.map(dynamicArchiveItem).filter(Boolean);
  const nextOffset = text(data?.offset);
  const updatesCursor = data?.has_more && nextOffset && nextOffset !== parsed.offset
    ? `${parsed.page + 1}:${nextOffset}`
    : "";
  return { updates, updatesCursor };
}

function liveRoomItem(row) {
  const roomID = positiveID(row?.roomid ?? row?.room_id);
  const title = text(row?.title);
  if (!roomID || !title) return undefined;
  const uid = positiveID(row?.uid ?? row?.mid);
  const uname = text(row?.uname);
  const area = text(row?.area_name_v2 || row?.area_name || row?.parent_area_name);
  const coverSrc = coverSource(row?.pic || row?.cover || row?.user_cover || row?.face);
  const views = count(row?.online) ?? parsePlayCount(row?.text_small);
  return {
    ref: { kind: "live", id: roomID },
    title,
    subtitle: area || undefined,
    creator: uid && uname ? { id: uid, name: uname, avatarURL: avatar(row?.face, 96), following: true } : undefined,
    coverURL: coverSrc ? cover(coverSrc) : undefined,
    backdropURL: coverSrc ? coverSrc + "@1920w.jpg" : undefined,
    views,
    category: area || undefined,
    quality: "LIVE"
  };
}

async function fetchPortalLiveFallback() {
  const data = await apiGet(site, "/x/polymer/web-dynamic/v1/portal", {}, {
    Referer: "https://t.bilibili.com/"
  });
  const raw = Array.isArray(data?.live_users?.items) ? data.live_users.items : [];
  return {
    liveRooms: raw.map(liveRoomItem).filter(Boolean),
    liveCursor: ""
  };
}

export async function fetchLiveRooms(cursor) {
  const page = pageIndex(cursor);
  try {
    const data = await apiGet(liveSite, "/xlive/web-ucenter/user/following", {
      page, page_size: livePageSize
    }, {
      Origin: "https://live.bilibili.com",
      Referer: "https://live.bilibili.com/"
    });
    const raw = Array.isArray(data?.list) ? data.list : [];
    const liveRooms = raw
      .filter(row => row?.live_status === 1)
      .map(liveRoomItem)
      .filter(Boolean);
    const totalPage = count(data?.totalPage) ?? 0;
    const hasMore = totalPage > 0
      ? page < totalPage && raw.length > 0 && liveRooms.length > 0
      : raw.length === livePageSize && liveRooms.length > 0;
    return {
      liveRooms,
      liveCursor: nextIndex(page, hasMore)
    };
  } catch (error) {
    if (page === 1 && (error?.code === "network" || error?.code === "permission" || error?.code === "plugin" || error?.code === "rateLimited")) {
      return fetchPortalLiveFallback().catch(fallbackErr => optionalData(fallbackErr, { liveRooms: [], liveCursor: "" }));
    }
    throw error;
  }
}

export async function readFollowing({ section = "overview", cursor = "", owner } = {}) {
  const mid = positiveID(owner);
  if (!mid) throw { code: "signIn" };
  const target = section || "overview";
  switch (target) {
    case "creators": {
      const result = await fetchCreators(mid, cursor);
      return { ...result, supportsLive: true };
    }
    case "updates": {
      const result = await fetchUpdates(cursor);
      return { ...result, supportsLive: true };
    }
    case "live": {
      const result = await fetchLiveRooms(cursor);
      return { ...result, supportsLive: true };
    }
    case "overview": {
      const [creatorsRes, updatesRes, liveRes] = await Promise.all([
        fetchCreators(mid, ""),
        fetchUpdates("").catch(error => optionalData(error, { updates: [], updatesCursor: "" })),
        fetchLiveRooms("").catch(error => optionalData(error, { liveRooms: [], liveCursor: "" }))
      ]);
      const liveSet = new Set(liveRes.liveRooms.map(room => room.creator?.id).filter(Boolean));
      const updateSet = new Set(updatesRes.updates.map(item => item.creator?.id).filter(Boolean));
      const creators = creatorsRes.creators.map(entry => ({
        ...entry,
        hasUpdate: updateSet.has(entry.creator.id),
        live: liveSet.has(entry.creator.id)
      }));
      return {
        creators,
        creatorsCursor: creatorsRes.creatorsCursor,
        updates: updatesRes.updates,
        updatesCursor: updatesRes.updatesCursor,
        liveRooms: liveRes.liveRooms,
        liveCursor: liveRes.liveCursor,
        supportsLive: true
      };
    }
    default:
      throw { code: "unsupported" };
  }
}
