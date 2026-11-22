import { optionalData, payload, request, webHeaders } from "./auth.js";
import { cover, coverSource } from "./recommendations.js";

const site = "https://api.bilibili.com";
const homeOrigin = "https://www.bilibili.com/";
const indexPageSize = 20;

const genres = [
  { value: "", label: "\u5168\u90e8" },
  { value: "1", label: "\u756a\u5267" },
  { value: "4", label: "\u56fd\u521b" },
  { value: "2", label: "\u7535\u5f71" },
  { value: "3", label: "\u7eaa\u5f55\u7247" },
  { value: "5", label: "\u7535\u89c6\u5267" },
  { value: "7", label: "\u7efc\u827a" }
];

const genreNames = new Map(genres.filter(g => g.value).map(g => [g.value, g.label]));
const genreEyebrows = {
  "1": "ANIME / FEATURED",
  "4": "ANIMATION / FEATURED",
  "2": "CINEMA / FEATURED",
  "3": "DOCUMENTARY / FEATURED",
  "5": "DRAMA / FEATURED",
  "7": "VARIETY / FEATURED"
};

const indexGenreOptions = genres.filter(g => g.value);

const defaultSortOptions = [
  { value: "0", label: "\u6700\u8fd1\u66f4\u65b0" },
  { value: "3", label: "\u8ffd\u756a\u4eba\u6570" },
  { value: "4", label: "\u6700\u9ad8\u8bc4\u5206" },
  { value: "2", label: "\u64ad\u653e\u6570\u91cf" },
  { value: "5", label: "\u5f00\u64ad\u65f6\u95f4" }
];

const preferredFilterFields = ["area", "year", "release_date", "is_finish", "style_id", "season_status"];

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

function poster(value) {
  const source = coverSource(value);
  return source ? source + "@480w_640h_1c.jpg" : undefined;
}

function landscape(value) {
  const source = coverSource(value);
  return source ? source + "@1920w.jpg" : undefined;
}

async function primeBuvid() {
  try {
    await fetch(homeOrigin, { method: "HEAD", headers: webHeaders, redirect: "error" });
  } catch {}
}

async function pgcGet(path, params = {}) {
  const query = new URLSearchParams(params).toString();
  const url = site + path + (query ? "?" + query : "");
  const run = async () => {
    let response;
    try {
      response = await fetch(url, {
        headers: { ...webHeaders, Referer: "https://www.bilibili.com/anime/index/" },
        redirect: "error"
      });
    } catch {
      throw { code: "network" };
    }
    if (response.status === 412 || response.status === 429) throw { code: "rateLimited" };
    if (!response.ok) throw { code: "network" };
    const body = await response.json();
    if (body?.code === -352) throw { code: "rateLimited" };
    if (body?.code === 0) return body.data ?? body.result;
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

function formatScore(raw) {
  const s = text(String(raw ?? ""));
  if (!s || s === "0" || s === "0.0") return "";
  return s;
}

function mapIndexRow(row, seasonType, trackedSet) {
  const id = positiveID(row?.season_id ?? row?.media_id);
  const title = text(row?.title);
  if (!id || !title) return undefined;
  const st = String(row?.season_type || seasonType || "1");
  const category = genreNames.get(st) || text(row?.season_type_name) || "\u756a\u5267";
  const badge = text(row?.badge) || text(row?.badge_info?.text) || text(row?.index_show);
  const status = text(row?.index_show);
  const score = formatScore(row?.score);
  const subtitle = text(row?.subTitle) || status || undefined;
  const coverURL = poster(row?.cover) || cover(row?.first_ep?.cover);
  const backdropURL = landscape(row?.first_ep?.cover || row?.cover);
  return {
    item: {
      ref: { kind: "series", id: "ss" + id },
      title,
      subtitle,
      coverURL,
      backdropURL,
      category,
      quality: badge || undefined
    },
    badge: badge || status || undefined,
    score: score || undefined,
    status: status || undefined,
    eyebrow: genreEyebrows[st] || "SERIES / FEATURED",
    tracked: trackedSet?.has(id) === true
  };
}

async function fetchTrackedSet(owner) {
  if (!positiveID(owner)) return { set: new Set(), entries: [] };
  const [anime, cinema] = await Promise.all([
    pgcGet("/x/space/bangumi/follow/list", { type: 1, vmid: owner, pn: 1, ps: 30 })
      .catch(error => optionalData(error, { list: [] })),
    pgcGet("/x/space/bangumi/follow/list", { type: 2, vmid: owner, pn: 1, ps: 30 })
      .catch(error => optionalData(error, { list: [] }))
  ]);
  const set = new Set();
  const entries = [];
  for (const row of [...(anime?.list ?? []), ...(cinema?.list ?? [])]) {
    const id = positiveID(row?.season_id);
    const title = text(row?.title);
    if (!id || !title || set.has(id)) continue;
    set.add(id);
    const st = String(row?.season_type || "1");
    const status = text(row?.new_ep?.index_show || row?.progress);
    const badge = text(row?.badge) || status;
    entries.push({
      item: {
        ref: { kind: "series", id: "ss" + id },
        title,
        subtitle: text(row?.evaluate) || status || undefined,
        coverURL: poster(row?.cover),
        backdropURL: landscape(row?.horizontal_cover_169 || row?.cover),
        category: genreNames.get(st) || text(row?.season_type_name) || "\u756a\u5267",
        quality: badge || undefined
      },
      badge: badge || undefined,
      status: status || undefined,
      eyebrow: genreEyebrows[st] || "SERIES / FEATURED",
      tracked: true
    });
  }
  return { set, entries };
}

async function fetchIndexConditions(seasonType) {
  const data = await pgcGet("/pgc/season/index/condition", {
    season_type: seasonType, type: 1
  }).catch(error => optionalData(error, null));
  const groups = [
    { key: "season_type", label: "\u7c7b\u578b", options: indexGenreOptions }
  ];
  const rawFilters = Array.isArray(data?.filter) ? data.filter : [];
  const byField = new Map();
  for (const f of rawFilters) {
    const field = text(f?.field);
    const name = text(f?.name);
    const values = Array.isArray(f?.values) ? f.values : [];
    if (!field || !name || !values.length) continue;
    const options = values
      .map(v => ({ value: String(v?.keyword ?? ""), label: text(v?.name) }))
      .filter(v => v.label);
    if (options.length) {
      byField.set(field, { key: field, label: name, options });
    }
  }
  let added = 0;
  for (const field of preferredFilterFields) {
    if (added >= 3) break;
    const g = byField.get(field);
    if (g) {
      groups.push(g);
      added++;
    }
  }
  for (const [field, g] of byField.entries()) {
    if (added >= 3) break;
    if (groups.some(existing => existing.key === field)) continue;
    groups.push(g);
    added++;
  }
  const rawOrders = Array.isArray(data?.order) ? data.order : [];
  const orderOptions = rawOrders
    .map(o => ({ value: String(o?.field ?? ""), label: text(o?.name) }))
    .filter(o => o.value && o.label);
  groups.push({
    key: "order",
    label: "\u6392\u5e8f",
    options: orderOptions.length ? orderOptions : defaultSortOptions
  });
  return groups;
}

async function fetchIndexResult(seasonType, filters, page, trackedSet) {
  const params = {
    season_type: seasonType,
    st: seasonType,
    type: 1,
    page,
    pagesize: indexPageSize,
    sort: 0
  };
  const order = text(filters?.order);
  params.order = order || "3";
  for (const [k, v] of Object.entries(filters ?? {})) {
    if (!k || k === "season_type" || k === "order") continue;
    const val = text(String(v ?? ""));
    if (!val || val === "-1") continue;
    params[k] = val;
  }
  const data = await pgcGet("/pgc/season/index/result", params);
  const raw = Array.isArray(data?.list) ? data.list : [];
  const items = raw.map(row => mapIndexRow(row, seasonType, trackedSet)).filter(Boolean);
  const total = count(data?.total);
  const hasMore = data?.has_next === 1 || (total !== undefined && page * indexPageSize < total && items.length > 0);
  return {
    items,
    total,
    nextCursor: nextIndex(page, hasMore)
  };
}

async function readHub(genre, cursor, signedIn, owner) {
  const page = pageIndex(cursor);
  const trackedInfo = signedIn && page === 1
    ? await fetchTrackedSet(owner).catch(error => optionalData(error, { set: new Set(), entries: [] }))
    : { set: new Set(), entries: [] };

  if (genre && genreNames.has(genre)) {
    const res = await fetchIndexResult(genre, { order: "3" }, page, trackedInfo.set);
    const hero = page === 1 && res.items.length ? res.items[0] : undefined;
    return {
      genres,
      hero,
      items: res.items,
      tracked: page === 1 ? trackedInfo.entries : undefined,
      total: res.total,
      nextCursor: res.nextCursor,
      supportsIndex: true,
      supportsCalendar: true
    };
  }

  // "全部" mixes top documentary, anime, and cinema picks on page 1, then paginates anime.
  if (page === 1) {
    const [doc, anime, film] = await Promise.all([
      fetchIndexResult("3", { order: "3" }, 1, trackedInfo.set).catch(error => optionalData(error, { items: [] })),
      fetchIndexResult("1", { order: "3" }, 1, trackedInfo.set),
      fetchIndexResult("2", { order: "3" }, 1, trackedInfo.set).catch(error => optionalData(error, { items: [] }))
    ]);
    const mixed = [];
    const seen = new Set();
    const lists = [doc.items, anime.items, film.items];
    const maxLen = Math.max(...lists.map(l => l.length));
    for (let i = 0; i < maxLen && mixed.length < 24; i++) {
      for (const list of lists) {
        const entry = list[i];
        if (!entry || seen.has(entry.item.ref.id)) continue;
        seen.add(entry.item.ref.id);
        mixed.push(entry);
        if (mixed.length >= 24) break;
      }
    }
    return {
      genres,
      hero: mixed[0],
      items: mixed,
      tracked: trackedInfo.entries,
      nextCursor: anime.nextCursor,
      supportsIndex: true,
      supportsCalendar: true
    };
  }

  const next = await fetchIndexResult("1", { order: "3" }, page, trackedInfo.set);
  return {
    genres,
    items: next.items,
    nextCursor: next.nextCursor,
    supportsIndex: true,
    supportsCalendar: true
  };
}

async function readIndex(genre, filters, cursor, signedIn, owner) {
  const page = pageIndex(cursor);
  const seasonType = genreNames.has(text(filters?.season_type))
    ? text(filters.season_type)
    : (genreNames.has(text(genre)) ? text(genre) : "1");
  const [filterGroups, trackedInfo] = page === 1
    ? await Promise.all([
        fetchIndexConditions(seasonType),
        signedIn ? fetchTrackedSet(owner).catch(error => optionalData(error, { set: new Set(), entries: [] })) : Promise.resolve({ set: new Set(), entries: [] })
      ])
    : [undefined, { set: new Set(), entries: [] }];
  const res = await fetchIndexResult(seasonType, filters, page, trackedInfo.set);
  return {
    genres,
    filterGroups,
    items: res.items,
    total: res.total,
    nextCursor: res.nextCursor,
    supportsIndex: true,
    supportsCalendar: true
  };
}

function parseMonthDay(dateStr) {
  const match = /^(\d{1,2})-(\d{1,2})$/.exec(text(dateStr));
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { month, day };
}

async function readCalendar(signedIn, owner) {
  const [animeDays, guochuangDays, trackedInfo] = await Promise.all([
    pgcGet("/pgc/web/timeline", { types: 1, before: 0, after: 6 }),
    pgcGet("/pgc/web/timeline", { types: 4, before: 0, after: 6 }).catch(error => optionalData(error, [])),
    signedIn ? fetchTrackedSet(owner).catch(error => optionalData(error, { set: new Set(), entries: [] })) : Promise.resolve({ set: new Set(), entries: [] })
  ]);

  const byDate = new Map();
  const order = [];

  const absorb = (rawDays, categoryLabel) => {
    for (const raw of (Array.isArray(rawDays) ? rawDays : [])) {
      const dateStr = text(raw?.date);
      const md = parseMonthDay(dateStr);
      if (!md) continue;
      // Bilibili day_of_week: 1=Mon..6=Sat, 7=Sun -> convert to 0=Sun..6=Sat
      const dow = Number(raw?.day_of_week);
      const weekday = dow === 7 ? 0 : (dow >= 1 && dow <= 6 ? dow : 0);
      let bucket = byDate.get(dateStr);
      if (!bucket) {
        bucket = {
          date: dateStr,
          month: md.month,
          day: md.day,
          weekday,
          isToday: raw?.is_today === 1,
          seen: new Set(),
          entries: []
        };
        byDate.set(dateStr, bucket);
        order.push(bucket);
      }
      for (const ep of (Array.isArray(raw?.episodes) ? raw.episodes : [])) {
        const sid = positiveID(ep?.season_id);
        const title = text(ep?.title);
        if (!sid || !title || bucket.seen.has(sid)) continue;
        bucket.seen.add(sid);
        const epLabel = ep?.delay === 1 && text(ep?.delay_reason)
          ? text(ep.delay_reason)
          : text(ep?.pub_index);
        const coverURL = cover(ep?.ep_cover || ep?.cover || ep?.square_cover);
        bucket.entries.push({
          time: text(ep?.pub_time) || "00:00",
          episodeLabel: epLabel || undefined,
          entry: {
            item: {
              ref: { kind: "series", id: "ss" + sid },
              title,
              subtitle: epLabel || undefined,
              coverURL,
              backdropURL: landscape(ep?.ep_cover || ep?.cover),
              category: categoryLabel
            },
            status: epLabel || undefined,
            tracked: trackedInfo.set.has(sid)
          }
        });
      }
    }
  };

  absorb(animeDays, "\u756a\u5267");
  absorb(guochuangDays, "\u56fd\u521b");

  const days = order.slice(0, 7).map(bucket => {
    bucket.entries.sort((a, b) => a.time.localeCompare(b.time));
    return {
      date: bucket.date,
      month: bucket.month,
      day: bucket.day,
      weekday: bucket.weekday,
      isToday: bucket.isToday,
      entries: bucket.entries
    };
  });

  return {
    genres,
    days,
    supportsIndex: true,
    supportsCalendar: true
  };
}

export async function readSeries({ mode = "hub", genre = "", filters = {}, cursor = "", signedIn = false, owner = "" } = {}) {
  switch (mode || "hub") {
    case "hub":
      return readHub(text(genre), text(cursor), signedIn, owner);
    case "index":
      return readIndex(text(genre), filters, text(cursor), signedIn, owner);
    case "calendar":
      return readCalendar(signedIn, owner);
    default:
      throw { code: "unsupported" };
  }
}

function httpsURL(value) {
  if (typeof value !== "string") return "";
  const url = value.trim().replace(/^\/\//, "https://").replace(/^http:/i, "https:");
  return url.startsWith("https://") ? url : "";
}

export function parseSeasonID(id) {
  const match = /^(?:ss)?([1-9]\d*)$/.exec(text(id));
  return match ? match[1] : undefined;
}

export async function fetchSeason(seasonID) {
  const sid = positiveID(seasonID);
  if (!sid) throw { code: "unsupported" };
  return pgcGet("/pgc/view/web/season", { season_id: sid });
}

function parsePublishTimestamp(raw) {
  const value = text(raw);
  if (!value) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?/.exec(value);
  if (!match) return undefined;
  const ms = Date.UTC(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4] || 0) - 8, Number(match[5] || 0), Number(match[6] || 0)
  );
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : undefined;
}

function formatEpisodeTitle(ep, index) {
  const epNum = text(ep?.title);
  const longTitle = text(ep?.long_title);
  const showTitle = text(ep?.show_title);
  if (longTitle) {
    if (!epNum || /^\d+(?:\.\d+)?$/.test(epNum)) return longTitle;
    return `${epNum} ${longTitle}`.trim();
  }
  if (showTitle) return showTitle;
  if (epNum) {
    return /^\d+(?:\.\d+)?$/.test(epNum) ? `\u7b2c ${epNum} \u8bdd` : epNum;
  }
  return `\u7b2c ${index + 1} \u96c6`;
}

export function parseSeasonEpisodes(data) {
  const raw = Array.isArray(data?.episodes) ? data.episodes : [];
  const parsed = [];
  for (let i = 0; i < raw.length; i++) {
    const ep = raw[i];
    const title = formatEpisodeTitle(ep, i);
    const epID = positiveID(ep?.id);
    const aid = positiveID(ep?.aid);
    const cid = positiveID(ep?.cid);
    const bvid = text(ep?.bvid);
    const partID = cid || epID;
    const durationMs = count(ep?.duration);
    const epStatus = Number(ep?.status ?? 2);
    const upcoming = !partID || epStatus === 14;
    const badge = text(ep?.badge) || text(ep?.badge_info?.text);
    parsed.push({
      title,
      partID: upcoming ? undefined : partID,
      durationSeconds: !upcoming && durationMs !== undefined ? Math.round(durationMs / 1000) : undefined,
      unavailable: upcoming || undefined,
      status: upcoming ? "\u5c1a\u672a\u66f4\u65b0" : (badge || undefined),
      epID,
      aid,
      cid,
      bvid: /^BV[a-zA-Z0-9]+$/.test(bvid) ? bvid : undefined,
      epStatus,
      pubTime: count(ep?.pub_time)
    });
  }
  const total = count(data?.total);
  const isFinish = data?.publish?.is_finish === 1;
  if (!isFinish && total !== undefined && total > parsed.length) {
    const remaining = Math.min(total - parsed.length, 12);
    for (let i = 0; i < remaining; i++) {
      const n = parsed.length + 1;
      parsed.push({
        title: `\u7b2c ${n} \u96c6`,
        unavailable: true,
        status: "\u5c1a\u672a\u66f4\u65b0"
      });
    }
  }
  return parsed;
}

export function toEpisodeSegments(parsed) {
  return parsed.map(ep => ({
    title: ep.title,
    partID: ep.partID,
    durationSeconds: ep.durationSeconds,
    unavailable: ep.unavailable,
    status: ep.status
  }));
}

function seasonAccess(data, userStatus, parsed, signedIn) {
  const rights = data?.rights ?? {};
  const areaLimited = userStatus?.area_limit === 1 || (rights.can_watch === 0 && Boolean(rights.area_limit));
  if (areaLimited) return "restricted";
  const first = parsed.find(ep => !ep.unavailable);
  if (!first) return "restricted";
  const status = first.epStatus;
  const effectiveUser = userStatus ?? data?.user_status ?? {};
  const vipInfo = effectiveUser.vip_info;
  const hasVIP = vipInfo?.status === 1 || vipInfo?.real_vip === 1 || effectiveUser.vip === 1;
  const vipKnown = vipInfo !== undefined || effectiveUser.vip !== undefined;
  const hasPay = effectiveUser.pay === 1 || effectiveUser.pay_pack_paid === 1;
  if (status === 6 || status === 7 || status === 8 || status === 9) {
    if (signedIn && hasPay) return "granted";
    return rights.is_preview === 1 ? "preview" : "restricted";
  }
  if (status === 13) {
    if (signedIn && (hasVIP || !vipKnown)) return "granted";
    return rights.is_preview === 0 ? "restricted" : "preview";
  }
  return "granted";
}

function mapRelatedSeason(row, excludeID) {
  const sid = positiveID(row?.season_id);
  const title = text(row?.title);
  if (!sid || !title || sid === excludeID) return undefined;
  const st = String(row?.season_type || "1");
  const coverSourceURL = row?.new_ep?.cover || row?.cover;
  return {
    ref: { kind: "series", id: "ss" + sid },
    title,
    subtitle: text(row?.subtitle) || text(row?.new_ep?.index_show) || undefined,
    coverURL: cover(coverSourceURL) || poster(row?.cover),
    backdropURL: landscape(coverSourceURL || row?.cover),
    views: count(row?.stat?.view),
    category: genreNames.get(st) || "\u756a\u5267",
    quality: text(row?.new_ep?.index_show) || formatScore(row?.rating?.score) || undefined
  };
}

export async function getSeriesDetail(id, { includeSections = false, signedIn = false, loadDiscussion } = {}) {
  const seasonID = parseSeasonID(id);
  if (!seasonID) throw { code: "unsupported" };
  const [data, relatedData, userStatus] = await Promise.all([
    fetchSeason(seasonID),
    includeSections
      ? pgcGet("/pgc/season/web/related/recommend", { season_id: seasonID }).catch(error => optionalData(error, null))
      : Promise.resolve(null),
    signedIn
      ? pgcGet("/pgc/view/web/season/user/status", { season_id: seasonID }).catch(error => optionalData(error, null))
      : Promise.resolve(null)
  ]);
  const title = text(data?.season_title || data?.title);
  if (!title) throw { code: "expired" };
  const score = data?.rating?.score ? `${data.rating.score} \u5206` : "";
  const categoryParts = Array.isArray(data?.styles) ? data.styles.map(text).filter(Boolean).slice(0, 2) : [];
  const category = categoryParts.join(" \u00b7 ") || text(data?.type_desc) || "\u756a\u5267";
  const parsed = parseSeasonEpisodes(data);
  const segments = toEpisodeSegments(parsed);
  const firstPlayable = parsed.find(ep => !ep.unavailable);
  const firstCommentEpisode = parsed.find(ep => !ep.unavailable && ep.aid) ?? parsed.find(ep => ep.aid);
  const firstCover = data?.horizontal_cover_169 || data?.episodes?.[0]?.cover || data?.cover;
  const views = count(data?.stat?.views);
  const comments = count(data?.stat?.reply);
  const publishedAt = firstPlayable?.pubTime ?? parsePublishTimestamp(data?.publish?.pub_time);
  const upID = positiveID(data?.up_info?.mid);
  const upName = text(data?.up_info?.uname);
  const creator = upID && upName ? {
    id: upID,
    name: upName,
    avatarURL: cover(data.up_info.avatar) || httpsURL(data.up_info.avatar) || undefined,
    following: data.up_info.is_follow === 1 || data.up_info.is_follow === true
  } : undefined;
  const related = includeSections
    ? (Array.isArray(relatedData?.season) ? relatedData.season : [])
        .map(row => mapRelatedSeason(row, seasonID))
        .filter(Boolean)
        .slice(0, 12)
    : undefined;
  const discussion = includeSections && loadDiscussion && firstCommentEpisode?.aid
    ? await loadDiscussion({
        aid: firstCommentEpisode.aid,
        stat: comments === 0 ? { reply: 0 } : undefined,
        owner: upID ? { mid: upID } : undefined
      }).catch(error => (error?.code === "rateLimited" ? [] : optionalData(error, [])))
    : undefined;
  const access = seasonAccess(data, userStatus, parsed, signedIn);
  const tracked = Boolean(signedIn && (userStatus?.follow === 1 || data?.user_status?.follow === 1));
  return {
    ref: { kind: "series", id: "ss" + seasonID },
    title,
    subtitle: text(data?.evaluate) || text(data?.new_ep?.desc) || undefined,
    creator,
    coverURL: poster(data?.cover) || cover(firstCover),
    backdropURL: landscape(firstCover),
    durationSeconds: firstPlayable?.durationSeconds,
    views,
    category,
    quality: text(data?.new_ep?.desc) || score || undefined,
    videoDetails: {
      publishedAt,
      comments,
      access,
      engagement: { tracked },
      segments: segments.length ? segments : undefined,
      segmentKind: segments.length ? "parts" : undefined,
      discussion: discussion?.length ? discussion : undefined,
      related: related?.length ? related : undefined
    }
  };
}

export async function trackSeries({ ref, enabled = false, owner, secret } = {}) {
  const csrf = text(secret?.csrf);
  if (!csrf || !positiveID(owner)) throw { code: "signIn" };
  const seasonID = ref?.kind === "series" ? parseSeasonID(ref.id) : undefined;
  if (!seasonID) throw { code: "permission" };
  const path = enabled ? "/pgc/web/follow/add" : "/pgc/web/follow/del";
  const response = await request(site + path, { season_id: seasonID, csrf });
  await payload(response);
  return { tracked: Boolean(enabled) };
}
