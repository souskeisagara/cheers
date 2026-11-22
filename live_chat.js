import { payload, request, webHeaders } from "./auth.js";
import { saveWbiKeys, signWbiParams } from "./wbi.js";

const site = "https://api.bilibili.com";
const liveSite = "https://api.live.bilibili.com";
const homeOrigin = "https://www.bilibili.com/";
const liveOrigin = "https://live.bilibili.com";
const buvidStorageKey = "live_buvid3";

const liveHeaders = {
  ...webHeaders,
  Origin: liveOrigin,
  Referer: liveOrigin + "/"
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8");

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function positiveID(value) {
  const id = String(value ?? "");
  return /^[1-9]\d*$/.test(id) ? id : undefined;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function primeBuvid() {
  try {
    await fetch(homeOrigin, { method: "HEAD", headers: webHeaders, redirect: "error" });
  } catch {}
}

async function ensureWbiKeys() {
  if (signWbiParams({ id: 1 })) return true;
  try {
    const res = await fetch(`${site}/x/web-interface/nav`, { headers: webHeaders, redirect: "error" });
    if (res.ok) {
      const body = await res.json();
      if (body?.data?.wbi_img) {
        saveWbiKeys(body.data.wbi_img);
        return true;
      }
    }
  } catch {}
  return false;
}

async function fetchBuvid3() {
  try {
    const cached = host.storage.get(buvidStorageKey);
    if (cached) return cached;
  } catch {}
  await primeBuvid();
  try {
    const spi = await payload(await request(`${site}/x/frontend/finger/spi`));
    const b3 = text(spi?.b_3);
    if (b3) {
      try {
        host.storage.set(buvidStorageKey, b3);
      } catch {}
      return b3;
    }
  } catch {}
  return "";
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

function encodePacket(op, bodyBytes) {
  const body = bodyBytes instanceof Uint8Array ? bodyBytes : new Uint8Array(0);
  const buf = new ArrayBuffer(16 + body.byteLength);
  const view = new DataView(buf);
  view.setUint32(0, 16 + body.byteLength, false);
  view.setUint16(4, 16, false);
  view.setUint16(6, 1, false);
  view.setUint32(8, op, false);
  view.setUint32(12, 1, false);
  new Uint8Array(buf, 16).set(body);
  return new Uint8Array(buf);
}

function decodePackets(bytes, out, depth = 0) {
  if (depth > 4 || !(bytes instanceof Uint8Array)) return;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  while (pos + 16 <= bytes.byteLength) {
    const packetLen = view.getUint32(pos, false);
    const headerLen = view.getUint16(pos + 4, false);
    const protoVer = view.getUint16(pos + 6, false);
    const op = view.getUint32(pos + 8, false);
    if (packetLen < headerLen || headerLen < 16 || pos + packetLen > bytes.byteLength) {
      break;
    }
    const body = bytes.subarray(pos + headerLen, pos + packetLen);
    pos += packetLen;
    if (protoVer === 2) {
      try {
        const inflated = host.compress.inflateZlib(body);
        decodePackets(new Uint8Array(inflated), out, depth + 1);
      } catch {}
      continue;
    }
    if (protoVer === 0 || protoVer === 1) {
      out.push({ op, protoVer, body });
    }
  }
}

function isMuteSignalText(raw) {
  const s = text(raw).toLowerCase();
  if (!s) return false;
  return s.includes("silent") || s.includes("ban") || s.includes("level") ||
    s.includes("medal") || s.includes("member") ||
    s.includes("\u7981\u8a00") || s.includes("\u53d1\u8a00\u9650\u5236") ||
    s.includes("\u7b49\u7ea7") || s.includes("\u52cb\u7ae0") || s.includes("\u7c89\u4e1d");
}

function parseServerHost(entry) {
  const hostName = text(entry?.host);
  const wssPort = Number(entry?.wss_port) || 2245;
  const wsPort = Number(entry?.ws_port) || 0;
  if (!hostName) return undefined;
  const scheme = entry?.scheme === "ws" ? "ws" : "wss";
  const port = scheme === "ws" && wsPort > 0 ? wsPort : wssPort;
  return `${scheme}://${hostName}:${port}/sub`;
}

async function fetchDanmuServer(roomID) {
  await ensureWbiKeys();
  const base = { id: roomID, type: 0 };
  const signed = signWbiParams(base) || base;
  const data = await liveGet("/xlive/web-room/v1/index/getDanmuInfo", signed, {
    Referer: `${liveOrigin}/${roomID}`
  });
  const token = text(data?.token);
  const hosts = (Array.isArray(data?.host_list) ? data.host_list : [])
    .map(parseServerHost)
    .filter(Boolean);
  if (!hosts.length) {
    hosts.push("wss://broadcastlv.chat.bilibili.com:2245/sub");
  }
  return { token, hosts };
}

function openSocketOnce(wsURL, authPayload, onPacket) {
  return new Promise(resolve => {
    let settled = false;
    let heartbeat = null;
    let socket = null;
    const finish = reason => {
      if (heartbeat != null) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      if (!settled) {
        settled = true;
        resolve(reason);
      }
    };
    try {
      socket = host.ws.connect(wsURL, {
        headers: {
          Origin: liveOrigin,
          "User-Agent": webHeaders["User-Agent"]
        },
        onOpen() {
          try {
            socket.send(encodePacket(7, textEncoder.encode(JSON.stringify(authPayload))));
          } catch {
            socket.close();
            finish("send-auth-failed");
            return;
          }
          const hbBody = textEncoder.encode("[object Object]");
          heartbeat = setInterval(() => {
            try {
              socket.send(encodePacket(2, hbBody));
            } catch {
              socket.close();
            }
          }, 30000);
        },
        onMessage(data) {
          if (!(data instanceof ArrayBuffer)) return;
          const packets = [];
          decodePackets(new Uint8Array(data), packets, 0);
          for (const pkt of packets) {
            const action = onPacket(pkt, socket);
            if (action === "stop") {
              socket.close();
              finish("ended");
              return;
            }
          }
        },
        onError() {
          // onClose will always follow onError to settle the promise.
        },
        onClose() {
          finish("closed");
        }
      });
    } catch {
      finish("dial-error");
    }
  });
}

export async function connectLiveChat({ ref, itemID = "", signedIn = false, owner = "" } = {}, emit) {
  const roomID = positiveID(itemID) || positiveID(ref?.id);
  if (!roomID || typeof emit !== "function") {
    throw { code: "unsupported" };
  }

  emit({ type: "status", status: "connecting" });

  const [roomInfo, userInfo, buvid3] = await Promise.all([
    liveGet("/room/v1/Room/get_info", { room_id: roomID }, { Referer: `${liveOrigin}/${roomID}` }).catch(() => undefined),
    signedIn
      ? liveGet("/xlive/web-room/v1/index/getInfoByUser", { room_id: roomID }, { Referer: `${liveOrigin}/${roomID}` }).catch(() => undefined)
      : Promise.resolve(undefined),
    fetchBuvid3()
  ]);

  const canonRoomID = positiveID(roomInfo?.room_id) || roomID;
  if (roomInfo && roomInfo.live_status != null && roomInfo.live_status !== 1) {
    emit({ type: "ended" });
    return;
  }
  if (Number.isSafeInteger(roomInfo?.online) && roomInfo.online > 0) {
    emit({ type: "viewers", viewers: roomInfo.online });
  }
  const userBanned = Boolean(userInfo?.info?.is_ban === 1 || userInfo?.room_admin?.is_ban === 1);
  const roomSilent = Boolean(text(roomInfo?.room_silent_type));
  if (userBanned || (roomSilent && !signedIn)) {
    emit({ type: "mute", muted: true });
  }

  const uidNum = signedIn && positiveID(owner) ? Number(owner) : 0;
  let server = null;
  let hostIndex = 0;
  let backoffMs = 2000;
  let msgSeq = 0;
  let ended = false;
  let hasConnectedOnce = false;
  let hasWatchedChange = false;

  while (!ended) {
    if (!server || hostIndex >= server.hosts.length) {
      try {
        server = await fetchDanmuServer(canonRoomID);
        hostIndex = 0;
      } catch (err) {
        emit({
          type: "status",
          status: hasConnectedOnce ? "reconnecting" : "disconnected",
          error: err?.code || "network"
        });
        await sleep(backoffMs);
        backoffMs = Math.min(15000, backoffMs * 2);
        continue;
      }
    }

    const wsURL = server.hosts[hostIndex % server.hosts.length];
    hostIndex++;

    const authPayload = {
      uid: uidNum,
      roomid: Number(canonRoomID),
      protover: 2,
      buvid: buvid3 || "",
      platform: "web",
      type: 2,
      key: server.token
    };

    const hbBody = textEncoder.encode("[object Object]");
    const reason = await openSocketOnce(wsURL, authPayload, (pkt, socket) => {
      if (pkt.op === 8) {
        let code = 0;
        try {
          const parsed = JSON.parse(textDecoder.decode(pkt.body));
          code = Number(parsed?.code ?? 0);
        } catch {}
        if (code === 0) {
          hasConnectedOnce = true;
          backoffMs = 2000;
          emit({ type: "status", status: "connected" });
          try {
            socket.send(encodePacket(2, hbBody));
          } catch {}
        }
        return;
      }
      if (pkt.op !== 5) return;
      let payloadObj;
      try {
        payloadObj = JSON.parse(textDecoder.decode(pkt.body));
      } catch {
        return;
      }
      const cmd = text(payloadObj?.cmd);
      if (cmd === "DANMU_MSG" || cmd.startsWith("DANMU_MSG:")) {
        const info = payloadObj?.info;
        const body = text(info?.[1]);
        if (!body) return;
        const senderUID = String(info?.[2]?.[0] ?? "");
        const author = text(info?.[2]?.[1]) || "\u89c2\u4f17";
        let ts = Number(info?.[0]?.[4] ?? 0);
        if (ts > 1e11) ts = Math.floor(ts / 1000);
        if (!Number.isSafeInteger(ts) || ts < 0) ts = 0;
        msgSeq++;
        emit({
          type: "message",
          message: {
            id: `${ts || Date.now()}-${msgSeq}`,
            author,
            authorID: senderUID,
            body,
            self: Boolean(signedIn && owner && senderUID === owner),
            timestamp: ts
          }
        });
        return;
      }
      if (cmd === "WATCHED_CHANGE") {
        const num = Number(payloadObj?.data?.num);
        if (Number.isSafeInteger(num) && num >= 0) {
          hasWatchedChange = true;
          emit({ type: "viewers", viewers: num });
        }
        return;
      }
      if (cmd === "ONLINE_RANK_COUNT") {
        if (hasWatchedChange) return;
        const num = Number(payloadObj?.data?.count);
        if (Number.isSafeInteger(num) && num >= 0) {
          emit({ type: "viewers", viewers: num });
        }
        return;
      }
      if (cmd === "ROOM_SILENT_ON") {
        emit({ type: "mute", muted: true });
        return;
      }
      if (cmd === "ROOM_SILENT_OFF") {
        emit({ type: "mute", muted: false });
        return;
      }
      if (cmd === "PREPARING" || cmd === "CUT_OFF" || cmd === "ROOM_LOCK") {
        ended = true;
        emit({ type: "ended" });
        return "stop";
      }
    });

    if (ended || reason === "ended") {
      return;
    }

    emit({ type: "status", status: "reconnecting" });
    await sleep(backoffMs);
    backoffMs = Math.min(15000, backoffMs * 2);
  }
}

export async function sendLiveChat({ data, secret } = {}) {
  const csrf = text(secret?.csrf);
  if (!csrf) throw { code: "signIn" };
  const roomID = positiveID(data?.itemID) || positiveID(data?.ref?.id);
  const bodyText = text(data?.text);
  if (!roomID || !bodyText) throw { code: "permission" };

  let response;
  try {
    response = await fetch(`${liveSite}/msg/send?web_location=444.8`, {
      method: "POST",
      headers: {
        ...liveHeaders,
        Accept: "application/json, text/plain, */*",
        Referer: `${liveOrigin}/${roomID}`
      },
      redirect: "error",
      body: new URLSearchParams({
        bubble: "0",
        msg: bodyText,
        color: "16777215",
        mode: "1",
        room_type: "0",
        jumpfrom: "0",
        reply_mid: "0",
        reply_attr: "0",
        replay_dmid: "",
        statistics: '{"appId":100,"platform":5}',
        fontsize: "25",
        dm_type: "0",
        rnd: String(Math.floor(Date.now() / 1000)),
        roomid: roomID,
        csrf,
        csrf_token: csrf
      })
    });
  } catch {
    throw { code: "network" };
  }
  if (response.status === 412 || response.status === 429) throw { code: "rateLimited" };
  if (!response.ok) throw { code: "network" };

  let jsonBody;
  try {
    jsonBody = await response.json();
  } catch {
    throw { code: "plugin" };
  }

  const code = Number(jsonBody?.code);
  const msgFlag = text(jsonBody?.msg);
  const errMsg = text(jsonBody?.message);
  const detail = errMsg || msgFlag || `code:${code}`;

  if (code === -101) throw { code: "signIn", message: detail };
  if (code === -111) throw { code: "permission", message: detail };
  if (code === 1003 || code === 10032 || code === 1990000) {
    return { muted: true, muteReason: errMsg || msgFlag };
  }
  if (code === 10030 || code === 10031) {
    throw { code: "rateLimited", message: detail };
  }
  if (code === 0) {
    const lower = msgFlag.toLowerCase();
    if (!msgFlag || lower === "0" || lower === "ok") {
      return {};
    }
    if (lower === "msg in 1s" || lower === "max limit" || lower === "msg repeat" || lower === "fire") {
      throw { code: "rateLimited", message: detail };
    }
    if (lower === "k" || lower === "f") {
      throw { code: "permission", message: "\u6d88\u606f\u5305\u542b\u623f\u95f4\u5c4f\u853d\u8bcd\uff0c\u8bf7\u8c03\u6574\u540e\u518d\u8bd5" };
    }
    if (isMuteSignalText(msgFlag) || isMuteSignalText(errMsg)) {
      return { muted: true, muteReason: errMsg || msgFlag };
    }
    throw { code: "permission", message: detail };
  }
  if (isMuteSignalText(errMsg) || isMuteSignalText(msgFlag)) {
    return { muted: true, muteReason: errMsg || msgFlag };
  }
  throw { code: "permission", message: detail };
}
