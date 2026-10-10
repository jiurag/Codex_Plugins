// SSH 管理插件的日志系统。
//
// 目标：出问题时能直接看到"谁在什么时候、对哪台服务器、做了什么、结果如何、原始输出是什么"，
// 而不是只有一个"失败"。日志写到 <vaultHome>/logs/，与凭据仓库同目录树。
//
// 约定：
//  - JSONL 格式（每行一个 JSON 对象），既能人工阅读，也能被工具解析过滤；
//  - 写日志前统一脱敏（密码、私钥口令、token 等绝不落盘）；
//  - 单文件超过 MAX_FILE_BYTES 自动滚动，保留最近 KEEP_DAYS 天；
//  - 任何写日志失败都不能影响主流程。

import fs from "node:fs";
import path from "node:path";
import { getVaultHome, ensurePrivateDirectory } from "./vault.mjs";

const LOG_DIR_NAME = "logs";
const LOG_FILE_PREFIX = "ssh-manager";
const MAX_FILE_BYTES = 5 * 1024 * 1024;
// 全部日志文件的总大小上限，超出后从最旧的开始删。
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const KEEP_DAYS = 7;
// 写盘时的单字段上限（比读取默认值大，便于 full: true 回溯）。
const MAX_FIELD_CHARS = 16000;
// 读取时 stdout/stderr 默认截断长度。
const READ_FIELD_CHARS = 2000;
const SECRET_KEY_PATTERN = /pass(word|phrase)?|secret|token|credential|privatekey|api[-_]?key/i;

export function getLogDirectory() {
  return path.join(getVaultHome(), LOG_DIR_NAME);
}

// 递归脱敏：键名命中敏感词就整体替换，字符串超长则截断。
export function redactSecrets(value, depth = 0) {
  if (depth > 6) {
    return "[深度截断]";
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = SECRET_KEY_PATTERN.test(key) ? "[已脱敏]" : redactSecrets(item, depth + 1);
    }
    return output;
  }
  if (typeof value === "string" && value.length > MAX_FIELD_CHARS) {
    return value.slice(0, MAX_FIELD_CHARS) + "…（已截断）";
  }
  return value;
}

function logFileName(date = new Date()) {
  return `${LOG_FILE_PREFIX}-${date.toISOString().slice(0, 10)}.log`;
}

export function getCurrentLogFile() {
  return path.join(getLogDirectory(), logFileName());
}

function cleanupOldLogs(directory) {
  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  let entries = [];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  const survivors = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(LOG_FILE_PREFIX)) {
      continue;
    }
    const full = path.join(directory, entry.name);
    try {
      const stat = fs.statSync(full);
      if (stat.mtimeMs < cutoff) {
        fs.rmSync(full, { force: true });
        continue;
      }
      survivors.push({ full, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch {
      // 清理失败可以忽略。
    }
  }
  // 总量仍超限时，从最旧的开始继续删。
  let total = survivors.reduce((sum, item) => sum + item.size, 0);
  survivors.sort((left, right) => left.mtimeMs - right.mtimeMs);
  for (const item of survivors) {
    if (total <= MAX_TOTAL_BYTES) {
      break;
    }
    try {
      fs.rmSync(item.full, { force: true });
      total -= item.size;
    } catch {
      // 忽略
    }
  }
}

// 支持 ISO 时间戳或相对时间（如 30m / 2h / 1d）。
function parseSince(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const text = String(value).trim();
  const relative = /^(\d+)\s*(m|h|d)$/i.exec(text);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const factor = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
    return Date.now() - amount * factor;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

// 追加一条日志。失败时静默忽略——日志不能把主流程带崩。
export function appendLog(entry) {
  try {
    const directory = getLogDirectory();
    ensurePrivateDirectory(directory);
    const file = getCurrentLogFile();
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_FILE_BYTES) {
      fs.renameSync(file, file.replace(/\.log$/, `.${Date.now()}.log`));
    }
    const line = JSON.stringify({ ts: new Date().toISOString(), ...redactSecrets(entry) }) + "\n";
    fs.appendFileSync(file, line, { encoding: "utf8", mode: 0o600 });
    cleanupOldLogs(directory);
  } catch {
    // 忽略
  }
}

export function listLogFiles() {
  const directory = getLogDirectory();
  let entries = [];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.startsWith(LOG_FILE_PREFIX))
    .map((entry) => {
      const full = path.join(directory, entry.name);
      let bytes = 0;
      let modified = null;
      try {
        const stat = fs.statSync(full);
        bytes = stat.size;
        modified = stat.mtime.toISOString();
      } catch {
        // 忽略
      }
      return { name: entry.name, bytes, modified };
    })
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

export function getLogStatus() {
  const files = listLogFiles();
  return {
    directory: getLogDirectory(),
    currentFile: getCurrentLogFile(),
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + (file.bytes || 0), 0),
    keepDays: KEEP_DAYS,
    maxFileBytes: MAX_FILE_BYTES,
    files,
  };
}

// 读取最近的日志条目：先按文件从新到旧，再倒序取需要的条数。
export function readRecentLogs({ limit = 50, onlyErrors = false, tool = null, since = null, full = false } = {}) {
  const safeLimit = Math.min(Math.max(Number.parseInt(String(limit ?? 50), 10) || 50, 1), 500);
  const sinceMs = parseSince(since);
  const files = listLogFiles().reverse();
  const collected = [];
  for (const file of files) {
    if (collected.length >= safeLimit) {
      break;
    }
    let content = "";
    try {
      content = fs.readFileSync(path.join(getLogDirectory(), file.name), "utf8");
    } catch {
      continue;
    }
    const lines = content.split("\n").filter((line) => line.trim());
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      let parsed = null;
      try {
        parsed = JSON.parse(lines[index]);
      } catch {
        continue;
      }
      if (onlyErrors && parsed.ok !== false) {
        continue;
      }
      if (tool && parsed.name !== tool) {
        continue;
      }
      if (sinceMs !== null) {
        const stamp = Date.parse(parsed.ts || "");
        if (!Number.isFinite(stamp) || stamp < sinceMs) {
          continue;
        }
      }
      collected.push(full ? parsed : clipLogEntry(parsed));
      if (collected.length >= safeLimit) {
        break;
      }
    }
  }
  return {
    status: "正常",
    ...getLogStatus(),
    returned: collected.length,
    onlyErrors: Boolean(onlyErrors),
    toolFilter: tool || null,
    since: since || null,
    full: Boolean(full),
    entries: collected,
  };
}

// 默认读取时对长输出做二次截断；full: true 时原样返回。
function clipLogEntry(entry) {
  const output = { ...entry };
  for (const key of ["stdout", "stderr", "uploadStdout", "uploadStderr", "commandStdout", "commandStderr"]) {
    const value = output[key];
    if (typeof value === "string" && value.length > READ_FIELD_CHARS) {
      output[key] = value.slice(0, READ_FIELD_CHARS) + "…（已截断，用 full: true 查看完整内容）";
    }
  }
  return output;
}