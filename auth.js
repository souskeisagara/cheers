import { saveWbiKeys } from "./wbi.js";

const site = "https://www.bilibili.com";
const passport = "https://passport.bilibili.com";
const webLogin = `${passport}/x/passport-login/web`;
const pollURL = `${webLogin}/qrcode/poll`;
const rotateURL = `${webLogin}/cookie/refresh`;
const accountURL = "https://api.bilibili.com/x/web-interface/nav";
const webRefreshKey = "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDLgd2OAkcGVtoE3ThUREbio0EgUc/prcajMKXvkCKFCWhJYJcLkcM2DKKcSeFpD/j6Boy538YXnR6VhcuUJOhH2x71nzPjfdTcqMz7djHum0qSZA0AyCBDABUqCrfNgCiJ00Ra7GmRj+YCK1NJEuewlb40JNrRuoEUXpabUzGB8QIDAQAB";
const loginCookies = new Set(["SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5"]);
export const webHeaders = {
  Origin: site,
  Referer: `${site}/`,
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"
};

export async function request(url, form) {
  let response;
  try {
    response = await fetch(url, {
      headers: webHeaders,
      redirect: "error",
      method: form === undefined ? "GET" : "POST",
      body: form === undefined ? undefined : new URLSearchParams(form)
    });
  } catch {
    throw {code: "network"};
  }
  if (response.status === 412 || response.status === 429) throw {code: "rateLimited"};
  if (!response.ok) throw {code: "network"};
  return response;
}

export async function payload(response, decode = value => value.json()) {
  const body = await decode(response);
  switch (body.code) {
    case 0: return body.data;
    case -101: throw {code: "signIn"};
    case -111: throw {code: "permission"};
    case -412:
    case -509: throw {code: "rateLimited"};
    default: throw {code: "plugin"};
  }
}

export function optionalData(error, fallback) {
  if (error?.code === "network" || error?.code === "permission" || error?.code === "plugin") {
    return fallback;
  }
  throw error;
}

export async function currentAccount() {
  const account = await payload(await request(accountURL));
  if (account?.wbi_img) saveWbiKeys(account.wbi_img);
  if (!account?.isLogin || account.mid == null) throw {code: "signIn"};
  const vip = account.vip?.status ?? account.vipStatus;
  const display = {id: String(account.mid), name: account.uname};
  if (typeof account.face === "string") {
    const avatarURL = account.face.replace(/^http:/, "https:");
    if (avatarURL.startsWith("https://")) display.avatarURL = avatarURL;
  }
  if (typeof vip === "number") {
    const label = "\u5927\u4f1a\u5458";
    const active = vip === 1;
    display.badge = {text: active ? label : "\u666e\u901a\u4f1a\u5458", icon: active ? "sparkles" : "user"};
    display.card = {
      title: label, icon: active ? "sparkles" : undefined, highlight: active,
      description: "\u628a\u559c\u6b22\u7684\u4f5c\u54c1\uff0c\u770b\u5230\u5c3d\u5174\u3002",
      benefits: ["4K \u8d85\u6e05", "\u9ad8\u5e27\u7387", "\u4f1a\u5458\u4e13\u4eab\u5185\u5bb9"],
      actionLabel: "\u67e5\u770b\u5927\u4f1a\u5458\u6743\u76ca",
      status: active ? "\u6743\u76ca\u5df2\u751f\u6548" : "\u5f53\u524d\u672a\u751f\u6548",
      details: {
        title: "\u8ba9\u597d\u753b\u9762\uff0c\u518d\u6e05\u6670\u4e00\u70b9",
        kicker: "\u5927\u4f1a\u5458\u4e13\u4eab",
        body: "4K\u3001HDR \u7b49\u753b\u8d28\u5c5e\u4e8e\u5927\u4f1a\u5458\u6743\u76ca\u3002\u5f53\u524d\u4ecd\u4ee5 1080P \u7ee7\u7eed\u64ad\u653e\uff0c\u4f60\u53ef\u4ee5\u5728\u624b\u673a\u7aef\u67e5\u770b\u5b98\u65b9\u6743\u76ca\uff0c\u5f00\u901a\u540e\u56de\u6765\u5237\u65b0\u3002",
        phoneAction: "\u5728\u624b\u673a\u7aef\u67e5\u770b\u6743\u76ca",
        phoneBody: "\u5728\u624b\u673a\u7aef\u67e5\u770b\u5e76\u5f00\u901a\u4f1a\u5458\u6743\u76ca\uff0c\u5b8c\u6210\u540e\u8fd4\u56de\u5237\u65b0\u3002",
        officialLabel: "\u524d\u5f80\u8d26\u53f7\u670d\u52a1",
        refreshAction: "\u6211\u5df2\u5f00\u901a\uff0c\u5237\u65b0\u6743\u76ca",
        dismissAction: "\u7ee7\u7eed\u4ee5\u5f53\u524d\u753b\u8d28\u89c2\u770b"
      }
    };
  }
  return display;
}

async function grant(response, data, url, previousToken) {
  const headers = response.headers.getSetCookie().filter(header => loginCookies.has(header.split("=", 1)[0]));
  const csrf = headers.find(header => header.startsWith("bili_jct="))?.slice(9).split(";", 1)[0];
  if (!csrf || !headers.some(header => header.startsWith("SESSDATA=")) || !data.refresh_token) {
    throw {code: "signIn"};
  }
  return {
    account: await currentAccount(),
    secret: {csrf, refreshToken: data.refresh_token, previousToken},
    cookies: [{url, headers}],
    pendingConfirmation: Boolean(previousToken)
  };
}

export async function beginSignIn() {
  const {url, qrcode_key: key} = await payload(await request(`${webLogin}/qrcode/generate`));
  const location = new URL(url);
  if (location.protocol !== "https:" || !location.hostname.endsWith(".bilibili.com")) throw {code: "permission"};
  return {url, key, expiresAt: Date.now() + 180_000};
}

export async function pollSignIn({key}) {
  const response = await request(`${pollURL}?${new URLSearchParams({qrcode_key: key})}`);
  const data = await payload(response);
  switch (data.code) {
    case 86101: return {status: "waiting"};
    case 86090: return {status: "scanned"};
    case 86038: return {status: "expired"};
    case 0: return {status: "approved", ...await grant(response, data, pollURL)};
    default: throw {code: "plugin"};
  }
}

export async function restoreAccount(secret) {
  const {csrf, refreshToken, previousToken} = secret;
  const account = await currentAccount();
  if (previousToken) {
    await payload(await request(`${webLogin}/confirm/refresh`, {csrf, refresh_token: previousToken}));
    return {account, secret: {csrf, refreshToken}};
  }

  const info = await payload(await request(`${webLogin}/cookie/info?${new URLSearchParams({csrf})}`));
  if (!info.refresh) return {account, secret};
  const path = host.crypto.encryptRSAOAEP(webRefreshKey, `refresh_${info.timestamp}`);
  const html = await (await request(`${site}/correspond/1/${path}`)).text();
  const refreshCSRF = /id=["']1-name["'][^>]*>\s*([^<\s]+)\s*</.exec(html)?.[1];
  if (!refreshCSRF) throw {code: "plugin"};
  const response = await request(rotateURL, {
    csrf, refresh_csrf: refreshCSRF, refresh_token: refreshToken, source: "main_web"
  });
  return grant(response, await payload(response), rotateURL, refreshToken);
}

export async function signOut({csrf}) {
  await payload(await request(`${passport}/login/exit/v2`, {biliCSRF: csrf}));
  return {};
}
