// WeChat channel health check.
//
//   node tools/doctor.mjs                 # 全面体检
//   node tools/doctor.mjs --send "测试"    # 给绑定微信发一条测试消息
//   node tools/doctor.mjs --listen 30     # 监听 30 秒，看微信消息能不能到达本机
//
// 只读状态文件，不写任何东西，不改凭据。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { WeixinApi } from "../lib/api.mjs";
import { loadCreds, stateDir } from "../lib/state.mjs";

const argv = process.argv.slice(2);
const flag = (name) => argv.indexOf(name);
const argOf = (name) => {
  const i = flag(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const problems = [];
const note = (msg) => console.log(`  ${msg}`);
const fail = (msg) => {
  problems.push(msg);
  console.log(`  ✗ ${msg}`);
};
const pass = (msg) => console.log(`  ✓ ${msg}`);

console.log("== 1. 凭证 ==");
const creds = loadCreds();
if (!creds) {
  fail(`没有找到可用凭证：${path.join(stateDir(), "credentials.json")}`);
} else {
  const missing = ["token", "botId", "baseUrl", "userId"].filter((k) => !creds[k]);
  if (missing.length) fail(`凭证缺字段：${missing.join(", ")}`);
  else if (!/^[^:]+@im\.(bot|wechat):[0-9a-f]{16,}$/i.test(creds.token)) fail("token 格式不符合 <botId>:<hex>");
  else {
    pass(`bot ${creds.botId}`);
    pass(`owner ${creds.userId}`);
    pass(`server ${creds.baseUrl}`);
  }
  if (creds.savedAt) note(`保存时间 ${creds.savedAt}`);
}

let api;
if (creds?.token) {
  api = new WeixinApi({ token: creds.token, baseUrl: creds.baseUrl, botAgent: "DSH/doctor" });

  console.log("== 2. 连通性 ==");
  try {
    await api.notifyStart();
    pass("notifyStart 成功，服务端认得这个 token");
  } catch (err) {
    const status = err?.status;
    if (status === 401 || status === 403) fail(`token 被拒绝（HTTP ${status}），需要重新扫码登录`);
    else fail(`notifyStart 失败：${String(err)}`);
  }

  console.log("== 3. 打字指示器 ==");
  try {
    const cfg = await api.getConfig(creds.userId);
    if (cfg?.typing_ticket) pass(`typing_ticket 可用 (${String(cfg.typing_ticket).slice(0, 8)}…)`);
    else fail("没有拿到 typing_ticket，微信端不会显示「正在输入」");
  } catch (err) {
    fail(`getConfig 失败：${String(err)}`);
  }
}

console.log("== 4. 插件轮询健康度 ==");
const statusPath = path.join(stateDir(), "status.json");
if (!fs.existsSync(statusPath)) {
  fail(`没有 status.json —— 插件可能还没启动过（${statusPath}）`);
} else {
  try {
    const st = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
    const ageMs = Date.now() - Date.parse(st.at);
    note(`state=${st.state} polls=${st.polls} messages=${st.messages}`);
    if (st.state === "connected" && ageMs < 120_000) pass(`轮询活跃（${Math.round(ageMs / 1000)} 秒前更新）`);
    else fail(`轮询可能已停止（${Math.round(ageMs / 1000)} 秒未更新，state=${st.state}）`);
    if (st.lastError) note(`最近错误 ${st.lastError}`);
  } catch (err) {
    fail(`status.json 读不了：${String(err)}`);
  }
}

console.log("== 5. 插件日志（最后 15 行）==");
const logPath = path.join(stateDir(), "channel.log");
if (!fs.existsSync(logPath)) note("还没有 channel.log");
else {
  const lines = fs.readFileSync(logPath, "utf-8").trimEnd().split(/\r?\n/);
  for (const line of lines.slice(-15)) note(line);
}

const sendText = argOf("--send");
if (sendText && api && creds) {
  console.log("== 6. 发测试消息 ==");
  try {
    const res = await api.sendText(creds.userId, sendText);
    pass(`已发送，server message id = ${res.messageId ?? "(none)"}`);
  } catch (err) {
    fail(`发送失败：${String(err)}`);
  }
}

const listenIndex = flag("--listen");
if (listenIndex >= 0) {
  const seconds = Number(argOf("--listen") ?? 30) || 30;
  console.log(`== 7. 监听 ${seconds} 秒 ==`);
  if (!api) fail("没有凭据，无法监听");
  else {
    const deadline = Date.now() + seconds * 1000;
    let buffer = "";
    let received = 0;
    while (Date.now() < deadline) {
      let resp;
      try {
        resp = await api.getUpdates(buffer, { timeoutMs: Math.min(40_000, deadline - Date.now()) });
      } catch (err) {
        if (err.name === "AbortError") continue;
        fail(`getUpdates 失败：${String(err)}`);
        break;
      }
      if (typeof resp?.get_updates_buf === "string") buffer = resp.get_updates_buf;
      for (const msg of resp?.msgs ?? []) {
        received += 1;
        const text = (msg.item_list ?? [])
          .map((it) => it?.text_item?.text)
          .filter(Boolean)
          .join(" ");
        note(`type=${msg.message_type} from=${msg.from_user_id} text=${JSON.stringify(text)}`);
      }
    }
    if (received === 0) fail("这段时间里没有收到任何消息（微信里发一句再跑一次）");
    else pass(`收到 ${received} 条消息，入站链路正常`);
  }
}

console.log();
if (problems.length === 0) {
  console.log("结论: 正常");
  process.exit(0);
}
console.log(`结论: 有问题: ${problems.join("；")}`);
process.exit(1);
