import { currentAccount, optionalData, payload, request, webHeaders } from "./auth.js";
import { cached } from "./cache.js";
import { collection, cover, parts } from "./recommendations.js";
import { fetchCourseSeason, isCourseOwned, parseCourseEpisodes, parseCourseID, toCourseSegments } from "./course.js";
import { resolveInteractiveBranch } from "./interactive.js";
import { resolveLivePlayback } from "./live.js";
import { fetchSeason, parseSeasonEpisodes, parseSeasonID, toEpisodeSegments } from "./series.js";
import { post, view } from "./video.js";
import { signWbiParams } from "./wbi.js";

const api = "https://api.bilibili.com";
const playURLPath = "/x/player/playurl";
const wbiPlayURLPath = "/x/player/wbi/playurl";
const episodePlayURLPath = "/pgc/player/web/playurl";
const coursePlayURLPath = "/pugv/player/web/playurl";
const danmakuSegmentSeconds = 360;
const regionDenied = { restriction: "region" };
const membershipDenied = { restriction: "membership" };
const purchaseDenied = { restriction: "purchase" };
const unknownDenied = { restriction: "unknown" };

async function get(path, params) {
  const response = await request(api + path + "?" + new URLSearchParams(params));
  const episode = path === episodePlayURLPath;
  if (path !== playURLPath && path !== wbiPlayURLPath && !episode) return payload(response);
  const body = await response.json();
  const message = typeof body?.message === "string" ? body.message : "";
  if (body?.code && /(?:\u5730\u533a|\u533a\u57df).{0,16}(?:\u65e0\u6cd5\u89c2\u770b|\u4e0d\u53ef\u89c2\u770b|\u65e0\u64ad\u653e\u7248\u6743|\u6682\u4e0d\u63d0\u4f9b)/u.test(message)) {
    return regionDenied;
  }
  if (episode && body.code === -10403) {
    if (/(?:\u4ed8\u8d39|\u8d2d\u4e70|\u5355\u7247|\u70b9\u64ad|\u89e3\u9501)/u.test(message)) return purchaseDenied;
    if (/(?:\u5927\u4f1a\u5458|\u4f1a\u5458)/u.test(message)) return membershipDenied;
    return unknownDenied;
  }
  if (!episode && body.code === 87008) return purchaseDenied;
  if (episode && body.code === 0) return body.result;
  return payload(response, () => body);
}

async function getPlayURL(episode, params) {
  if (episode) return get(episodePlayURLPath, params);
  const signed = signWbiParams(params);
  if (signed) {
    try {
      return await get(wbiPlayURLPath, signed);
    } catch (error) {
      if (error?.code === "signIn" || error?.code === "rateLimited") throw error;
    }
  }
  return get(playURLPath, params);
}

// Thumbnail sheets point at static, unsigned image assets keyed by archive and
// part, yet were refetched on every quality or episode switch.
const videoshotTTL = 1800;

function videoshot(params) {
  const target = params.bvid ? "b" + params.bvid : "a" + params.aid;
  return cached(`videoshot:${target}:${params.cid}`, videoshotTTL, () => get("/x/player/videoshot", params),
    value => value != null && typeof value === "object");
}

function id(value) {
  const candidate = String(value ?? "");
  return /^[1-9]\d*$/.test(candidate) ? candidate : undefined;
}

function time(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function https(value) {
  if (typeof value !== "string") return "";
  const url = value.replace(/^\/\//, "https://").replace(/^http:/i, "https:");
  return url.startsWith("https://") ? url : "";
}

function resource(...candidates) {
  const urls = [...new Set(candidates.map(https).filter(Boolean))];
  return urls.length ? { urls, headers: webHeaders } : undefined;
}

function byteRange(value) {
  const match = /^(\d+)-(\d+)$/.exec(value ?? "");
  if (!match) return undefined;
  const [first, last] = match.slice(1).map(Number);
  return Number.isSafeInteger(first) && Number.isSafeInteger(last) && first <= last ? { first, last } : undefined;
}

function track(row) {
  const base = row.SegmentBase ?? row.segment_base;
  const init = byteRange(base?.Initialization ?? base?.initialization);
  const index = byteRange(base?.indexRange ?? base?.index_range);
  const media = resource(row.baseUrl ?? row.base_url, ...(row.backupUrl ?? row.backup_url ?? []));
  if (!media || !init || !index || init.last >= index.first || !row.codecs || !row.bandwidth) return undefined;
  const rate = String(row.frameRate ?? row.frame_rate ?? "").split("/");
  return {
    resource: media, init, index, codec: row.codecs, contentType: row.mimeType ?? row.mime_type,
    bandwidth: row.bandwidth, width: row.width || undefined, height: row.height || undefined,
    frameRate: time(Number(rate[0]) / Number(rate[1] ?? 1))
  };
}

function canPlayCodec(codec, hevc) {
  return /^avc[13]\./i.test(codec) || hevc && /^(hvc1|hev1|dvh1|dvhe)\./i.test(codec);
}

// Apple HLS prefers hvc1/dvh1 over hev1/dvhe; prefer hardware hvc1 over avc1,
// and keep avc1 ahead of hev1 so hev1 is only used as a last-resort fallback.
function codecRank(codec) {
  if (/^(dvh1|hvc1)\./i.test(codec)) return 3;
  if (/^avc[13]\./i.test(codec)) return 2;
  if (/^(dvhe|hev1)\./i.test(codec)) return 1;
  return 0;
}

function dashVariants(data, limits) {
  const seenAudio = new Set();
  const seenIDs = new Set();
  const aacTracks = (data?.dash?.audio ?? []).filter(row => /^mp4a\./i.test(row.codecs ?? ""))
    .sort((a, b) => b.bandwidth - a.bandwidth).flatMap((row, index) => {
      const parsed = track(row);
      if (!parsed) return [];
      const kbps = Math.max(1, Math.round(row.bandwidth / 1000));
      const label = `AAC ${kbps}k`;
      const trackID = String(row.id ?? `aac-${index}`);
      if (seenAudio.has(label) || seenIDs.has(trackID)) return [];
      seenAudio.add(label);
      seenIDs.add(trackID);
      return [{ ...parsed, id: trackID, label }];
    });
  const dolbyRows = Array.isArray(data?.dash?.dolby?.audio) ? data.dash.dolby.audio : [];
  const dolbyType = Number(data?.dash?.dolby?.type ?? 0);
  const dolbyTracks = dolbyRows.filter(row => /^(ec-3|ac-3|mp4a\.)/i.test(row?.codecs ?? ""))
    .sort((a, b) => b.bandwidth - a.bandwidth).flatMap((row, index) => {
      const parsed = track(row);
      if (!parsed) return [];
      const baseLabel = dolbyType === 2 ? "\u675c\u6bd4\u5168\u666f\u58f0" : "\u675c\u6bd4\u97f3\u6548";
      const label = seenAudio.has(baseLabel) ? `${baseLabel} ${Math.max(1, Math.round(row.bandwidth / 1000))}k` : baseLabel;
      const trackID = String(row.id ?? `dolby-${index}`);
      if (seenAudio.has(label) || seenIDs.has(trackID)) return [];
      seenAudio.add(label);
      seenIDs.add(trackID);
      return [{ ...parsed, id: trackID, label }];
    });
  const audioTracks = [...aacTracks.slice(0, 1), ...dolbyTracks, ...aacTracks.slice(1)];
  if (audioTracks.length > 0) {
    audioTracks[0] = { ...audioTracks[0], default: true };
  }
  const audio = audioTracks[0];
  return (data?.dash?.video ?? []).flatMap(row => {
    if (row.id >= 127 || !canPlayCodec(row.codecs ?? "", limits.hevc) || row.id >= 125 && !limits.hdr || !row.width || !row.height) return [];
    const video = track(row);
    if (!video) return [];
    const entry = { id: row.id, format: "dash", video, audio };
    if (audioTracks.length > 1) entry.audioTracks = audioTracks;
    return [entry];
  }).sort((a, b) =>
    b.id - a.id ||
    codecRank(b.video.codec) - codecRank(a.video.codec) ||
    Number(b.video.frameRate <= 64) - Number(a.video.frameRate <= 64)
  );
}

function preferredInitialQn(selection, preferredQuality, hdr, hevc) {
  if (selection) return selection;
  switch (preferredQuality) {
    case "720p": return 74;
    case "1080p": return 116;
    case "4k": return hevc ? 120 : 116;
    case "4k-hdr": return hdr ? 126 : hevc ? 120 : 116;
    default: return hdr ? 126 : hevc ? 120 : 116;
  }
}

function selectVariant(variants, selection, preferredQuality) {
  if (!variants.length) return undefined;
  if (selection) return variants.find(variant => variant.id === selection) ?? variants[0];
  switch (preferredQuality) {
    case "720p": return variants.find(variant => variant.id <= 74) ?? variants[variants.length - 1];
    case "1080p": return variants.find(variant => variant.id <= 116) ?? variants[variants.length - 1];
    case "4k": return variants.find(variant => variant.id <= 120) ?? variants[0];
    default: return variants[0];
  }
}

const qualityLabels = {
  127: "8K", 126: "Dolby Vision", 125: "HDR", 120: "4K", 116: "1080P 60",
  112: "1080P+", 80: "1080P", 74: "720P 60", 64: "720P", 32: "480P", 16: "360P"
};

function qualityMenu(data, variants, chosen, selection, limits) {
  const formats = new Map((data?.support_formats ?? []).map(item => [Number(item.quality), item]));
  const available = new Set(variants.map(item => item.id));
  const bandwidthByQuality = new Map();
  for (const item of variants) {
    const bw = (item.video?.bandwidth ?? 0) + (item.audio?.bandwidth ?? 0);
    if (bw > (bandwidthByQuality.get(item.id) ?? 0)) bandwidthByQuality.set(item.id, bw);
  }
  if (chosen) available.add(chosen);
  const reported = [...new Set([...formats.keys(), ...available, ...(selection ? [selection] : [])])];
  return reported.sort((a, b) => b - a).map(value => {
    const details = formats.get(value);
    const label = qualityLabels[value] || details?.display_desc?.trim();
    if (!label) return undefined;
    let limit;
    if (value >= 127 || value >= 125 && !limits.hdr || value >= 120 && !limits.hevc) limit = "device";
    else if (!available.has(value) && !limits.signedIn && value >= 64) limit = "login";
    else if (!available.has(value) && details?.limit_watch_reason) limit = "membership";
    else if (value === selection && chosen !== value) limit = "source";
    const hdr = value >= 125 || undefined;
    const badge = value >= 125 ? "HDR" : value >= 120 ? "4K" : undefined;
    const bandwidth = bandwidthByQuality.get(value) || undefined;
    return { id: String(value), label, limit, hdr, badge, bandwidth };
  }).filter(Boolean);
}

function chapters(player) {
  const seen = new Set();
  return (player?.view_points ?? []).filter(point => {
    if (point?.type !== 2 || !point.content?.trim() || !Number.isFinite(point.from) || point.from < 0 || seen.has(point.from)) return false;
    seen.add(point.from);
    return true;
  }).map(point => ({ title: point.content.trim(), start: point.from, imageURL: cover(point.imgUrl) || https(point.imgUrl) || undefined }))
    .sort((a, b) => a.start - b.start);
}

function subtitles(player) {
  return (player?.subtitle?.subtitles ?? []).flatMap(row => {
    const label = row.lan_doc?.trim();
    const language = typeof row.lan === "string" ? row.lan.trim() : "";
    const media = resource(row.subtitle_url);
    const key = String(row.id_str ?? row.id ?? language ?? "");
    return media && label && key ? [{ id: key, label, language: language || undefined, resource: media, contentType: "application/json" }] : [];
  });
}

function thumbnails(sheet) {
  if (!sheet) return undefined;
  let images = (sheet.image ?? []).map(https);
  const times = (sheet.index ?? []).map(value => time(value));
  let { img_x_len: columns, img_y_len: rows, img_x_size: width, img_y_size: height } = sheet;
  if (!images.length || !times.length || ![columns, rows, width, height].every(value => Number.isSafeInteger(value) && value > 0)) {
    return undefined;
  }
  const maxSide = 1024;
  if (Math.max(columns * width, rows * height) > maxSide) {
    // Keep the catalogue image limit and preserve whole, proportional cells.
    let divisor = width;
    for (let remainder = height; remainder !== 0;) {
      [divisor, remainder] = [remainder, divisor % remainder];
    }
    width /= divisor;
    height /= divisor;
    const scale = Math.floor(maxSide / Math.max(columns * width, rows * height));
    if (scale < 1) return undefined;
    width *= scale;
    height *= scale;
    const suffix = `@${columns * width}w_${rows * height}h_1c.jpg`;
    images = images.map(value => {
      const source = /^(https:\/\/(?:bimp|i[012])\.hdslb\.com\/[^?@#\s]+)/.exec(value)?.[1];
      return source ? source + suffix : "";
    });
  }
  if (!images.some(Boolean)) return undefined;
  return { images, times, columns, rows, width, height };
}

function expiry(streams) {
  const deadlines = streams.flatMap(stream => [stream.video, stream.audio, ...(stream.audioTracks ?? [])].filter(Boolean)).map(track => {
    const query = track.resource.urls[0].split("?")[1] ?? "";
    return Number(new URLSearchParams(query).get("deadline"));
  }).filter(value => Number.isSafeInteger(value) && value > 0);
  return deadlines.length ? Math.min(...deadlines) : undefined;
}

function directStream(data) {
  const file = data?.durl?.length === 1 ? data.durl[0] : undefined;
  const media = file && resource(file.url, ...(file.backup_url ?? []));
  if (!media || !data.format?.startsWith("mp4") && !/\.mp4(?:[?#]|$)/i.test(media.urls[0])) return undefined;
  const quality = Number(data.quality);
  return {
    quality: qualityLabels[quality] ? quality : 16,
    stream: { format: "direct", video: { resource: media, contentType: "video/mp4" } },
    duration: time(file.length) / 1000
  };
}

async function resolveSeriesPlayback({ ref, partID, quality, preferredQuality = "", hdr = false, hevc = false, signedIn = false }) {
  const seasonID = parseSeasonID(ref?.id);
  if (!seasonID) throw { code: "unsupported" };
  const selection = Number(quality ?? 0);
  if (selection && !qualityLabels[selection]) throw { code: "unsupported" };

  const season = await fetchSeason(seasonID);
  const parsed = parseSeasonEpisodes(season);
  const episodes = toEpisodeSegments(parsed);
  const chosenEp = partID
    ? parsed.find(ep => !ep.unavailable && (ep.partID === partID || ep.epID === partID))
    : parsed.find(ep => !ep.unavailable);
  if (!chosenEp) {
    if (partID) throw { code: "permission" };
    return { partID: "", episodes, access: "restricted", restriction: "source" };
  }
  const epID = chosenEp.epID;
  const aid = chosenEp.aid;
  const cid = chosenEp.cid;
  const resolvedPartID = partID || chosenEp.partID || cid || epID;
  if (!resolvedPartID) throw { code: "permission" };

  const paid = chosenEp.epStatus === 6 || chosenEp.epStatus === 7 || chosenEp.epStatus === 8 || chosenEp.epStatus === 9;
  const vip = chosenEp.epStatus === 13;
  const unavailable = { itemID: aid, partID: resolvedPartID, episodes, access: "restricted" };
  const mapDenied = denied => {
    if (denied === unknownDenied) {
      return { ...unavailable, ...(paid ? purchaseDenied : vip ? membershipDenied : regionDenied) };
    }
    return { ...unavailable, ...denied };
  };

  if (season?.rights?.can_watch === 0 && season?.rights?.area_limit) {
    return { ...unavailable, ...regionDenied };
  }

  const target = epID ? (cid ? { ep_id: epID, cid } : { ep_id: epID }) : { cid };
  const params = { ...target, qn: preferredInitialQn(selection, preferredQuality, hdr, hevc), fnver: 0, fourk: 1 };
  const data = await getPlayURL(true, { ...params, fnval: 4048 });
  if (data === regionDenied || data === membershipDenied || data === purchaseDenied || data === unknownDenied) {
    return mapDenied(data);
  }

  const limits = { hdr, hevc, signedIn };
  const variants = dashVariants(data, limits);
  const selected = selectVariant(variants, selection, preferredQuality);
  let streams;
  let chosen;
  let duration = time(data?.timelength) / 1000 || time(chosenEp.durationSeconds);
  let preview = data?.is_preview === 1 || data?.is_preview === true || data?.preview === 1;
  if (selected) {
    chosen = selected.id;
    streams = variants.filter(variant => variant.id === chosen).map(({ id, ...stream }) => stream);
  } else {
    let fallback = directStream(data);
    if (!fallback) {
      const progressive = await getPlayURL(true, { ...params, fnval: 1, qn: 16 }).catch(error => optionalData(error));
      if (progressive === regionDenied || progressive === membershipDenied || progressive === purchaseDenied || progressive === unknownDenied) {
        return mapDenied(progressive);
      }
      if (progressive) {
        fallback = directStream(progressive);
        if (fallback) {
          duration = time(progressive.timelength) / 1000 || duration;
          preview = preview || progressive.is_preview === 1 || progressive.is_preview === true;
        }
      }
    }
    if (fallback) {
      chosen = fallback.quality;
      streams = [fallback.stream];
      if ((vip || paid) && fallback.duration > 0 && duration > 0 && fallback.duration < duration - 1) preview = true;
      duration = fallback.duration || duration;
    }
  }
  const qualities = qualityMenu(data, variants, chosen, selection, limits);
  const common = { itemID: aid, partID: resolvedPartID, qualities, episodes };
  const previewRestriction = preview ? (paid ? "purchase" : "membership") : undefined;
  if (!streams?.length) {
    return { ...common, access: "restricted", restriction: paid ? "purchase" : vip ? "membership" : "source" };
  }
  const restriction = chosen !== selection && selection ? qualities.find(entry => entry.id === String(selection))?.limit || "source" : undefined;
  if (signedIn && selection >= 64 && (restriction === "source" || restriction === "membership")) {
    await currentAccount().catch(error => {
      if (error?.code === "signIn") throw error;
    });
  }
  const v2Params = aid && cid ? (signWbiParams({ aid, cid }) ?? { aid, cid }) : undefined;
  const shotParams = cid ? (chosenEp.bvid ? { bvid: chosenEp.bvid, cid, index: 1 } : aid ? { aid, cid, index: 1 } : undefined) : undefined;
  const [player, sheet] = await Promise.all([
    v2Params ? get("/x/player/wbi/v2", v2Params).catch(() => undefined) : Promise.resolve(undefined),
    shotParams ? videoshot(shotParams).catch(() => undefined) : Promise.resolve(undefined)
  ]);
  return {
    ...common, quality: String(chosen), streams, restriction,
    duration, expiresAt: expiry(streams), danmakuSegmentSeconds, access: preview ? "preview" : "granted",
    previewRestriction,
    chapters: chapters(player).filter(chapter => duration <= 0 || chapter.start < duration),
    subtitles: subtitles(player), thumbnails: thumbnails(sheet),
    resumeSeconds: signedIn && cid && id(player?.last_play_cid) === cid ? time(player.last_play_time) / 1000 : undefined
  };
}

async function getCoursePlayURL(seasonID, params) {
  const referer = `https://www.bilibili.com/cheese/play/ss${seasonID}`;
  let response;
  try {
    response = await fetch(api + coursePlayURLPath + "?" + new URLSearchParams(params), {
      headers: { ...webHeaders, Referer: referer },
      redirect: "error"
    });
  } catch {
    throw { code: "network" };
  }
  if (response.status === 412 || response.status === 429) throw { code: "rateLimited" };
  if (!response.ok) throw { code: "network" };
  const body = await response.json();
  if (body?.code === 0) return body.data ?? body.result;
  if (body?.code === -403 || body?.code === -10403 || body?.code === -10404) return purchaseDenied;
  if (body?.code === -101) return { restriction: "login" };
  return payload(response, () => body);
}

async function resolveCoursePlayback({ ref, partID, quality, preferredQuality = "", hdr = false, hevc = false, signedIn = false }) {
  const seasonID = parseCourseID(ref?.id);
  if (!seasonID) throw { code: "unsupported" };
  const selection = Number(quality ?? 0);
  if (selection && !qualityLabels[selection]) throw { code: "unsupported" };

  const season = await fetchCourseSeason(seasonID);
  const owned = isCourseOwned(season);
  const parsed = parseCourseEpisodes(season);
  const episodes = toCourseSegments(parsed);
  const chosenEp = partID
    ? parsed.find(ep => !ep.unavailable && (ep.partID === partID || ep.epID === partID || ep.cid === partID))
    : (parsed.find(ep => !ep.unavailable && !ep.locked) ?? parsed.find(ep => !ep.unavailable));
  if (!chosenEp) {
    if (partID) throw { code: "permission" };
    return { partID: "", episodes, access: "restricted", restriction: "source" };
  }
  const epID = chosenEp.epID;
  const aid = chosenEp.aid;
  const cid = chosenEp.cid;
  const resolvedPartID = partID || chosenEp.partID || cid || epID;
  if (!resolvedPartID) throw { code: "permission" };

  const unavailable = { itemID: aid, partID: resolvedPartID, episodes, access: "restricted" };
  if (chosenEp.locked && !owned) {
    return { ...unavailable, ...purchaseDenied };
  }

  const target = { ...(aid ? { avid: aid } : {}), ...(epID ? { ep_id: epID } : {}), ...(cid ? { cid } : {}) };
  const params = { ...target, qn: preferredInitialQn(selection, preferredQuality, hdr, hevc), fnver: 0, fourk: 1 };
  const data = await getCoursePlayURL(seasonID, { ...params, fnval: 4048 });
  if (data === purchaseDenied || data?.restriction === "login") {
    return { ...unavailable, ...purchaseDenied };
  }

  const limits = { hdr, hevc, signedIn };
  const variants = dashVariants(data, limits);
  const selected = selectVariant(variants, selection, preferredQuality);
  let streams;
  let chosen;
  let duration = time(data?.timelength) / 1000 || time(chosenEp.durationSeconds);
  let preview = !owned && (data?.is_preview === 1 || data?.is_preview === true || data?.preview === 1 || chosenEp.payStatus === 3);
  if (selected) {
    chosen = selected.id;
    streams = variants.filter(variant => variant.id === chosen).map(({ id, ...stream }) => stream);
  } else {
    let fallback = directStream(data);
    if (!fallback) {
      const progressive = await getCoursePlayURL(seasonID, { ...params, fnval: 1, qn: 16 }).catch(error => optionalData(error));
      if (progressive === purchaseDenied || progressive?.restriction === "login") {
        return { ...unavailable, ...purchaseDenied };
      }
      if (progressive) {
        fallback = directStream(progressive);
        if (fallback) {
          duration = time(progressive.timelength) / 1000 || duration;
          preview = preview || (!owned && (progressive.is_preview === 1 || progressive.is_preview === true));
        }
      }
    }
    if (fallback) {
      chosen = fallback.quality;
      streams = [fallback.stream];
      if (!owned && fallback.duration > 0 && duration > 0 && fallback.duration < duration - 1) preview = true;
      duration = fallback.duration || duration;
    }
  }

  const qualities = qualityMenu(data, variants, chosen, selection, limits);
  const common = { itemID: aid, partID: resolvedPartID, qualities, episodes };
  const previewRestriction = preview ? "purchase" : undefined;
  if (!streams?.length) {
    return { ...common, access: "restricted", restriction: owned ? "source" : "purchase" };
  }
  const restriction = chosen !== selection && selection ? qualities.find(entry => entry.id === String(selection))?.limit || "source" : undefined;
  const v2Params = aid && cid ? (signWbiParams({ aid, cid }) ?? { aid, cid }) : undefined;
  const shotParams = aid && cid ? { aid, cid, index: 1 } : undefined;
  const [player, sheet] = await Promise.all([
    v2Params ? get("/x/player/wbi/v2", v2Params).catch(() => undefined) : Promise.resolve(undefined),
    shotParams ? videoshot(shotParams).catch(() => undefined) : Promise.resolve(undefined)
  ]);
  return {
    ...common, quality: String(chosen), streams, restriction,
    duration, expiresAt: expiry(streams), danmakuSegmentSeconds, access: preview ? "preview" : "granted",
    previewRestriction,
    chapters: chapters(player).filter(chapter => duration <= 0 || chapter.start < duration),
    subtitles: subtitles(player), thumbnails: thumbnails(sheet),
    resumeSeconds: signedIn && cid && id(player?.last_play_cid) === cid ? time(player.last_play_time) / 1000 : undefined
  };
}

export async function resolvePlayback({ ref, partID, quality, preferredQuality = "", line, branchID, branchState, hdr = false, hevc = false, signedIn = false }) {
  if (ref?.kind === "live") {
    return resolveLivePlayback({ ref, partID, quality, preferredQuality, line, hevc, signedIn });
  }
  if (ref?.kind === "series") {
    return resolveSeriesPlayback({ ref, partID, quality, preferredQuality, hdr, hevc, signedIn });
  }
  if (ref?.kind === "course") {
    return resolveCoursePlayback({ ref, partID, quality, preferredQuality, hdr, hevc, signedIn });
  }
  const row = await view(ref, { allowMissing: true });
  const selection = Number(quality ?? 0);
  if (selection && !qualityLabels[selection]) throw { code: "unsupported" };

  const interactive = row?.rights?.is_stein_gate === 1;
  const pages = row === null ? await get("/x/player/pagelist", { bvid: ref.id }) : row.pages;
  const part = partID ? pages?.find(page => id(page.cid) === partID) : pages?.[0];
  const cid = id(part?.cid ?? (interactive && partID ? id(partID) : (!partID ? row?.cid : undefined)));
  if (row === null) {
    // A regional episode can be absent from the archive while its page still resolves by BV ID.
    if (cid) {
      const data = await get(episodePlayURLPath, { bvid: ref.id, cid, qn: 16, fnver: 0, fnval: 4048, fourk: 1 });
      if (data === regionDenied || data === unknownDenied) return { partID: cid, access: "restricted", ...regionDenied };
    }
    throw { code: "plugin" };
  }
  const aid = id(row.aid);
  if (!aid || !cid) throw { code: "permission" };
  const videoParts = parts(row).filter(page => page.partID);
  const episodes = interactive ? undefined : (videoParts.length > 1 ? videoParts : collection(row));

  const episode = /^https:\/\/www\.bilibili\.com\/bangumi\/play\/ep([1-9]\d*)(?:[?#].*)?$/.exec(row.redirect_url ?? "")?.[1];
  const target = episode ? { ep_id: episode } : { bvid: ref.id, cid };
  const params = { ...target, qn: preferredInitialQn(selection, preferredQuality, hdr, hevc), fnver: 0, fourk: 1 };
  const exclusive = row.is_upower_exclusive || row.is_upower_play;
  const data = await getPlayURL(Boolean(episode), { ...params, fnval: 4048 });
  const unavailable = { itemID: aid, partID: cid, episodes, access: "restricted" };
  if (data === regionDenied || data === membershipDenied || data === purchaseDenied || data === unknownDenied) {
    return { ...unavailable, ...(data === unknownDenied ? regionDenied : data) };
  }
  const limits = { hdr, hevc, signedIn };
  const variants = dashVariants(data, limits);
  const selected = selectVariant(variants, selection, preferredQuality);
  let streams;
  let chosen;
  let duration = time(data?.timelength) / 1000 || time(part?.duration) || time(row.duration);
  let preview = data?.is_preview === 1 || data?.is_preview === true;
  if (selected) {
    chosen = selected.id;
    streams = variants.filter(variant => variant.id === chosen).map(({ id, ...stream }) => stream);
  } else {
    let fallback = directStream(data);
    if (!fallback && !row.is_upower_exclusive) {
      const progressive = await getPlayURL(Boolean(episode), { ...params, fnval: 1, qn: 16 }).catch(error => optionalData(error));
      if (progressive === regionDenied || progressive === membershipDenied || progressive === purchaseDenied) return { ...unavailable, ...progressive };
      if (progressive) {
        fallback = directStream(progressive);
        if (fallback) {
          duration = time(progressive.timelength) / 1000 || duration;
          preview = preview || progressive.is_preview === 1 || progressive.is_preview === true;
        }
      }
    }
    if (fallback) {
      chosen = fallback.quality;
      streams = [fallback.stream];
      // Exclusive uploads can return a short MP4 and the full duration without a preview flag.
      if (exclusive && fallback.duration > 0 && fallback.duration < duration - 1) preview = true;
      duration = fallback.duration || duration;
    }
  }
  const qualities = qualityMenu(data, variants, chosen, selection, limits);
  const common = { itemID: aid, partID: cid, qualities, episodes };
  const previewRestriction = preview ? (exclusive ? "purchase" : episode ? "membership" : undefined) : undefined;
  if (!streams?.length) {
    return { ...common, access: "restricted", restriction: exclusive ? "purchase" : previewRestriction || "source" };
  }
  const restriction = chosen !== selection && selection ? qualities.find(entry => entry.id === String(selection))?.limit || "source" : undefined;
  if (signedIn && selection >= 64 && (restriction === "source" || restriction === "membership")) {
    // A stale session can receive a successful playurl response with guest streams.
    await currentAccount().catch(error => {
      if (error?.code === "signIn") throw error;
    });
  }
  const v2Params = signWbiParams({ aid, cid }) ?? { aid, cid };
  const [player, sheet] = await Promise.all([
    get("/x/player/wbi/v2", v2Params).catch(() => undefined),
    videoshot({ bvid: ref.id, cid, index: 1 }).catch(() => undefined)
  ]);
  const branch = (interactive || player?.interaction?.graph_version)
    ? await resolveInteractiveBranch({ aid, player, duration, branchID, branchState })
    : undefined;
  return {
    ...common, quality: String(chosen), streams, restriction,
    duration, expiresAt: expiry(streams), danmakuSegmentSeconds, access: preview ? "preview" : "granted",
    previewRestriction,
    chapters: chapters(player).filter(chapter => duration <= 0 || chapter.start < duration),
    subtitles: subtitles(player), thumbnails: thumbnails(sheet),
    branch,
    resumeSeconds: !interactive && !branch && signedIn && id(player?.last_play_cid) === cid ? time(player.last_play_time) / 1000 : undefined
  };
}

export async function readSubtitles({ track }) {
  const url = track?.resource?.urls?.[0];
  if (!url?.startsWith("https://")) throw { code: "permission" };
  const transcript = await (await request(url)).json();
  const cues = (transcript?.body ?? []).flatMap(row => {
    const text = row.content?.trim();
    return text && time(row.to) > time(row.from) ? [{ start: time(row.from), end: time(row.to), text }] : [];
  }).sort((a, b) => a.start - b.start);
  return { cues };
}

export async function reportPlayback({ data, secret }) {
  if (!id(data?.itemID) || !id(data?.partID) || !secret?.csrf) throw { code: "permission" };
  await post("/x/v2/history/report", {
    aid: data.itemID, cid: data.partID, progress: data.finished ? -1 : data.seconds, platform: "web", csrf: secret.csrf
  });
  return {};
}

const danmakuModes = {1: "scroll", 2: "scroll", 3: "scroll", 4: "bottom", 5: "top"};

function parseFields(buffer, visit) {
  let cursor = 0;
  function varint() {
    let value = 0;
    for (let byte = 0; byte < 10 && cursor < buffer.length; byte++) {
      const current = buffer[cursor++];
      value += (current & 127) * 2 ** (7 * byte);
      if (current < 128) return value;
    }
    throw { code: "plugin" };
  }
  while (cursor < buffer.length) {
    const tag = varint();
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (wire === 0) visit(field, varint());
    else if (wire === 2) {
      const size = varint();
      if (size > buffer.length - cursor) throw { code: "plugin" };
      visit(field, buffer.subarray(cursor, cursor + size));
      cursor += size;
    } else if (wire === 5 || wire === 1) cursor += wire === 5 ? 4 : 8;
    else throw { code: "plugin" };
    if (cursor > buffer.length || !field) throw { code: "plugin" };
  }
}

export async function readDanmaku({ partID, itemID, segment }) {
  if (!id(partID) || !id(itemID) || !Number.isSafeInteger(segment) || segment < 1) throw { code: "permission" };
  const query = new URLSearchParams({ type: 1, oid: partID, pid: itemID, segment_index: segment });
  const response = await request(api + "/x/v2/dm/web/seg.so?" + query);
  const decoder = new TextDecoder();
  const items = [];
  parseFields(new Uint8Array(await response.arrayBuffer()), (field, value) => {
    if (field !== 1 || !(value instanceof Uint8Array)) return;
    let seconds = 0, mode, text, senderHash;
    parseFields(value, (key, entry) => {
      if (key === 2 && typeof entry === "number") seconds = entry / 1000;
      if (key === 3 && typeof entry === "number") mode = danmakuModes[entry];
      if (key === 6 && entry instanceof Uint8Array) senderHash = decoder.decode(entry).trim();
      if (key === 7 && entry instanceof Uint8Array) text = decoder.decode(entry).trim();
    });
    if (mode && text) {
      const item = { seconds, mode, text };
      if (senderHash) item.senderHash = senderHash;
      items.push(item);
    }
  });
  return { items };
}

function crc32Hex(input) {
  let crc = 0xffffffff;
  const bytes = new TextEncoder().encode(String(input ?? ""));
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 1) ? ((crc >>> 1) ^ 0xedb88320) : (crc >>> 1);
    }
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16);
}

function mapCloudRule(row) {
  if (!row || typeof row !== "object") return null;
  const remoteID = row.id != null ? String(row.id) : "";
  const pattern = typeof row.filter === "string" ? row.filter.trim() : "";
  if (!remoteID || !pattern) return null;
  if (row.type === 0) return { remoteID, kind: "keyword", pattern, enabled: true, synced: true };
  if (row.type === 2) return { remoteID, kind: "user", pattern, enabled: true, synced: true };
  return null;
}

export async function readDanmakuRules() {
  const data = await payload(await request(api + "/x/dm/filter/user"));
  const rules = [];
  for (const row of data?.rule ?? []) {
    const mapped = mapCloudRule(row);
    if (mapped) rules.push(mapped);
  }
  return { rules };
}

export async function addDanmakuRule({ data, secret }) {
  if (!secret?.csrf) throw { code: "signIn" };
  const kind = data?.kind;
  const pattern = typeof data?.pattern === "string" ? data.pattern.trim() : "";
  if (!pattern || [...pattern].length > 40) throw { code: "permission" };
  let type, filter;
  if (kind === "keyword") {
    type = 0;
    filter = pattern;
  } else if (kind === "user" && /^\d+$/.test(pattern)) {
    type = 2;
    filter = crc32Hex(pattern);
  } else {
    throw { code: "permission" };
  }
  const response = await request(api + "/x/dm/filter/user/add", {
    type: String(type), filter, csrf: secret.csrf
  });
  const body = await response.json();
  if (body?.code === 36201) {
    const existing = await readDanmakuRules();
    const normFilter = filter.toLowerCase().replace(/^0+/, "") || "0";
    const match = existing.rules.find(r => r.kind === kind && (
      kind === "keyword" ? r.pattern === pattern : ((r.pattern.toLowerCase().replace(/^0+/, "") || "0") === normFilter)
    ));
    if (match) return { rule: { ...match, pattern } };
    return { rule: { kind, pattern, enabled: true, synced: true } };
  }
  const result = await payload(response, () => body);
  const remoteID = result?.id != null ? String(result.id) : "";
  return { rule: { remoteID, kind, pattern, enabled: true, synced: true } };
}

export async function removeDanmakuRule({ data, secret }) {
  if (!secret?.csrf) throw { code: "signIn" };
  const remoteID = typeof data?.remoteID === "string" ? data.remoteID.trim() : "";
  if (!remoteID) throw { code: "permission" };
  await post("/x/dm/filter/user/del", { ids: remoteID, csrf: secret.csrf });
  return {};
}

export async function postDanmaku({ data, secret }) {
  if (!id(data?.partID) || !secret?.csrf) throw { code: "permission" };
  const mode = { scroll: 1, bottom: 4, top: 5 }[data.mode];
  if (!mode || !data.text?.trim() || [...data.text].length > 100) throw { code: "permission" };
  const fields = {
    type: 1, oid: data.partID, msg: data.text.trim(), progress: Math.floor(data.start * 1000),
    color: 16777215, fontsize: 25, mode, pool: 0, rnd: Date.now(), csrf: secret.csrf
  };
  if (/^BV[a-zA-Z0-9]+$/.test(data.ref?.id ?? "")) {
    fields.bvid = data.ref.id;
  } else if (id(data?.itemID)) {
    fields.aid = data.itemID;
  }
  await post("/x/v2/dm/post", fields);
  return {};
}
