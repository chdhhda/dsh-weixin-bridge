/**
 * QR login for the WeChat bot backend.
 *
 * Flow: request a bot QR code, long-poll its status, and on `confirmed` persist
 * the issued bot token. This is the same handshake the reference OpenClaw
 * channel performs; nothing here is OpenClaw-specific.
 */
import { CLIENT_VERSION, DEFAULT_APP_ID, DEFAULT_BASE_URL } from "./api.mjs";
import { saveCreds } from "./state.mjs";

const QR_LONG_POLL_MS = 35_000;
const QR_TTL_MS = 5 * 60_000;

function headers() {
  return {
    "Content-Type": "application/json",
    "iLink-App-Id": DEFAULT_APP_ID,
    "iLink-App-ClientVersion": CLIENT_VERSION,
  };
}

async function call(method, endpoint, body, timeoutMs) {
  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  try {
    const res = await fetch(new URL(endpoint, `${DEFAULT_BASE_URL}/`), {
      method,
      headers: headers(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${endpoint} HTTP ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function requestQrCode(botType = "3") {
  return call("POST", `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`, {
    local_token_list: [],
  });
}

async function pollStatus(qrcode, verifyCode) {
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
  try {
    return await call("GET", endpoint, undefined, QR_LONG_POLL_MS);
  } catch (err) {
    if (err.name === "AbortError") return { status: "wait" };
    return { status: "wait", _error: String(err) };
  }
}

/**
 * Drive one QR login to completion.
 *
 * @param options.onQr - called with each fresh QR payload `{ qrcodeUrl, qrcode }`
 *   so the caller can render or print it.
 * @param options.onStatus - called on every status transition.
 * @param options.onVerifyCode - called when WeChat asks for the on-screen digit
 *   code; returns the code to submit.
 * @param options.signal - abort the whole flow.
 * @param options.timeoutMs - overall deadline.
 * @returns the persisted credential record, or a failure description.
 */
export async function runQrLogin({
  onQr,
  onStatus = () => {},
  onVerifyCode,
  signal,
  timeoutMs = 8 * 60_000,
  botType = "3",
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let qr = await requestQrCode(botType);
  if (!qr?.qrcode || !qr?.qrcode_img_content) {
    throw new Error("微信没有返回二维码，请稍后重试");
  }
  let qrcode = qr.qrcode;
  await onQr?.({ qrcode, qrcodeUrl: qr.qrcode_img_content });

  let pendingVerifyCode;
  let lastStatus = "";
  let refreshCount = 0;

  while (Date.now() < deadline) {
    if (signal?.aborted) return { ok: false, message: "已取消" };
    const status = await pollStatus(qrcode, pendingVerifyCode);
    const kind = status.status ?? "wait";

    if (kind !== lastStatus) {
      onStatus(kind);
      lastStatus = kind;
    }

    switch (kind) {
      case "wait":
        break;
      case "scaned":
        pendingVerifyCode = undefined;
        break;
      case "need_verifycode": {
        const code = onVerifyCode ? await onVerifyCode() : "";
        if (!code) return { ok: false, message: "登录需要手机上的数字验证码，但没有可用的输入通道" };
        pendingVerifyCode = code;
        continue;
      }
      case "scaned_but_redirect":
        // The server may move the account to another IDC; the poll endpoint stays
        // the same host for status, so nothing to do here.
        break;
      case "expired": {
        refreshCount += 1;
        if (refreshCount > 3) return { ok: false, message: "二维码多次失效，请稍后再试" };
        qr = await requestQrCode(botType);
        qrcode = qr.qrcode;
        lastStatus = "";
        await onQr?.({ qrcode, qrcodeUrl: qr.qrcode_img_content });
        break;
      }
      case "verify_code_blocked": {
        refreshCount += 1;
        if (refreshCount > 3) return { ok: false, message: "验证码多次错误，请稍后再试" };
        pendingVerifyCode = undefined;
        qr = await requestQrCode(botType);
        qrcode = qr.qrcode;
        lastStatus = "";
        await onQr?.({ qrcode, qrcodeUrl: qr.qrcode_img_content });
        break;
      }
      case "binded_redirect": {
        return { ok: false, alreadyBound: true, message: "这个微信已经绑定过本机，无需重复扫码" };
      }
      case "confirmed": {
        if (!status.ilink_bot_id) return { ok: false, message: "登录失败：服务器没有返回 bot id" };
        const creds = {
          token: status.bot_token,
          botId: status.ilink_bot_id,
          baseUrl: status.baseurl || DEFAULT_BASE_URL,
          userId: status.ilink_user_id,
        };
        saveCreds(creds);
        return { ok: true, creds };
      }
      default:
        break;
    }

    await new Promise((r) => setTimeout(r, 1000));
  }
  return { ok: false, message: "登录超时，请重试" };
}
