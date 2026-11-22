import { optionalData, payload, request, webHeaders } from "./auth.js";
import { archiveCategoryNames } from "./categories.js";
import { fetchCreatorCourses } from "./course.js";
import { cover, coverSource, durationText } from "./recommendations.js";
import { post } from "./video.js";
import { saveWbiKeys, signWbiParams } from "./wbi.js";

const site = "https://api.bilibili.com";
const homeOrigin = "https://www.bilibili.com/";
const videosPageSize = 20;
const collectionsPageSize = 10;
const supportedTabs = ["videos", "posts", "collections", "about"];

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

function endpoint(path, params = {}) {
  return site + path + "?" + new URLSearchParams(params);
}

function avatar(value, size = 192) {
  const source = coverSource(value);
  return source ? `${source}@${size}w_${size}h_1c.jpg` : undefined;
}

async function primeBuvid() {
  try {
    await fetch(homeOrigin, { method: "HEAD", headers: webHeaders, redirect: "error" });
  } catch {}
}

async function ensureWbiParams(params) {
  let signed = signWbiParams(params);
  if (signed) return signed;
  try {
    const nav = await payload(await request(endpoint("/x/web-interface/nav")));
    if (nav?.wbi_img) saveWbiKeys(nav.wbi_img);
    signed = signWbiParams(params);
  } catch {}
  return signed ?? params;
}

async function spaceRequest(path, params, { mid, wbi = false } = {}) {
  const headers = { ...webHeaders, Referer: `https://space.bilibili.com/${mid}/` };
  const run = async () => {
    const query = wbi ? await ensureWbiParams(params) : params;
    let response;
    try {
      response = await fetch(endpoint(path, query), { headers, redirect: "error" });
    } catch {
      throw { code: "network" };
    }
    if (response.status === 412 || response.status === 429) throw { code: "rateLimited" };
    if (!response.ok) throw { code: "network" };
    const body = await response.json();
    if (body?.code === -352) throw { code: "rateLimited" };
    if (body?.code === -404) throw { code: "expired" };
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

function cleanCollectionTitle(meta) {
  const explicit = text(meta?.title);
  if (explicit) return explicit;
  const raw = text(meta?.name);
  if (!raw) return "";
  return raw.replace(/^\u5408\u96c6[\u00b7\u30fb\s-]*/, "").trim() || raw;
}

function spaceVideoItem(row, owner) {
  const id = text(row?.bvid);
  const title = text(row?.title);
  if (!/^BV[a-zA-Z0-9]+$/.test(id) || !title) return undefined;
  const source = coverSource(row.pic);
  const seconds = typeof row.duration === "number" ? count(row.duration) : durationText(row.length ?? row.duration_text);
  const views = parsePlayCount(row.play ?? row.stat?.view ?? row.stat?.play);
  const category = archiveCategoryNames[Number(row.typeid)] || undefined;
  const itemCreator = owner || (text(row.author) && positiveID(row.mid)
    ? { id: String(row.mid), name: text(row.author) }
    : undefined);
  return {
    ref: { kind: "video", id },
    title,
    subtitle: text(row.description ?? row.desc) || undefined,
    creator: itemCreator,
    coverURL: source ? cover(source) : undefined,
    backdropURL: source ? source + "@1920w.jpg" : undefined,
    durationSeconds: seconds,
    views,
    category
  };
}

function topCategories(tlist) {
  if (!tlist || typeof tlist !== "object") return "";
  const names = Object.values(tlist)
    .filter(entry => entry && text(entry.name) && (count(entry.count) ?? 0) > 0)
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
    .slice(0, 2)
    .map(entry => text(entry.name));
  return names.join(" \u00b7 ");
}

async function fetchCard(mid, signedIn) {
  const data = await spaceRequest("/x/web-interface/card", { mid, photo: "true" }, { mid });
  const card = data?.card;
  const name = text(card?.name);
  if (!name) throw { code: "expired" };
  const banner = coverSource(data?.space?.l_img || data?.space?.s_img);
  const official = text(card?.Official?.title || card?.official_verify?.desc);
  const attributes = official ? [{ label: "\u8ba4\u8bc1", value: official }] : undefined;
  return {
    creator: {
      id: mid,
      name,
      avatarURL: avatar(card.face, 192),
      following: signedIn && data?.following === true
    },
    backdropURL: banner ? banner + "@1920w.jpg" : undefined,
    bio: text(card.sign) || undefined,
    followers: count(card.fans ?? data?.follower),
    works: count(data?.archive_count),
    attributes,
    tabs: supportedTabs
  };
}

async function fetchVideos(mid, cursor, owner) {
  const page = pageIndex(cursor);
  const data = await spaceRequest("/x/space/wbi/arc/search", {
    mid, ps: videosPageSize, pn: page, order: "pubdate"
  }, { mid, wbi: true });
  const vlist = Array.isArray(data?.list?.vlist) ? data.list.vlist : [];
  const items = vlist.map(row => spaceVideoItem(row, owner)).filter(Boolean);
  const total = count(data?.page?.count) ?? 0;
  const ps = count(data?.page?.ps) || videosPageSize;
  return {
    items,
    nextCursor: nextIndex(page, items.length > 0 && page * ps < total),
    category: topCategories(data?.list?.tlist)
  };
}

function dynamicVideoItem(archive, author) {
  const id = text(archive?.bvid);
  const title = text(archive?.title);
  if (!/^BV[a-zA-Z0-9]+$/.test(id) || !title) return undefined;
  const source = coverSource(archive.cover);
  return {
    ref: { kind: "video", id },
    title,
    subtitle: text(archive.desc) || undefined,
    creator: author,
    coverURL: source ? cover(source) : undefined,
    backdropURL: source ? source + "@1920w.jpg" : undefined,
    durationSeconds: durationText(archive.duration_text),
    views: parsePlayCount(archive.stat?.play)
  };
}

function dynamicPost(entry, mid) {
  const id = text(entry?.id_str);
  if (!id) return undefined;
  const modules = entry?.modules ?? {};
  const ma = modules.module_author ?? {};
  const md = modules.module_dynamic ?? {};
  const major = md.major ?? {};
  const authorName = text(ma.name);
  const author = authorName ? { id: mid, name: authorName, avatarURL: avatar(ma.face, 96) } : undefined;
  const opus = major.opus;
  let body = text(md.desc?.text);
  if (!body && opus) {
    const title = text(opus.title);
    const summary = text(opus.summary?.text);
    body = title && summary ? `${title}\n${summary}` : title || summary;
  }
  let item = major.type === "MAJOR_TYPE_ARCHIVE" ? dynamicVideoItem(major.archive, author) : undefined;
  if (!item && entry?.orig?.modules?.module_dynamic?.major?.type === "MAJOR_TYPE_ARCHIVE") {
    const origAuthor = entry.orig.modules.module_author;
    const origMid = positiveID(origAuthor?.mid);
    const origCreator = origMid && text(origAuthor?.name)
      ? { id: origMid, name: text(origAuthor.name), avatarURL: avatar(origAuthor.face, 96) }
      : author;
    item = dynamicVideoItem(entry.orig.modules.module_dynamic.major.archive, origCreator);
  }
  if (!body && item?.subtitle) {
    body = item.subtitle;
  }
  let imageURL;
  if (!item) {
    const pic = opus?.pics?.[0]?.url || major.draw?.items?.[0]?.src;
    const source = coverSource(pic);
    if (source) imageURL = cover(source);
  }
  if (!body && !item && !imageURL) return undefined;
  return {
    id,
    publishedAt: count(ma.pub_ts),
    publishedLabel: text(ma.pub_time) || undefined,
    body: body || undefined,
    imageURL,
    item
  };
}

async function fetchPosts(mid, cursor) {
  const params = { host_mid: mid, features: "itemOpusStyle" };
  if (cursor) params.offset = cursor;
  const data = await spaceRequest("/x/polymer/web-dynamic/v1/feed/space", params, { mid });
  const raw = Array.isArray(data?.items) ? data.items : [];
  const posts = raw.map(entry => dynamicPost(entry, mid)).filter(Boolean);
  const offset = text(data?.offset);
  return {
    posts,
    nextCursor: data?.has_more && offset && offset !== cursor ? offset : ""
  };
}

function spaceCollection(prefix, entry, owner) {
  const meta = entry?.meta ?? {};
  const rawID = positiveID(meta.season_id ?? meta.series_id);
  const title = cleanCollectionTitle(meta);
  if (!rawID || !title) return undefined;
  const archives = Array.isArray(entry?.archives) ? entry.archives : [];
  const items = archives.map(row => spaceVideoItem(row, owner)).filter(Boolean);
  if (!items.length) return undefined;
  return {
    id: `${prefix}:${rawID}`,
    title,
    description: text(meta.description) || undefined,
    count: count(meta.total) ?? items.length,
    items
  };
}

async function fetchCollections(mid, cursor, owner) {
  const page = pageIndex(cursor);
  const [data, courseCollection] = await Promise.all([
    spaceRequest("/x/polymer/web-space/seasons_series_list", {
      mid, page_num: page, page_size: collectionsPageSize
    }, { mid }),
    page === 1 ? fetchCreatorCourses(mid, owner) : Promise.resolve(null)
  ]);
  const lists = data?.items_lists ?? {};
  const seasons = (Array.isArray(lists.seasons_list) ? lists.seasons_list : [])
    .map(entry => spaceCollection("season", entry, owner))
    .filter(Boolean);
  const series = (Array.isArray(lists.series_list) ? lists.series_list : [])
    .map(entry => spaceCollection("series", entry, owner))
    .filter(Boolean);
  const collections = [...(courseCollection ? [courseCollection] : []), ...seasons, ...series];
  const total = count(lists.page?.total) ?? 0;
  const ps = count(lists.page?.page_size) || collectionsPageSize;
  return {
    collections,
    nextCursor: nextIndex(page, (seasons.length + series.length) > 0 && page * ps < total)
  };
}

export async function readCreator({ creatorID, tab = "videos", cursor = "", includeProfile = false, signedIn = false } = {}) {
  const mid = positiveID(creatorID);
  if (!mid) throw { code: "permission" };
  const activeTab = tab || "videos";

  if (includeProfile) {
    const profilePromise = fetchCard(mid, signedIn);
    if (activeTab === "about") {
      return { profile: await profilePromise };
    }
    if (activeTab === "videos") {
      const [profile, videos] = await Promise.all([
        profilePromise,
        fetchVideos(mid, cursor).catch(error => optionalData(error, { items: [], nextCursor: "", category: "" }))
      ]);
      if (videos.category && !profile.category) {
        profile.category = videos.category;
      }
      const owner = { id: profile.creator.id, name: profile.creator.name, avatarURL: profile.creator.avatarURL };
      const items = videos.items.map(item => item.creator?.avatarURL ? item : { ...item, creator: owner });
      if (!profile.backdropURL && items[0]?.backdropURL) {
        profile.backdropURL = items[0].backdropURL;
      }
      return { profile, items, nextCursor: videos.nextCursor };
    }
    const profile = await profilePromise;
    const owner = { id: profile.creator.id, name: profile.creator.name, avatarURL: profile.creator.avatarURL };
    if (activeTab === "posts") {
      const result = await fetchPosts(mid, cursor);
      return { profile, posts: result.posts, nextCursor: result.nextCursor };
    }
    if (activeTab === "collections") {
      const result = await fetchCollections(mid, cursor, owner);
      return { profile, collections: result.collections, nextCursor: result.nextCursor };
    }
    throw { code: "unsupported" };
  }

  switch (activeTab) {
    case "videos": {
      const result = await fetchVideos(mid, cursor);
      return { items: result.items, nextCursor: result.nextCursor };
    }
    case "posts":
      return fetchPosts(mid, cursor);
    case "collections":
      return fetchCollections(mid, cursor);
    case "about":
      return { profile: await fetchCard(mid, signedIn) };
    default:
      throw { code: "unsupported" };
  }
}

export async function followCreator({ creatorID, enabled = false, owner, secret } = {}) {
  const csrf = text(secret?.csrf);
  const fid = positiveID(creatorID);
  if (!csrf || !positiveID(owner)) throw { code: "signIn" };
  if (!fid) throw { code: "permission" };
  await post("/x/relation/modify", { fid, act: enabled ? 1 : 2, re_src: 11, csrf });
  return { following: Boolean(enabled) };
}
