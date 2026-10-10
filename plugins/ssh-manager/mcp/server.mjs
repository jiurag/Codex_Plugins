import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import {
  getDashboardStatus,
  primeOperations,
  recordOperation,
  startDashboard,
  stopDashboard,
  appendStreamChunk,
  updateOperation,
} from "./lib/dashboard.mjs";
import { createTerminalController } from "./lib/terminal.mjs";
import { appendLog, readRecentLogs, getLogDirectory } from "./lib/log.mjs";
import {
  appendAudit,
  getKeyProtection,
  getVaultHome,
  readVault,
  vaultExists,
  writeVault,
} from "./lib/vault.mjs";
import {
  ToolInputError,
  describeLocalPaths,
  downloadPaths,
  downloadPathsPersistent,
  explainCommandClassification,
  formatBytes,
  getPersistentSessionStatus,
  getPersistentSftpStatus,
  hasPersistentSession,
  hasPersistentSftpSession,
  openPersistentSession,
  openPersistentSftpSession,
  closePersistentSession,
  closePersistentSftpSession,
  publicProfile,
  requireString,
  runRemoteCommand,
  runRemoteCommandPersistent,
  testConnection,
  uploadPaths,
  uploadPathsPersistent,
  validateAlias,
  validateHost,
  validateHostKeyPolicy,
  validateLocalPath,
  validatePort,
  validateRemotePath,
  validateSecret,
  validateTimeoutSeconds,
  READ_ONLY_TIMEOUT_SECONDS,
  DEFAULT_TIMEOUT_SECONDS,
  classifyRemoteFailure,
  ensureKeyPair,
  installPublicKey,
  getKeyDirectory,
  validateUsername,
} from "./lib/ssh.mjs";

const SERVER_NAME = "Codex SSH 管理器";
const SERVER_VERSION = "0.3.2";
const ELICITATION_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_MESSAGE_LENGTH = 20_000;
// Codex 的 elicitation 面板高度 = message 换行后的行数 + 选项区高度
// （见 Codex TUI 的 McpServerElicitationOverlay::desired_height）。
// message 越长，选项区越容易被挤出可视区域，于是出现"选项被遮挡"。
// Codex 自身的工具参数摘要只显示 3 条、每条截断 60 字素，这里采用同等克制的预算。
const APPROVAL_MESSAGE_HEAD_ROWS = 9;
const APPROVAL_MESSAGE_TAIL_ROWS = 3;
const APPROVAL_MESSAGE_ASSUMED_COLS = 72;

const JsonRpcError = {
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
};

let nextRequestId = 1;
const pendingRequests = new Map();

const APPROVAL_MODES = {
  DEFAULT: "默认执行",
  READ_ONLY: "只读免确认",
  SESSION_AUTO: "会话免确认",
};
let approvalMode = APPROVAL_MODES.DEFAULT;
// "会话免确认"跨 MCP 进程重启的有效期。Codex 在 cwd/审批策略/权限变化时会重建 MCP 进程，
// 之前该模式只存在内存里，于是"聊几轮又弹确认"。现在持久化到 vault，并只在窗口内恢复。
const SESSION_AUTO_TTL_MS =
  Math.max(1, Number.parseInt(process.env.SSH_MANAGER_SESSION_AUTO_TTL_MINUTES || "30", 10) || 30) * 60 * 1000;
let sessionAutoRestoredAt = null;

function persistApprovalMode(mode) {
  try {
    const vault = readVault();
    vault.runtime = {
      ...(vault.runtime || {}),
      approvalMode: mode,
      approvalModeUpdatedAt: Date.now(),
    };
    writeVault(vault);
  } catch {
    // 持久化失败不影响本次操作。
  }
}

function restoreApprovalMode() {
  try {
    const vault = readVault();
    const runtime = vault.runtime && typeof vault.runtime === "object" ? vault.runtime : {};
    if (runtime.approvalMode !== APPROVAL_MODES.SESSION_AUTO) {
      return;
    }
    const updatedAt = Number(runtime.approvalModeUpdatedAt) || 0;
    const age = Date.now() - updatedAt;
    if (age < 0 || age > SESSION_AUTO_TTL_MS) {
      return;
    }
    approvalMode = APPROVAL_MODES.SESSION_AUTO;
    sessionAutoRestoredAt = updatedAt;
  } catch {
    // 读取失败就按默认模式处理。
  }
}

restoreApprovalMode();
const terminalController = createTerminalController();
let liveSessionId =
  process.env.CODEX_THREAD_ID ||
  process.env.CODEX_SESSION_ID ||
  process.env.CODEX_TASK_ID ||
  crypto.randomUUID();
let liveSessionName = process.env.CODEX_THREAD_TITLE || "未命名 SSH 会话";

function currentApprovalDecision() {
  if (approvalMode === APPROVAL_MODES.SESSION_AUTO) {
    return "allow";
  }
  if (approvalMode === APPROVAL_MODES.READ_ONLY) {
    return "block";
  }
  return "ask";
}

function blockedByReadOnlyMode(action) {
  return {
    status: "已阻止",
    action,
    approved: false,
    reason: "只读模式",
    message:
      "已阻止：" + action + " 属于变更类操作。当前为「只读免确认」模式，只允许只读命令。" +
      "如需执行变更，请先用 ssh_set_approval_mode 切回「默认执行」。",
  };
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) {
    error.data = data;
  }
  send({ jsonrpc: "2.0", id, error });
}

function request(method, params, timeoutMs = ELICITATION_TIMEOUT_MS) {
  const id = `server-${nextRequestId++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`MCP 请求超时：${method}`));
    }, timeoutMs);
    timer.unref();
    pendingRequests.set(id, { resolve, reject, timer });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

// 当前正在执行的工具调用，供 toolResult 落日志用。
let currentToolCall = null;

function summarizeForLog(payload) {
  if (!payload || typeof payload !== "object") {
    return {};
  }
  const detail =
    typeof payload.result === "object" && payload.result !== null ? payload.result : payload;
  return {
    status: payload.status,
    action: payload.action,
    alias: payload.profile?.alias,
    host: payload.profile?.host,
    port: payload.profile?.port,
    failureKind: payload.failureKind || detail?.failureKind,
    failureHint: payload.failureHint || detail?.failureHint,
    completed: detail?.completed,
    verified: detail?.verified,
    timedOut: detail?.timedOut,
    exitCode: detail?.exitCode,
    stderr: detail?.stderr,
    stdout: detail?.stdout,
    // ssh_deploy 的上传与 postCommand 输出是分开的两块，必须都记下来。
    uploadExitCode: payload.uploadResult?.exitCode,
    uploadStdout: payload.uploadResult?.stdout,
    uploadStderr: payload.uploadResult?.stderr,
    commandExitCode: payload.commandResult?.exitCode,
    commandStdout: payload.commandResult?.stdout,
    commandStderr: payload.commandResult?.stderr,
    error: payload.error,
  };
}

function recordToolCall(payload, isError) {
  const call = currentToolCall;
  currentToolCall = null;
  if (!call) {
    return;
  }
  const summary = summarizeForLog(payload);
  appendLog({
    kind: "tool",
    name: call.name,
    ok: !isError && summary.status !== "失败" && summary.status !== "部分失败" && summary.status !== "错误",
    durationMs: Date.now() - call.startedAt,
    args: call.args,
    ...summary,
  });
}

const MAX_RESULT_OUTPUT_CHARS = 4000;

// 汇总一次调用里所有需要展示给用户的子进程输出。
// 成功和失败都要带：ssh_exec 的 stdout 本身就是执行结果，deploy 的 postCommand 同理。
// 依次检查顶层、result、uploadResult、commandResult，按对象引用去重。
function collectResultOutput(payload) {
  const seen = new Set();
  const sections = [];
  const sources = [
    ["", payload],
    ["", payload?.result],
    ["上传", payload?.uploadResult],
    ["部署后命令", payload?.commandResult],
    ["持久连接", payload?.session],
  ];
  for (const [label, source] of sources) {
    if (!source || typeof source !== "object" || seen.has(source)) {
      continue;
    }
    seen.add(source);
    const stdout = typeof source.stdout === "string" ? source.stdout.trim() : "";
    const stderr = typeof source.stderr === "string" ? source.stderr.trim() : "";
    if (stdout) {
      sections.push({ label: label ? label + " stdout" : "stdout", text: stdout });
    }
    if (stderr) {
      sections.push({ label: label ? label + " stderr" : "stderr", text: stderr });
    }
    // ssh_log_read 这类工具直接把 entries 里的输出带出来。
    if (Array.isArray(source.entries)) {
      for (const entry of source.entries) {
        const entryStdout = typeof entry?.stdout === "string" ? entry.stdout.trim() : "";
        const entryStderr = typeof entry?.stderr === "string" ? entry.stderr.trim() : "";
        if (entryStdout) {
          sections.push({ label: (entry.name || "日志") + " stdout", text: entryStdout });
        }
        if (entryStderr) {
          sections.push({ label: (entry.name || "日志") + " stderr", text: entryStderr });
        }
      }
    }
  }
  if (sections.length === 0) {
    return "";
  }
  const multi = sections.length > 1;
  const rendered = sections
    .map((section) => (multi ? "[" + section.label + "]\n" + section.text : section.text))
    .join("\n\n");
  if (rendered.length <= MAX_RESULT_OUTPUT_CHARS) {
    return rendered;
  }
  return (
    rendered.slice(0, MAX_RESULT_OUTPUT_CHARS) +
    "\n…（输出已截断，" +
    (rendered.length - MAX_RESULT_OUTPUT_CHARS) +
    " 字符未显示；完整内容见 ssh_log_read）"
  );
}

// 输出段的统一渲染：先报退出码，再贴内容；内容为空时显式写"（无输出）"。
// 目的是让"命令本来就没输出"和"输出没被回传"在正文里长得不一样。
// 正文只保留头尾若干行，避免一次 ls -lR 淹没整个对话（完整内容仍在日志里）。
const DISPLAY_HEAD_LINES = 20;
const DISPLAY_TAIL_LINES = 20;

function clipOutputForDisplay(text) {
  const lines = text.split("\n");
  if (lines.length <= DISPLAY_HEAD_LINES + DISPLAY_TAIL_LINES + 1) {
    return text;
  }
  const head = lines.slice(0, DISPLAY_HEAD_LINES);
  const tail = lines.slice(-DISPLAY_TAIL_LINES);
  const omitted = lines.length - head.length - tail.length;
  return [...head, "…（中间省略 " + omitted + " 行；完整输出见 ssh_log_read）", ...tail].join("\n");
}

function renderResultOutput(payload) {
  // 部署类结果的主体是 postCommand 的 commandResult（其次才是上传结果）。
  const detail =
    payload?.commandResult && typeof payload.commandResult === "object"
      ? payload.commandResult
      : payload && typeof payload.result === "object" && payload.result !== null
        ? payload.result
        : payload;
  const hasResultField =
    (payload && typeof payload.result === "object" && payload.result !== null) ||
    Boolean(payload?.commandResult) ||
    Boolean(payload?.uploadResult);
  const body = collectResultOutput(payload);
  const exitCode =
    detail?.commandExitCode ?? detail?.exitCode ?? payload?.commandExitCode ?? payload?.exitCode;
  const timedOut = Boolean(detail?.timedOut || payload?.timedOut);
  const durationMs = detail?.durationMs ?? payload?.durationMs;

  // 只有真的跑过子进程的结果才渲染输出段；元信息类工具（profile_list / vault_status 等）不再出现"（无输出）"噪音。
  const ranProcess =
    hasResultField ||
    typeof payload?.exitCode === "number" ||
    typeof payload?.commandExitCode === "number" ||
    Boolean(body);
  if (!ranProcess) {
    return "";
  }

  const lines = [];
  if (typeof exitCode === "number") {
    lines.push(timedOut ? "exit=" + exitCode + "（超时中断）" : "exit=" + exitCode);
  } else if (timedOut) {
    lines.push("exit=?(超时中断)");
  }
  lines.push(body ? clipOutputForDisplay(body) : "（无输出）");
  const truncated = Boolean(detail?.stdoutTruncated || detail?.stderrTruncated);
  if (truncated) {
    lines.push("…（输出已截断，完整内容见 ssh_log_read）");
  }

  // 关键字段回显进正文：校验结论、实际生效的超时、耗时。
  const notes = [];
  const verifiedValue =
    payload?.verified ?? detail?.verified ?? payload?.uploadResult?.verified ?? undefined;
  if (verifiedValue === true) {
    notes.push("校验：一致 ✓");
  } else if (verifiedValue === false) {
    notes.push("校验：不一致，已自动重传 ⚠");
  }
  if (typeof payload?.timeoutSeconds === "number") {
    notes.push("超时：" + payload.timeoutSeconds + " 秒");
  }
  if (typeof durationMs === "number" && durationMs > 0) {
    notes.push("耗时：" + (durationMs >= 1000 ? (durationMs / 1000).toFixed(1) + " 秒" : durationMs + " 毫秒"));
  }
  if (notes.length > 0) {
    lines.push(notes.join("　|　"));
  }
  return lines.join("\n");
}

function toolResult(id, payload, { isError = false } = {}) {
  const summary = displayTextFor(payload) || JSON.stringify(payload, null, 2);
  // 传输类结果的明细挂在 payload.result 上，这里统一取出。
  const detail =
    payload && typeof payload.result === "object" && payload.result !== null ? payload.result : payload;
  const parts = [summary];
  const failureKind = payload?.failureKind || detail?.failureKind;
  const failureHint = payload?.failureHint || detail?.failureHint;
  if (failureKind) {
    parts.push("失败类型：" + failureKind);
  }
  if (failureHint) {
    parts.push("建议：" + failureHint);
  }
  const failedNow =
    isError || Boolean(failureKind) || payload?.status === "失败" || payload?.status === "部分失败";
  if (failedNow && payload?.retryable === false) {
    parts.push("提示：这是变更类操作，失败后不要自动重试。");
  }
  const rendered = renderResultOutput(payload);
  if (rendered) {
    parts.push((isError || failureKind ? "原始输出：" : "输出：") + "\n" + rendered);
  }
  const text = parts.join("\n");
  recordToolCall(payload, isError);
  sendResult(id, {
    content: [
      {
        type: "text",
        text,
      },
    ],
    // 结构化结果放协议元数据：Codex 不会把它当内容渲染（避免界面多出一大块 JSON），
    // 程序化消费方（含自带冒烟测试）仍可读取。
    _meta: payload,
    isError,
  });
}

function displayTarget(profile) {
  const user = profile?.username || "";
  const host = profile?.host || profile?.alias || "";
  return `${user}${user ? "@" : ""}${host}`;
}

// 命令预览：只显示首行，多行时标注总行数。
function displayCommandPreview(command) {
  const text = String(command || "").trim();
  const lines = text.split("\n");
  return lines.length > 1 ? lines[0] + " …（共 " + lines.length + " 行）" : lines[0];
}

function displayShellQuote(value) {
  return `"${String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$")}"`;
}

function displaySftpFlags(payload) {
  const flags = [];
  if (payload.recursive) flags.push("-r");
  if (payload.preserveTimes !== false) flags.push("-p");
  return flags;
}

function displayTextFor(payload) {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const action = payload.action;
  const profile = payload.profile || {};
  const port = profile.port || 22;
  const target = displayTarget(profile);

  if (payload.status === "已拒绝" || payload.status === "已阻止") {
    const detailText = payload.message || payload.reason || payload.status || "未执行";
    return `${action || "操作"}：未执行\n${detailText}`;
  }

  if (action === "远程命令") {
    const command = payload.command || "";
    const summary = payload.purpose || "执行远程命令";
    const failed = payload.status === "失败" ? "（失败）" : "";
    return `$ ${displayCommandPreview(command)}\n总结：${summary}${failed}`;
  }
  if (action === "远程上传") {
    const localPaths = Array.isArray(payload.localPaths) ? payload.localPaths : [];
    const remoteDirectory = payload.remoteDirectory || "";
    const flags = displaySftpFlags(payload);
    const summary = payload.purpose || `上传 ${localPaths.length || 1} 项到 ${remoteDirectory}`;
    const failed = payload.status === "失败" ? "（失败）" : "";
    return `上传 ${localPaths.length || 1} 项 → ${target}:${remoteDirectory}\n总结：${summary}${failed}`;
  }
  if (action === "远程部署") {
    const localPaths = Array.isArray(payload.localPaths) ? payload.localPaths : [];
    const remoteDirectory = payload.remoteDirectory || "";
    const postCommand = payload.postCommand || "";
    const flags = displaySftpFlags(payload);
    const lines = [`上传 ${localPaths.length || 1} 项 → ${target}:${remoteDirectory}`];
    if (postCommand) lines.push(`$ ${displayCommandPreview(postCommand)}`);
    const summary = payload.purpose || `部署到 ${remoteDirectory}`;
    const failed = payload.status === "失败" || payload.status === "部分失败" ? "（失败）" : "";
    return `${lines.join("\n")}\n总结：${summary}${failed}`;
  }
  if (action === "远程下载") {
    const remotePaths = Array.isArray(payload.remotePaths) ? payload.remotePaths : [];
    const localDirectory = payload.localDirectory || "";
    const flags = displaySftpFlags(payload);
    const summary = payload.purpose || `从远程下载 ${remotePaths.length || 1} 项到 ${localDirectory}`;
    const failed = payload.status === "失败" ? "（失败）" : "";
    return `下载 ${remotePaths.length || 1} 项 ← ${target} → ${localDirectory}\n总结：${summary}${failed}`;
  }
  if (Array.isArray(payload.entries)) {
    const header = [
      "日志目录：" + (payload.logDirectory || ""),
      "当前文件：" + (payload.currentFile || ""),
      "文件数：" + (payload.fileCount ?? 0) + "，共 " + formatBytes(payload.totalBytes || 0) + "（保留 " + (payload.keepDays ?? 7) + " 天）",
      "返回：" + (payload.returned ?? 0) + " 条" + (payload.onlyErrors ? "（仅失败）" : "") + (payload.toolFilter ? "，工具=" + payload.toolFilter : ""),
      "",
    ];
    const lines = payload.entries.map((entry) => {
      const when = String(entry.ts || "").replace("T", " ").slice(0, 19);
      const ok = entry.ok === false ? "FAIL" : "OK";
      const parts = ["[" + when + "] " + entry.name + " " + ok + " " + (entry.durationMs ?? "?") + "ms"];
      if (entry.args) {
        parts.push("  args: " + JSON.stringify(entry.args));
      }
      if (entry.failureKind) {
        parts.push("  失败类型: " + entry.failureKind);
      }
      if (entry.error) {
        parts.push("  错误: " + entry.error);
      }
      if (typeof entry.exitCode === "number") {
        parts.push("  退出码: " + entry.exitCode);
      }
      if (typeof entry.commandExitCode === "number") {
        parts.push("  部署命令退出码: " + entry.commandExitCode);
      }
      if (entry.stdout) {
        parts.push("  stdout: " + String(entry.stdout).trim().split("\n").slice(0, 6).join(" / "));
      }
      if (entry.uploadStdout || entry.commandStdout) {
        if (entry.uploadStdout) {
          parts.push("  上传输出: " + String(entry.uploadStdout).trim().split("\n").slice(0, 4).join(" / "));
        }
        if (entry.commandStdout) {
          parts.push("  部署命令输出: " + String(entry.commandStdout).trim().split("\n").slice(0, 6).join(" / "));
        }
      }
      if (entry.stderr) {
        parts.push("  stderr: " + String(entry.stderr).trim().split("\n").slice(0, 4).join(" / "));
      }
      if (entry.commandStderr) {
        parts.push("  部署命令错误: " + String(entry.commandStderr).trim().split("\n").slice(0, 4).join(" / "));
      }
      return parts.join("\n");
    });
    return [...header, ...lines].join("\n");
  }

  if (action === "连接测试") {
    return `ssh -p ${port} ${target} ${displayShellQuote("printf 'SSH_MANAGER_OK\\n'")}\n总结：测试 SSH 连接`;
  }
  if (action === "交互式终端") {
    return `ssh -tt -p ${port} ${target}\n总结：打开交互式 SSH 终端`;
  }
  if (action === "打开持久连接") {
    return `ssh -T -p ${port} ${target}\n总结：打开 OpenSSH 持久连接`;
  }
  return "";
}

function isTrue(value) {
  return value === true || value === 1 || value === "1" || value === "true";
}

function cleanText(value, field, maxLength = MAX_MESSAGE_LENGTH) {
  return requireString(value, field, { allowEmpty: true, maxLength });
}

function resolveProfile(vault, aliasValue) {
  const alias = validateAlias(aliasValue);
  if (vault.profiles[alias]) {
    return vault.profiles[alias];
  }
  const matches = Object.keys(vault.profiles).filter(
    (candidate) => candidate.toLowerCase() === alias.toLowerCase(),
  );
  if (matches.length === 1) {
    return vault.profiles[matches[0]];
  }
  if (matches.length > 1) {
    throw new ToolInputError(`SSH 配置别名不明确：${alias}`);
  }
  throw new ToolInputError(`未找到 SSH 配置：${alias}`);
}

function profileChoices(vault) {
  return Object.values(vault.profiles)
    .map(publicProfile)
    .sort((left, right) => left.alias.localeCompare(right.alias));
}

function charDisplayWidth(ch) {
  const code = ch.codePointAt(0);
  const wide =
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6);
  return wide ? 2 : 1;
}

function textDisplayWidth(value) {
  let width = 0;
  for (const ch of value) {
    width += charDisplayWidth(ch);
  }
  return width;
}

function truncateToDisplayWidth(value, maxWidth) {
  const limit = Math.max(1, maxWidth);
  let width = 0;
  let out = '';
  for (const ch of value) {
    const next = charDisplayWidth(ch);
    if (width + next > limit - 1) {
      break;
    }
    out += ch;
    width += next;
  }
  return out + '…';
}

function approvalDisplayRows(line) {
  return Math.max(1, Math.ceil(textDisplayWidth(line) / APPROVAL_MESSAGE_ASSUMED_COLS));
}

// 把确认表单的 message 压进可视预算：保留头部（目标/命令）与尾部（影响说明），
// 中间过长时省略并明确告知，避免选项被挤出屏幕。
function clampApprovalMessage(text) {
  const lines = [];
  for (const rawLine of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.replace(/\s+$/u, '');
    if (!line.trim() && (!lines.length || !lines[lines.length - 1].trim())) {
      continue;
    }
    lines.push(line);
  }
  while (lines.length && !lines[lines.length - 1].trim()) {
    lines.pop();
  }
  if (!lines.length) {
    return '';
  }

  const head = [];
  let headRows = 0;
  for (const line of lines) {
    const rows = approvalDisplayRows(line);
    if (headRows + rows <= APPROVAL_MESSAGE_HEAD_ROWS) {
      head.push(line);
      headRows += rows;
      continue;
    }
    // 超长单行（例如一整条命令）不要整行丢弃：按剩余预算截断并保留开头。
    const remainingRows = APPROVAL_MESSAGE_HEAD_ROWS - headRows;
    if (remainingRows > 0 && line.trim()) {
      head.push(truncateToDisplayWidth(line, remainingRows * APPROVAL_MESSAGE_ASSUMED_COLS));
      headRows = APPROVAL_MESSAGE_HEAD_ROWS;
    }
    break;
  }

  const tail = [];
  let tailRows = 0;
  for (let index = lines.length - 1; index >= head.length; index -= 1) {
    const rows = approvalDisplayRows(lines[index]);
    if (tailRows + rows > APPROVAL_MESSAGE_TAIL_ROWS) {
      break;
    }
    tail.unshift(lines[index]);
    tailRows += rows;
  }

  const omitted = lines.length - head.length - tail.length;
  const kept = [...head, ...tail].join('\n').trim();
  return omitted > 0
    ? kept + '\n（另有 ' + omitted + ' 行已省略，完整信息见操作面板）'
    : kept;
}

// 长内容（命令、路径清单）在确认表单里只展示有限行，其余提示省略。
function limitPreviewLines(text, maxLines) {
  const value = String(text ?? '');
  const lines = value.replace(/\r\n?/g, '\n').split('\n');
  if (maxLines <= 1 || lines.length <= maxLines) {
    return value;
  }
  const head = lines.slice(0, maxLines - 1);
  return [...head, '… 另有 ' + (lines.length - head.length) + ' 行'].join('\n');
}

function shortenPath(value, maxChars = 44) {
  const text = String(value ?? '');
  return text.length <= maxChars ? text : '…' + text.slice(-(maxChars - 1));
}

function previewPathList(paths, limit = 1) {
  const list = Array.isArray(paths) ? paths.filter((item) => String(item ?? '').trim()) : [];
  if (!list.length) {
    return '（未提供）';
  }
  const shown = list.slice(0, limit).map((item) => shortenPath(item)).join('、');
  return list.length > limit ? shown + ' 等 ' + list.length + ' 项' : shown;
}

// 常驻 SFTP 会话可能已被中间设备静默断开：子进程还活着，但连接早已失效。
// 此时复用会话会立刻失败，所以失败后丢弃它，并用一次性 sftp 连接重试一次。
async function transferWithFallback(profile, runPersistent, runOneshot) {
  if (!hasPersistentSftpSession(profile)) {
    return runOneshot();
  }
  try {
    const result = await runPersistent();
    if (result && result.exitCode === 0) {
      return result;
    }
  } catch {
    // 常驻会话抛错同样按"会话已坏"处理。
  }
  closePersistentSftpSession(profile);
  return runOneshot();
}

// exec 优先复用常驻 SSH 会话（省去每次握手），失败则丢弃并降级到一次性连接。
// 常驻会话退出码来自远端 $?，与一次性连接等价。
// 需要关闭复用时设置 SSH_MANAGER_EXEC_REUSE=0。
const EXEC_REUSE_PERSISTENT = process.env.SSH_MANAGER_EXEC_REUSE !== "0";

async function execWithFallback(profile, command, options) {
  if (!EXEC_REUSE_PERSISTENT) {
    return runRemoteCommand(profile, command, options);
  }
  const hadSession = hasPersistentSession(profile);
  try {
    return await runRemoteCommandPersistent(profile, command, options);
  } catch {
    // 常驻会话可能已被中间设备断开：丢掉它，用一次性连接重试一次。
    if (hadSession) {
      closePersistentSession(profile);
    }
    return runRemoteCommand(profile, command, options);
  }
}

async function askApproval({ title, message, details }) {
  let result;
  try {
    result = await request("elicitation/create", {
      mode: "form",
      message: clampApprovalMessage(`${message}\n\n${details}`),
      requestedSchema: {
        type: "object",
        properties: {
          decision: {
            type: "string",
            title,
            oneOf: [
              {
                const: "confirm",
                title: "确认本次执行",
              },
              {
                const: "confirm_and_auto",
                title: "确认并开启本次会话免询问",
              },
            ],
            default: "confirm",
          },
        },
        required: ["decision"],
      },
    });
  } catch (error) {
    return {
      approved: false,
      reason: "确认界面不可用",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (result?.action !== "accept") {
    return {
      approved: false,
      reason: `确认_${result?.action === "decline" ? "已拒绝" : "已取消"}`,
    };
  }
  const decision = result?.content?.decision;
  if (decision === "confirm_and_auto") {
    approvalMode = APPROVAL_MODES.SESSION_AUTO;
    persistApprovalMode(APPROVAL_MODES.SESSION_AUTO);
    return {
      approved: true,
      reason: "已确认并开启会话免询问",
      sessionAutoEnabled: true,
    };
  }
  if (decision === "confirm") {
    return { approved: true, reason: "本次已确认" };
  }
  return { approved: false, reason: "未确认" };
}

function approvalDenied(approval, action) {
  return {
    status: "已拒绝",
    action,
    approved: false,
    reason: approval.reason,
    message:
      approval.reason === "确认界面不可用"
        ? "Codex 确认界面不可用，操作未执行。"
        : "用户未同意该操作，操作未执行。",
  };
}

function profileSummary(profile) {
  return `${profile.alias} (${profile.username}@${profile.host}:${profile.port})`;
}

function audit(vault, event) {
  const profile = event.alias ? vault.profiles[event.alias] : undefined;
  const saved = appendAudit(vault, {
    ...event,
    sessionId: event.sessionId || liveSessionId,
    sessionName: event.sessionName || liveSessionName,
    host: event.host || profile?.host,
    username: event.username || profile?.username,
    mode: event.mode || approvalMode,
  });
  writeVault(vault);
  recordOperation(saved);
  return saved;
}
function operationResultDetails(result) {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    completed: result.completed,
    verified: result.verified,
    failureKind: result.failureKind,
    failureHint: result.failureHint,
  };
}

function authMethodToLabel(value) {
  return { password: "密码", key: "私钥", agent: "SSH 代理" }[value] || "密码";
}

function authMethodFromLabel(value) {
  return {
    密码: "password",
    password: "password",
    私钥: "key",
    key: "key",
    "SSH 代理": "agent",
    agent: "agent",
  }[String(value || "密码")] || "";
}

function hostKeyPolicyToLabel(value) {
  return {
    "accept-new": "首次连接自动接受",
    strict: "严格校验",
    insecure: "不校验（不安全）",
  }[value] || "首次连接自动接受";
}

function hostKeyPolicyFromLabel(value) {
  return {
    首次连接自动接受: "accept-new",
    "accept-new": "accept-new",
    严格校验: "strict",
    strict: "strict",
    "不校验（不安全）": "insecure",
    insecure: "insecure",
  }[String(value || "首次连接自动接受")] || "";
}

function profileUpsertSchema(existing, args) {
  const defaults = {
    alias: args.alias || existing?.alias || "",
    host: args.host || existing?.host || "",
    port: String(args.port || existing?.port || 22),
    username: args.username || existing?.username || "",
    authMethod: authMethodToLabel(args.authMethod || existing?.authMethod || "password"),
    privateKeyPath: args.privateKeyPath || existing?.privateKeyPath || "",
    defaultRemoteDir: args.defaultRemoteDir || existing?.defaultRemoteDir || "",
    hostKeyPolicy: hostKeyPolicyToLabel(args.hostKeyPolicy || existing?.hostKeyPolicy || "accept-new"),
    description: args.description || existing?.description || "",
  };

  return {
    type: "object",
    properties: {
      approve: {
        type: "boolean",
        title: existing
          ? "我同意更新这台服务器的 SSH 凭据"
          : "我同意将这台服务器的 SSH 凭据保存到本机",
        description: "凭证会加密写入本机 SSH 管理仓库，不会返回给模型。",
        default: false,
      },
      alias: {
        type: "string",
        title: "服务器别名",
        description: "例如 生产服务器 或 production-web-1；之后部署时直接使用这个别名。",
        default: defaults.alias,
        minLength: 1,
      },
      host: {
        type: "string",
        title: "服务器地址或 IP",
        default: defaults.host,
        minLength: 1,
      },
      port: {
        type: "string",
        title: "SSH 端口",
        default: defaults.port,
        minLength: 1,
      },
      username: {
        type: "string",
        title: "登录账户",
        default: defaults.username,
        minLength: 1,
      },
      authMethod: {
        type: "string",
        title: "认证方式（可填：密码 / 私钥 / SSH 代理）",
        description: "请输入：密码、私钥 或 SSH 代理。",
        default: defaults.authMethod,
        minLength: 1,
      },
      password: {
        type: "string",
        title: existing?.authMethod === "password" ? "新密码（留空保留原密码）" : "密码",
        description: "仅加密保存在本机仓库，不会返回给模型或聊天上下文。",
        default: "",
      },
      privateKeyPath: {
        type: "string",
        title: "私钥文件路径（私钥认证时填写）",
        default: defaults.privateKeyPath,
      },
      privateKeyPassphrase: {
        type: "string",
        title: existing?.authMethod === "key" ? "新私钥口令（留空保留原口令）" : "私钥口令（可留空）",
        description: "仅加密保存在本机仓库，不会返回给模型或聊天上下文。",
        default: "",
      },
      defaultRemoteDir: {
        type: "string",
        title: "默认远程部署目录（可选）",
        default: defaults.defaultRemoteDir,
      },
      hostKeyPolicy: {
        type: "string",
        title: "主机指纹策略（可填：首次连接自动接受 / 严格校验 / 不校验）",
        description: "请输入：首次连接自动接受、严格校验 或 不校验。",
        default: defaults.hostKeyPolicy,
        minLength: 1,
      },
      description: {
        type: "string",
        title: "备注（可选）",
        default: defaults.description,
        maxLength: 500,
      },
      preferKeyAuth: {
        type: "boolean",
        title: "保存后自动改用密钥认证（会写入服务器，取消勾选可只保存密码）",
        description:
          "安全说明：勾选后插件会用你填的密码连一次服务器，把你的公钥追加进 ~/.ssh/authorized_keys，" +
          "之后该账户可用这把密钥免密登录，同时本机保存的密码会被清除。" +
          "这会实际修改服务器上的授权文件；如需撤销，删除服务器上以 codex-ssh-manager: 开头的那一行即可。" +
          "不同意就取消勾选，插件只保存密码、不改服务器。",
        default: true,
      },
    },
    required: ["approve", "alias", "host", "port", "username", "authMethod"],
  };
}

// 把一台"密码认证"的服务器升级成"密钥认证"：
//  1) 生成（或复用）该服务器的专用密钥对
//  2) 用密码连一次，把公钥追加进 ~/.ssh/authorized_keys
//  3) 用密钥再连一次验证
// 任一步失败都保留原来的密码认证，不影响已经保存的配置。
async function tryUpgradeToKeyAuth(profile) {
  try {
    const key = await ensureKeyPair(profile.alias);
    const install = await installPublicKey(profile, key.publicKey, { timeoutSeconds: 20 });
    if (install.exitCode !== 0 || !String(install.stdout || "").includes("SSH_MANAGER_KEY_INSTALLED")) {
      return {
        ok: false,
        reason: "公钥安装失败",
        detail: String(install.stderr || install.stdout || "").trim().slice(0, 300),
      };
    }
    const verify = await testConnection(
      {
        ...profile,
        authMethod: "key",
        privateKeyPath: key.privateKeyPath,
        privateKeyPassphrase: "",
      },
      { timeoutSeconds: 20 },
    );
    if (verify.exitCode !== 0) {
      return {
        ok: false,
        reason: "密钥验证失败",
        detail: String(verify.stderr || verify.stdout || "").trim().slice(0, 300),
      };
    }
    return { ok: true, privateKeyPath: key.privateKeyPath, publicKey: key.publicKey };
  } catch (error) {
    return { ok: false, reason: "自动升级异常", detail: String(error?.message || error).slice(0, 300) };
  }
}

async function handleProfileUpsert(args) {
  const requestedAlias = args.alias ? validateAlias(args.alias) : "";
  const vault = readVault();
  let existing = null;
  if (requestedAlias) {
    try {
      existing = resolveProfile(vault, requestedAlias);
    } catch (error) {
      if (!(error instanceof ToolInputError) || !String(error.message).startsWith("未找到 SSH 配置：")) {
        throw error;
      }
    }
  }

  const result = await request("elicitation/create", {
    mode: "form",
    message: existing
      ? `更新 SSH 服务器配置：${existing.alias}。请在 Codex 表单中确认或修改字段。`
      : "新增 SSH 服务器配置。请在 Codex 表单中填写字段；密码不会进入聊天或模型上下文。",
    requestedSchema: profileUpsertSchema(existing, args),
  });

  if (result?.action !== "accept") {
    return { status: "已拒绝", action: "配置添加或更新", approved: false, reason: result?.action === "decline" ? "已拒绝" : "已取消" };
  }
  const content = result.content || {};
  if (!isTrue(content.approve)) {
    return { status: "已拒绝", action: "配置添加或更新", approved: false, reason: "未确认" };
  }

  const alias = validateAlias(content.alias);
  const host = validateHost(content.host);
  const port = validatePort(content.port);
  const username = validateUsername(content.username);
  const authMethod = authMethodFromLabel(content.authMethod);
  if (!["password", "key", "agent"].includes(authMethod)) {
    throw new ToolInputError("认证方式无效。");
  }
  const defaultRemoteDir = cleanText(content.defaultRemoteDir || "", "defaultRemoteDir", 4096);
  if (defaultRemoteDir) {
    validateRemotePath(defaultRemoteDir, "defaultRemoteDir");
  }
  const hostKeyPolicy = validateHostKeyPolicy(hostKeyPolicyFromLabel(content.hostKeyPolicy));
  const description = cleanText(content.description || "", "description", 500);
  const now = new Date().toISOString();

  let password = "";
  let privateKeyPath = "";
  let privateKeyPassphrase = "";

  if (authMethod === "password") {
    password = validateSecret(content.password ?? "", "password", true);
    if (!password && existing?.authMethod === "password") {
      password = existing.password || "";
    }
    if (!password) {
      throw new ToolInputError("密码认证必须填写密码。");
    }
  } else if (authMethod === "key") {
    const keyInput = cleanText(content.privateKeyPath || "", "privateKeyPath", 4096);
    if (!keyInput) {
      throw new ToolInputError("密钥认证必须填写私钥文件路径。");
    }
    privateKeyPath = validateLocalPath(keyInput, "privateKeyPath");
    if (!fs.statSync(privateKeyPath).isFile()) {
      throw new ToolInputError("私钥文件路径必须指向一个文件。");
    }
    privateKeyPassphrase = validateSecret(content.privateKeyPassphrase ?? "", "privateKeyPassphrase", true);
    if (!privateKeyPassphrase && existing?.authMethod === "key") {
      privateKeyPassphrase = existing.privateKeyPassphrase || "";
    }
  }

  const nextProfile = {
    alias,
    host,
    port,
    username,
    authMethod,
    password,
    privateKeyPath,
    privateKeyPassphrase,
    defaultRemoteDir,
    hostKeyPolicy,
    description,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  const previousAlias = existing?.alias;
  if (previousAlias && previousAlias !== alias) {
    delete vault.profiles[previousAlias];
  }
  vault.profiles[alias] = nextProfile;

  // 密码认证 + 用户同意 → 用密码连一次装公钥，成功后自动改为密钥认证。
  let keyAuthUpgrade = null;
  const preferKeyAuth = content.preferKeyAuth === undefined ? true : isTrue(content.preferKeyAuth);
  if (authMethod === "password" && password && preferKeyAuth) {
    keyAuthUpgrade = await tryUpgradeToKeyAuth(nextProfile);
    if (keyAuthUpgrade.ok) {
      nextProfile.authMethod = "key";
      nextProfile.privateKeyPath = keyAuthUpgrade.privateKeyPath;
      nextProfile.privateKeyPassphrase = "";
      // 不再需要密码了：清掉它更安全，也避免以后误用密码通道。
      nextProfile.password = "";
    }
    // 这一步改过服务器上的授权文件，必须留下可追溯的审计记录。
    audit(vault, {
      alias,
      action: "自动升级密钥认证",
      approved: "用户已在表单中同意",
      result: keyAuthUpgrade.ok ? "成功" : "失败",
      summary: keyAuthUpgrade.ok
        ? `已在 ${host} 追加公钥到 ~/.ssh/authorized_keys，并改用密钥认证`
        : `未升级，保留密码认证：${keyAuthUpgrade.reason || "原因未知"}`,
      details: {
        host,
        port,
        username,
        privateKeyPath: keyAuthUpgrade.privateKeyPath || null,
        publicKey: keyAuthUpgrade.publicKey || null,
        reason: keyAuthUpgrade.reason || null,
        detail: keyAuthUpgrade.detail || null,
      },
    });
  }
  audit(vault, {
    alias,
    action: existing ? "配置更新" : "配置添加",
    approved: true,
    result: "已保存",
    summary: profileSummary(nextProfile),
    details: {
      authMethod,
      host,
      port,
      username,
      defaultRemoteDir,
      hostKeyPolicy,
    },
  });

  return {
    status: "已保存",
    action: existing ? "配置更新" : "配置添加",
    profile: publicProfile(nextProfile),
    // 自动升级密钥认证的结果（仅密码认证时出现）
    keyAuthUpgrade: keyAuthUpgrade
      ? {
          ok: Boolean(keyAuthUpgrade.ok),
          privateKeyPath: keyAuthUpgrade.privateKeyPath || null,
          keyDirectory: getKeyDirectory(),
          reason: keyAuthUpgrade.reason || null,
          detail: keyAuthUpgrade.detail || null,
          securityNotice:
            "本次操作修改了服务器上的授权文件：公钥已追加到 " +
            username +
            "@" +
            host +
            " 的 ~/.ssh/authorized_keys（注释以 codex-ssh-manager: 开头）。" +
            "本机保存的密码已清除。如需撤销授权，请在服务器上删除该行，或改用其他认证方式。",
          summary: keyAuthUpgrade.ok
            ? "已自动改用密钥认证，之后连接不再需要密码，也不会再弹黑框。"
            : "自动升级未成功，已保留密码认证：" + (keyAuthUpgrade.reason || "原因未知"),
        }
      : null,
  };
}

async function handleProfileRemove(args) {
  const vault = readVault();
  const profile = resolveProfile(vault, args.alias);
  const modeDecision = currentApprovalDecision();
  if (modeDecision === "block") {
    return blockedByReadOnlyMode("配置删除");
  }
  let approval = { approved: true, reason: "会话免确认" };
  if (modeDecision === "ask") {
    approval = await askApproval({
      title: "我同意删除这个 SSH 配置",
      message: `删除本机保存的 SSH 配置：${profile.alias}`,
      details: `目标服务器：${profileSummary(profile)}
影响：从本机加密仓库中删除该服务器、账户和密码/私钥口令。远程服务器不会被修改。`,
    });
    if (!approval.approved) {
      audit(vault, {
        alias: profile.alias,
        action: "配置删除",
        approved: false,
        result: approval.reason,
        summary: profileSummary(profile),
        details: { host: profile.host, port: profile.port, username: profile.username },
      });
      return approvalDenied(approval, "配置删除");
    }
  }
  delete vault.profiles[profile.alias];
  audit(vault, {
    alias: profile.alias,
    action: "配置删除",
    approved: modeDecision === "allow" ? "会话免确认" : true,
    result: "已删除",
    summary: profileSummary(profile),
    details: { host: profile.host, port: profile.port, username: profile.username },
  });
  return { status: "已删除", action: "配置删除", profile: publicProfile(profile) };
}

async function handleTestConnection(args) {
  const vault = readVault();
  const profile = resolveProfile(vault, args.alias);
  const timeoutSeconds = validateTimeoutSeconds(args.timeoutSeconds, 30);
  const result = await testConnection(profile, { timeoutSeconds });
  audit(vault, {
    alias: profile.alias,
    action: "连接测试",
    approved: true,
    result: result.exitCode === 0 ? "成功" : "失败",
    summary: `测试连接：${profileSummary(profile)}`,
    details: operationResultDetails(result),
  });
  return {
    status: result.exitCode === 0 ? "连接成功" : "失败",
    action: "连接测试",
    profile: publicProfile(profile),
    result,
  };
}
async function handleSessionRegister(args) {
  const name = requireString(args.name, "name", { maxLength: 100 }).trim();
  if (!name) {
    throw new ToolInputError("会话名称不能为空。");
  }
  if (args.id !== undefined && args.id !== null && String(args.id).trim()) {
    liveSessionId = requireString(String(args.id), "id", { maxLength: 160 }).trim();
  }
  liveSessionName = name;
  const vault = readVault();
  const saved = audit(vault, {
    action: "注册会话",
    approved: true,
    result: "已注册",
    summary: `SSH 操作会话：${liveSessionName}`,
    details: {
      sessionId: liveSessionId,
      sessionName: liveSessionName,
    },
  });
  return {
    status: "已注册",
    sessionId: liveSessionId,
    sessionName: liveSessionName,
    operationId: saved.id,
    dashboard: getDashboardStatus(),
  };
}

async function handleSetApprovalMode(args) {
  const mode = String(args.mode || "").trim();
  if (!Object.values(APPROVAL_MODES).includes(mode)) {
    throw new ToolInputError("模式必须是：默认执行、只读免确认 或 会话免确认。");
  }
  approvalMode = mode;
  persistApprovalMode(mode);
  if (mode !== APPROVAL_MODES.SESSION_AUTO) {
    sessionAutoRestoredAt = null;
  }
  const description = mode === APPROVAL_MODES.SESSION_AUTO
    ? "当前 MCP 会话内，敏感操作也不再询问，默认直接执行。"
    : mode === APPROVAL_MODES.READ_ONLY
      ? "仅允许只读命令；上传、下载、部署、删除和变更命令会被阻止。"
      : "只读命令无需询问；上传、下载、部署、删除和变更命令仍会询问。";
  recordOperation({
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    sessionId: liveSessionId,
    sessionName: liveSessionName,
    alias: "本机会话",
    action: "操作模式",
    approved: true,
    result: mode,
    summary: description,
    details: { approvalMode: mode },
    mode,
  });
  return {
    status: "已设置",
    mode,
    description,
  };
}

async function handleTerminalOpen(args) {
  const alias = validateAlias(args.alias);
  const vault = readVault();
  const profile = resolveProfile(vault, alias);
  const modeDecision = currentApprovalDecision();
  if (modeDecision === "block") {
    return blockedByReadOnlyMode("交互式终端");
  }
  if (modeDecision === "ask") {
    const approval = await askApproval({
      title: "我同意打开交互式 SSH 终端",
      message: `打开交互式 SSH 终端：${profileSummary(profile)}`,
      details: `服务器：${profileSummary(profile)}
影响：打开连接后，后续终端输入将直接发送到远程 shell，不再逐条弹确认。`,
    });
    if (!approval.approved) {
      return approvalDenied(approval, "交互式终端");
    }
  }
  const result = terminalController.start(alias);
  audit(vault, {
    alias: profile.alias,
    action: "交互式终端",
    approved: modeDecision === "allow" ? "会话免确认" : true,
    result: "已连接",
    summary: `打开交互式 SSH 终端：${profileSummary(profile)}`,
    details: { terminalId: result.terminalId, pid: result.pid },
  });
  return result;
}

function handleTerminalWrite(args) {
  const terminalId = requireString(args.terminalId, "terminalId", { maxLength: 160 });
  const data = requireString(args.data, "data", { allowEmpty: true, maxLength: MAX_MESSAGE_LENGTH });
  return terminalController.write(terminalId, data);
}

function handleTerminalRead(args) {
  const terminalId = requireString(args.terminalId, "terminalId", { maxLength: 160 });
  return terminalController.read(terminalId);
}

function handleTerminalClose(args) {
  const terminalId = requireString(args.terminalId, "terminalId", { maxLength: 160 });
  return terminalController.close(terminalId);
}

function handleTerminalList() {
  return { status: "正常", terminals: terminalController.list() };
}

async function handleOperationDashboard(args) {
  const action = String(args.action || "打开").trim();
  if (action === "状态") {
    return getDashboardStatus();
  }
  if (action === "停止") {
    return await stopDashboard();
  }
  if (action !== "打开") {
    throw new ToolInputError("action 必须是：打开、状态 或 停止。");
  }

  const vault = readVault();
  const current = getDashboardStatus();
  if (current.status === "未启动") {
    primeOperations(vault.audit || []);
  }
  const status = await startDashboard({ terminalController });
  return {
    ...status,
    message: "SSH 实时操作面板已启动。请用 Codex 内置浏览器打开 url，后续 SSH 操作会实时出现。",
  };
}

async function handleSessionOpen(args) {
  const vault = readVault();
  const profile = resolveProfile(vault, args.alias);
  const session = openPersistentSession(profile);
  let sftp = null;
  let sftpError = null;
  try {
    sftp = openPersistentSftpSession(profile);
  } catch (error) {
    // 之前这里静默吞掉错误，导致"SFTP 用不了"却看不出原因。
    sftpError = error instanceof Error ? error.message : String(error);
  }
  audit(vault, {
    alias: profile.alias,
    action: "打开持久连接",
    approved: true,
    result: "已连接",
    summary: `打开 ${profile.alias} 的 OpenSSH 和 SFTP 持久连接`,
    details: { session, sftp, sftpError },
  });
  return { status: "已连接", session, sftp, sftpError };
}

async function handleSessionClose(args) {
  const vault = readVault();
  const profile = resolveProfile(vault, args.alias);
  const session = closePersistentSession(profile);
  const sftp = closePersistentSftpSession(profile);
  audit(vault, {
    alias: profile.alias,
    action: "关闭持久连接",
    approved: true,
    result: session || sftp ? "已关闭" : "未连接",
    summary: `关闭 ${profile.alias} 的 OpenSSH 和 SFTP 持久连接`,
    details: { session, sftp },
  });
  return { status: session || sftp ? "已关闭" : "未连接", session: session || null, sftp: sftp || null };
}

function handleSessionStatus() {
  return {
    status: "正常",
    sessions: getPersistentSessionStatus(),
    sftpSessions: getPersistentSftpStatus(),
  };
}

async function handleExec(args) {
  const vault = readVault();
  const profile = resolveProfile(vault, args.alias);
  const command = requireString(args.command, "command", { maxLength: MAX_MESSAGE_LENGTH });
  const purpose = requireString(args.purpose, "purpose", { maxLength: 1000 });
  const classification = explainCommandClassification(command);
  // 超时分层：只读诊断类默认 30 秒，变更类默认 120 秒；显式传入时以传入为准。
  const timeoutSeconds = validateTimeoutSeconds(
    args.timeoutSeconds,
    classification.approvalRequired ? DEFAULT_TIMEOUT_SECONDS : READ_ONLY_TIMEOUT_SECONDS,
  );

  const modeDecision = classification.approvalRequired ? currentApprovalDecision() : "allow";
  if (modeDecision === "block") {
    return blockedByReadOnlyMode("远程命令");
  }
  if (classification.approvalRequired && modeDecision === "ask") {
    const approval = await askApproval({
      title: classification.risk === "破坏性"
        ? "我同意执行这个破坏性远程操作"
        : "我同意执行这个远程变更操作",
      message: `远程操作：${classification.risk === "破坏性" ? "破坏性/高风险" : "变更"}`,
      details: `服务器：${profileSummary(profile)}
命令：
${limitPreviewLines(command, 8)}
${purpose ? `用途：${purpose}\n` : ""}影响：会在远程服务器上执行上述命令。`,
    });
    if (!approval.approved) {
      audit(vault, {
        alias: profile.alias,
        action: "远程命令",
        approved: false,
        result: approval.reason,
        summary: purpose || command,
        details: { command, purpose, risk: classification.risk, approvalMode },
      });
      return approvalDenied(approval, "远程命令");
    }
  }

  const approvalLabel = !classification.approvalRequired
    ? "无需确认"
    : modeDecision === "allow"
      ? "会话免确认"
      : "已同意";
  // 流式模式：先登记一条"执行中"记录，把实时输出推给面板，结束后更新状态。
  const streamEnabled = args.stream !== false;
  const pendingId = streamEnabled ? crypto.randomUUID() : null;
  if (pendingId) {
    recordOperation({
      id: pendingId,
      timestamp: new Date().toISOString(),
      sessionId: liveSessionId,
      sessionName: liveSessionName,
      alias: profile.alias,
      action: "远程命令",
      approved: true,
      result: "执行中",
      summary: purpose || command,
      details: { command, purpose, risk: classification.risk, approvalMode },
      mode: approvalMode,
      streaming: true,
    });
  }
  const result = await execWithFallback(profile, command, {
    timeoutSeconds,
    onChunk: pendingId ? (chunk) => appendStreamChunk(pendingId, chunk) : undefined,
  });
  if (pendingId) {
    updateOperation(pendingId, {
      streaming: false,
      result: result.exitCode === 0 ? "完成" : "失败",
      exitCode: result.exitCode,
    });
  }
  audit(vault, {
    alias: profile.alias,
    action: "远程命令",
    approved: classification.approvalRequired ? (modeDecision === "allow" ? "会话免确认" : true) : "无需确认",
    result: result.exitCode === 0 ? "成功" : "失败",
    summary: purpose || command,
    details: {
      command,
      purpose,
      risk: classification.risk,
      approvalMode,
      ...operationResultDetails(result),
    },
  });
  // 失败时接入与传输一致的失败分类（同时识别中英文错误信息）。
  let failureKind = null;
  let failureHint = null;
  if (result.exitCode !== 0) {
    const classified = classifyRemoteFailure(
      [result.stderr, result.stdout].filter(Boolean).join("\n"),
      result.exitCode,
    );
    if (classified) {
      failureKind = classified.kind;
      failureHint = classified.hint;
    }
  }
  return {
    status: result.exitCode === 0 ? "已执行" : "失败",
    action: "远程命令",
    approval: approvalLabel,
    risk: classification.risk,
    failureKind,
    failureHint,
    profile: publicProfile(profile),
    command,
    purpose: purpose || undefined,
    connectionMode: result.connectionMode || "短连接",
    // 重试语义分级：只读命令可安全重试，变更/破坏性操作失败后不要自动重试。
    retryable: !classification.approvalRequired,
    timeoutSeconds,
    result,
  };
}

function validateDeployInputs(args, requireFiles = true) {
  const localPaths = Array.isArray(args.localPaths) ? args.localPaths : [];
  if (requireFiles && localPaths.length === 0) {
    throw new ToolInputError("本地路径至少需要包含一个本地文件或目录。");
  }
  const descriptor = describeLocalPaths(localPaths);
  const missing = descriptor.entries.filter((entry) => entry.exists === false);
  if (missing.length > 0) {
    throw new ToolInputError(`以下本地路径不存在：${missing.map((entry) => entry.path).join("、")}`);
  }
  const remoteDirectory = validateRemotePath(args.remoteDirectory, "remoteDirectory");
  const recursive = args.recursive !== false;
  const preserveTimes = args.preserveTimes !== false;
  const timeoutSeconds = validateTimeoutSeconds(args.timeoutSeconds);
  return { localPaths, descriptor, remoteDirectory, recursive, preserveTimes, timeoutSeconds };
}

async function handleUpload(args) {
  const vault = readVault();
  const profile = resolveProfile(vault, args.alias);
  const input = validateDeployInputs(args, true);
  const purpose = requireString(args.purpose, "purpose", { maxLength: 1000 });
  const modeDecision = currentApprovalDecision();
  if (modeDecision === "block") {
    return blockedByReadOnlyMode("远程上传");
  }
  if (modeDecision === "ask") {
    const approval = await askApproval({
      title: "我同意上传文件到远程服务器",
      message: "上传/部署会写入远程服务器",
      details: `服务器：${profileSummary(profile)}
本地路径：${previewPathList(input.localPaths)}
远程目录：${input.remoteDirectory}
传输方式：SFTP${input.recursive ? "（递归）" : ""}，共约 ${input.descriptor.totalFiles} 个文件，${formatBytes(input.descriptor.totalBytes)}
${purpose ? `用途：${purpose}\n` : ""}影响：远程目录将被创建或覆盖同名文件。`,
    });
    if (!approval.approved) {
      audit(vault, {
        alias: profile.alias,
        action: "远程上传",
        approved: false,
        result: approval.reason,
        summary: `上传 ${input.localPaths.join("、")} 到 ${input.remoteDirectory}`, 
        details: {
          localPaths: input.localPaths,
          remoteDirectory: input.remoteDirectory,
          recursive: input.recursive,
          preserveTimes: input.preserveTimes,
          purpose,
          approvalMode,
        },
      });
      return approvalDenied(approval, "远程上传");
    }
  }

  const uploadOptions = {
    recursive: input.recursive,
    preserveTimes: input.preserveTimes,
    timeoutSeconds: input.timeoutSeconds,
  };
  const result = await transferWithFallback(
    profile,
    () => uploadPathsPersistent(profile, input.localPaths, input.remoteDirectory, uploadOptions),
    () => uploadPaths(profile, input.localPaths, input.remoteDirectory, uploadOptions),
  );
  audit(vault, {
    alias: profile.alias,
    action: "远程上传",
    approved: modeDecision === "allow" ? "会话免确认" : true,
    result: result.exitCode === 0 ? "成功" : "失败",
    summary: `上传 ${input.localPaths.join("、")} 到 ${input.remoteDirectory}`, 
    details: {
      localPaths: input.localPaths,
      remoteDirectory: input.remoteDirectory,
      recursive: input.recursive,
      preserveTimes: input.preserveTimes,
      purpose,
      approvalMode,
      ...operationResultDetails(result),
    },
  });
  return {
    status: result.exitCode === 0 ? "已上传" : "失败",
    action: "远程上传",
    approval: modeDecision === "allow" ? "会话免确认" : "已同意",
    profile: publicProfile(profile),
    remoteDirectory: input.remoteDirectory,
    localPaths: input.localPaths,
    recursive: input.recursive,
    preserveTimes: input.preserveTimes,
    purpose,
    result,
  };
}

async function handleDeploy(args) {
  const vault = readVault();
  const profile = resolveProfile(vault, args.alias);
  const input = validateDeployInputs(args, true);
  const postCommand = cleanText(args.postCommand || "", "postCommand", MAX_MESSAGE_LENGTH);
  const purpose = requireString(args.purpose, "purpose", { maxLength: 1000 });
  const modeDecision = currentApprovalDecision();
  if (modeDecision === "block") {
    return blockedByReadOnlyMode("远程部署");
  }
  if (modeDecision === "ask") {
    const approval = await askApproval({
      title: postCommand
        ? "我同意上传文件并执行部署命令"
        : "我同意上传文件到远程服务器",
      message: postCommand ? "部署包含文件上传和远程命令" : "部署包含文件上传",
      details: `服务器：${profileSummary(profile)}
本地路径：${previewPathList(input.localPaths)}
远程目录：${input.remoteDirectory}
传输方式：SFTP${input.recursive ? "（递归）" : ""}，共约 ${input.descriptor.totalFiles} 个文件，${formatBytes(input.descriptor.totalBytes)}
${postCommand ? `部署后命令：\n${limitPreviewLines(postCommand, 4)}\n` : ""}${purpose ? `用途：${purpose}\n` : ""}影响：远程目录将被创建或覆盖同名文件${postCommand ? "，随后执行上述命令" : ""}。`,
    });
    if (!approval.approved) {
      audit(vault, {
        alias: profile.alias,
        action: "远程部署",
        approved: false,
        result: approval.reason,
        summary: `部署 ${input.localPaths.join("、")} 到 ${input.remoteDirectory}${postCommand ? `，然后执行：${postCommand}` : ""}`,
        details: {
          localPaths: input.localPaths,
          remoteDirectory: input.remoteDirectory,
          postCommand,
          purpose,
          approvalMode,
        },
      });
      return approvalDenied(approval, "远程部署");
    }
  }

  const uploadResult = await uploadPaths(profile, input.localPaths, input.remoteDirectory, {
    recursive: input.recursive,
    preserveTimes: input.preserveTimes,
    timeoutSeconds: input.timeoutSeconds,
  });
  let commandResult;
  if (uploadResult.exitCode === 0 && postCommand) {
    commandResult = hasPersistentSession(profile)
      ? await runRemoteCommandPersistent(profile, postCommand, {
          timeoutSeconds: input.timeoutSeconds,
        })
      : await runRemoteCommand(profile, postCommand, {
          timeoutSeconds: input.timeoutSeconds,
        });
  }
  const success = uploadResult.exitCode === 0 && (!postCommand || commandResult?.exitCode === 0);
  // 部署失败时对齐传输/命令的分类，避免只知道"失败了"。
  let deployFailure = null;
  if (!success) {
    const failedStep = uploadResult.exitCode !== 0 ? uploadResult : commandResult;
    if (failedStep) {
      deployFailure = classifyRemoteFailure(
        [failedStep.stderr, failedStep.stdout].filter(Boolean).join("\n"),
        failedStep.exitCode,
      );
      if (deployFailure) {
        const stepName = uploadResult.exitCode !== 0 ? "上传" : "部署后命令";
        deployFailure = {
          kind: deployFailure.kind,
          hint:
            stepName + "退出码 " + failedStep.exitCode + "。" +
            deployFailure.hint +
            (stepName === "部署后命令" ? "可先用 ssh_exec 单独执行该命令排查。" : ""),
        };
      }
    }
  }
  audit(vault, {
    alias: profile.alias,
    action: "远程部署",
    approved: modeDecision === "allow" ? "会话免确认" : true,
    result: success ? "成功" : "失败",
    summary: `部署 ${input.localPaths.join("、")} 到 ${input.remoteDirectory}${postCommand ? `，然后执行：${postCommand}` : ""}`,
    details: {
      localPaths: input.localPaths,
      remoteDirectory: input.remoteDirectory,
      postCommand,
      purpose,
      approvalMode,
      uploadResult: operationResultDetails(uploadResult),
      commandResult: operationResultDetails(commandResult),
    },
  });
  return {
    status: success ? "已部署" : uploadResult.exitCode === 0 ? "部分失败" : "失败",
    action: "远程部署",
    approval: modeDecision === "allow" ? "会话免确认" : "已同意",
    profile: publicProfile(profile),
    remoteDirectory: input.remoteDirectory,
    localPaths: input.localPaths,
    postCommand,
    recursive: input.recursive,
    preserveTimes: input.preserveTimes,
    purpose,
    failureKind: deployFailure?.kind || null,
    failureHint: deployFailure?.hint || null,
    uploadResult,
    commandResult,
  };
}
async function handleDownload(args) {
  const vault = readVault();
  const profile = resolveProfile(vault, args.alias);
  const remotePaths = Array.isArray(args.remotePaths)
    ? args.remotePaths.map((item) => validateRemotePath(item, "remotePaths[]"))
    : [];
  if (remotePaths.length === 0) {
    throw new ToolInputError("远程路径至少需要包含一个远程文件或目录。");
  }
  if (remotePaths.length > 50) {
    throw new ToolInputError("远程路径最多包含 50 项。");
  }
  const localDirectory = validateLocalPath(args.localDirectory, "localDirectory");
  const recursive = args.recursive !== false;
  const preserveTimes = args.preserveTimes !== false;
  const timeoutSeconds = validateTimeoutSeconds(args.timeoutSeconds);
  const purpose = requireString(args.purpose, "purpose", { maxLength: 1000 });

  const modeDecision = currentApprovalDecision();
  if (modeDecision === "block") {
    return blockedByReadOnlyMode("远程下载");
  }
  if (modeDecision === "ask") {
    const approval = await askApproval({
      title: "我同意从远程服务器下载文件",
      message: "下载会把远程文件写入本机",
      details: `服务器：${profileSummary(profile)}
远程路径：${previewPathList(remotePaths)}
本机目录：${localDirectory}
传输方式：SFTP${recursive ? "（递归）" : ""}
${purpose ? `用途：${purpose}\n` : ""}影响：本机目录中可能出现新增或覆盖文件。`,
    });
    if (!approval.approved) {
      audit(vault, {
        alias: profile.alias,
        action: "远程下载",
        approved: false,
        result: approval.reason,
        summary: `从 ${remotePaths.join("、")} 下载到 ${localDirectory}`,
        details: {
          remotePaths,
          localDirectory,
          recursive,
          preserveTimes,
          purpose,
          approvalMode,
        },
      });
      return approvalDenied(approval, "远程下载");
    }
  }

  const downloadOptions = { recursive, preserveTimes, timeoutSeconds };
  const result = await transferWithFallback(
    profile,
    () => downloadPathsPersistent(profile, remotePaths, localDirectory, downloadOptions),
    () => downloadPaths(profile, remotePaths, localDirectory, downloadOptions),
  );
  audit(vault, {
    alias: profile.alias,
    action: "远程下载",
    approved: modeDecision === "allow" ? "会话免确认" : true,
    result: result.exitCode === 0 ? "成功" : "失败",
    summary: `从 ${remotePaths.join("、")} 下载到 ${localDirectory}`,
    details: {
      remotePaths,
      localDirectory,
      recursive,
      preserveTimes,
      purpose,
      approvalMode,
      ...operationResultDetails(result),
    },
  });
  return {
    status: result.exitCode === 0 ? "已下载" : "失败",
    action: "远程下载",
    approval: modeDecision === "allow" ? "会话免确认" : "已同意",
    profile: publicProfile(profile),
    remotePaths,
    localDirectory,
    recursive,
    preserveTimes,
    purpose,
    result,
  };
}

function formatToolError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("MCP 请求超时") || message.includes("MCP request timed out")) {
    return "确认表单等待超时（5 分钟），操作未执行。请重试，或新建任务后重新操作。";
  }
  if (message.includes("ElicitRequestParamsWire") || message.includes("elicitation")) {
    return "当前 Codex 客户端无法打开确认表单，操作未执行。请确保使用已更新的 SSH 管理插件，并在新任务中重试。";
  }
  return message;
}

async function handleToolCall(id, params) {
  const name = params?.name;
  const args = params?.arguments && typeof params.arguments === "object" ? params.arguments : {};
  currentToolCall = { name, args, startedAt: Date.now() };
  try {
    switch (name) {
      case "ssh_profile_list": {
        const vault = readVault();
        return toolResult(id, {
          status: "正常",
          vaultHome: getVaultHome(),
          count: Object.keys(vault.profiles).length,
          profiles: profileChoices(vault),
        });
      }
      case "ssh_vault_status": {
        return toolResult(id, {
          status: "正常",
          vaultHome: getVaultHome(),
          exists: vaultExists(),
          protection: `${getKeyProtection()} + AES-256-GCM`,
          approvalMode,
          sessionAutoTtlMinutes: Math.round(SESSION_AUTO_TTL_MS / 60000),
          sessionAutoRestored: sessionAutoRestoredAt ? new Date(sessionAutoRestoredAt).toISOString() : null,
          sessionAutoExpiresAt: sessionAutoRestoredAt
            ? new Date(sessionAutoRestoredAt + SESSION_AUTO_TTL_MS).toISOString()
            : null,
          dashboard: getDashboardStatus(),
          persistentSessions: getPersistentSessionStatus().length,
          persistentSftpSessions: getPersistentSftpStatus().length,
          profileCount: Object.keys(readVault().profiles).length,
        });
      }
      case "ssh_profile_upsert":
        return toolResult(id, await handleProfileUpsert(args));
      case "ssh_profile_remove":
        return toolResult(id, await handleProfileRemove(args));
      case "ssh_session_open":
        return toolResult(id, await handleSessionOpen(args));
      case "ssh_session_close":
        return toolResult(id, await handleSessionClose(args));
      case "ssh_session_status":
        return toolResult(id, handleSessionStatus());
      case "ssh_session_register":
        return toolResult(id, await handleSessionRegister(args));
      case "ssh_set_approval_mode":
        return toolResult(id, await handleSetApprovalMode(args));
      case "ssh_operation_dashboard":
        return toolResult(id, await handleOperationDashboard(args));
      case "ssh_terminal_open":
        return toolResult(id, await handleTerminalOpen(args));
      case "ssh_terminal_write":
        return toolResult(id, handleTerminalWrite(args));
      case "ssh_terminal_read":
        return toolResult(id, handleTerminalRead(args));
      case "ssh_terminal_close":
        return toolResult(id, handleTerminalClose(args));
      case "ssh_terminal_list":
        return toolResult(id, handleTerminalList());
      case "ssh_test_connection":
        return toolResult(id, await handleTestConnection(args));
      case "ssh_exec":
        return toolResult(id, await handleExec(args));
      case "ssh_upload":
        return toolResult(id, await handleUpload(args));
      case "ssh_deploy":
        return toolResult(id, await handleDeploy(args));
      case "ssh_download":
        return toolResult(id, await handleDownload(args));
      case "ssh_log_read": {
        const toolFilter = args.tool === undefined || args.tool === null ? null : String(args.tool).trim() || null;
        const logs = readRecentLogs({
          limit: args.limit,
          onlyErrors: Boolean(args.onlyErrors),
          tool: toolFilter,
          since: args.since,
          full: Boolean(args.full),
        });
        return toolResult(id, {
          status: "正常",
          action: "读取日志",
          logDirectory: getLogDirectory(),
          currentFile: logs.currentFile,
          fileCount: logs.fileCount,
          totalBytes: logs.totalBytes,
          keepDays: logs.keepDays,
          returned: logs.returned,
          onlyErrors: logs.onlyErrors,
          toolFilter: logs.toolFilter,
          since: logs.since,
          full: logs.full,
          entries: logs.entries,
        });
      }
      default:
        sendError(id, JsonRpcError.INVALID_PARAMS, `未知工具：${name || ""}`);
    }
  } catch (error) {
    const message = formatToolError(error);
    toolResult(
      id,
      {
        status: "错误",
        action: name || "未知",
        error: message,
      },
      { isError: true },
    );
  }
}
const TOOLS = [
  {
    name: "ssh_profile_list",
    title: "列出已保存的 SSH 服务器",
    description: "列出已保存的服务器别名和非敏感连接信息，不返回密码或私钥口令。",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "ssh_vault_status",
    title: "查看 SSH 仓库状态",
    description: "查看本地加密仓库的位置、保护方式和已保存配置数量。",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "ssh_session_open",
    title: "打开 OpenSSH 持久连接",
    description: "为已保存的服务器保持常驻 OpenSSH 远程命令连接和常驻 SFTP 连接。后续 ssh_exec、部署后命令、上传和下载都会复用长连接。",
    inputSchema: {
      type: "object",
      properties: { alias: { type: "string", description: "已保存的服务器别名。" } },
      required: ["alias"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "ssh_session_close",
    title: "关闭 OpenSSH 持久连接",
    description: "关闭指定服务器的常驻 OpenSSH 连接。",
    inputSchema: {
      type: "object",
      properties: { alias: { type: "string", description: "已保存的服务器别名。" } },
      required: ["alias"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "ssh_session_status",
    title: "查看 OpenSSH 持久连接",
    description: "查看当前所有常驻 OpenSSH 连接。",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "ssh_session_register",
    title: "注册 SSH 实时会话",
    description: "为当前任务注册一个可切换的 SSH 操作会话名称，后续所有 SSH 操作都会归入该会话，并在实时面板中分组显示。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "会话名称，例如：生产服务器维护、客户服务器部署。" },
        id: { type: "string", description: "可选的自定义会话 ID；不填则使用当前 MCP 会话 ID。" },
      },
      required: ["name"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "ssh_terminal_open",
    title: "打开交互式 SSH 终端",
    description: "使用已保存的服务器配置打开一个持续连接的交互式 SSH shell。打开后可通过 ssh_terminal_write 连续发送命令，通过 ssh_terminal_read 读取输出。",
    inputSchema: {
      type: "object",
      properties: {
        alias: { type: "string", description: "已保存的服务器别名。" },
      },
      required: ["alias"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "ssh_terminal_write",
    title: "向交互式 SSH 终端发送输入",
    description: "向已打开的交互式 SSH 终端写入文本。通常需要以换行符结尾来执行命令。",
    inputSchema: {
      type: "object",
      properties: {
        terminalId: { type: "string", description: "ssh_terminal_open 返回的终端 ID。" },
        data: { type: "string", description: "要发送的终端输入。" },
      },
      required: ["terminalId", "data"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "ssh_terminal_read",
    title: "读取交互式 SSH 终端输出",
    description: "读取指定终端尚未读取的输出内容。",
    inputSchema: {
      type: "object",
      properties: {
        terminalId: { type: "string", description: "交互式终端 ID。" },
      },
      required: ["terminalId"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "ssh_terminal_close",
    title: "关闭交互式 SSH 终端",
    description: "关闭指定的交互式 SSH 终端连接。",
    inputSchema: {
      type: "object",
      properties: {
        terminalId: { type: "string", description: "交互式终端 ID。" },
      },
      required: ["terminalId"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "ssh_terminal_list",
    title: "列出交互式 SSH 终端",
    description: "列出当前 MCP 服务中打开的交互式 SSH 终端。",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "ssh_operation_dashboard",
    title: "打开 SSH 实时操作面板",
    description: "启动或管理本机 SSH 实时操作面板。面板通过 SSE 实时显示 Codex 执行的 SSH 命令、上传、下载、部署、退出码和输出。",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["打开", "状态", "停止"],
          default: "打开",
          description: "面板操作：打开、状态或停止。",
        },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "ssh_log_read",
    title: "读取 SSH 操作日志",
    description: "读取 ssh-manager 的本地操作日志，用于排查失败原因。日志为 JSONL，已自动脱敏，包含每次工具调用的参数、耗时、结果、失败类型、原始 stdout/stderr。默认返回最近 50 条。",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          default: 50,
          description: "返回最近的多少条日志。",
        },
        onlyErrors: {
          type: "boolean",
          default: false,
          description: "只返回失败/出错的记录。",
        },
        tool: {
          type: "string",
          description: "只返回指定工具的日志，例如 ssh_upload。",
        },
        since: {
          type: "string",
          description: "只返回该时间之后的日志。支持 ISO 时间戳或相对时间，例如 30m、2h、1d。",
        },
        full: {
          type: "boolean",
          default: false,
          description: "为 true 时返回未截断的 stdout/stderr（默认会截断到 2000 字符）。",
        },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "ssh_set_approval_mode",
    title: "设置 SSH 操作模式",
    description: "设置当前 MCP 会话的操作模式。默认执行：只读免询问，敏感操作仍确认；只读免确认：仅执行只读，阻止变更；会话免确认：本次会话所有操作默认直接执行。",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["默认执行", "只读免确认", "会话免确认"],
          description: "要设置的操作模式。",
        },
      },
      required: ["mode"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "ssh_profile_upsert",
    title: "添加或更新 SSH 服务器配置",
    description: "打开安全的 Codex 表单，添加或更新服务器、账户、密码、私钥或私钥口令。敏感字段只保存在本机，不会返回给模型。",
    inputSchema: {
      type: "object",
      properties: {
        alias: { type: "string", description: "已有或新的服务器别名，支持中文。" },
        host: { type: "string", description: "可选的服务器地址默认值。" },
        port: { type: "string", description: "可选的 SSH 端口默认值。" },
        username: { type: "string", description: "可选的登录账户默认值。" },
        authMethod: { type: "string", enum: ["密码", "私钥", "SSH 代理"], description: "可选的认证方式默认值。" },
        privateKeyPath: { type: "string", description: "可选的私钥文件路径默认值。" },
        defaultRemoteDir: { type: "string", description: "可选的默认远程目录。" },
        hostKeyPolicy: { type: "string", enum: ["首次连接自动接受", "严格校验", "不校验（不安全）"], description: "可选的主机指纹策略默认值。" },
        description: { type: "string", description: "可选的备注。" },
      },
      required: ["alias"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "ssh_profile_remove",
    title: "删除已保存的 SSH 配置",
    description: "从本机加密仓库中删除指定的 SSH 配置。调用前先用一句简短中文说明删除目标。",
    inputSchema: {
      type: "object",
      properties: { alias: { type: "string", description: "要删除的服务器别名。" } },
      required: ["alias"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "ssh_test_connection",
    title: "测试 SSH 连接",
    description: "使用已保存的凭据连接服务器并执行无害检查，不询问服务器、账户或密码。",
    inputSchema: {
      type: "object",
      properties: {
        alias: { type: "string", description: "已保存的服务器别名。" },
        timeoutSeconds: { type: "integer", minimum: 1, maximum: 900, description: "连接超时时间，单位秒。" },
      },
      required: ["alias"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "ssh_exec",
    title: "执行远程 SSH 命令",
    description: "使用已保存的配置执行远程命令。调用前必须先用一句简短中文说明服务器和操作内容；只读诊断按默认执行，敏感操作按当前模式执行。",
    inputSchema: {
      type: "object",
      properties: {
        alias: { type: "string", description: "已保存的服务器别名。" },
        command: { type: "string", description: "要执行的完整远程命令，建议每次只执行一条命令。" },
        purpose: { type: "string", description: "执行该命令的简短用途。" },
        timeoutSeconds: { type: "integer", minimum: 1, maximum: 900, description: "命令超时时间，单位秒。" },
        stream: {
          type: "boolean",
          default: true,
          description: "是否把命令的实时输出推送到操作面板（默认开启；面板未打开时不产生额外开销）。",
        },
      },
      required: ["alias", "command", "purpose"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "ssh_upload",
    title: "上传文件到服务器",
    description: "使用已保存的凭据通过 SFTP 上传本地文件或目录。调用前必须先用一句简短中文说明服务器、本地路径和远程目录。",
    inputSchema: {
      type: "object",
      properties: {
        alias: { type: "string", description: "已保存的服务器别名。" },
        localPaths: { type: "array", items: { type: "string" }, description: "本地文件或目录的绝对路径。" },
        remoteDirectory: { type: "string", description: "远程目标目录。" },
        recursive: { type: "boolean", default: true, description: "是否递归传输目录。" },
        preserveTimes: { type: "boolean", default: true, description: "是否保留文件时间戳。" },
        purpose: { type: "string", description: "上传用途的简短说明。" },
        timeoutSeconds: { type: "integer", minimum: 1, maximum: 900, description: "传输超时时间，单位秒。" },
      },
      required: ["alias", "localPaths", "remoteDirectory", "purpose"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "ssh_deploy",
    title: "部署文件到服务器",
    description: "上传文件或目录，并可选执行部署后命令。调用前必须先用一句简短中文说明部署目标、路径和部署后命令。",
    inputSchema: {
      type: "object",
      properties: {
        alias: { type: "string", description: "已保存的服务器别名。" },
        localPaths: { type: "array", items: { type: "string" }, description: "要部署的本地文件或目录绝对路径。" },
        remoteDirectory: { type: "string", description: "远程目标目录。" },
        postCommand: { type: "string", description: "上传成功后可选执行的命令。" },
        recursive: { type: "boolean", default: true, description: "是否递归传输目录。" },
        preserveTimes: { type: "boolean", default: true, description: "是否保留文件时间戳。" },
        purpose: { type: "string", description: "部署用途的简短说明。" },
        timeoutSeconds: { type: "integer", minimum: 1, maximum: 900, description: "传输和命令超时时间，单位秒。" },
      },
      required: ["alias", "localPaths", "remoteDirectory", "purpose"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "ssh_download",
    title: "从服务器下载文件",
    description: "使用已保存的凭据通过 SFTP 下载远程文件或目录。调用前必须先用一句简短中文说明远程来源和本机目标目录。",
    inputSchema: {
      type: "object",
      properties: {
        alias: { type: "string", description: "已保存的服务器别名。" },
        remotePaths: { type: "array", items: { type: "string" }, description: "远程文件或目录路径。" },
        localDirectory: { type: "string", description: "本机目标目录的绝对路径。" },
        recursive: { type: "boolean", default: true, description: "是否递归下载目录。" },
        preserveTimes: { type: "boolean", default: true, description: "是否保留文件时间戳。" },
        purpose: { type: "string", description: "下载用途的简短说明。" },
        timeoutSeconds: { type: "integer", minimum: 1, maximum: 900, description: "传输超时时间，单位秒。" },
      },
      required: ["alias", "remotePaths", "localDirectory", "purpose"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
];
async function handleRequest(message) {
  const { id, method, params } = message;

  if (method === "initialize") {
    sendResult(id, {
      protocolVersion: params?.protocolVersion || "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions:
        "使用已保存的 SSH 配置，不要重复询问服务器、账户或密码。所有敏感操作都必须经过 MCP 确认流程；用户拒绝时不得执行。",
    });
    return;
  }

  if (method === "ping") {
    sendResult(id, {});
    return;
  }

  if (method === "tools/list") {
    sendResult(id, { tools: TOOLS });
    return;
  }

  
if (method === "tools/call") {
    if (id === undefined) {
      return;
    }
    await handleToolCall(id, params);
    return;
  }

  if (method === "notifications/initialized" || method === "notifications/cancelled") {
    return;
  }

  if (id !== undefined) {
    sendError(id, JsonRpcError.METHOD_NOT_FOUND, `未找到方法：${method}`);
  }
}

const lines = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

// 宿主（Codex）关闭 stdin 说明会话结束，直接退出，避免残留子进程把进程挂住。
lines.on("close", () => process.exit(0));
lines.on("line", (line) => {
  if (line.trim().length === 0) {
    return;
  }

  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    process.stderr.write(`已忽略无效的 JSON-RPC 行： ${error instanceof Error ? error.message : String(error)}\n`);
    return;
  }

  if (message.method === undefined && message.id !== undefined) {
    const pending = pendingRequests.get(message.id);
    if (pending !== undefined) {
      pendingRequests.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error !== undefined) {
        pending.reject(new Error(message.error.message || "MCP 请求失败。"));
      } else {
        pending.resolve(message.result);
      }
    }
    return;
  }

  void handleRequest(message).catch((error) => {
    if (message.id !== undefined) {
      sendError(
        message.id,
        JsonRpcError.INTERNAL_ERROR,
        error instanceof Error ? error.message : String(error),
      );
    }
  });
});
