import { optionalData, payload, request } from "./auth.js";
import { cover } from "./recommendations.js";

const api = "https://api.bilibili.com";
const messages = "https://message.bilibili.com";
const im = "https://api.vc.bilibili.com";
const web = { build: 0, mobi_app: "web" };

async function read(origin, path, params = {}) {
  const query = new URLSearchParams(params).toString();
  return payload(await request(origin + path + (query ? "?" + query : "")), decodeAccountJSON);
}

export async function decodeAccountJSON(response) {
  const text = await response.text();
  // Keep the provider's 64-bit record IDs and cursors exact across JSON decoding.
  return JSON.parse(text.replace(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, token => {
    return /^-?\d{16,}$/.test(token) && !Number.isSafeInteger(Number(token)) ? '"' + token + '"' : token;
  }));
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function identifier(value) {
  return value == null ? "" : String(value);
}

function timestamp(value) {
  if (value == null || value === "") return undefined;
  const seconds = Number(value);
  if (Number.isSafeInteger(seconds) && seconds > 0) return seconds;
  const date = Date.parse(value);
  return Number.isFinite(date) && date > 0 ? Math.floor(date / 1000) : undefined;
}

function rows(list, convert) {
  return (Array.isArray(list) ? list : []).map(convert).filter(row => row?.id && row.title);
}

function cursor(value, fallback) {
  if (!value) return fallback;
  try {
    const decoded = JSON.parse(value);
    return decoded && typeof decoded === "object" ? decoded : fallback;
  } catch {
    return fallback;
  }
}

function historyItem(item) {
  const history = item.history ?? {};
  const id = identifier(history.bvid || history.oid || item.kid);
  if (!id) return undefined;
  const oid = identifier(history.oid);
  const ref = history.bvid ? { kind: "video", id: history.bvid } : undefined;
  const mid = identifier(item.author_mid);
  const avatarURL = accountArtwork(item.author_face, "96w_96h");
  return {
    id: (history.business || "video") + ":" + id,
    title: item.title,
    subtitle: item.author_name || "",
    time: timestamp(item.view_at),
    coverURL: favoriteCover(item.cover || item.covers?.[0]),
    creatorAvatarURL: avatarURL,
    durationSeconds: count(item.duration),
    progressSeconds: item.progress === -1 ? undefined : count(item.progress),
    finished: item.progress === -1 || undefined,
    views: count(item.stat?.view),
    removalID: /^[a-z][a-z_]*$/.test(history.business) && positiveID(oid) ? history.business + "_" + oid : undefined,
    ref,
    item: ref ? {
      ref,
      title: item.title,
      coverURL: cover(item.cover || item.covers?.[0]),
      durationSeconds: count(item.duration),
      progressSeconds: count(item.progress),
      creator: mid && item.author_name ? { id: mid, name: item.author_name, avatarURL } : undefined
    } : undefined
  };
}

async function history(input) {
  const offset = cursor(input.cursor, {});
  const [data, shadow] = await Promise.all([
    read(api, "/x/web-interface/history/cursor", { max: offset.max ?? 0, view_at: offset.view_at ?? 0, business: offset.business ?? "" }),
    input.cursor ? undefined : read(api, "/x/v2/history/shadow").catch(error => optionalData(error))
  ]);
  const items = rows(data?.list, historyItem);
  const next = data?.cursor;
  return {
    rows: items,
    paused: typeof shadow === "boolean" || shadow === 0 || shadow === 1 ? Boolean(shadow) : undefined,
    nextCursor: items.length && next?.view_at ? JSON.stringify({ max: next.max, view_at: next.view_at, business: next.business }) : ""
  };
}

export function accountArtwork(value, size) {
  const match = /^(?:https?:)?\/\/(i[012]\.hdslb\.com\/[^?@#\s]+)(?:[?@#].*)?$/.exec(value);
  return match ? "https://" + match[1] + "@" + size + "_1c.jpg" : undefined;
}

function favoriteCover(value) {
  return accountArtwork(value, "768w_432h");
}

function videoItem(item) {
  const id = identifier(item.bvid || item.aid || item.id);
  const resourceID = identifier(item.id ?? item.aid);
  const resourceType = identifier(item.type);
  return {
    id,
    title: item.title,
    subtitle: item.owner?.name || item.upper?.name || "",
    time: timestamp(item.add_at || item.fav_time),
    coverURL: favoriteCover(item.cover || item.pic),
    creatorAvatarURL: accountArtwork(item.upper?.face || item.owner?.face, "96w_96h"),
    removalID: positiveID(resourceID) && positiveID(resourceType) ? resourceID + ":" + resourceType : undefined,
    durationSeconds: count(item.duration),
    views: count(item.cnt_info?.play ?? item.stat?.view),
    ref: id ? { kind: "video", id } : undefined
  };
}

async function watchLater() {
  const data = await read(api, "/x/v2/history/toview/web");
  const items = rows(data?.list, item => {
    const aid = identifier(item.aid || item.id);
    return { ...videoItem(item), removalID: positiveID(aid) ? aid : undefined };
  });
  return { rows: items, total: count(data?.count) ?? items.length };
}

export async function removeAccountItems({section, ids, secret}) {
  const csrf = secret?.csrf;
  if (!csrf) throw { code: "signIn" };
  if (!Array.isArray(ids) || ids.length === 0) throw { code: "permission" };
  const post = async (path, form) => payload(await request(api + path, { ...form, csrf }), decodeAccountJSON);
  if (section === "history" && ids.every(id => /^[a-z][a-z_]*_[1-9]\d{0,18}$/.test(id))) {
    for (let i = 0; i < ids.length; i += 20) {
      await post("/x/v2/history/delete", { kid: ids.slice(i, i + 20).join(",") });
    }
  } else if (section === "watchLater" && ids.every(positiveID)) {
    for (const id of ids) {
      await post("/x/v2/history/toview/del", { aid: id });
    }
  } else if (section === "tracking" && ids.every(positiveID)) {
    for (const id of ids) {
      await post("/pgc/web/follow/del", { season_id: id });
    }
  } else {
    throw { code: "permission" };
  }
  return {};
}

function trackingRow(item) {
  const id = identifier(item.season_id);
  return {
    id,
    title: item.translated_title || item.title,
    subtitle: item.new_ep?.index_show || item.season_type_name || "",
    coverURL: favoriteCover(item.horizontal_cover_169 || item.horizontal_cover || item.cover),
    removalID: positiveID(id) ? id : undefined,
    ref: positiveID(id) ? { kind: "series", id: "ss" + id } : undefined
  };
}

async function tracking(input) {
  const state = cursor(input.cursor, {});
  const ps = 20;
  if (!input.cursor) {
    const [anime, cinema] = await Promise.all([
      read(api, "/x/space/bangumi/follow/list", { vmid: input.owner, type: 1, pn: 1, ps }),
      read(api, "/x/space/bangumi/follow/list", { vmid: input.owner, type: 2, pn: 1, ps }).catch(error => optionalData(error, { list: [], total: 0 }))
    ]);
    const seen = new Set();
    const items = [];
    let animeCount = 0;
    let cinemaUnique = 0;
    for (const row of rows(anime?.list, trackingRow)) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      items.push(row);
      animeCount++;
    }
    for (const row of rows(cinema?.list, trackingRow)) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      items.push(row);
      cinemaUnique++;
    }
    const total1 = count(anime?.total) ?? animeCount;
    const total2 = cinemaUnique > 0 ? (count(cinema?.total) ?? cinemaUnique) : 0;
    const total = total1 + total2;
    const more1 = animeCount > 0 && ps < total1;
    const more2 = cinemaUnique > 0 && ps < total2;
    let nextCursor = "";
    if (more1) nextCursor = JSON.stringify({ type: 1, page: 2, more2 });
    else if (more2) nextCursor = JSON.stringify({ type: 2, page: 2, more2: false });
    return { rows: items, total, nextCursor };
  }
  const type = state.type === 2 ? 2 : 1;
  const pn = count(state.page) || 2;
  const data = await read(api, "/x/space/bangumi/follow/list", { vmid: input.owner, type, pn, ps });
  const items = rows(data?.list, trackingRow);
  const total = count(data?.total);
  const hasMore = items.length > 0 && pn * ps < (total ?? 0);
  let nextCursor = "";
  if (hasMore) {
    nextCursor = JSON.stringify({ type, page: pn + 1, more2: Boolean(state.more2) });
  } else if (type === 1 && state.more2) {
    nextCursor = JSON.stringify({ type: 2, page: 2, more2: false });
  }
  return { rows: items, nextCursor };
}

async function courses(input) {
  const pn = count(cursor(input.cursor, {})?.page) || 1;
  const ps = 10;
  const data = await read(api, "/pugv/pay/web/my/paid", { pn, ps });
  const items = rows(data?.data ?? data?.items, item => {
    const id = identifier(item.season_id || item.id);
    return {
      id,
      title: item.title,
      subtitle: item.sub_title || item.subtitle || item.update_info || item.up_name || "",
      coverURL: favoriteCover(item.cover),
      ref: positiveID(id) ? { kind: "course", id: "cs" + id } : undefined
    };
  });
  const total = count(data?.total ?? data?.page?.total);
  return { rows: items, total, nextCursor: items.length && pn * ps < (total ?? 0) ? JSON.stringify({ page: pn + 1 }) : "" };
}

async function favorites(input) {
  const page = Math.max(1, Number(input.cursor) || 1);
  if (!input.folder) {
    const data = await read(api, "/x/v3/fav/folder/created/list", { up_mid: input.owner, pn: page, ps: 20 });
    const items = rows(data?.list, (item, index) => {
      const id = identifier(item.id);
      const attr = count(item.attr);
      return {
        id,
        title: item.title,
        count: count(item.media_count),
        coverURL: favoriteCover(item.cover),
        private: attr === undefined ? undefined : Boolean(attr & 1),
        canDelete: page !== 1 || index !== 0,
        ref: { kind: "collection", id }
      };
    });
    return { rows: items, total: count(data?.count), nextCursor: data?.has_more ? String(page + 1) : "" };
  }
  if (!/^\d+$/.test(input.folder)) throw { code: "permission" };
  const data = await read(api, "/x/v3/fav/resource/list", {
    media_id: input.folder, pn: page, ps: 20, keyword: "", order: "mtime", type: 0, tid: 0, platform: "web"
  });
  return {
    rows: rows(data?.medias, videoItem),
    total: count(data?.info?.media_count),
    nextCursor: data?.has_more ? String(page + 1) : ""
  };
}

const positiveID = value => /^[1-9]\d*$/.test(value);

export async function editFavoriteFolder({action, folder, title, private: isPrivate, resources, secret}) {
  const csrf = secret?.csrf;
  if (!csrf) throw { code: "signIn" };
  const post = async (path, form) => payload(await request(api + "/x/v3/fav/" + path, { ...form, csrf }), decodeAccountJSON);
  if (action === "create") {
    await post("folder/add", { title, intro: "", privacy: isPrivate ? 1 : 0 });
    return {};
  }
  if (!positiveID(folder)) throw { code: "permission" };
  switch (action) {
    case "update": {
      const info = await read(api, "/x/v3/fav/folder/info", { media_id: folder });
      if (!info) throw { code: "plugin" };
      await post("folder/edit", { media_id: folder, title, intro: info.intro ?? "", privacy: isPrivate ? 1 : 0, cover: info.cover ?? "" });
      break;
    }
    case "delete":
      await post("folder/del", { media_ids: folder, platform: "web" });
      break;
    case "remove":
      if (!resources?.length || resources.some(value => !/^[1-9]\d*:[1-9]\d*$/.test(value))) throw { code: "permission" };
      for (let i = 0; i < resources.length; i += 20) {
        await post("resource/batch-del", { media_id: folder, resources: resources.slice(i, i + 20).join(","), platform: "web" });
      }
      break;
    default:
      throw { code: "unsupported" };
  }
  return {};
}

const bvAlphabet = "FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf";
const bvTwo26 = 67108864;
const bvMaxHi = 33554432;
const bvMaxAid = bvMaxHi * bvTwo26;
const bvXorHi = Math.floor(23442827791579 / bvTwo26);
const bvXorLo = 23442827791579 % bvTwo26;

function av2bv(aid) {
  const id = identifier(aid);
  if (!positiveID(id)) return undefined;
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n <= 0 || n >= bvMaxAid) return undefined;
  const hi = (Math.floor(n / bvTwo26) | bvMaxHi) ^ bvXorHi;
  const lo = (n % bvTwo26) ^ bvXorLo;
  let tmp = hi * bvTwo26 + lo;
  const chars = ["B", "V", "1", "0", "0", "0", "0", "0", "0", "0", "0", "0"];
  for (let i = 11; tmp > 0 && i >= 0; i--) {
    chars[i] = bvAlphabet[tmp % 58];
    tmp = Math.floor(tmp / 58);
  }
  [chars[3], chars[9]] = [chars[9], chars[3]];
  [chars[4], chars[7]] = [chars[7], chars[4]];
  return chars.join("");
}

function noticeRefFromSources(sources, item = {}) {
  if (typeof item.bvid === "string" && /^BV[a-zA-Z0-9]+$/.test(item.bvid)) {
    return { kind: "video", id: item.bvid };
  }
  for (const raw of sources) {
    if (typeof raw !== "string" || !raw) continue;
    let m = /(?:bilibili\.com\/video\/|bilibili:\/\/video\/)(BV[a-zA-Z0-9]+)/.exec(raw);
    if (m) return { kind: "video", id: m[1] };
    m = /(?:bilibili\.com\/video\/av|bilibili:\/\/video\/)([1-9]\d*)/.exec(raw);
    if (m) {
      const bvid = av2bv(m[1]);
      if (bvid) return { kind: "video", id: bvid };
    }
    m = /(?:bilibili\.com\/bangumi\/play\/ss|bilibili:\/\/pgc\/season\/)([1-9]\d*)/.exec(raw);
    if (m) return { kind: "series", id: "ss" + m[1] };
    m = /(?:bilibili\.com\/cheese\/play\/ss|bilibili:\/\/cheese\/season\/)([1-9]\d*)/.exec(raw);
    if (m) return { kind: "course", id: "cs" + m[1] };
    m = /(?:live\.bilibili\.com\/|bilibili:\/\/live\/)([1-9]\d*)/.exec(raw);
    if (m) return { kind: "live", id: m[1] };
  }
  const bizID = String(item.business_id ?? "");
  if (bizID === "1" || item.business === "\u89c6\u9891" || item.type === "video") {
    const bvid = av2bv(item.subject_id || item.oid || item.aid);
    if (bvid) return { kind: "video", id: bvid };
  }
  return undefined;
}

function clean(value) {
  return typeof value === "string" ? value.replace(/<[^>]+>/g, "").trim() : "";
}

const noticeLabel = {
  reply: "\u56de\u590d\u4f60",
  at: "\u63d0\u5230\u4f60",
  like: "\u6536\u5230\u7684\u8d5e",
  system: "\u7cfb\u7edf\u901a\u77e5"
};

function noticeFilterForKind(kind) {
  if (kind === "reply" || kind === "at") return "reply";
  if (kind === "like") return "like";
  return "system";
}

function feedItem(kind, row, { defaultUnread = false, lastViewAt = 0 } = {}) {
  const item = row.item ?? {};
  const user = row.user ?? row.users?.[0];
  const id = identifier(row.id || item.id || item.source_id);
  if (!id) return undefined;
  const action = noticeLabel[kind];
  const actor = clean(user?.nickname);
  const actorID = positiveID(identifier(user?.mid)) ? identifier(user.mid) : undefined;
  const avatarURL = accountArtwork(user?.avatar || user?.face, "128w_128h");
  const coverURL = favoriteCover(item.pic || item.cover);
  const ts = timestamp(row.reply_time || row.at_time || row.like_time || row.time);
  const unread = row.is_unread === true || row.is_unread === 1 ||
    (row.is_unread === undefined && (defaultUnread || (lastViewAt > 0 && ts > lastViewAt)));
  const ref = noticeRefFromSources([item.uri, item.native_uri, row.link, item.link], item);
  const isCommentNotice = kind === "reply" || kind === "at" ||
    item.type === "reply" || String(item.uri ?? "").includes("#reply") || String(item.native_uri ?? "").includes("comment");
  const target = ref && (ref.kind === "video" || ref.kind === "series") && isCommentNotice ? "comments" : undefined;
  const itemTitle = clean(item.title) || actor || action;
  return {
    id: kind + ":" + id,
    title: actor || action,
    subtitle: clean(item.source_content) || clean(item.target_reply_content) || clean(item.title) || clean(row.content),
    time: ts,
    creatorAvatarURL: avatarURL,
    coverURL,
    ref,
    item: ref ? {
      ref,
      title: itemTitle,
      coverURL: cover(item.pic || item.cover) || coverURL,
      creator: actorID && actor ? { id: actorID, name: actor, avatarURL } : undefined
    } : undefined,
    notice: {
      actor,
      actorID,
      action,
      unread,
      filter: noticeFilterForKind(kind),
      target
    }
  };
}

async function feed(kind, offset) {
  const data = await read(api, "/x/msgfeed/" + kind, { ...web, platform: "web", ...(offset ?? {}) });
  const body = data?.total?.items ? data.total : data?.list?.items ? data.list : data;
  const next = body?.cursor;
  const lastViewAt = offset ? 0 : (count(data?.last_view_at ?? body?.last_view_at) ?? 0);
  const latest = offset ? [] : data?.latest?.items ?? [];
  const combined = [
    ...rows(latest, item => feedItem(kind, item, { defaultUnread: true, lastViewAt })),
    ...rows(body?.items, item => feedItem(kind, item, { defaultUnread: false, lastViewAt }))
  ];
  const seen = new Set();
  const deduped = combined.filter(row => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
  return {
    rows: deduped,
    next: next && !next.is_end && next.id != null && next.time != null ?
      { id: String(next.id), [kind + "_time"]: next.time } : null
  };
}

function cleanSystemText(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const extracted = parsed.web ?? parsed.text ?? parsed.content ?? parsed.msg ?? parsed.message ?? parsed.title;
        if (typeof extracted === "string" && extracted.trim()) {
          return clean(extracted);
        }
      }
    } catch {}
  }
  return clean(trimmed);
}

function systemItem(item) {
  const id = identifier(item.id || item.cursor);
  if (!id) return undefined;
  const itemCursor = identifier(item.cursor);
  const title = cleanSystemText(item.title) || noticeLabel.system;
  const subtitle = cleanSystemText(item.content) || cleanSystemText(item.message) || cleanSystemText(item.text);
  const ref = noticeRefFromSources([item.link, item.uri, item.native_uri, subtitle, item.content, item.message], item);
  return {
    id: "system:" + id,
    title,
    subtitle,
    time: timestamp(item.time_at || item.time || item.publish_time || item.mtime),
    ref,
    item: ref ? { ref, title } : undefined,
    notice: {
      unread: item.is_unread === true || item.is_unread === 1,
      filter: "system",
      cursor: positiveID(itemCursor) ? itemCursor : undefined
    }
  };
}

function compareNumericID(left, right) {
  if (left.length !== right.length) return left.length - right.length;
  return left === right ? 0 : left < right ? -1 : 1;
}

async function latestSystemCursor() {
  const [unified, personal] = await Promise.all([
    read(messages, "/x/sys-msg/query_unified_notify", { ...web, page_size: 10 }).catch(error => optionalData(error, null)),
    read(messages, "/x/sys-msg/query_user_notify", { ...web, page_size: 20 }).catch(error => optionalData(error, null))
  ]);
  let maxCursor = "";
  for (const item of [...(unified?.system_notify_list ?? []), ...(personal?.system_notify_list ?? [])]) {
    const c = identifier(item?.cursor);
    if (positiveID(c) && (!maxCursor || compareNumericID(c, maxCursor) > 0)) {
      maxCursor = c;
    }
  }
  return maxCursor;
}

async function updateSystemCursor(targetCursor, csrf) {
  const cursorID = positiveID(identifier(targetCursor)) ? identifier(targetCursor) : await latestSystemCursor();
  if (!cursorID) return;
  const query = new URLSearchParams({ ...web, cursor: cursorID, has_up: 0, csrf }).toString();
  const response = await fetch(messages + "/x/sys-msg/update_cursor?" + query, {
    headers: {
      Origin: "https://message.bilibili.com",
      Referer: "https://message.bilibili.com/",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"
    },
    redirect: "error"
  }).catch(() => { throw { code: "network" }; });
  if (response.status === 412 || response.status === 429) throw { code: "rateLimited" };
  if (!response.ok) throw { code: "network" };
  await payload(response, decodeAccountJSON);
}

async function readUnreadCount() {
  const unread = await read(im, "/x/im/web/msgfeed/unread", web);
  return ["reply", "at", "like", "sys_msg"].reduce((total, category) => total + (count(unread?.[category]) ?? 0), 0);
}

export async function markNotificationsRead({ all = false, filter = "", ids = [], cursor: targetCursor = "", secret } = {}) {
  const csrf = secret?.csrf;
  if (!csrf) throw { code: "signIn" };
  const feedKinds = new Set();
  let markSystem = false;
  let sysCursor = positiveID(identifier(targetCursor)) ? identifier(targetCursor) : "";

  if (all) {
    if (!filter || filter === "all") {
      feedKinds.add("reply");
      feedKinds.add("at");
      feedKinds.add("like");
      markSystem = true;
    } else if (filter === "reply") {
      feedKinds.add("reply");
      feedKinds.add("at");
    } else if (filter === "like") {
      feedKinds.add("like");
    } else if (filter === "system") {
      markSystem = true;
    } else {
      throw { code: "permission" };
    }
  } else {
    for (const rawID of ids) {
      const id = identifier(rawID);
      if (id.startsWith("reply:")) feedKinds.add("reply");
      else if (id.startsWith("at:")) feedKinds.add("at");
      else if (id.startsWith("like:")) feedKinds.add("like");
      else if (id.startsWith("system:")) {
        markSystem = true;
        const suffix = id.slice(7);
        if (!sysCursor && positiveID(suffix)) sysCursor = suffix;
      }
    }
    if (!feedKinds.size && !markSystem) {
      if (filter === "reply") { feedKinds.add("reply"); feedKinds.add("at"); }
      else if (filter === "like") feedKinds.add("like");
      else if (filter === "system") markSystem = true;
    }
  }

  const tasks = [...feedKinds].map(kind => read(api, "/x/msgfeed/" + kind, { ...web, platform: "web" }));
  if (markSystem) tasks.push(updateSystemCursor(sysCursor, csrf));
  await Promise.all(tasks);

  const fallbackUnread = all && (!filter || filter === "all") ? 0 : undefined;
  const unread = await readUnreadCount().catch(error => optionalData(error, fallbackUnread));
  return unread === undefined ? {} : { unread };
}

async function system(offset) {
  if (offset) {
    const data = await read(messages, "/x/sys-msg/query_notify_list", { ...web, data_type: 1, cursor: offset });
    const list = Array.isArray(data) ? data : (data?.system_notify_list ?? []);
    return { rows: rows(list, systemItem), next: list.length ? identifier(list.at(-1).cursor) || null : null };
  }
  const [unified, personal] = await Promise.all([
    read(messages, "/x/sys-msg/query_unified_notify", { ...web, page_size: 10 }),
    read(messages, "/x/sys-msg/query_user_notify", { ...web, page_size: 20 })
  ]);
  const list = [...(unified?.system_notify_list ?? []), ...(personal?.system_notify_list ?? [])];
  list.sort((a, b) => {
    const left = identifier(a.cursor), right = identifier(b.cursor);
    return right.length - left.length || (left === right ? 0 : left < right ? 1 : -1);
  });
  return { rows: rows(list, systemItem), next: list.length ? identifier(list.at(-1).cursor) || null : null };
}

async function notifications(input) {
  if (input.summary) {
    const unread = await read(im, "/x/im/web/msgfeed/unread", web);
    return { unread: ["reply", "at", "like", "sys_msg"].reduce((total, category) => total + (count(unread?.[category]) ?? 0), 0) };
  }
  const kinds = input.filter === "all" ? ["reply", "at", "like", "system"] : [input.filter];
  const offsets = cursor(input.cursor, {});
  const next = {};
  const lists = await Promise.all(kinds.map(async kind => {
    if (!Object.hasOwn(noticeLabel, kind)) throw { code: "permission" };
    if (offsets[kind] === null) {
      next[kind] = null;
      return [];
    }
    const result = await (kind === "system" ? system(offsets[kind]) : feed(kind, offsets[kind]));
    next[kind] = result.next;
    return result.rows;
  }));
  return {
    rows: lists.flat().sort((a, b) => (b.time || 0) - (a.time || 0)),
    nextCursor: Object.values(next).some(value => value !== null) ? JSON.stringify(next) : ""
  };
}

export async function readAccount(input) {
  switch (input.section) {
    case "history": return history(input);
    case "watchLater": return watchLater();
    case "favorites": return favorites(input);
    case "tracking": return tracking(input);
    case "courses": return courses(input);
    case "notifications": return notifications(input);
    default: throw { code: "unsupported" };
  }
}
