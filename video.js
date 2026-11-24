import { optionalData, payload, request } from "./auth.js";
import { fetchCourseSeason, parseCourseEpisodes, parseCourseID } from "./course.js";
import { fetchSeason, parseSeasonEpisodes, parseSeasonID, parseSectionEpisodes } from "./series.js";

const api = "https://api.bilibili.com";

function endpoint(path, params) {
  return api + path + "?" + new URLSearchParams(params);
}

async function get(path, params = {}) {
  return payload(await request(endpoint(path, params)));
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function number(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function positiveID(value) {
  const id = String(value ?? "");
  return /^[1-9]\d*$/.test(id) ? id : undefined;
}

export async function view(ref, { allowMissing = false } = {}) {
  if (ref?.kind === "series") {
    const seasonID = parseSeasonID(ref.id);
    if (!seasonID) throw { code: "permission" };
    const data = await fetchSeason(seasonID);
    const episodes = parseSeasonEpisodes(data);
    const first = episodes.find(ep => !ep.unavailable && ep.aid) ?? episodes.find(ep => ep.aid) ?? parseSectionEpisodes(data).find(ep => ep.aid);
    if (!first?.aid) {
      if (allowMissing) return null;
      throw { code: "expired" };
    }
    return {
      aid: first.aid,
      bvid: first.bvid,
      cid: first.cid,
      owner: data?.up_info?.mid ? { mid: data.up_info.mid } : undefined
    };
  }
  if (ref?.kind === "course") {
    const seasonID = parseCourseID(ref.id);
    if (!seasonID) throw { code: "permission" };
    const data = await fetchCourseSeason(seasonID);
    const episodes = parseCourseEpisodes(data);
    const first = episodes.find(ep => !ep.unavailable && ep.aid) ?? episodes.find(ep => ep.aid);
    if (!first?.aid) {
      if (allowMissing) return null;
      throw { code: "expired" };
    }
    return {
      aid: first.aid,
      cid: first.cid,
      owner: data?.up_info?.mid ? { mid: data.up_info.mid } : undefined
    };
  }
  if (ref?.kind !== "video" || !/^BV[a-zA-Z0-9]+$/.test(ref.id)) throw { code: "permission" };
  const response = await request(endpoint("/x/web-interface/view", { bvid: ref.id }));
  const body = await response.json();
  if (allowMissing && body?.code === -404) return null;
  return payload(response, () => body);
}

function videoComment(reply, creator, pinned = false, preview = false) {
  const id = positiveID(reply?.rpid_str ?? reply?.rpid);
  let body = text(reply?.content?.message);
  if (!id || !body) return undefined;
  let replyToAuthor;
  const replyPrefix = /^\u56de\u590d\s*@([^:\uff1a\r\n]+?)\s*[:\uff1a]\s*(.*)$/s.exec(body);
  if (replyPrefix && replyPrefix[2].trim()) {
    replyToAuthor = replyPrefix[1].trim();
    body = replyPrefix[2].trim();
  }
  const avatar = text(reply.member?.avatar).replace(/^(?:http:)?\/\//, "https://");
  return {
    id, body, author: text(reply.member?.uname),
    replyToAuthor: replyToAuthor || undefined,
    avatarURL: avatar || undefined,
    publishedAt: number(reply.ctime),
    location: text(reply.reply_control?.location) || undefined,
    likes: number(reply.like),
    replyCount: number(reply.rcount),
    liked: reply.action === 1,
    disliked: reply.action === 2,
    pinned,
    isCreator: !!creator && positiveID(reply.mid_str ?? reply.mid) === creator,
    replies: preview && Array.isArray(reply.replies) ? reply.replies.map(item => videoComment(item, creator)).filter(Boolean) : undefined
  };
}

function commentList(data, creator, pinned) {
  const rows = Array.isArray(data?.replies) ? data.replies : [];
  const top = pinned ? [data?.top?.upper, data?.top?.admin].filter(Boolean) : [];
  const seen = new Set();
  return [...top, ...rows].map(reply => videoComment(reply, creator, pinned && reply === data?.top?.upper, true)).filter(comment => {
    if (!comment || seen.has(comment.id)) return false;
    seen.add(comment.id);
    return true;
  });
}

export async function videoDiscussion(row, fallback) {
  if (!positiveID(row.aid) || row.stat?.reply === 0) return [];
  const data = await get("/x/v2/reply/main", { oid: row.aid, type: 1, mode: 3 }).catch(error => optionalData(error, fallback));
  return commentList(data, positiveID(row.owner?.mid), true);
}

export async function videoComments({ ref, order, threadID, page = 0 }) {
  const row = await view(ref, { allowMissing: ref?.kind === "series" || ref?.kind === "course" });
  if (!row) return { comments: [] };
  const oid = positiveID(row?.aid);
  const creator = positiveID(row?.owner?.mid);
  if (!oid) throw { code: "expired" };
  if (threadID) {
    const root = positiveID(threadID);
    page ||= 1;
    if (!root || !Number.isSafeInteger(page) || page < 1) throw { code: "permission" };
    const data = await get("/x/v2/reply/reply", { oid, type: 1, root, pn: page, ps: 20 });
    const rows = Array.isArray(data?.replies) ? data.replies : [];
    const total = number(data?.page?.count);
    const size = number(data?.page?.size) || 20;
    return { comments: rows.map(reply => videoComment(reply, creator)).filter(Boolean),
      nextPage: rows.length && total > page * size ? page + 1 : undefined };
  }
  if (order !== "hot" && order !== "latest") throw { code: "permission" };
  const data = await get("/x/v2/reply/main", { oid, type: 1, mode: order === "hot" ? 3 : 2, next: page });
  const cursor = number(data?.cursor?.next);
  return {
    comments: commentList(data, creator, order === "hot" && page === 0),
    nextPage: !data?.cursor?.is_end && cursor > 0 && cursor !== page ? cursor : undefined
  };
}

function videoActions(coins = 0) {
  return [
    {
      id: "triple",
      slot: "hero",
      label: "\u4e00\u952e\u4e09\u8fde",
      icon: "like",
      confirm: {
        title: "\u4e3a\u559c\u6b22\u7684\u4f5c\u54c1\u9001\u4e0a\u4e09\u8fde\uff1f",
        body: "\u786e\u8ba4\u540e\u5c06\u540c\u65f6\u4e3a\u6b64\u4f5c\u54c1\u70b9\u8d5e\u3001\u6295\u51fa 1 \u679a\u786c\u5e01\u5e76\u6536\u85cf\uff0c\u6295\u5e01\u540e\u65e0\u6cd5\u64a4\u56de\u3002",
        accept: "\u4e00\u952e\u4e09\u8fde",
        cancel: "\u518d\u60f3\u60f3",
        icon: "detail-primary/like"
      },
      doneMessage: "\u70ed\u7231\uff0c\u5df2\u9001\u8fbe",
      celebrate: true,
      celebrateIcons: ["like", "coin", "detail/star"]
    },
    {
      id: "coin",
      slot: "overview",
      label: "\u6295\u5e01",
      icon: "coin",
      activeIcon: "coin-filled",
      active: coins > 0,
      confirm: {
        title: "\u4e3a\u559c\u6b22\u7684\u4f5c\u54c1\u6295\u5e01\uff1f",
        body: "\u786e\u8ba4\u540e\u5c06\u5411\u6b64\u4f5c\u54c1\u6295\u51fa 1 \u679a\u786c\u5e01\uff0c\u6295\u51fa\u540e\u65e0\u6cd5\u64a4\u56de\u3002",
        accept: "\u786e\u8ba4\u6295\u5e01",
        cancel: "\u518d\u60f3\u60f3",
        icon: "detail-primary/coin"
      },
      doneMessage: "\u5df2\u6295\u51fa 1 \u679a\u786c\u5e01"
    }
  ];
}

export async function videoEngagement(row, signedIn) {
  if (!signedIn) return { engagement: {}, actions: videoActions(0) };
  const [relation, watchLater] = await Promise.all([
    get("/x/web-interface/archive/relation", { bvid: row.bvid }).catch(error => optionalData(error)),
    get("/x/v2/history/toview/web").catch(error => optionalData(error))
  ]);
  return {
    engagement: {
      liked: relation?.like === true,
      favorite: relation?.favorite === true,
      watchLater: (watchLater?.list ?? []).some(item => item?.bvid === row.bvid || item?.aid === row.aid)
    },
    actions: videoActions(number(relation?.coin) ?? 0)
  };
}

export async function post(path, fields) {
  const response = await request(api + path, fields);
  const body = await response.json();
  if (body.code === -104) throw { code: "permission", message: "\u786c\u5e01\u4f59\u989d\u4e0d\u8db3" };
  return payload(response, () => body);
}

async function setFavorite(aid, owner, enabled, csrf) {
  const folders = await get("/x/v3/fav/folder/created/list-all", { up_mid: owner, type: 2, rid: aid });
  const list = folders?.list ?? [];
  const folder = list.find(item => (item.attr & 1) !== 0) ?? list[0];
  const id = positiveID(folder?.id);
  if (!id) throw { code: "unsupported" };
  const wasFavorite = Boolean(folder.fav_state);
  if (enabled !== wasFavorite) {
    await post("/x/v3/fav/resource/deal", {
      rid: aid, type: 2, add_media_ids: enabled ? id : "", del_media_ids: enabled ? "" : id, csrf
    });
  }
  return {
    favorite: enabled || list.some(item => item.id !== folder.id && Boolean(item.fav_state)),
    favoriteCollection: enabled || wasFavorite ? text(folder.title) || undefined : undefined
  };
}

export async function videoFavoriteFolders({ ref, owner }) {
  const row = await view(ref);
  const aid = positiveID(row.aid);
  if (!aid || !positiveID(owner)) throw { code: "permission" };
  const result = await get("/x/v3/fav/folder/created/list-all", { up_mid: owner, type: 2, rid: aid });
  const folders = (result?.list ?? []).flatMap(folder => {
    const id = positiveID(folder.id);
    const title = text(folder.title);
    if (!id || !title) return [];
    return [{ id, title, count: number(folder.media_count) ?? 0, private: Boolean(folder.attr & 1), selected: Boolean(folder.fav_state) }];
  });
  return { folders };
}

export async function editVideoFavoriteFolders({ data, secret }) {
  const { ref, add = [], remove = [] } = data;
  const csrf = text(secret?.csrf);
  if (!csrf || !add.every(positiveID) || !remove.every(positiveID)) throw { code: "permission" };
  const row = await view(ref);
  const aid = positiveID(row.aid);
  if (!aid) throw { code: "permission" };
  await post("/x/v3/fav/resource/deal", {
    rid: aid, type: 2, add_media_ids: add.join(","), del_media_ids: remove.join(","), csrf
  });
  return {};
}

export async function editVideo({ ref, interaction, actionID, enabled = false, replyID, threadID, body, owner, secret }) {
  const csrf = text(secret?.csrf);
  if (!csrf || !positiveID(owner)) throw { code: "signIn" };
  const row = await view(ref);
  const aid = positiveID(row?.aid);
  if (!aid) throw { code: "expired" };
  switch (interaction) {
    case "watchLater":
      await post(enabled ? "/x/v2/history/toview/add" : "/x/v2/history/toview/del", { aid, csrf });
      return { watchLater: enabled };
    case "follow": {
      const fid = positiveID(row.owner?.mid);
      if (!fid) throw { code: "permission" };
      await post("/x/relation/modify", { fid, act: enabled ? 1 : 2, re_src: 11, csrf });
      return { following: enabled };
    }
    case "like":
      await post("/x/web-interface/archive/like", { aid, like: enabled ? 1 : 2, csrf });
      return { liked: enabled };
    case "favorite":
      return setFavorite(aid, owner, enabled, csrf);
    case "action":
      switch (actionID) {
        case "coin":
          await post("/x/web-interface/coin/add", { aid, multiply: 1, select_like: 0, csrf });
          return { actionStates: { coin: true }, message: "\u5df2\u6295\u51fa 1 \u679a\u786c\u5e01" };
        case "triple": {
          const result = await post("/x/web-interface/archive/like/triple", { aid, csrf });
          const coined = result?.coin === true;
          const partial = result?.like !== true || !coined || result?.fav !== true;
          return {
            liked: result?.like === true ? true : undefined,
            favorite: result?.fav === true ? true : undefined,
            actionStates: coined ? { coin: true } : undefined,
            message: partial ? undefined : "\u70ed\u7231\uff0c\u5df2\u9001\u8fbe",
            celebrate: !partial,
            partial
          };
        }
        default:
          throw { code: "unsupported" };
      }
    case "replyLike":
    case "replyDislike":
      if (!positiveID(replyID)) throw { code: "permission" };
      await post(interaction === "replyLike" ? "/x/v2/reply/action" : "/x/v2/reply/hate",
        { oid: aid, type: 1, rpid: replyID, action: enabled ? 1 : 0, csrf });
      return {};
    case "postComment": {
      const message = text(body);
      const root = positiveID(threadID);
      const parent = positiveID(replyID);
      if (!message || [...message].length > 500 || (threadID || replyID) && (!root || !parent)) {
        throw { code: "permission" };
      }
      const result = await post("/x/v2/reply/add", {
        oid: aid, type: 1, message, root: root || "0", parent: parent || "0", csrf
      });
      return { comment: videoComment(result?.reply, positiveID(row.owner?.mid)) };
    }
    default:
      throw { code: "unsupported" };
  }
}
