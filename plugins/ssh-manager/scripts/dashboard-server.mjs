import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getVaultHome, readVault } from "../mcp/lib/vault.mjs";
import {
  getDashboardStatus,
  primeOperations,
  recordOperation,
  startDashboard,
  stopDashboard,
} from "../mcp/lib/dashboard.mjs";
import { createTerminalController } from "../mcp/lib/terminal.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const vaultHome = getVaultHome();
const runtimeFile = path.join(vaultHome, "dashboard.json");
const vaultFile = path.join(vaultHome, "vault.json");

function operationKey(entry) {
  return entry.id || `${entry.timestamp}\u0000${entry.alias}\u0000${entry.action}\u0000${entry.summary}`;
}

function loadAudit() {
  try {
    return Array.isArray(readVault().audit) ? readVault().audit : [];
  } catch {
    return [];
  }
}

const seen = new Set();
function pollAudit() {
  for (const entry of loadAudit()) {
    const key = operationKey(entry);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    recordOperation(entry);
  }
}

function readRuntimeInfo() {
  try {
    return fs.existsSync(runtimeFile) ? JSON.parse(fs.readFileSync(runtimeFile, "utf8")) : null;
  } catch {
    return null;
  }
}

async function existingDashboard() {
  try {
    if (!fs.existsSync(runtimeFile)) {
      return null;
    }
    const info = JSON.parse(fs.readFileSync(runtimeFile, "utf8"));
    if (!info?.url || !info?.token) {
      return null;
    }
    const healthUrl = new URL("/health", info.url);
    healthUrl.searchParams.set("token", info.token);
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1500) });
    return response.ok ? info : null;
  } catch {
    return null;
  }
}

const previousRuntime = readRuntimeInfo();
const existing = await existingDashboard();
if (existing) {
  process.stdout.write(`${JSON.stringify({ reused: true, ...existing })}\n`);
  process.exit(0);
}

fs.mkdirSync(vaultHome, { recursive: true });
const initialAudit = loadAudit();
for (const entry of initialAudit) {
  seen.add(operationKey(entry));
}
primeOperations(initialAudit);
const terminalController = createTerminalController();
const status = await startDashboard({
  token: previousRuntime?.token,
  port: Number.isInteger(previousRuntime?.port) ? previousRuntime.port : 8765,
  terminalController,
});
const token = new URL(status.url).searchParams.get("token");
const runtime = {
  ...status,
  token,
  pid: process.pid,
  startedAt: new Date().toISOString(),
};
fs.writeFileSync(runtimeFile, JSON.stringify(runtime, null, 2), { mode: 0o600 });
process.stdout.write(`${JSON.stringify(runtime)}\n`);

fs.watchFile(vaultFile, { interval: 1000 }, pollAudit);
const fallbackTimer = setInterval(pollAudit, 30_000);
fallbackTimer.unref();

async function shutdown() {
  clearInterval(fallbackTimer);
  fs.unwatchFile(vaultFile, pollAudit);
  try {
    await stopDashboard();
  } catch {
    // 退出时忽略面板关闭异常。
  }
  try {
    fs.rmSync(runtimeFile, { force: true });
  } catch {
    // 忽略清理异常。
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);