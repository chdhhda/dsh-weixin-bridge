// 微信扫码登录工具。
//
//   node tools/login.mjs          # 扫码登录（会覆盖现有凭证）
//   node tools/login.mjs --status # 看当前绑定的 bot
//
// 登录成功后凭证写到 ~/.dsh/weixin/credentials.json，插件启动时读取。
import path from "node:path";

import { runQrLogin } from "../lib/login.mjs";
import { credsPath, loadCreds, stateDir } from "../lib/state.mjs";

// 二维码属于登录凭证，写在状态目录里，不落进仓库。
const PNG = path.join(stateDir(), "qr.png");

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);

if (process.argv.includes("--status")) {
  const creds = loadCreds();
  if (!creds) {
    console.log("未登录。运行 `node tools/login.mjs` 扫码。");
    console.log(`状态文件: ${credsPath()}`);
    process.exit(1);
  }
  console.log(`bot:    ${creds.botId}`);
  console.log(`owner:  ${creds.userId}`);
  console.log(`server: ${creds.baseUrl}`);
  console.log(`saved:  ${creds.savedAt}`);
  process.exit(0);
}

// qrcode 是可选依赖：没有它就只打印链接，不阻塞登录流程。
let QRCode = null;
try {
  QRCode = (await import("qrcode")).default;
} catch {
  /* 可选依赖缺失时降级 */
}

async function show({ qrcodeUrl }) {
  if (QRCode) {
    await QRCode.toFile(PNG, qrcodeUrl, { width: 520, margin: 1 });
    log("二维码已写入:", PNG);
    log("（打开图片，用手机微信「扫一扫」）");
  } else {
    log("没装 qrcode，无法生成图片。在插件目录执行 `npm i qrcode` 后重试。");
  }
  log("链接:", qrcodeUrl);
}

const result = await runQrLogin({
  onQr: show,
  onStatus: (status) => {
    const label = {
      wait: "等待扫码",
      scaned: "已扫码，请在手机上确认",
      need_verifycode: "手机要求数字验证码（本终端无法输入，请重跑）",
      expired: "二维码过期，正在刷新",
      verify_code_blocked: "验证码错误次数过多",
      binded_redirect: "这个微信已经绑定过本机",
      confirmed: "已确认",
    }[status];
    log("状态:", status, label ? `— ${label}` : "");
  },
});

if (result.ok) {
  log("登录成功，凭证已写入", credsPath());
  log("bot:", result.creds.botId, "owner:", result.creds.userId);
  log("下一步：在 DSH 里重载 @local/dsh-weixin（或重启应用）。");
  process.exit(0);
}
log("登录失败:", result.message ?? "unknown");
process.exit(1);
