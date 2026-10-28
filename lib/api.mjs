/**
 * WeChat (iLink / ClawBot) transport for DSH.
 *
 * Protocol is the official WeChat bot backend API documented and implemented by
 * Tencent's MIT-licensed `@tencent-weixin/openclaw-weixin`; this module is a
 * small client for the same endpoints, independent of OpenClaw.
 *
 * Every request is a plain JSON POST/GET to `<baseUrl>/ilink/bot/...` carrying
 * `Authorization: Bearer <botToken>` plus the two iLink identity headers.
 */
import crypto from "node:crypto";

export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const DEFAULT_APP_ID = "bot";
export const CHANNEL_VERSION = "2.4.10";
/** 0x00MMNNPP for the client version, matching the reference implementation. */
export const CLIENT_VERSION = String((2 << 16) | (4 << 8) | 10);

export const MessageType = { NONE: 0, USER: 1, BOT: 2 };
export const MessageItemType = { NONE: 0, TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 };
export const MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 };

/** uint64 ids arrive as bare JSON numbers; quote them so JSON.parse keeps them exact. */
const LOSSLESS_ID_FIELDS = new Set(["message_id", "msg_id", "svr_id"]);

export function parseLossless(raw) {
  let out = "";
  let i = 0;
  while (i < raw.length) {
    if (raw[i] !== '"') {
      out += raw[i++];
      continue;
    }
    const start = i++;
    let esc = false;
    while (i < raw.length) {
      const ch = raw[i++];
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') break;
    }
    const token = raw.slice(start, i);
    out += token;
    let c = i;
    while (/\s/.test(raw[c] ?? "")) c++;
    if (raw[c] !== ":") continue;
    let key;
    try {
      key = JSON.parse(token);
    } catch {
      continue;
    }
    if (typeof key !== "string" || !LOSSLESS_ID_FIELDS.has(key)) continue;
    out += raw.slice(i, c + 1);
    c++;
    while (/\s/.test(raw[c] ?? "")) c++;
    const numStart = c;
    if (raw[c] === "-") c++;
    while (/\d/.test(raw[c] ?? "")) c++;
    if (c > numStart && !(c === numStart + 1 && raw[numStart] === "-")) {
      out += `"${raw.slice(numStart, c)}"`;
      i = c;
    } else {
      i = numStart;
    }
  }
  return JSON.parse(out);
}

function randomWechatUin() {
  return Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0)), "utf-8").toString("base64");
}

export class WeixinApi {
  constructor({ token, baseUrl = DEFAULT_BASE_URL, appId = DEFAULT_APP_ID, botAgent = "DSH" }) {
    this.token = token;
    this.baseUrl = baseUrl || DEFAULT_BASE_URL;
    this.appId = appId;
    this.botAgent = botAgent;
  }

  headers(extra = {}) {
    const h = {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      "X-WECHAT-UIN": randomWechatUin(),
      "iLink-App-Id": this.appId,
      "iLink-App-ClientVersion": CLIENT_VERSION,
      ...extra,
    };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  baseInfo() {
    return { channel_version: CHANNEL_VERSION, bot_agent: this.botAgent };
  }

  async request(method, endpoint, body, timeoutMs) {
    const controller = new AbortController();
    const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    try {
      const res = await fetch(new URL(endpoint, this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`), {
        method,
        headers: this.headers(),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        const err = new Error(`${endpoint} HTTP ${res.status}: ${text.slice(0, 300)}`);
        err.status = res.status;
        throw err;
      }
      return text;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async getUpdates(getUpdatesBuf, { timeoutMs = 40_000, signal } = {}) {
    // AbortController merging: honour the caller's signal alongside the long-poll timeout.
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(new URL("ilink/bot/getupdates", this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ get_updates_buf: getUpdatesBuf ?? "", base_info: this.baseInfo() }),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        const err = new Error(`getUpdates HTTP ${res.status}: ${text.slice(0, 300)}`);
        err.status = res.status;
        throw err;
      }
      return parseLossless(text);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async sendText(toUserId, text, contextToken, runId) {
    const clientId = `dsh-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
    const raw = await this.request(
      "POST",
      "ilink/bot/sendmessage",
      {
        msg: {
          from_user_id: "",
          to_user_id: toUserId,
          client_id: clientId,
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
          context_token: contextToken || undefined,
          run_id: runId || undefined,
        },
        base_info: this.baseInfo(),
      },
      20_000,
    );
    const resp = parseLossless(raw);
    if (resp.ret && resp.ret !== 0) throw new Error(`sendMessage ret=${resp.ret} ${resp.errmsg ?? ""}`);
    return { clientId, messageId: resp.message_id };
  }

  async getConfig(ilinkUserId, contextToken) {
    const raw = await this.request(
      "POST",
      "ilink/bot/getconfig",
      { ilink_user_id: ilinkUserId, context_token: contextToken, base_info: this.baseInfo() },
      10_000,
    );
    return parseLossless(raw);
  }

  async sendTyping(ilinkUserId, typingTicket, status = 1) {
    await this.request(
      "POST",
      "ilink/bot/sendtyping",
      { ilink_user_id: ilinkUserId, typing_ticket: typingTicket, status, base_info: this.baseInfo() },
      10_000,
    );
  }

  async notifyStart() {
    return this.request("POST", "ilink/bot/msg/notifystart", { base_info: this.baseInfo() }, 10_000);
  }

  async notifyStop() {
    return this.request("POST", "ilink/bot/msg/notifystop", { base_info: this.baseInfo() }, 10_000);
  }
}

/** Extract the readable text of one inbound WeixinMessage, or "" when it carries none. */
export function extractText(msg) {
  const items = Array.isArray(msg?.item_list) ? msg.item_list : [];
  const parts = [];
  for (const item of items) {
    if (item?.type === MessageItemType.TEXT && typeof item.text_item?.text === "string") {
      parts.push(item.text_item.text);
    } else if (item?.type === MessageItemType.VOICE && typeof item.voice_item?.text === "string") {
      parts.push(item.voice_item.text);
    } else if (item?.type === MessageItemType.IMAGE) {
      parts.push("[图片]");
    } else if (item?.type === MessageItemType.FILE) {
      parts.push(`[文件 ${item.file_item?.file_name ?? ""}]`);
    } else if (item?.type === MessageItemType.VIDEO) {
      parts.push("[视频]");
    }
  }
  return parts.join("\n").trim();
}
