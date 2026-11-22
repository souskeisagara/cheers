import { optionalData } from "./auth.js";
import { accountArtwork, decodeAccountJSON } from "./account.js";

const im = "https://api.vc.bilibili.com";
const web = { build: 0, mobi_app: "web" };
const imHeaders = {
  Origin: "https://message.bilibili.com",
  Referer: "https://message.bilibili.com/",
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"
};

const positiveID = value => /^[1-9]\d*$/.test(value);

function identifier(value) {
  return value == null ? "" : String(value);
}

function count(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

function clean(value) {
  return typeof value === "string" ? value.replace(/<[^>]+>/g, "").trim() : "";
}

function avatarURL(raw) {
  if (typeof raw !== "string" || !raw) return undefined;
  const sized = accountArtwork(raw, "128w_128h");
  if (sized) return sized;
  const normalized = raw.replace(/^http:/, "https:");
  if (/^https:\/\/(?:i[012]|bimp)\.hdslb\.com\/[^?\s#]+/.test(normalized)) {
    return normalized;
  }
  return undefined;
}

async function imRequest(path, { params, form } = {}) {
  const query = params ? new URLSearchParams(params).toString() : "";
  const url = im + path + (query ? "?" + query : "");
  let response;
  try {
    response = await fetch(url, {
      headers: imHeaders,
      redirect: "error",
      method: form === undefined ? "GET" : "POST",
      body: form === undefined ? undefined : new URLSearchParams(form)
    });
  } catch {
    throw { code: "network" };
  }
  if (response.status === 412 || response.status === 429) throw { code: "rateLimited" };
  if (!response.ok) throw { code: "network" };
  return response;
}

async function imPayload(response) {
  const body = await decodeAccountJSON(response);
  const code = Number(body?.code);
  const message = clean(body?.message || body?.msg);
  switch (code) {
    case 0:
      return body.data;
    case -101:
      throw { code: "signIn", message };
    case -111:
      throw { code: "permission", message };
    case -412:
    case -509:
    case 21015:
    case 21020:
    case 21047:
      throw { code: "rateLimited", message };
    case 21001:
    case 21002:
    case 21010:
    case 21016:
    case 21026:
    case 21046:
    case 21050:
      throw { code: "permission", message };
    default:
      throw { code: "plugin", message };
  }
}

async function readSingleUnread() {
  const data = await imPayload(await imRequest("/session_svr/v1/session_svr/single_unread", {
    params: { ...web, unread_type: 0 }
  }));
  const follow = count(data?.follow_unread) ?? 0;
  const unfollow = count(data?.unfollow_unread) ?? 0;
  return follow + unfollow;
}

function parseContentObject(raw) {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function extractTextFromRichArray(items) {
  if (!Array.isArray(items)) return "";
  return items.map(part => clean(part?.text || part?.content)).filter(Boolean).join("").trim();
}

function formatMessageBody(msgType, rawContent) {
  const type = Number(msgType);
  if (type === 5) return "[\u5df2\u64a4\u56de\u4e00\u6761\u6d88\u606f]";
  const parsed = parseContentObject(rawContent);
  if (type === 1) {
    if (typeof parsed?.content === "string" && parsed.content.trim()) return parsed.content.trim();
    if (typeof rawContent === "string" && rawContent.trim() && !rawContent.trim().startsWith("{")) {
      return rawContent.trim();
    }
    return "[\u6d88\u606f]";
  }
  if (type === 2) return "[\u56fe\u7247]";
  if (type === 6) return clean(parsed?.text) || "[\u8868\u60c5]";
  if (type === 7 || type === 14) {
    const title = clean(parsed?.title);
    return title ? "[\u5206\u4eab] " + title : "[\u5206\u4eab\u5185\u5bb9]";
  }
  if (type === 10 || type === 11 || type === 12 || type === 13) {
    const title = clean(parsed?.title);
    const text = clean(parsed?.text || parsed?.content);
    if (title && text && title !== text) return title + "\uff1a" + text;
    if (title) return title;
    if (text) return text;
    return "[\u901a\u77e5\u5361\u7247]";
  }
  if (type === 16) {
    return clean(parsed?.content || parsed?.title || parsed?.text) || "[\u81ea\u52a8\u56de\u590d]";
  }
  if (type === 18) {
    const rich = extractTextFromRichArray(parsed?.content);
    if (rich) return rich;
    return clean(parsed?.content || parsed?.text) || "[\u7cfb\u7edf\u63d0\u793a]";
  }
  if (parsed && typeof parsed === "object") {
    const rich = extractTextFromRichArray(parsed.content);
    if (rich) return rich;
    const text = clean(parsed.content || parsed.title || parsed.text || parsed.msg);
    if (text) return text;
  } else if (typeof rawContent === "string") {
    const plain = clean(rawContent);
    if (plain && !plain.startsWith("{")) return plain;
  }
  return "[\u6682\u4e0d\u652f\u6301\u7684\u6d88\u606f\u7c7b\u578b]";
}

async function fetchPeerProfiles(uids) {
  const profiles = new Map();
  const unique = [...new Set(uids.filter(positiveID))];
  for (let i = 0; i < unique.length; i += 40) {
    const batch = unique.slice(i, i + 40);
    const data = await imPayload(await imRequest("/account/v1/user/cards", {
      params: { uids: batch.join(",") }
    })).catch(error => optionalData(error, null));
    const list = Array.isArray(data) ? data : (Array.isArray(data?.cards) ? data.cards : []);
    for (const card of list) {
      const uid = identifier(card?.mid);
      if (!uid) continue;
      const name = clean(card?.name);
      const face = avatarURL(card?.face);
      profiles.set(uid, { name, avatarURL: face });
    }
  }
  return profiles;
}

function sessionUpdatedAt(session) {
  const msgTs = count(session?.last_msg?.timestamp);
  if (msgTs) return msgTs;
  const raw = identifier(session?.session_ts);
  if (/^\d{13,}$/.test(raw)) {
    const sec = Number(raw.slice(0, -6));
    if (Number.isSafeInteger(sec) && sec > 0) return sec;
  }
  return count(session?.session_ts) ?? 0;
}

export async function readPrivateConversations({ cursor = "", summary = false } = {}) {
  if (summary) {
    const unread = await readSingleUnread();
    return { unread };
  }
  const params = {
    session_type: 1,
    group_fold: 1,
    unfollow_fold: 0,
    sort_rule: 2,
    size: 20,
    ...web
  };
  if (cursor) {
    if (!positiveID(cursor)) throw { code: "permission" };
    params.end_ts = cursor;
  }
  const [data, unread] = await Promise.all([
    imPayload(await imRequest("/session_svr/v1/session_svr/get_sessions", { params })),
    cursor ? Promise.resolve(undefined) : readSingleUnread().catch(error => optionalData(error, undefined))
  ]);
  const rawList = Array.isArray(data?.session_list) ? data.session_list : [];
  const directSessions = rawList.filter(item => Number(item?.session_type) === 1 && positiveID(identifier(item?.talker_id)));
  const profiles = await fetchPeerProfiles(directSessions.map(item => identifier(item.talker_id)));

  const conversations = directSessions.map(item => {
    const peerID = identifier(item.talker_id);
    const card = profiles.get(peerID);
    const accountInfo = item.account_info ?? {};
    const name = card?.name || clean(accountInfo.name) || ("UID " + peerID);
    const face = card?.avatarURL || avatarURL(accountInfo.pic_url);
    const lastMsg = item.last_msg ?? {};
    const preview = lastMsg.msg_type != null || lastMsg.content != null
      ? formatMessageBody(lastMsg.msg_type, lastMsg.content)
      : "";
    return {
      id: peerID,
      peer: {
        id: peerID,
        name,
        avatarURL: face
      },
      preview,
      updatedAt: sessionUpdatedAt(item),
      unread: count(item.unread_count) ?? 0,
      lastSeq: positiveID(identifier(item.max_seqno)) ? identifier(item.max_seqno) : undefined,
      ackSeq: positiveID(identifier(item.ack_seqno)) ? identifier(item.ack_seqno) : undefined
    };
  });

  const hasMore = data?.has_more === 1 || data?.has_more === true;
  const lastRaw = rawList.at(-1);
  const lastTS = identifier(lastRaw?.session_ts);
  const nextCursor = hasMore && positiveID(lastTS) && lastTS !== cursor ? lastTS : "";
  const page = { conversations, nextCursor };
  if (unread !== undefined) page.unread = unread;
  return page;
}

export async function readPrivateMessages({ conversationID = "", peerID = "", cursor = "", owner = "" } = {}) {
  const talkerID = positiveID(identifier(peerID)) ? identifier(peerID) : identifier(conversationID);
  if (!positiveID(talkerID)) throw { code: "permission" };
  const params = {
    talker_id: talkerID,
    session_type: 1,
    size: 20,
    sender_device_id: 1,
    ...web
  };
  if (cursor) {
    if (!positiveID(cursor)) throw { code: "permission" };
    params.end_seqno = cursor;
  }
  const data = await imPayload(await imRequest("/svr_sync/v1/svr_sync/fetch_session_msgs", { params }));
  const rawList = Array.isArray(data?.messages) ? data.messages : [];
  const ownerID = identifier(owner);

  const mapped = [];
  let minSeq = "";
  for (const item of rawList) {
    const seq = identifier(item?.msg_seqno);
    const id = identifier(item?.msg_key || seq);
    if (!id) continue;
    if (positiveID(seq)) {
      if (!minSeq || seq.length < minSeq.length || (seq.length === minSeq.length && seq < minSeq)) {
        minSeq = seq;
      }
    }
    const senderID = identifier(item?.sender_uid);
    mapped.push({
      id,
      seq: positiveID(seq) ? seq : undefined,
      senderID,
      fromSelf: Boolean(ownerID && senderID === ownerID),
      body: formatMessageBody(item?.msg_type, item?.content),
      sentAt: count(item?.timestamp) ?? 0
    });
  }
  // fetch_session_msgs returns newest-first; reverse so messages display oldest -> newest.
  mapped.reverse();

  const reportedMin = identifier(data?.min_seqno);
  const nextSeq = positiveID(minSeq) ? minSeq : (positiveID(reportedMin) ? reportedMin : "");
  const hasMore = (data?.has_more === 1 || data?.has_more === true) && Boolean(nextSeq) && nextSeq !== cursor;
  return {
    messages: mapped,
    nextCursor: hasMore ? nextSeq : "",
    hasMore
  };
}

function makeDeviceUUID() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID().toUpperCase();
  }
  const hex = "0123456789ABCDEF";
  let out = "";
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      out += "-";
    } else if (i === 14) {
      out += "4";
    } else if (i === 19) {
      out += hex[(Math.floor(Math.random() * 4)) | 8];
    } else {
      out += hex[Math.floor(Math.random() * 16)];
    }
  }
  return out;
}

export async function sendPrivateMessage({ conversationID = "", peerID = "", body = "", owner = "", secret } = {}) {
  const csrf = secret?.csrf;
  if (!csrf) throw { code: "signIn" };
  const senderID = identifier(owner);
  const receiverID = positiveID(identifier(peerID)) ? identifier(peerID) : identifier(conversationID);
  const text = typeof body === "string" ? body.trim() : "";
  if (!positiveID(senderID) || !positiveID(receiverID) || !text) {
    throw { code: "permission" };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const devID = makeDeviceUUID();
  const data = await imPayload(await imRequest("/web_im/v1/web_im/send_msg", {
    form: {
      "msg[sender_uid]": senderID,
      "msg[receiver_id]": receiverID,
      "msg[receiver_type]": "1",
      "msg[msg_type]": "1",
      "msg[msg_status]": "0",
      "msg[dev_id]": devID,
      "msg[timestamp]": String(nowSec),
      "msg[new_face_version]": "1",
      "msg[content]": JSON.stringify({ content: text }),
      from_firework: "0",
      build: "0",
      mobi_app: "web",
      csrf_token: csrf,
      csrf
    }
  }));
  const msgKey = identifier(data?.msg_key);
  return {
    message: {
      id: msgKey || ("sent:" + nowSec + ":" + devID),
      senderID,
      fromSelf: true,
      body: text,
      sentAt: nowSec
    }
  };
}

async function ackSession(talkerID, ackSeq, csrf) {
  if (!positiveID(talkerID) || !positiveID(ackSeq)) return;
  await imPayload(await imRequest("/session_svr/v1/session_svr/update_ack", {
    form: {
      talker_id: talkerID,
      session_type: "1",
      ack_seqno: ackSeq,
      build: "0",
      mobi_app: "web",
      csrf_token: csrf,
      csrf
    }
  }));
}

export async function markPrivateMessagesRead({ all = false, conversationID = "", peerID = "", ackSeq = "", targets = [], secret } = {}) {
  const csrf = secret?.csrf;
  if (!csrf) throw { code: "signIn" };

  if (all) {
    const ackList = [];
    const seen = new Set();
    for (const target of Array.isArray(targets) ? targets : []) {
      const uid = identifier(target?.peerID || target?.conversationID);
      const seq = identifier(target?.ackSeq);
      if (positiveID(uid) && positiveID(seq) && !seen.has(uid)) {
        seen.add(uid);
        ackList.push({ uid, seq });
      }
    }
    if (ackList.length === 0) {
      const data = await imPayload(await imRequest("/session_svr/v1/session_svr/get_sessions", {
        params: { session_type: 1, group_fold: 1, unfollow_fold: 0, sort_rule: 2, size: 50, ...web }
      }));
      for (const item of Array.isArray(data?.session_list) ? data.session_list : []) {
        if (Number(item?.session_type) !== 1) continue;
        const uid = identifier(item?.talker_id);
        const seq = identifier(item?.max_seqno);
        const unread = count(item?.unread_count) ?? 0;
        if (unread > 0 && positiveID(uid) && positiveID(seq) && !seen.has(uid)) {
          seen.add(uid);
          ackList.push({ uid, seq });
        }
      }
    }
    for (let i = 0; i < ackList.length; i += 6) {
      await Promise.all(ackList.slice(i, i + 6).map(item => ackSession(item.uid, item.seq, csrf)));
    }
  } else {
    const uid = positiveID(identifier(peerID)) ? identifier(peerID) : identifier(conversationID);
    if (!positiveID(uid)) throw { code: "permission" };
    let seq = identifier(ackSeq);
    if (!positiveID(seq)) {
      const history = await imPayload(await imRequest("/svr_sync/v1/svr_sync/fetch_session_msgs", {
        params: { talker_id: uid, session_type: 1, size: 1, sender_device_id: 1, ...web }
      })).catch(error => optionalData(error, null));
      seq = identifier(history?.max_seqno || history?.messages?.[0]?.msg_seqno);
    }
    if (positiveID(seq)) {
      await ackSession(uid, seq, csrf);
    }
  }

  const fallbackUnread = all ? 0 : undefined;
  const unread = await readSingleUnread().catch(error => optionalData(error, fallbackUnread));
  return unread === undefined ? {} : { unread };
}
