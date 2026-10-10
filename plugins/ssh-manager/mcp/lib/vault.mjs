import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const VAULT_VERSION = 1;
const AAD = Buffer.from("codex-ssh-manager-vault-v1", "utf8");
const KEY_BYTES = 32;

export function getVaultHome() {
  const configured = process.env.SSH_MANAGER_HOME?.trim();
  if (configured) {
    return path.resolve(expandHome(configured));
  }
  return path.join(os.homedir(), ".codex", "ssh-manager");
}

export function expandHome(value) {
  if (typeof value !== "string") {
    return value;
  }
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith(`~${path.sep}`) || value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

export function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(directory, 0o700);
    } catch {
      // Best effort on filesystems that do not expose POSIX modes.
    }
  }
}

function atomicWrite(filePath, contents, mode = 0o600) {
  ensurePrivateDirectory(path.dirname(filePath));
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, contents, { mode });
  try {
    if (process.platform !== "win32") {
      fs.chmodSync(temporary, mode);
    }
  } catch {
    // Best effort.
  }
  fs.renameSync(temporary, filePath);
}

function runPowerShell(script, input) {
  const executable = process.env.SSH_MANAGER_POWERSHELL || "powershell.exe";
  const result = spawnSync(
    executable,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      input: `${input}\n`,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 30_000,
    },
  );

  if (result.error) {
    throw new Error(`Windows DPAPI 回退失败：${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`Windows DPAPI 执行失败，退出代码 ${result.status}：${detail}`);
  }
  const output = (result.stdout || "").trim();
  if (!output) {
    throw new Error("Windows DPAPI 返回了空结果。");
  }
  return output;
}

function protectWithDpapi(buffer) {
  const script = [
    "Add-Type -AssemblyName System.Security",
    "$inputText=[Console]::In.ReadToEnd().Trim()",
    "$bytes=[Convert]::FromBase64String($inputText)",
    "$protected=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Console]::Out.Write([Convert]::ToBase64String($protected))",
  ].join("; ");
  return runPowerShell(script, buffer.toString("base64"));
}

function unprotectWithDpapi(value) {
  const script = [
    "Add-Type -AssemblyName System.Security",
    "$inputText=[Console]::In.ReadToEnd().Trim()",
    "$bytes=[Convert]::FromBase64String($inputText)",
    "$plain=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Console]::Out.Write([Convert]::ToBase64String($plain))",
  ].join("; ");
  return Buffer.from(runPowerShell(script, value), "base64");
}

function keyPath() {
  return path.join(getVaultHome(), "vault.key");
}

function restrictWindowsAcl(filePath) {
  if (process.platform !== "win32") {
    return;
  }
  let account = "";
  try {
    const identity = spawnSync("whoami", [], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    account = (identity.stdout || "").trim();
  } catch {
    account = "";
  }
  if (!account) {
    return;
  }
  try {
    spawnSync("icacls", [filePath, "/inheritance:r", "/grant:r", `${account}:F`], {
      windowsHide: true,
      stdio: "ignore",
      timeout: 15_000,
    });
  } catch {
    // File permissions are a best effort when ACL tooling is unavailable.
  }
}

function decodePlainKey(stored) {
  const key = Buffer.from(stored.slice("plain:".length), "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error("密钥长度无效。");
  }
  return key;
}

function loadOrCreateMasterKey() {
  const file = keyPath();
  if (fs.existsSync(file)) {
    const stored = fs.readFileSync(file, "utf8").trim();
    if (stored.startsWith("dpapi:")) {
      if (process.platform !== "win32") {
        throw new Error("密钥由 Windows DPAPI 保护，但当前系统不是 Windows。");
      }
      const key = unprotectWithDpapi(stored.slice("dpapi:".length));
      if (key.length !== KEY_BYTES) {
        throw new Error("解密后的密钥长度无效。");
      }
      return key;
    }

    if (stored.startsWith("plain:")) {
      return decodePlainKey(stored);
    }
  }

  const key = crypto.randomBytes(KEY_BYTES);
  let stored;
  if (process.platform === "win32") {
    try {
      stored = `dpapi:${protectWithDpapi(key)}`;
    } catch {
      // Some restricted or non-interactive Windows sessions cannot use DPAPI. Keep
      // the AES key in a user-only file instead of blocking the plugin entirely.
      stored = `plain:${key.toString("base64")}`;
    }
  } else {
    stored = `plain:${key.toString("base64")}`;
  }
  atomicWrite(file, stored, 0o600);
  restrictWindowsAcl(file);
  return key;
}

export function getKeyProtection() {
  const file = keyPath();
  if (!fs.existsSync(file)) {
    return "尚未创建";
  }
  const stored = fs.readFileSync(file, "utf8").trim();
  if (stored.startsWith("dpapi:")) {
    return "Windows DPAPI（当前用户）";
  }
  if (process.platform === "win32") {
    return "Windows 文件 ACL 回退（当前会话无法使用 DPAPI）";
  }
  return "AES-256-GCM，密钥文件权限 0600";
}

function encryptPayload(payload, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payload), "utf8")),
    cipher.final(),
  ]);
  return {
    version: VAULT_VERSION,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decryptPayload(envelope, key) {
  if (envelope?.version !== VAULT_VERSION || envelope?.algorithm !== "aes-256-gcm") {
    throw new Error("不支持的 SSH 管理仓库格式。");
  }
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(envelope.iv, "base64"),
  );
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8"));
}

export function createEmptyVault() {
  return {
    version: VAULT_VERSION,
    profiles: {},
    audit: [],
    // 运行期状态（例如会话免确认模式及其时间戳），需要跨 MCP 进程重启保留。
    runtime: {},
  };
}

export function readVault() {
  const file = path.join(getVaultHome(), "vault.json");
  if (!fs.existsSync(file)) {
    return createEmptyVault();
  }
  const envelope = JSON.parse(fs.readFileSync(file, "utf8"));
  const key = loadOrCreateMasterKey();
  const payload = decryptPayload(envelope, key);
  if (!payload || typeof payload !== "object") {
    throw new Error("SSH 管理仓库内容无效。");
  }
  return {
    ...createEmptyVault(),
    ...payload,
    profiles: payload.profiles && typeof payload.profiles === "object" ? payload.profiles : {},
    audit: Array.isArray(payload.audit) ? payload.audit : [],
    runtime: payload.runtime && typeof payload.runtime === "object" ? payload.runtime : {},
  };
}

export function writeVault(vault) {
  const file = path.join(getVaultHome(), "vault.json");
  const key = loadOrCreateMasterKey();
  const runtime = vault?.runtime && typeof vault.runtime === "object" ? { ...vault.runtime } : {};
  // 只允许白名单字段进入运行时状态，避免把任意内容写进仓库。
  const normalized = {
    version: VAULT_VERSION,
    profiles: vault?.profiles && typeof vault.profiles === "object" ? vault.profiles : {},
    audit: Array.isArray(vault?.audit) ? vault.audit.slice(-250) : [],
    runtime: {
      approvalMode: typeof runtime.approvalMode === "string" ? runtime.approvalMode : undefined,
      approvalModeUpdatedAt: Number.isFinite(runtime.approvalModeUpdatedAt)
        ? runtime.approvalModeUpdatedAt
        : undefined,
    },
  };
  atomicWrite(file, JSON.stringify(encryptPayload(normalized, key), null, 2), 0o600);
}

function sanitizeValue(value, depth = 0) {
  if (value === null || value === undefined) {
    return value;
  }
  if (depth > 5) {
    return "[层级过深，已省略]";
  }
  if (typeof value === "string") {
    return value
      .replace(/(password|passwd|token|secret|api[_-]?key|private[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=***")
      .slice(0, 16 * 1024);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => sanitizeValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const result = {};
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      if (/password|passphrase|privatekey/i.test(key)) {
        continue;
      }
      result[key] = sanitizeValue(item, depth + 1);
    }
    return result;
  }
  return String(value).slice(0, 1000);
}

export function appendAudit(vault, event) {
  const safeEvent = {
    id: event.id || crypto.randomUUID(),
    timestamp: event.timestamp || new Date().toISOString(),
    sessionId: event.sessionId,
    sessionName: event.sessionName,
    alias: event.alias,
    host: event.host,
    username: event.username,
    action: event.action,
    mode: event.mode,
    approved: event.approved,
    result: event.result,
    summary: typeof event.summary === "string" ? event.summary.slice(0, 1000) : undefined,
    details: sanitizeValue(event.details),
  };
  vault.audit = [...(Array.isArray(vault.audit) ? vault.audit : []), safeEvent].slice(-250);
  return safeEvent;
}

export function vaultExists() {
  return fs.existsSync(path.join(getVaultHome(), "vault.json"));
}