/**
 * DSH WeChat channel.
 *
 * Bridges a WeChat bot conversation (official iLink/ClawBot backend) to a real
 * DSH Agent session: inbound text becomes a user turn, the assistant's final
 * answer is sent back. Each WeChat conversation keeps its own DSH session, so
 * context persists across messages and restarts.
 */
import crypto from "node:crypto";

import { MessageType, WeixinApi, extractText } from "./lib/api.mjs";
import { appendLog, loadCreds, loadSessionMap, saveSessionMap, writeStatus } from "./lib/state.mjs";

export const name = "weixin";

/** Only the Agent registry is mandatory; everything else is looked up with ctx.get(). */
export const inject = ["agents"];

/**
 * Defaults for the row config in cordis.patch.yml. No schemastery schema is
 * exported on purpose: a plain object here would be called as a validator and
 * throw, so the config is normalised in `apply` instead.
 */
const CONFIG_DEFAULTS = {
  cwd: "",
  allowUsers: [],
  botAgent: "DSH",
  maxChars: 1800,
  turnTimeoutMs: 15 * 60_000,
};

const MAX_SEEN = 500;

export function chunkText(text, max) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= max) return [trimmed];
  const chunks = [];
  let rest = trimmed;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max * 0.4) cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.4) cut = max;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks.filter(Boolean);
}

/**
 * Rewrite markdown tables as plain lines. WeChat renders no markdown, so a
 * table arrives as a wall of pipes; a key/value pair per line survives.
 */
export function convertTables(text) {
  const isRow = (line) => /^\s*\|.*\|\s*$/.test(line);
  const isDivider = (line) => /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes("-");
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!isRow(lines[i])) {
      out.push(lines[i]);
      continue;
    }
    const block = [];
    let j = i;
    while (j < lines.length && isRow(lines[j])) {
      block.push(lines[j]);
      j += 1;
    }
    i = j - 1;
    const rows = block
      .filter((line) => !isDivider(line))
      .map((line) =>
        line
          .trim()
          .replace(/^\|/, "")
          .replace(/\|$/, "")
          .split("|")
          .map((cell) => cell.trim()),
      )
      .filter((cells) => cells.some((cell) => cell !== ""));
    if (rows.length === 0) {
      out.push(...block);
      continue;
    }
    const header = rows.length > 1 ? rows[0] : undefined;
    const body = header ? rows.slice(1) : rows;
    for (const cells of body) {
      const kept = cells.filter((cell) => cell !== "");
      if (kept.length === 0) continue;
      if (kept.length === 1) out.push(kept[0]);
      else if (kept.length === 2) out.push(`${kept[0]}: ${kept[1]}`);
      else out.push(kept.join(" · "));
    }
    if (header && body.length === 0) out.push(header.filter(Boolean).join(" · "));
  }
  return out.join("\n");
}

/** Turn assistant markdown into something that reads well as a WeChat plain-text bubble. */
export function forWeChat(markdown) {
  return convertTables(markdown)
    .replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, (_, code) => code.trim())
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\(([^)]+)\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "· ")
    .trim();
}

/** Shared by every WeChat session: the model must write for a plain-text bubble. */
const WECHAT_STYLE = [
  "You are replying inside WeChat, where messages are plain text and Markdown is not rendered.",
  "Write short paragraphs, use \"· \" for lists, never use tables, code fences, or headings.",
  "Lead with the answer; offer detail only if it changes what the user should do.",
].join(" ");

class WeixinChannel {
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
    this.stopping = false;
    this.abort = new AbortController();
    this.api = null;
    this.creds = null;
    this.seen = new Set();
    this.queues = new Map();
    this.typingTickets = new Map();
    this.buffer = "";
    this.agents = new Map();
  }

  log(level, message) {
    const line = `[weixin] ${message}`;
    appendLog(level, line);
    const logger = this.ctx.logger;
    if (logger && typeof logger[level] === "function") logger[level](line);
  }

  resolveCwd() {
    if (this.config.cwd && this.config.cwd.trim()) return this.config.cwd.trim();
    const wd = this.ctx.get?.("workingDirectory");
    if (wd?.defaultDirectory) return wd.defaultDirectory;
    return process.cwd();
  }

  agentOptions() {
    const selection = this.ctx.get?.("agentDefaultModel")?.currentSelection?.();
    if (!selection?.provider || !selection?.model) return {};
    return { provider: selection.provider, model: selection.model };
  }

  async start() {
    this.creds = loadCreds();
    const missing = ["token", "botId", "baseUrl", "userId"].filter(
      (key) => typeof this.creds?.[key] !== "string" || !this.creds[key].trim(),
    );
    if (missing.length) {
      const message = this.creds
        ? `微信凭证不完整（缺少：${missing.join(", ")}），请重新扫码登录。`
        : "还没有登录微信。请先运行扫码登录工具，再重启 DSH。";
      this.log("error", message);
      writeStatus({ state: this.creds ? "invalid-credentials" : "no-credentials", message });
      return;
    }
    this.api = new WeixinApi({
      token: this.creds.token,
      baseUrl: this.creds.baseUrl,
      botAgent: this.config.botAgent,
    });
    this.log("info", `已连接 ${this.creds.botId ?? "(unknown bot)"}`);
    this.stats = { polls: 0, messages: 0 };
    this.pushStatus("connected");
    try {
      await this.api.notifyStart();
    } catch (err) {
      this.log("debug", `notifyStart failed: ${String(err)}`);
    }
    this.pollLoop();
  }

  pushStatus(state) {
    writeStatus({
      state,
      botId: this.creds?.botId,
      owner: this.creds?.userId,
      cwd: this.resolveCwd(),
      polls: this.stats?.polls ?? 0,
      messages: this.stats?.messages ?? 0,
      lastError: this.stats?.lastError,
    });
  }

  async stop() {
    this.stopping = true;
    this.abort.abort();
    if (this.api) {
      try {
        await this.api.notifyStop();
      } catch {
        /* best effort */
      }
    }
  }

  async pollLoop() {
    let backoff = 1000;
    while (!this.stopping) {
      let resp;
      try {
        resp = await this.api.getUpdates(this.buffer, { signal: this.abort.signal });
        backoff = 1000;
        this.stats.polls += 1;
        if (this.stats.polls % 5 === 1) this.pushStatus("connected");
      } catch (err) {
        if (this.stopping) return;
        if (err.name === "AbortError") continue; // normal long-poll timeout
        this.log("warn", `getUpdates failed: ${String(err)}`);
        this.stats.lastError = String(err);
        this.pushStatus("poll-error");
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 15_000);
        continue;
      }

      if (resp?.errcode === -14) {
        this.log("warn", "session expired (-14), resetting update cursor");
        this.buffer = "";
        continue;
      }
      if (resp?.ret && resp.ret !== 0) {
        this.log("warn", `getUpdates ret=${resp.ret} ${resp.errmsg ?? ""}`);
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      if (typeof resp?.get_updates_buf === "string" && resp.get_updates_buf !== this.buffer) {
        this.buffer = resp.get_updates_buf;
      }
      for (const msg of resp?.msgs ?? []) this.accept(msg);
    }
  }

  accept(msg) {
    if (!msg || msg.message_type === MessageType.BOT) return;
    const key = msg.message_id ? String(msg.message_id) : "";
    if (key) {
      if (this.seen.has(key)) return;
      this.seen.add(key);
      if (this.seen.size > MAX_SEEN) this.seen.delete(this.seen.values().next().value);
    }
    const from = msg.from_user_id;
    if (typeof from !== "string" || !from) return;
    const owner = this.creds?.userId;
    const allowed = new Set([owner, ...(Array.isArray(this.config.allowUsers) ? this.config.allowUsers : [])]);
    if (!owner || !allowed.has(from)) {
      this.log("info", `ignored message from unauthorized user ${from}`);
      return;
    }
    const text = extractText(msg);
    if (!text) {
      this.log("debug", `ignored non-text message from ${from}`);
      return;
    }
    this.stats.messages += 1;
    this.pushStatus("connected");
    this.log("info", `recv from=${from} chars=${text.length}`);
    this.enqueue(from, text, msg.context_token, msg.run_id);
  }

  enqueue(from, text, contextToken, runId) {
    const previous = this.queues.get(from) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => this.handle(from, text, contextToken, runId))
      .catch((err) => this.log("error", `turn failed for ${from}: ${String(err)}`))
      .finally(() => {
        if (this.queues.get(from) === next) this.queues.delete(from);
      });
    this.queues.set(from, next);
  }

  /**
   * Compose the Agent the same way the GUI does: resolve an Agent preset and
   * mount it onto the new Agent's context, which is what supplies tools, the
   * system prompt, and every other preset-scoped plugin.
   */
  async composition(presetId) {
    const presets = this.ctx.get?.("agentPresets");
    if (!presets) return {};
    const resolvedId = (await presets.resolve(presetId)).id;
    return {
      agentPreset: resolvedId,
      setup: async (agentCtx) => {
        await presets.mount(agentCtx, resolvedId);
        try {
          agentCtx.systemPrompt?.context?.({ name: "weixin:style", text: WECHAT_STYLE });
        } catch {
          /* style guidance is best effort; never block the session on it */
        }
      },
    };
  }

  async ensureAgent(conversationKey) {
    const live = this.agents.get(conversationKey);
    if (live && this.ctx.agents.get(live.id)) return live;

    const map = loadSessionMap();
    const entry = map[conversationKey];
    const wantedCwd = this.resolveCwd();
    const mappedCwd = typeof entry === "string" ? undefined : entry?.cwd;
    const moved = Boolean(entry) && mappedCwd !== wantedCwd;
    if (moved) {
      this.log("info", `工作目录从 ${mappedCwd} 换到 ${wantedCwd}，为这个会话新建 DSH 会话`);
    }
    const known = moved ? undefined : typeof entry === "string" ? entry : entry?.sessionId;
    const agentOptions = this.agentOptions();

    if (known && this.ctx.agents.get(known)) return this.ctx.agents.get(known);
    if (known) {
      try {
        const composition = await this.composition(entry?.preset);
        const handle = await this.ctx.agents.resume({
          resumeSessionId: known,
          agentOptions,
          ...(composition.setup ? { setup: composition.setup } : {}),
        });
        this.prepare(handle.agent);
        this.agents.set(conversationKey, handle.agent);
        this.log("info", `resumed session ${known} for ${conversationKey}`);
        return handle.agent;
      } catch (err) {
        this.log("warn", `resume of ${known} failed (${String(err)}), starting a new session`);
      }
    }

    const composition = await this.composition(undefined);
    const sessionId = `wx-${crypto.randomUUID()}`;
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: {
        cwd: this.resolveCwd(),
        ...(composition.agentPreset ? { agentPreset: composition.agentPreset } : {}),
      },
      agentOptions,
      ...(composition.setup ? { setup: composition.setup } : {}),
    });
    this.prepare(handle.agent);
    this.agents.set(conversationKey, handle.agent);
    map[conversationKey] = { sessionId, preset: composition.agentPreset, cwd: wantedCwd };
    saveSessionMap(map);
    this.log("info", `created session ${sessionId} for ${conversationKey}`);
    return handle.agent;
  }

  prepare(agent) {
    // No human is present on the WeChat side to answer approval prompts, and a
    // silent fail-closed prompt would hang the turn forever.
    try {
      this.ctx.get?.("approval")?.setPolicy(agent, "never");
    } catch (err) {
      this.log("debug", `approval policy: ${String(err)}`);
    }
  }

  /** Wait until the agent and any subagent it started are genuinely idle. */
  async settle(agent) {
    const subagents = this.ctx.get?.("subagents");
    for (;;) {
      await agent.whenIdle();
      const idleSeq = agent.session.seq;
      const childrenBusy = (await subagents?.waitForChildren(agent)) === true;
      if (!childrenBusy && agent.status === "idle" && agent.session.seq === idleSeq) return;
      if (this.stopping) return;
    }
  }

  summarize(session, firstSeq) {
    let started = false;
    let text = "";
    let reason;
    const length = session.seq;
    for (let seq = firstSeq; seq < length; seq += 1) {
      const event = session.eventAt(seq);
      if (!event) break;
      if (event.type === "turn/start") {
        started = true;
        continue;
      }
      if (!started) continue;
      if (event.type === "assistant/message") {
        const joined = (event.data?.message?.content ?? [])
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("");
        if (joined) text = joined;
      }
      if (event.type === "turn/end") reason = event.data?.reason;
    }
    return { text, reason };
  }

  async withTyping(userId, contextToken, run) {
    let ticket = this.typingTickets.get(userId);
    if (!ticket) {
      try {
        const cfg = await this.api.getConfig(userId, contextToken);
        if (cfg?.typing_ticket) {
          ticket = cfg.typing_ticket;
          this.typingTickets.set(userId, ticket);
        }
      } catch {
        /* typing is cosmetic */
      }
    }
    if (!ticket) return run();
    try {
      await this.api.sendTyping(userId, ticket, 1);
    } catch {
      /* ignore */
    }
    try {
      return await run();
    } finally {
      try {
        await this.api.sendTyping(userId, ticket, 2);
      } catch {
        /* ignore */
      }
    }
  }

  async handle(from, text, contextToken, runId) {
    if (this.stopping) return;
    const started = Date.now();
    await this.withTyping(from, contextToken, async () => {
      let agent;
      try {
        agent = await this.ensureAgent(from);
      } catch (err) {
        this.log("error", `cannot start agent: ${String(err)}`);
        await this.reply(from, `启动会话失败：${String(err)}`, contextToken, runId);
        return;
      }

      const firstSeq = agent.session.seq;
      const timeout = setTimeout(() => {
        try {
          agent.cancel({ kind: "hook", reason: "wechat turn timeout" });
        } catch {
          /* ignore */
        }
      }, this.config.turnTimeoutMs);
      // A first turn has to assemble the prompt and every tool schema before the
      // model is called; WeChat shows nothing meanwhile, so acknowledge once.
      const ack = setTimeout(() => {
        this.reply(from, "收到，正在处理……", contextToken, runId).catch(() => {});
      }, 8000);

      try {
        agent.followup({
          id: crypto.randomUUID(),
          role: "user",
          content: [{ type: "text", text }],
          source: { kind: "user" },
        });
        await this.settle(agent);
      } catch (err) {
        this.log("error", `turn error: ${String(err)}`);
      } finally {
        clearTimeout(timeout);
        clearTimeout(ack);
      }

      try {
        await this.ctx.get?.("sessions")?.flush?.(agent.session);
      } catch {
        /* persistence is best effort here */
      }

      const { text: answer, reason } = this.summarize(agent.session, firstSeq);
      const body =
        answer ||
        (reason?.kind === "error"
          ? `（模型调用失败：${reason.error?.message ?? "unknown"}）`
          : "（这一轮没有产生文字回复）");
      this.log("info", `turn done in ${Date.now() - started}ms, ${body.length} chars`);
      await this.reply(from, body, contextToken, runId);
    });
  }

  async reply(to, text, contextToken, runId) {
    const body = forWeChat(text);
    for (const part of chunkText(body, this.config.maxChars)) {
      try {
        await this.api.sendText(to, part, contextToken, runId);
      } catch (err) {
        this.log("error", `send failed: ${String(err)}`);
        return;
      }
    }
  }
}

export function apply(ctx, config) {
  const resolved = { ...CONFIG_DEFAULTS, ...(config ?? {}) };
  const channel = new WeixinChannel(ctx, resolved);

  ctx.effect(() => {
    channel
      .start()
      .catch((err) => {
        channel.log("error", `start failed: ${String(err)}`);
        writeStatus({ state: "error", message: String(err) });
      });
    return () => channel.stop().catch(() => {});
  });
}
