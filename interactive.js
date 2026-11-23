import { optionalData, payload, webHeaders } from "./auth.js";

const site = "https://api.bilibili.com";
const maxStateBytes = 3800;

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function positiveID(value) {
  const id = String(value ?? "");
  return /^[1-9]\d*$/.test(id) ? id : undefined;
}

function parseBranchState(raw) {
  if (typeof raw !== "string" || !raw) return { vars: {}, choices: [] };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { vars: {}, choices: [] };
    const vars = {};
    if (parsed.vars && typeof parsed.vars === "object") {
      for (const [k, v] of Object.entries(parsed.vars)) {
        if (typeof k === "string" && typeof v === "number" && Number.isFinite(v)) {
          vars[k] = v;
        }
      }
    }
    const choices = Array.isArray(parsed.choices)
      ? parsed.choices.map(c => positiveID(c)).filter(Boolean).slice(-40)
      : [];
    return {
      gv: positiveID(parsed.gv),
      buvid: text(parsed.buvid) || undefined,
      vars,
      choices
    };
  } catch {
    return { vars: {}, choices: [] };
  }
}

function serializeBranchState(state) {
  const obj = {
    gv: state.gv,
    buvid: state.buvid,
    vars: state.vars && Object.keys(state.vars).length ? state.vars : undefined,
    choices: state.choices?.length ? state.choices.slice(-40) : undefined
  };
  let encoded = JSON.stringify(obj);
  if (encoded.length > maxStateBytes && obj.choices) {
    obj.choices = obj.choices.slice(-10);
    encoded = JSON.stringify(obj);
  }
  if (encoded.length > maxStateBytes) {
    encoded = JSON.stringify({ gv: state.gv, buvid: state.buvid });
  }
  return encoded;
}

// Safe pure-JS recursive-descent evaluator for Stein conditions and native_action expressions.
function tokenize(input) {
  const tokens = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const two = input.slice(i, i + 2);
    if (two === "&&" || two === "||" || two === "==" || two === "!=" || two === ">=" || two === "<=") {
      tokens.push({ type: "op", value: two });
      i += 2;
      continue;
    }
    if ("+-*/()><!".includes(ch)) {
      tokens.push({ type: "op", value: ch });
      i++;
      continue;
    }
    if (ch === "$") {
      let end = i + 1;
      while (end < input.length && /[A-Za-z0-9_@#-]/.test(input[end])) end++;
      tokens.push({ type: "var", value: input.slice(i, end) });
      i = end;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let end = i;
      while (end < input.length && /[0-9.]/.test(input[end])) end++;
      const num = Number(input.slice(i, end));
      tokens.push({ type: "num", value: Number.isFinite(num) ? num : 0 });
      i = end;
      continue;
    }
    i++;
  }
  return tokens;
}

function evalExpression(expr, vars) {
  const tokens = tokenize(expr);
  let pos = 0;
  const peek = () => tokens[pos];
  const consume = () => tokens[pos++];

  function parseOr() {
    let left = parseAnd();
    while (peek()?.type === "op" && peek().value === "||") {
      consume();
      const right = parseAnd();
      left = (Boolean(left) || Boolean(right)) ? 1 : 0;
    }
    return left;
  }

  function parseAnd() {
    let left = parseCmp();
    while (peek()?.type === "op" && peek().value === "&&") {
      consume();
      const right = parseCmp();
      left = (Boolean(left) && Boolean(right)) ? 1 : 0;
    }
    return left;
  }

  function parseCmp() {
    let left = parseAdd();
    while (peek()?.type === "op" && ["==", "!=", ">=", "<=", ">", "<"].includes(peek().value)) {
      const op = consume().value;
      const right = parseAdd();
      switch (op) {
        case "==": left = left === right ? 1 : 0; break;
        case "!=": left = left !== right ? 1 : 0; break;
        case ">=": left = left >= right ? 1 : 0; break;
        case "<=": left = left <= right ? 1 : 0; break;
        case ">":  left = left > right ? 1 : 0; break;
        case "<":  left = left < right ? 1 : 0; break;
      }
    }
    return left;
  }

  function parseAdd() {
    let left = parseMul();
    while (peek()?.type === "op" && (peek().value === "+" || peek().value === "-")) {
      const op = consume().value;
      const right = parseMul();
      left = op === "+" ? left + right : left - right;
    }
    return left;
  }

  function parseMul() {
    let left = parseUnary();
    while (peek()?.type === "op" && (peek().value === "*" || peek().value === "/")) {
      const op = consume().value;
      const right = parseUnary();
      left = op === "*" ? left * right : (right !== 0 ? left / right : 0);
    }
    return left;
  }

  function parseUnary() {
    if (peek()?.type === "op" && peek().value === "!") {
      consume();
      return parseUnary() ? 0 : 1;
    }
    if (peek()?.type === "op" && peek().value === "-") {
      consume();
      return -parseUnary();
    }
    if (peek()?.type === "op" && peek().value === "+") {
      consume();
      return +parseUnary();
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const tok = peek();
    if (!tok) return 0;
    if (tok.type === "num") {
      consume();
      return tok.value;
    }
    if (tok.type === "var") {
      consume();
      return Number(vars[tok.value] ?? 0);
    }
    if (tok.type === "op" && tok.value === "(") {
      consume();
      const val = parseOr();
      if (peek()?.type === "op" && peek().value === ")") consume();
      return val;
    }
    consume();
    return 0;
  }

  return parseOr();
}

export function evalCondition(condition, vars) {
  const raw = text(condition);
  if (!raw) return true;
  try {
    return Boolean(evalExpression(raw, vars));
  } catch {
    return true;
  }
}

export function applyNativeAction(action, vars) {
  const next = { ...vars };
  const raw = text(action);
  if (!raw) return next;
  for (const stmt of raw.split(";")) {
    const line = stmt.trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const lhs = line.slice(0, eq).trim();
    const rhs = line.slice(eq + 1).trim();
    if (!lhs.startsWith("$") || !rhs) continue;
    try {
      const val = evalExpression(rhs, next);
      if (Number.isFinite(val)) next[lhs] = val;
    } catch {
      // Ignore malformed assignments.
    }
  }
  return next;
}

function cleanOptionTitle(option, index, autoAdvance) {
  const raw = text(option);
  const stripped = raw.replace(/^[A-Z][\s.\u3001:\uff1a]+(.+)$/, "$1").trim();
  if (stripped) return stripped;
  if (raw && !/^[A-Z]$/.test(raw)) return raw;
  return autoAdvance ? "" : (raw || `\u9009\u9879 ${index + 1}`);
}

async function fetchEdgeInfo(aid, graphVersion, edgeID, choicesStr, buvid) {
  const params = {
    aid,
    graph_version: graphVersion,
    platform: "pc",
    portal: "0",
    screen: "0",
    choices: choicesStr || ""
  };
  if (edgeID) params.edge_id = edgeID;
  if (buvid) params.buvid = buvid;
  const url = site + "/x/stein/edgeinfo_v2?" + new URLSearchParams(params);
  let response;
  try {
    response = await fetch(url, {
      headers: { ...webHeaders, Referer: `https://www.bilibili.com/video/av${aid}/` },
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

export async function resolveInteractiveBranch({ aid, player, duration, branchID, branchState }) {
  const prevState = parseBranchState(branchState);
  const graphVersion = positiveID(player?.interaction?.graph_version) || prevState.gv;
  if (!aid || !graphVersion) return undefined;

  const edgeID = positiveID(branchID);
  const edge = await fetchEdgeInfo(
    aid,
    graphVersion,
    edgeID,
    prevState.choices.join(","),
    prevState.buvid
  ).catch(error => optionalData(error, null));
  if (!edge || typeof edge !== "object") return undefined;

  const vars = { ...prevState.vars };
  if (Array.isArray(edge.hidden_vars)) {
    for (const item of edge.hidden_vars) {
      const key = text(item?.id_v2) || text(item?.id);
      if (!key) continue;
      if (item.skip_overwrite && Object.prototype.hasOwnProperty.call(vars, key)) continue;
      if (!Object.prototype.hasOwnProperty.call(vars, key) && typeof item.value === "number" && Number.isFinite(item.value)) {
        vars[key] = item.value;
      }
    }
  }

  const currentState = {
    gv: graphVersion,
    buvid: text(edge.buvid) || prevState.buvid,
    vars,
    choices: prevState.choices
  };
  const nodeID = positiveID(edge.edge_id) || edgeID || "1";
  const nodeTitle = text(edge.title);
  const baseState = serializeBranchState(currentState);

  const questions = Array.isArray(edge.edges?.questions) ? edge.edges.questions : [];
  const question = questions.find(q => Array.isArray(q?.choices) && q.choices.length > 0);
  if (edge.is_leaf === 1 || !question) {
    return {
      nodeID,
      nodeTitle: nodeTitle || undefined,
      state: baseState
    };
  }

  const allChoices = question.choices.filter(c => positiveID(c?.id) && positiveID(c?.cid));
  let visibleChoices = allChoices.filter(c => evalCondition(c.condition, vars));
  if (!visibleChoices.length) {
    const fallback = allChoices.find(c => c.is_default === 1) ?? allChoices[0];
    visibleChoices = fallback ? [fallback] : [];
  }
  if (!visibleChoices.length) {
    return {
      nodeID,
      nodeTitle: nodeTitle || undefined,
      state: baseState
    };
  }

  const qType = Number(question.type ?? 1);
  const pauseFlag = question.pause_video !== 0;
  const autoAdvance = qType === 0 && !pauseFlag && visibleChoices.length === 1;

  const clipDuration = Number(duration) > 0 ? Number(duration) : 0;
  const startTimeR = Number(question.start_time_r ?? 0);
  const qDuration = Number(question.duration ?? -1);
  let leadSeconds = 0.5;
  if (qDuration > 0) {
    leadSeconds = qDuration / 1000;
  } else if (startTimeR > 0) {
    leadSeconds = startTimeR / 1000;
  }
  let triggerSeconds = clipDuration > 0 ? Math.max(0, clipDuration - leadSeconds) : 0;
  if (clipDuration > 1) {
    triggerSeconds = Math.min(triggerSeconds, Math.max(0, clipDuration - 0.25));
  }

  const options = visibleChoices.slice(0, 16).map((choice, index) => {
    const choiceID = positiveID(choice.id);
    const choiceCID = positiveID(choice.cid);
    const nextVars = applyNativeAction(choice.native_action, vars);
    const nextState = serializeBranchState({
      ...currentState,
      vars: nextVars,
      choices: [...currentState.choices, choiceID]
    });
    return {
      id: choiceID,
      title: cleanOptionTitle(choice.option, index, autoAdvance),
      partID: choiceCID,
      state: nextState,
      default: choice.is_default === 1 || undefined
    };
  });

  return {
    nodeID,
    nodeTitle: nodeTitle || undefined,
    question: text(question.title) || undefined,
    triggerSeconds,
    pauseVideo: !autoAdvance,
    autoAdvance: autoAdvance || undefined,
    state: baseState,
    options
  };
}
