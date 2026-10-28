/** Durable state for the WeChat channel: login credentials and conversation→session map. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function stateDir() {
  const dir = path.join(os.homedir(), ".dsh", "weixin");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf-8");
  fs.renameSync(tmp, file);
}

export const credsPath = () => path.join(stateDir(), "credentials.json");
export const mapPath = () => path.join(stateDir(), "sessions.json");

export function loadCreds() {
  const c = readJson(credsPath(), null);
  if (!c || typeof c.token !== "string" || !c.token) return null;
  return c;
}

export function saveCreds(creds) {
  writeJson(credsPath(), { ...creds, savedAt: new Date().toISOString() });
}

export function loadSessionMap() {
  const m = readJson(mapPath(), {});
  return m && typeof m === "object" ? m : {};
}

export function saveSessionMap(map) {
  writeJson(mapPath(), map);
}

/** Last observed channel state, for diagnosing a silent plugin from outside the app. */
export function writeStatus(status) {
  try {
    writeJson(path.join(stateDir(), "status.json"), { ...status, at: new Date().toISOString() });
  } catch {
    /* status reporting must never break the channel */
  }
}

/** Append one line to the channel's own log file (the host console is not readable here). */
export function appendLog(level, message) {
  try {
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}\n`;
    fs.appendFileSync(path.join(stateDir(), "channel.log"), line, "utf-8");
  } catch {
    /* best effort */
  }
}
