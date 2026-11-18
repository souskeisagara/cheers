import { optionalData, payload, request } from "./auth.js";
import { archiveCategoryNames } from "./categories.js";
import { getCourseDetail } from "./course.js";
import { getLiveDetail } from "./live.js";
import { getSeriesDetail } from "./series.js";
import { videoDiscussion, videoEngagement } from "./video.js";

const site = "https://api.bilibili.com";
const recommendationID = "recommendations";
const titles = {
  recommendations: "\u4e3a\u4f60\u63a8\u8350",
  popular: "\u6b63\u5728\u70ed\u95e8",
  ranking: "\u6392\u884c\u699c",
  regions: "\u5206\u533a\u63a2\u7d22",
  following: "\u6765\u81ea\u4f60\u5173\u6ce8\u7684 UP \u4e3b"
};
const freshness = { initial: 0, change: 3, scroll: 4 };
const pageSize = 12;
const thumbnailSuffix = "@672w_378h_1c.jpg";
const filters = [
  ["0", "\u5168\u90e8"], ["1", "\u52a8\u753b"], ["3", "\u97f3\u4e50"],
  ["4", "\u6e38\u620f"], ["36", "\u77e5\u8bc6"], ["188", "\u79d1\u6280\u6570\u7801"],
  ["160", "\u751f\u6d3b"], ["211", "\u7f8e\u98df"], ["181", "\u5f71\u89c6"],
  ["223", "\u6c7d\u8f66"], ["119", "\u9b3c\u755c"], ["217", "\u52a8\u7269"]
].map(([id, title]) => ({ id, title }));
const regionNames = new Map(filters.slice(1).map(({ id, title }) => [Number(id), title]));

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function category(row) {
  return text(row.tname) || text(row.tname_v2) ||
    archiveCategoryNames[Number(row.tid_v2)] || regionNames.get(Number(row.tid));
}

export function coverSource(value) {
  const image = /^(?:https?:)?\/\/(i[012]\.hdslb\.com\/[^?@#\s]+)(?:[?@#].*)?$/.exec(text(value));
  return image ? "https://" + image[1] : undefined;
}

export function cover(value) {
  const source = coverSource(value);
  return source ? source + thumbnailSuffix : undefined;
}

function creator(owner) {
  const id = String(owner?.mid ?? "");
  const name = text(owner?.name);
  if (!name || !/^[1-9]\d*$/.test(id)) return undefined;
  const avatar = coverSource(owner.face);
  return { id, name, avatarURL: avatar ? avatar + "@96w_96h_1c.jpg" : undefined };
}

export function video(row) {
  const id = text(row?.bvid);
  const title = text(row?.title);
  if (!/^BV[a-zA-Z0-9]+$/.test(id) || !title) return undefined;
  const { width = 0, height = 0 } = row.dimension ?? {};
  const source = coverSource(row.pic);
  return {
    ref: { kind: "video", id },
    title,
    subtitle: text(row.rcmd_reason?.content) || text(row.desc) || undefined,
    creator: creator(row.owner),
    coverURL: source ? source + thumbnailSuffix : undefined,
    backdropURL: source ? source + "@1920w.jpg" : undefined,
    durationSeconds: count(row.duration),
    views: count(row.stat?.view),
    category: category(row),
    quality: Math.max(width, height) >= 3840 && Math.min(width, height) >= 2160 ? "4K" : undefined
  };
}

function pageOf(id, items, nextCursor = "", availableFilters) {
  return {
    collections: items.length ? [{ id, title: titles[id], items }] : [],
    nextCursor,
    filters: availableFilters
  };
}

function pageIndex(cursor, start) {
  if (!cursor) return start;
  const index = Number(cursor);
  if (!Number.isSafeInteger(index) || index < 1 || String(index) !== cursor) {
    throw { code: "permission" };
  }
  return index;
}

function nextIndex(index) {
  return index < Number.MAX_SAFE_INTEGER ? String(index + 1) : "";
}

function endpoint(path, params = {}) {
  return site + path + "?" + new URLSearchParams(params);
}

async function get(path, params) {
  return payload(await request(endpoint(path, params)));
}

export function durationText(value) {
  const parts = text(value).split(":");
  if (parts.length < 2 || parts.length > 3 || parts.some(part => !/^\d+$/.test(part))) return undefined;
  return count(parts.reduce((seconds, part) => seconds * 60 + Number(part), 0));
}

async function following() {
  const data = await get("/x/polymer/web-dynamic/v1/feed/all", { type: "video" });
  const items = (data?.items ?? []).map(item => {
    const modules = item?.modules;
    const archive = modules?.module_dynamic?.major?.archive;
    if (!archive) return undefined;
    return video({
      bvid: archive.bvid, title: archive.title, desc: archive.desc, pic: archive.cover,
      duration: durationText(archive.duration_text), owner: modules.module_author
    });
  }).filter(Boolean);
  return items.length ? [{ id: "following", title: titles.following, items }] : [];
}

async function recommendations(cursor, refresh, signedIn) {
  const index = pageIndex(cursor, refresh ? 1 : 0);
  const params = {
    fresh_type: refresh ? freshness.change : cursor ? freshness.scroll : freshness.initial,
    fresh_idx: index, fresh_idx_1h: index, brush: index, feed_version: "V8", ps: pageSize
  };
  const response = await request(endpoint("/x/web-interface/index/top/feed/rcmd", params));
  const body = await response.json();
  if (cursor && !refresh && body?.code === 62011) return pageOf(recommendationID, []);
  const data = await payload(response, () => body);
  if (!Array.isArray(data?.item)) throw { code: "plugin" };
  const items = data.item.filter(row => row?.goto === "av").map(video).filter(Boolean);
  const page = pageOf(recommendationID, items, data.item.length ? nextIndex(index) : "");
  if ((!cursor || refresh) && signedIn) {
    page.shelves = await following().catch(error => optionalData(error, []));
  }
  return page;
}

async function popular(cursor) {
  const index = pageIndex(cursor, 1);
  const data = await get("/x/web-interface/popular", { pn: index, ps: pageSize });
  if (!Array.isArray(data?.list)) throw { code: "plugin" };
  const next = data.no_more || !data.list.length ? "" : nextIndex(index);
  return pageOf("popular", data.list.map(video).filter(Boolean), next, filters);
}

async function discovery(collection, filter, cursor) {
  const rid = filter || "0";
  if (!filters.some(choice => choice.id === rid)) throw { code: "permission" };
  if (collection === "popular" && rid === "0") return popular(cursor);
  if (collection !== "regions") {
    const data = await get("/x/web-interface/ranking/v2", { rid, type: "all" });
    if (!Array.isArray(data?.list)) throw { code: "plugin" };
    const items = data.list.map(row => {
      const item = video(row);
      const score = count(row?.score);
      if (item && collection === "ranking" && score > 0) item.rankScore = score;
      return item;
    }).filter(Boolean);
    return pageOf(collection, items, "", filters);
  }
  const index = pageIndex(cursor, 1);
  const data = await get("/x/web-interface/newlist", { rid, pn: index, ps: pageSize });
  if (!Array.isArray(data?.archives)) throw { code: "plugin" };
  return pageOf(collection, data.archives.map(video).filter(Boolean), data.archives.length === pageSize ? nextIndex(index) : "", filters);
}

export async function browse({ collection = "", filter = "", cursor = "", refresh = false, signedIn = false }) {
  switch (collection) {
    case "":
    case recommendationID:
      return recommendations(cursor, refresh, signedIn);
    case "popular":
    case "ranking":
    case "regions":
      return discovery(collection, filter, refresh ? "" : cursor);
    default:
      throw { code: "unsupported" };
  }
}

export function parts(row) {
  return (row.pages ?? []).map(page => ({
    title: text(page.part),
    partID: count(page.cid) ? String(page.cid) : undefined,
    durationSeconds: count(page.duration)
  })).filter(page => page.title);
}

export function collection(row) {
  return (row.ugc_season?.sections ?? []).flatMap(section => section.episodes ?? []).map(episode => {
    const archive = episode.arc;
    const id = text(episode.bvid) || text(archive?.bvid);
    const title = text(episode.title) || text(archive?.title);
    if (!/^BV[a-zA-Z0-9]+$/.test(id) || !title) return undefined;
    return { title, durationSeconds: count(archive?.duration), ref: { kind: "video", id } };
  }).filter(Boolean);
}

async function chapters(row) {
  if (!count(row.aid) || !count(row.cid)) return [];
  const player = await get("/x/player/wbi/v2", { aid: row.aid, cid: row.cid });
  return (player?.view_points ?? []).filter(point => point?.type === 2 && text(point.content)).map(point => ({
    title: text(point.content),
    durationSeconds: count(point.to - point.from),
    startSeconds: count(point.from)
  }));
}

async function sections(row) {
  const pages = parts(row);
  if (pages.length > 1) return { segments: pages, segmentKind: "parts" };
  const uploads = collection(row);
  if (uploads.length > 1) return { segments: uploads, segmentKind: "collection" };
  const timeline = await chapters(row).catch(error => optionalData(error, []));
  if (timeline.length) return { segments: timeline, segmentKind: "chapters" };
  return {};
}

export async function getItem({ kind, id, includeSections = false, signedIn = false }) {
  if (kind === "series") return getSeriesDetail(id, { includeSections, signedIn, loadDiscussion: videoDiscussion });
  if (kind === "course") return getCourseDetail(id, { includeSections, signedIn, loadDiscussion: videoDiscussion });
  if (kind === "live") return getLiveDetail(id, { signedIn });
  if (kind !== "video" || !/^BV[a-zA-Z0-9]+$/.test(id)) throw { code: "unsupported" };
  const endpointPath = includeSections ? "/x/web-interface/view/detail" : "/x/web-interface/view";
  const response = await request(endpoint(endpointPath, { bvid: id }));
  const body = await response.json();
  if (body?.code === -403) throw { code: "permission" };
  if (body?.code === -404) throw { code: "expired" };
  const data = await payload(response, () => body);
  const row = includeSections ? data?.View : data;
  const item = video(row);
  if (!item) throw { code: "plugin" };
  if (item.creator && includeSections) {
    item.creator.following = data.Card?.following === true;
  }
  item.subtitle = text(row.desc) || undefined;
  item.videoDetails = {
    publishedAt: count(row.pubdate),
    comments: count(row.stat?.reply)
  };
  if (row.is_upower_exclusive === true) {
    item.videoDetails.access = row.is_upower_play === true ? "granted" :
      row.is_upower_preview === true ? "preview" : "restricted";
  }
  if (includeSections) {
    const [segments, discussion, interaction] = await Promise.all([
      sections(row), videoDiscussion(row, data.Reply), videoEngagement(row, signedIn)
    ]);
    const related = (data.Related ?? []).map(video).filter(related => related && related.ref.id !== id);
    Object.assign(item.videoDetails, segments, interaction, { discussion, related });
  }
  return item;
}
