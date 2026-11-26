import { optionalData, payload, webHeaders } from "./auth.js";
import { cacheGeneration, cached, relationGeneration } from "./cache.js";
import { cover, coverSource } from "./recommendations.js";

const site = "https://api.bilibili.com";
const maxCourseEpisodes = 120;

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

function landscape(value) {
  const source = coverSource(value);
  return source ? source + "@1920w.jpg" : undefined;
}

function courseAvatar(value) {
  const source = coverSource(value);
  return source ? source + "@128w_128h_1c.jpg" : (httpsURL(value) || undefined);
}

export function parseCourseID(id) {
  const match = /^(?:cs|ss)?([1-9]\d*)$/.exec(text(id));
  return match ? match[1] : undefined;
}

export async function pugvGet(path, params = {}, referer = "https://www.bilibili.com/cheese/") {
  const query = new URLSearchParams(params).toString();
  const url = site + path + (query ? "?" + query : "");
  let response;
  try {
    response = await fetch(url, {
      headers: { ...webHeaders, Referer: referer },
      redirect: "error"
    });
  } catch {
    throw { code: "network" };
  }
  if (response.status === 412 || response.status === 429) throw { code: "rateLimited" };
  if (!response.ok) throw { code: "network" };
  const body = await response.json();
  if (body?.code === -404) throw { code: "expired" };
  if (body?.code === -352) throw { code: "rateLimited" };
  return payload(response, () => body);
}

// Course metadata gates playback on user_status.payed. Purchases happen outside
// the plugin, so unowned courses are only held long enough to cover the
// detail-to-playback burst; owned ones keep a longer TTL.
const ownedCourseTTL = 600;
const unownedCourseTTL = 60;

export async function fetchCourseSeason(seasonID) {
  const sid = positiveID(seasonID);
  if (!sid) throw { code: "unsupported" };
  return cached(`course:${sid}:${cacheGeneration(relationGeneration)}`,
    data => isCourseOwned(data) ? ownedCourseTTL : unownedCourseTTL,
    () => loadCourseSeason(sid),
    data => data != null && typeof data === "object");
}

async function loadCourseSeason(sid) {
  const referer = `https://www.bilibili.com/cheese/play/ss${sid}`;
  const data = await pugvGet("/pugv/view/web/season", { season_id: sid }, referer);
  if (data?.episode_page?.next && Array.isArray(data.episodes) && data.episodes.length < maxCourseEpisodes) {
    const extra = await pugvGet("/pugv/view/web/ep/list", { season_id: sid, pn: 2, ps: 50 }, referer)
      .catch(error => optionalData(error, null));
    if (Array.isArray(extra?.items) && extra.items.length) {
      const seen = new Set(data.episodes.map(ep => positiveID(ep?.id)).filter(Boolean));
      for (const ep of extra.items) {
        const id = positiveID(ep?.id);
        if (id && !seen.has(id)) {
          seen.add(id);
          data.episodes.push(ep);
          if (data.episodes.length >= maxCourseEpisodes) break;
        }
      }
    }
  }
  return data;
}

export function isCourseOwned(data) {
  const status = data?.user_status;
  return Boolean(status && (status.payed === 1 || status.payed === true) && !status.is_expired);
}

export function parseCourseEpisodes(data) {
  const owned = isCourseOwned(data);
  const raw = Array.isArray(data?.episodes) ? data.episodes : [];
  const parsed = [];
  for (let i = 0; i < raw.length; i++) {
    const ep = raw[i];
    const epID = positiveID(ep?.id);
    const aid = positiveID(ep?.aid);
    const cid = positiveID(ep?.cid);
    const partID = cid || epID;
    const title = text(ep?.title) || `\u7b2c ${i + 1} \u8bfe`;
    const durationSeconds = count(ep?.duration);
    const epStatus = Number(ep?.ep_status ?? 0);
    const payStatus = Number(ep?.status ?? 2);
    const upcoming = !partID || epStatus === -1;
    const playable = !upcoming && (owned || ep?.playable === true || payStatus === 1 || payStatus === 3);
    const locked = !upcoming && !playable;
    const previewOnly = !upcoming && !owned && (payStatus === 1 || payStatus === 3);
    let status;
    if (upcoming) {
      status = "\u5c1a\u672a\u66f4\u65b0";
    } else if (locked) {
      status = "\u9700\u8d2d\u4e70";
    } else if (previewOnly) {
      status = text(ep?.label) || "\u8bd5\u770b";
    }
    parsed.push({
      title,
      partID: upcoming ? undefined : partID,
      durationSeconds: !upcoming ? durationSeconds : undefined,
      unavailable: upcoming || undefined,
      locked: locked || undefined,
      status,
      epID,
      aid,
      cid,
      payStatus,
      playable,
      releaseDate: count(ep?.release_date)
    });
  }
  return parsed;
}

export function toCourseSegments(parsed) {
  return parsed.map(ep => ({
    title: ep.title,
    partID: ep.partID,
    durationSeconds: ep.durationSeconds,
    unavailable: ep.unavailable,
    locked: ep.locked,
    status: ep.status
  }));
}

export function courseAccess(data, parsed) {
  const owned = isCourseOwned(data);
  if (owned) return "granted";
  const released = parsed.filter(ep => !ep.unavailable);
  if (!released.length) return "restricted";
  const anyUnlocked = released.some(ep => !ep.locked);
  const anyLocked = released.some(ep => ep.locked);
  if (anyUnlocked && !anyLocked) return "granted";
  if (anyUnlocked) return "preview";
  return "restricted";
}

function mapRelatedCourse(row, excludeID) {
  const sid = positiveID(row?.id ?? row?.season_id);
  const title = text(row?.title);
  if (!sid || !title || sid === excludeID) return undefined;
  return {
    ref: { kind: "course", id: "cs" + sid },
    title,
    subtitle: text(row?.subtitle) || undefined,
    coverURL: cover(row?.cover),
    backdropURL: landscape(row?.cover),
    views: count(row?.view),
    category: "\u8bfe\u5802",
    quality: text(row?.ep_count) || undefined
  };
}

export async function getCourseDetail(id, { includeSections = false, loadDiscussion } = {}) {
  const seasonID = parseCourseID(id);
  if (!seasonID) throw { code: "unsupported" };
  const data = await fetchCourseSeason(seasonID);
  const title = text(data?.title);
  if (!title) throw { code: "expired" };

  const parsed = parseCourseEpisodes(data);
  const segments = toCourseSegments(parsed);
  const firstUnlocked = parsed.find(ep => !ep.unavailable && !ep.locked) ?? parsed.find(ep => !ep.unavailable);
  const firstCommentEpisode = parsed.find(ep => !ep.unavailable && ep.aid) ?? parsed.find(ep => ep.aid);

  const upID = positiveID(data?.up_info?.mid);
  const upName = text(data?.up_info?.uname);
  const creator = upID && upName ? {
    id: upID,
    name: upName,
    avatarURL: courseAvatar(data.up_info.avatar),
    following: data.up_info.is_follow === 1 || data.up_info.is_follow === true
  } : undefined;

  const briefText = typeof data?.brief?.content === "string" ? text(data.brief.content) : "";
  const subtitle = text(data?.subtitle) || briefText || undefined;
  const views = count(data?.stat?.play);
  const epCount = count(data?.ep_count) ?? parsed.length;
  const releaseInfo = text(data?.release_info) || (epCount > 0 ? `\u5171 ${epCount} \u8bfe` : "");
  const publishedAt = firstUnlocked?.releaseDate;
  const access = courseAccess(data, parsed);

  const related = includeSections
    ? (Array.isArray(data?.recommend_seasons) ? data.recommend_seasons : [])
        .map(row => mapRelatedCourse(row, seasonID))
        .filter(Boolean)
        .slice(0, 12)
    : undefined;

  const discussion = includeSections && loadDiscussion && firstCommentEpisode?.aid
    ? await loadDiscussion({
        aid: firstCommentEpisode.aid,
        owner: upID ? { mid: upID } : undefined
      }).catch(error => (error?.code === "rateLimited" ? [] : optionalData(error, [])))
    : undefined;

  return {
    ref: { kind: "course", id: "cs" + seasonID },
    title,
    subtitle,
    creator,
    coverURL: cover(data?.cover),
    backdropURL: landscape(data?.cover),
    durationSeconds: firstUnlocked?.durationSeconds,
    views,
    category: "\u8bfe\u5802",
    quality: releaseInfo || undefined,
    videoDetails: {
      publishedAt,
      access,
      segments: segments.length ? segments : undefined,
      segmentKind: segments.length ? "parts" : undefined,
      discussion: discussion?.length ? discussion : undefined,
      related: related?.length ? related : undefined
    }
  };
}

export async function fetchCreatorCourses(mid, owner) {
  const uid = positiveID(mid);
  if (!uid) return null;
  const data = await pugvGet("/pugv/app/web/season/page", { mid: uid, pn: 1, ps: 10 }, `https://space.bilibili.com/${uid}/`)
    .catch(error => optionalData(error, null));
  const raw = Array.isArray(data?.items) ? data.items : [];
  const items = raw.flatMap(row => {
    const sid = positiveID(row?.season_id ?? row?.id);
    const title = text(row?.title);
    if (!sid || !title) return [];
    const epCount = count(row?.ep_count);
    return [{
      ref: { kind: "course", id: "cs" + sid },
      title,
      subtitle: text(row?.subtitle) || undefined,
      creator: owner,
      coverURL: cover(row?.cover),
      backdropURL: landscape(row?.cover),
      category: "\u8bfe\u5802",
      quality: epCount ? `\u5171 ${epCount} \u8bfe` : undefined
    }];
  });
  if (!items.length) return null;
  const total = count(data?.page?.total) ?? items.length;
  return {
    id: `courses:${uid}`,
    title: "\u8bfe\u5802",
    count: total,
    items
  };
}
