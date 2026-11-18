const mixinKeyEncTab = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
];

const wbiStorageKey = "wbi_keys";
const wbiMaxAgeMs = 12 * 60 * 60 * 1000;

const md5Shifts = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
];

const md5K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0);

function md5Hex(input) {
  const bytes = new TextEncoder().encode(input);
  const bitLen = bytes.length * 8;
  const padLen = ((bytes.length + 8) & ~63) + 64;
  const buf = new Uint8Array(padLen);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(padLen - 8, bitLen >>> 0, true);
  view.setUint32(padLen - 4, Math.floor(bitLen / 0x100000000) >>> 0, true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const M = new Uint32Array(16);

  for (let offset = 0; offset < padLen; offset += 64) {
    for (let j = 0; j < 16; j++) M[j] = view.getUint32(offset + j * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) & 15;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) & 15;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) & 15;
      }
      const tmp = D;
      D = C;
      C = B;
      const sum = (A + F + md5K[i] + M[g]) >>> 0;
      const s = md5Shifts[i];
      B = (B + ((sum << s) | (sum >>> (32 - s)))) >>> 0;
      A = tmp;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  let hex = "";
  for (const word of [a0, b0, c0, d0]) {
    for (let b = 0; b < 4; b++) {
      hex += ((word >>> (b * 8)) & 0xff).toString(16).padStart(2, "0");
    }
  }
  return hex;
}

function keyStem(url) {
  if (typeof url !== "string") return "";
  const file = url.split("/").pop() ?? "";
  return file.split(".")[0] ?? "";
}

export function saveWbiKeys(wbiImg) {
  const imgKey = keyStem(wbiImg?.img_url);
  const subKey = keyStem(wbiImg?.sub_url);
  if (!imgKey || !subKey) return;
  try {
    host.storage.set(wbiStorageKey, JSON.stringify({ imgKey, subKey, at: Date.now() }));
  } catch {}
}

export function signWbiParams(params) {
  let raw;
  try {
    raw = host.storage.get(wbiStorageKey);
  } catch {
    return null;
  }
  if (!raw) return null;
  let keys;
  try {
    keys = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!keys?.imgKey || !keys?.subKey || !Number.isFinite(keys.at) || Date.now() - keys.at > wbiMaxAgeMs) {
    return null;
  }
  const combined = keys.imgKey + keys.subKey;
  if (combined.length < 64) return null;
  const mixinKey = mixinKeyEncTab.map(index => combined[index]).join("").slice(0, 32);
  const wts = Math.floor(Date.now() / 1000);
  const signed = { ...params, wts };
  const query = Object.keys(signed).sort().map(key => {
    const value = String(signed[key] ?? "").replace(/[!'()*]/g, "");
    return encodeURIComponent(key) + "=" + encodeURIComponent(value);
  }).join("&");
  return { ...signed, w_rid: md5Hex(query + mixinKey) };
}
