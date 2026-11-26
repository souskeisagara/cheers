import { optionalData, payload, request, webHeaders } from "./auth.js";
import { cached } from "./cache.js";
import { fetchLiveRooms } from "./following.js";

const site = "https://api.bilibili.com";
const liveSite = "https://api.live.bilibili.com";
const homeOrigin = "https://www.bilibili.com/";
const liveOrigin = "https://live.bilibili.com";
const livePageSize = 24;
const maxAreas = 10;

const liveHeaders = {
  ...webHeaders,
  Origin: liveOrigin,
  Referer: liveOrigin + "/"
};

const fallbackQnLabels = {
  30000: "\u675c\u6bd4",
  25000: "\u675c\u6bd4",
  20000: "4K",
  15000: "2K",
  10000: "\u539f\u753b",
  400: "\u84dd\u5149",
  250: "\u8d85\u6e05",
  150: "\u9ad8\u6e05",
  80: "\u6d41\u7545"
};

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

function httpsURL(value) {
  if (typeof value !== "string") return "";
  const url = value.trim().replace(/^\/\//, "https://").replace(/^http:/i, "https:");
  return url.startsWith("https://") ? url : "";
}

function coverSource(value) {
  const url = httpsURL(value);
  return /^(https:\/\/i[012]\.hdslb\.com\/[^?@#\s]+)/.exec(url)?.[1];
}

function coverThumb(value) {
  const src = coverSource(value);
  return src ? src + "@672w_378h_1c.jpg" : httpsURL(value) || undefined;
}

function coverBackdrop(value) {
  const src = coverSource(value);
  return src ? src + "@1920w.jpg" : httpsURL(value) || undefined;
}

function avatar(value, size = 96) {
  const src = coverSource(value);
  return src ? `${src}@${size}w_${size}h_1c.jpg` : httpsURL(value) || undefined;
}

function stripHTML(raw) {
  if (typeof raw !== "string" || !raw) return "";
  return raw
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
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

async function primeBuvid() {
  try {
    await fetch(homeOrigin, { method: "HEAD", headers: webHeaders, redirect: "error" });
  } catch {}
}

async function liveGet(path, params = {}, extraHeaders = {}) {
  const query = new URLSearchParams(params).toString();
  const url = liveSite + path + (query ? "?" + query : "");
  const headers = { ...liveHeaders, ...extraHeaders };
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
    if (body?.code === 19002003 || body?.code === 1) throw { code: "expired" };
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

function parseRoomCard(row, followedUIDs) {
  const roomID = positiveID(row?.roomid ?? row?.room_id);
  const title = text(row?.title);
  if (!roomID || !title) return undefined;
  const uid = positiveID(row?.uid);
  const uname = text(row?.uname);
  const area = text(row?.area_name || row?.parent_name || row?.parent_area_name);
  const pic = row?.cover || row?.user_cover || row?.system_cover || row?.keyframe || row?.face;
  const watchedNum = count(row?.watched_show?.num);
  const views = (watchedNum && watchedNum > 0 ? watchedNum : undefined) ?? count(row?.online);
  return {
    ref: { kind: "live", id: roomID },
    title,
    subtitle: uname && area ? `${uname} \u00b7 ${area}` : uname || area || undefined,
    creator: uid && uname ? {
      id: uid,
      name: uname,
      avatarURL: avatar(row?.face, 96),
      following: followedUIDs ? followedUIDs.has(uid) : false
    } : undefined,
    coverURL: coverThumb(pic),
    backdropURL: coverBackdrop(pic),
    views,
    category: area || undefined,
    quality: "LIVE"
  };
}

// Area taxonomy and anchor profiles are static between sessions; room state,
// online counts and stream URLs are never cached.
const liveCatalogTTL = 1800;

async function fetchAreas() {
  const data = await cached("live-areas", liveCatalogTTL,
    () => liveGet("/xlive/web-interface/v1/index/getWebAreaList", { source_id: 2 }),
    value => Array.isArray(value?.data) && value.data.length > 0);
  const raw = Array.isArray(data?.data) ? data.data : [];
  const areas = [{ id: "", label: "\u5168\u90e8" }];
  const seen = new Set([""]);
  for (const row of raw) {
    const id = positiveID(row?.id);
    const label = text(row?.name);
    if (!id || !label || seen.has(id)) continue;
    seen.add(id);
    areas.push({ id, label });
    if (areas.length >= maxAreas + 1) break;
  }
  return areas;
}

async function fetchAreaRooms(area, cursor, followedUIDs) {
  const page = pageIndex(cursor);
  const parentID = area ? positiveID(area) : "0";
  if (area && !parentID) throw { code: "permission" };
  const data = await liveGet("/room/v3/area/getRoomList", {
    platform: "web",
    parent_area_id: parentID,
    area_id: 0,
    sort_type: "online",
    page,
    page_size: livePageSize
  });
  const list = Array.isArray(data?.list) ? data.list : [];
  const rooms = list.map(row => parseRoomCard(row, followedUIDs)).filter(Boolean);
  const total = count(data?.count) ?? 0;
  const hasMore = rooms.length > 0 && (total > 0 ? page * livePageSize < total : list.length >= livePageSize);
  return {
    rooms,
    nextCursor: nextIndex(page, hasMore)
  };
}

export async function readLive({ section = "", area = "", cursor = "", signedIn = false, owner = "" } = {}) {
  const target = section || "";
  switch (target) {
    case "rooms": {
      const result = await fetchAreaRooms(area, cursor);
      return {
        rooms: result.rooms,
        nextCursor: result.nextCursor
      };
    }
    case "following": {
      if (!signedIn || !positiveID(owner)) throw { code: "signIn" };
      const result = await fetchLiveRooms(cursor);
      return {
        followingRooms: result.liveRooms,
        followingCursor: result.liveCursor
      };
    }
    case "": {
      const [areasRes, roomsRes, followingRes] = await Promise.all([
        fetchAreas().catch(err => optionalData(err, [{ id: "", label: "\u5168\u90e8" }])),
        fetchAreaRooms(area, ""),
        signedIn && positiveID(owner)
          ? fetchLiveRooms("").catch(err => optionalData(err, { liveRooms: [], liveCursor: "" }))
          : Promise.resolve({ liveRooms: [], liveCursor: "" })
      ]);
      const followedUIDs = new Set(followingRes.liveRooms.map(item => item.creator?.id).filter(Boolean));
      const rooms = roomsRes.rooms.map(item => {
        if (item.creator && followedUIDs.has(item.creator.id)) {
          return { ...item, creator: { ...item.creator, following: true } };
        }
        return item;
      });
      let hero = rooms[0] ? { ...rooms[0] } : undefined;
      if (hero) {
        const detail = await liveGet("/room/v1/Room/get_info", { room_id: hero.ref.id }).catch(() => undefined);
        const desc = stripHTML(detail?.description);
        if (desc) {
          hero.subtitle = desc.length > 140 ? desc.slice(0, 140) + "\u2026" : desc;
        }
      }
      return {
        areas: areasRes,
        hero,
        rooms,
        nextCursor: roomsRes.nextCursor,
        followingRooms: signedIn ? followingRes.liveRooms : undefined,
        followingCursor: signedIn ? followingRes.liveCursor : ""
      };
    }
    default:
      throw { code: "unsupported" };
  }
}

export async function getLiveDetail(id, { signedIn = false } = {}) {
  const roomID = positiveID(id);
  if (!roomID) throw { code: "unsupported" };
  const info = await liveGet("/room/v1/Room/get_info", { room_id: roomID });
  const title = text(info?.title);
  if (!title) throw { code: "expired" };
  const uid = positiveID(info?.uid);
  const [anchor, relation] = await Promise.all([
    uid
      ? cached(`live-anchor:${uid}`, liveCatalogTTL, () => liveGet("/live_user/v1/Master/info", { uid }),
          value => Boolean(text(value?.info?.uname))).catch(() => undefined)
      : Promise.resolve(undefined),
    signedIn && uid
      ? request(site + "/x/relation?fid=" + uid).then(res => payload(res)).catch(err => optionalData(err))
      : Promise.resolve(undefined)
  ]);
  const uname = text(anchor?.info?.uname) || (uid ? `UID ${uid}` : "");
  const face = avatar(anchor?.info?.face, 192);
  const following = relation?.attribute === 2 || relation?.attribute === 6;
  const parentArea = text(info?.parent_area_name);
  const subArea = text(info?.area_name);
  const category = parentArea && subArea && parentArea !== subArea
    ? `${parentArea} \u00b7 ${subArea}`
    : subArea || parentArea || undefined;
  const pic = info?.user_cover || info?.keyframe || anchor?.info?.face;
  const desc = stripHTML(info?.description);
  return {
    ref: { kind: "live", id: roomID },
    title,
    subtitle: desc || undefined,
    creator: uid && uname ? { id: uid, name: uname, avatarURL: face, following } : undefined,
    coverURL: coverThumb(pic),
    backdropURL: coverBackdrop(pic),
    views: count(info?.online),
    category,
    quality: info?.live_status === 1 ? "LIVE" : undefined
  };
}

function liveLineLabel(index, total) {
  if (index === 0) return "\u4e3b\u7ebf\u8def";
  if (total === 2) return "\u5907\u7528\u7ebf\u8def";
  return `\u5907\u7528\u7ebf\u8def ${index}`;
}

function parseExpiry(urls) {
  const values = [];
  for (const address of urls) {
    const query = address.split("?")[1] ?? "";
    const params = new URLSearchParams(query);
    const exp = Number(params.get("expires") ?? params.get("deadline"));
    if (Number.isSafeInteger(exp) && exp > 0) values.push(exp);
  }
  return values.length ? Math.min(...values) : undefined;
}

function livePreferredQn(preferredQuality) {
  switch (preferredQuality) {
    case "720p": return 250;
    case "1080p": return 400;
    default: return 10000;
  }
}

export async function resolveLivePlayback({ ref, partID = "", quality = "", preferredQuality = "", line = "", hevc = false, signedIn = false } = {}) {
  const roomID = positiveID(ref?.id);
  if (!roomID) throw { code: "unsupported" };
  const requestedQn = quality ? Number(quality) : livePreferredQn(preferredQuality);
  if (!Number.isSafeInteger(requestedQn) || requestedQn < 1) {
    throw { code: "unsupported" };
  }
  const data = await liveGet("/xlive/web-room/v2/index/getRoomPlayInfo", {
    room_id: roomID,
    protocol: "0,1",
    format: "0,1,2",
    codec: "0,1",
    qn: requestedQn,
    platform: "web",
    ptype: 8,
    dolby: 5,
    panorama: 1
  }, { Referer: `${liveOrigin}/${roomID}` });

  const canonRoomID = positiveID(data?.room_id) || roomID;
  const resolvedPartID = partID || canonRoomID;
  if (data?.live_status !== 1) {
    return {
      itemID: canonRoomID,
      partID: resolvedPartID,
      live: true,
      liveEnded: true
    };
  }
  if (data?.is_encrypted && !data?.pwd_verified) {
    return {
      itemID: canonRoomID,
      partID: resolvedPartID,
      live: true,
      access: "restricted",
      restriction: "source"
    };
  }

  const playurl = data?.playurl_info?.playurl;
  const descMap = new Map();
  for (const entry of playurl?.g_qn_desc ?? []) {
    const qn = Number(entry?.qn);
    const desc = text(entry?.desc);
    if (Number.isSafeInteger(qn) && qn > 0 && desc) {
      descMap.set(qn, desc);
    }
  }

  // Collect Apple TV AVPlayer-compatible HLS codecs:
  // - fmp4 + avc (H.264 in fMP4, 1s chunks)
  // - fmp4 + hevc (hvc1 in fMP4, 1s chunks, when device supports HEVC)
  // - ts + avc (H.264 in MPEG-TS, universal backup)
  // Exclude ts + hevc (Apple HLS spec prohibits HEVC in TS) and flv.
  const hlsStreams = (playurl?.stream ?? []).filter(s => s?.protocol_name === "http_hls");
  const candidates = [];
  for (const st of hlsStreams) {
    for (const fmt of st?.format ?? []) {
      const formatName = text(fmt?.format_name);
      if (formatName !== "fmp4" && formatName !== "ts") continue;
      for (const co of fmt?.codec ?? []) {
        const codecName = text(co?.codec_name);
        if (codecName === "hevc" && (!hevc || formatName === "ts")) continue;
        if (codecName !== "avc" && codecName !== "hevc") continue;
        const baseURL = text(co?.base_url);
        const urlInfos = Array.isArray(co?.url_info) ? co.url_info : [];
        if (!baseURL || !urlInfos.length) continue;
        candidates.push({
          formatName,
          codecName,
          currentQn: Number(co?.current_qn) || requestedQn,
          acceptQn: Array.isArray(co?.accept_qn) ? co.accept_qn.map(Number).filter(n => Number.isSafeInteger(n) && n > 0) : [],
          baseURL,
          urlInfos
        });
      }
    }
  }

  if (!candidates.length) {
    return {
      itemID: canonRoomID,
      partID: resolvedPartID,
      live: true,
      access: "restricted",
      restriction: "source"
    };
  }

  // Prefer fmp4 over ts; prefer avc for standard QN and hevc for 2K/4K/Dolby.
  candidates.sort((a, b) => {
    const fmtRank = x => x.formatName === "fmp4" ? 2 : 1;
    const codecRank = x => {
      if (x.currentQn >= 15000) return x.codecName === "hevc" ? 2 : 1;
      return x.codecName === "avc" ? 2 : 1;
    };
    return (b.currentQn === requestedQn ? 1 : 0) - (a.currentQn === requestedQn ? 1 : 0) ||
      fmtRank(b) - fmtRank(a) ||
      codecRank(b) - codecRank(a);
  });

  const primary = candidates[0];
  const chosenQn = primary.currentQn;

  // Build deduplicated CDN lines across the compatible HLS entries at chosenQn.
  const rawLines = [];
  const seenKey = new Set();
  for (const entry of candidates) {
    if (entry.currentQn !== chosenQn) continue;
    for (const info of entry.urlInfos) {
      const host = httpsURL(info?.host);
      if (!host) continue;
      const fullURL = host + entry.baseURL + (typeof info?.extra === "string" ? info.extra : "");
      const dedupKey = `${entry.formatName}|${host}`;
      if (seenKey.has(dedupKey)) continue;
      seenKey.add(dedupKey);
      rawLines.push({
        id: `${entry.formatName}-${rawLines.length}`,
        url: fullURL,
        formatName: entry.formatName
      });
      if (rawLines.length >= 6) break;
    }
    if (rawLines.length >= 6) break;
  }

  if (!rawLines.length) {
    return {
      itemID: canonRoomID,
      partID: resolvedPartID,
      live: true,
      access: "restricted",
      restriction: "source"
    };
  }

  const lines = rawLines.map((item, idx) => ({
    id: item.id,
    label: liveLineLabel(idx, rawLines.length)
  }));

  const qnSet = new Set([chosenQn]);
  for (const entry of candidates) {
    for (const qn of entry.acceptQn) qnSet.add(qn);
  }
  if (quality) qnSet.add(requestedQn);

  const qualities = [...qnSet].sort((a, b) => b - a).map(qn => {
    const label = descMap.get(qn) || fallbackQnLabels[qn] || `${qn}`;
    let limit;
    if (!signedIn && qn > chosenQn) {
      limit = "login";
    } else if (quality && qn === requestedQn && chosenQn !== requestedQn) {
      limit = "source";
    }
    return { id: String(qn), label, limit };
  });

  const restriction = quality && chosenQn !== requestedQn
    ? qualities.find(q => q.id === String(requestedQn))?.limit || "source"
    : undefined;

  const streamHeaders = {
    ...webHeaders,
    Origin: liveOrigin,
    Referer: `${liveOrigin}/${canonRoomID}`
  };
  const makeStream = entry => ({
    format: "hls",
    live: true,
    video: {
      resource: { urls: [entry.url], headers: streamHeaders },
      contentType: "application/vnd.apple.mpegurl"
    }
  });

  const matchedLine = line ? rawLines.find(item => item.id === line) : undefined;
  const activeLine = matchedLine ? matchedLine.id : rawLines[0].id;
  const streams = matchedLine
    ? [makeStream(matchedLine)]
    : rawLines.map(makeStream);

  return {
    itemID: canonRoomID,
    partID: resolvedPartID,
    live: true,
    access: "granted",
    quality: String(chosenQn),
    qualities,
    line: activeLine,
    lines,
    streams,
    restriction,
    expiresAt: parseExpiry(streams.flatMap(s => s.video.resource.urls))
  };
}
