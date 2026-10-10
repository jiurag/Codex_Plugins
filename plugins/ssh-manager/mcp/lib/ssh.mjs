import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { ensurePrivateDirectory, expandHome, getVaultHome } from "./vault.mjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(MODULE_DIR, "..", "..");
const DEFAULT_TIMEOUT_SECONDS = 120;
// 只读诊断类命令给更短的默认超时，避免卡在没响应的连接上。
const READ_ONLY_TIMEOUT_SECONDS = 30;
// 常驻 SSH 会话空闲超过这个时间就回收，避免复用已经失效的连接。
const PERSISTENT_IDLE_MS = 5 * 60 * 1000;
const MAX_TIMEOUT_SECONDS = 900;
const MAX_CAPTURE_BYTES = 512 * 1024;
const SAFE_COMMAND_MAX_LENGTH = 20_000;
const SHELL_META_PATTERN = /[;&|`$(){}<>\r\n]/;
const SECRET_PATH_PATTERN = /(?:^|[\s/])(?:\.env(?:\.[A-Za-z0-9_-]+)?|id_rsa|id_dsa|id_ecdsa|id_ed25519|credentials?|secrets?|tokens?|shadow|gshadow|passwd|\.pem|\.key)(?:$|[\s/])/i;

const SAFE_READ_COMMANDS = [
  /^pwd$/,
  /^whoami$/,
  /^id(?:\s+[^\s]+)?$/,
  /^uname(?:\s+-[a-zA-Z]+)*$/,
  /^hostname$/,
  /^uptime$/,
  /^date(?:\s+[^\r\n;&|`$(){}<>]+)?$/,
  /^ls(?:\s+[^\r\n;&|`$(){}<>]+)*$/,
  /^stat(?:\s+[^\r\n;&|`$(){}<>]+)+$/,
  /^df(?:\s+[^\r\n;&|`$(){}<>]+)*$/,
  /^du(?:\s+[^\r\n;&|`$(){}<>]+)+$/,
  /^free(?:\s+[^\r\n;&|`$(){}<>]+)*$/,
  /^vmstat(?:\s+[^\r\n;&|`$(){}<>]+)*$/,
  /^ps(?:\s+[^\r\n;&|`$(){}<>]+)*$/,
  /^ss(?:\s+[^\r\n;&|`$(){}<>]+)*$/,
  /^netstat(?:\s+[^\r\n;&|`$(){}<>]+)*$/,
  /^ip\s+(?:addr|address|route|link)(?:\s+[^\r\n;&|`$(){}<>]+)*$/,
  /^systemctl\s+(?:status|show|is-active|is-enabled|list-units|list-unit-files)(?:\s+[^\r\n;&|`$(){}<>]+)*$/,
  /^docker\s+(?:ps|images|version|info)(?:\s+[^\r\n;&|`$(){}<>]+)*$/,
  /^kubectl\s+(?:get|version)(?:\s+[^\r\n;&|`$(){}<>]+)*$/,
  /^git\s+(?:status|log|diff|show|branch|remote|rev-parse)(?:\s+[^\r\n;&|`$(){}<>]+)*$/,
  /^pm2\s+(?:status|list)(?:\s+[^\r\n;&|`$(){}<>]+)*$/,
  /^nginx\s+-t$/,
  /^(?:node|npm|php|python|python3|go|java|docker-compose|docker)\s+--?version$/,
  /^docker\s+compose\s+(?:ps|config)(?:\s+[^\r\n;&|`$(){}<>]+)*$/,
  /^docker-compose\s+(?:ps|config)(?:\s+[^\r\n;&|`$(){}<>]+)*$/,
];

const DESTRUCTIVE_PATTERN = /\b(?:rm|rmdir|unlink|shred|dd|mkfs|fdisk|parted|truncate|chmod|chown|chgrp|kill|pkill|killall|shutdown|reboot|halt|poweroff|iptables|ip6tables|nft|ufw|firewall-cmd|systemctl\s+(?:stop|restart|start|disable|enable|mask|unmask)|service\s+\S+\s+(?:stop|restart|start)|docker\s+(?:rm|rmi|stop|kill|prune|system\s+prune)|kubectl\s+delete|sed\s+-i|tee\b|mv\b|cp\b|tar\s+.*\s-x)\b/i;

export class ToolInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "ToolInputError";
  }
}

export function requireString(value, field, options = {}) {
  const { allowEmpty = false, maxLength = 4096 } = options;
  if (typeof value !== "string") {
    throw new ToolInputError(`${field} 必须是字符串。`);
  }
  if (!allowEmpty && value.length === 0) {
    throw new ToolInputError(`${field} 不能为空。`);
  }
  if (value.length > maxLength) {
    throw new ToolInputError(`${field} 太长（最多 ${maxLength} 个字符）。`);
  }
  if (!allowEmpty && value.includes("\u0000")) {
    throw new ToolInputError(`${field} 包含空字符。`);
  }
  return value;
}

export function validateAlias(value) {
  const alias = requireString(value, "alias", { maxLength: 64 }).trim();
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u.test(alias)) {
    throw new ToolInputError(
      "别名必须以字母、汉字或数字开头，且只能包含字母、汉字、数字、点、下划线或连字符。",
    );
  }
  return alias;
}

export function validateHost(value) {
  const host = requireString(value, "host", { maxLength: 255 }).trim();
  if (!/^[A-Za-z0-9._:[\]%+-]+$/.test(host) || host.startsWith("-")) {
    throw new ToolInputError("服务器地址包含不支持的字符。");
  }
  return host;
}

export function validateUsername(value) {
  const username = requireString(value, "username", { maxLength: 128 }).trim();
  if (!/^[A-Za-z0-9._@+\\-]+$/.test(username) || username.startsWith("-")) {
    throw new ToolInputError("账户名包含不支持的字符。");
  }
  return username;
}

export function validatePort(value) {
  const port = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ToolInputError("端口必须是 1 到 65535 之间的整数。");
  }
  return port;
}

export { DEFAULT_TIMEOUT_SECONDS, READ_ONLY_TIMEOUT_SECONDS };

export function validateTimeoutSeconds(value, fallback = DEFAULT_TIMEOUT_SECONDS) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const timeout = Number.parseInt(String(value), 10);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_SECONDS) {
    throw new ToolInputError(`超时时间必须是 1 到 ${MAX_TIMEOUT_SECONDS} 之间的整数。`);
  }
  return timeout;
}

export function validateHostKeyPolicy(value) {
  const policy = value || "accept-new";
  if (!["accept-new", "strict", "insecure"].includes(policy)) {
    throw new ToolInputError("主机指纹策略无效。");
  }
  return policy;
}

export function validateRemotePath(value, field = "remote path") {
  const remotePath = requireString(value, field, { maxLength: 4096 });
  if (remotePath.includes("\u0000") || remotePath.includes("\r") || remotePath.includes("\n")) {
    throw new ToolInputError(`${field} 包含不支持的控制字符。`);
  }
  if (!(remotePath.startsWith("/") || remotePath.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(remotePath))) {
    throw new ToolInputError(`${field} 必须是绝对 POSIX 路径、相对用户目录路径或 Windows 盘符路径。`);
  }
  return remotePath;
}

export function validateLocalPath(value, field = "local path") {
  const requested = requireString(value, field, { maxLength: 4096 });
  const expanded = path.resolve(expandHome(requested));
  if (!fs.existsSync(expanded)) {
    throw new ToolInputError(`${field} 不存在：${expanded}`);
  }
  return expanded;
}

export function validateSecret(value, field = "secret", allowEmpty = true) {
  if (value === undefined || value === null) {
    return "";
  }
  const secret = requireString(value, field, { allowEmpty, maxLength: 4096 });
  if (secret.includes("\r") || secret.includes("\n") || secret.includes("\u0000")) {
    throw new ToolInputError(`${field} 不能包含换行或空字符。`);
  }
  return secret;
}

export function publicProfile(profile) {
  return {
    alias: profile.alias,
    host: profile.host,
    port: profile.port,
    username: profile.username,
    authMethod: profile.authMethod,
    privateKeyPath: profile.authMethod === "key" ? profile.privateKeyPath : undefined,
    defaultRemoteDir: profile.defaultRemoteDir || undefined,
    hostKeyPolicy: profile.hostKeyPolicy,
    description: profile.description || undefined,
    hasPassword: profile.authMethod === "password" && Boolean(profile.password),
    hasKeyPassphrase: profile.authMethod === "key" && Boolean(profile.privateKeyPassphrase),
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

export function connectionTarget(profile) {
  return `${profile.username}@${profile.host}`;
}

export function isSafeReadOnlyCommand(command) {
  const value = requireString(command, "command", { maxLength: SAFE_COMMAND_MAX_LENGTH }).trim();
  if (value.length === 0 || SHELL_META_PATTERN.test(value) || value.includes("\u0000")) {
    return false;
  }
  if (SECRET_PATH_PATTERN.test(value)) {
    return false;
  }
  if (value.includes(" --follow") || value.includes(" -f") || /\btail\s+-[^\s]*f/.test(value)) {
    return false;
  }
  return SAFE_READ_COMMANDS.some((pattern) => pattern.test(value));
}

export function isDestructiveCommand(command) {
  return DESTRUCTIVE_PATTERN.test(String(command || ""));
}

export function explainCommandClassification(command) {
  if (isSafeReadOnlyCommand(command)) {
    return { approvalRequired: false, risk: "只读" };
  }
  return {
    approvalRequired: true,
    risk: isDestructiveCommand(command) ? "破坏性" : "变更",
  };
}

function knownHostsPath() {
  const directory = getVaultHome();
  ensurePrivateDirectory(directory);
  return path.join(directory, "known_hosts");
}

function strictHostKeyOption(policy) {
  switch (policy) {
    case "strict":
      return "yes";
    case "insecure":
      return "no";
    case "accept-new":
    default:
      return "accept-new";
  }
}

function connectionArguments(profile, { includePort = true } = {}) {
  const args = [
    "-o", "ConnectTimeout=15",
    "-o", "ConnectionAttempts=2",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-o", `StrictHostKeyChecking=${strictHostKeyOption(profile.hostKeyPolicy)}`,
    "-o", `UserKnownHostsFile=${knownHostsPath()}`,
    "-o", "LogLevel=ERROR",
  ];

  if (includePort) {
    args.push("-p", String(profile.port));
  }

  if (profile.authMethod === "password") {
    args.push(
      "-o", "PreferredAuthentications=password,keyboard-interactive",
      "-o", "PubkeyAuthentication=no",
      "-o", "NumberOfPasswordPrompts=1",
    );
  } else if (profile.authMethod === "key") {
    const keyPath = path.resolve(expandHome(profile.privateKeyPath));
    if (!fs.existsSync(keyPath)) {
      throw new ToolInputError(`未找到私钥文件：${keyPath}`);
    }
    args.push(
      "-i", keyPath,
      "-o", "IdentitiesOnly=yes",
      "-o", "PreferredAuthentications=publickey,keyboard-interactive",
    );
  } else {
    args.push("-o", "PreferredAuthentications=publickey,keyboard-interactive");
  }

  return args;
}

function askpassScriptPath() {
  return process.platform === "win32"
    ? path.join(PLUGIN_ROOT, "scripts", "askpass.cmd")
    : path.join(PLUGIN_ROOT, "scripts", "askpass.sh");
}

function secretForProfile(profile) {
  if (profile.authMethod === "password") {
    return profile.password || "";
  }
  if (profile.authMethod === "key") {
    return profile.privateKeyPassphrase || "";
  }
  return "";
}

function createAskpassContext(profile) {
  const secret = secretForProfile(profile);
  if (!secret) {
    return {
      env: { ...process.env },
      cleanup() {},
    };
  }

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-manager-askpass-"));
  const secretFile = path.join(temporaryDirectory, "secret.txt");
  fs.writeFileSync(secretFile, secret, { mode: 0o600 });
  let askpassPath = askpassScriptPath();
  try {
    if (process.platform === "win32") {
      fs.chmodSync(secretFile, 0o600);
    } else {
      askpassPath = path.join(temporaryDirectory, "askpass.sh");
      fs.copyFileSync(askpassScriptPath(), askpassPath);
      fs.chmodSync(secretFile, 0o600);
      fs.chmodSync(askpassPath, 0o700);
    }
  } catch {
    // Best effort. On POSIX a non-executable plugin copy is replaced by the temp copy above.
  }

  return {
    env: {
      ...process.env,
      SSH_ASKPASS: askpassPath,
      SSH_ASKPASS_REQUIRE: "force",
      DISPLAY: process.env.DISPLAY || "ssh-manager",
      SSH_MANAGER_ASKPASS_FILE: secretFile,
    },
    cleanup() {
      try {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
      } catch {
        // The askpass helper normally removes the secret file first.
      }
    },
  };
}

async function withAskpass(profile, callback) {
  const context = createAskpassContext(profile);
  try {
    return await callback(context.env);
  } finally {
    context.cleanup();
  }
}

function appendCaptured(target, chunk, state) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
  state.total += buffer.length;
  if (state.total > MAX_CAPTURE_BYTES) {
    const remaining = Math.max(0, MAX_CAPTURE_BYTES - target.length);
    if (remaining > 0) {
      target.push(buffer.subarray(0, remaining));
    }
    state.truncated = true;
    return;
  }
  target.push(buffer);
}

async function runProcess(executable, args, { env, timeoutMs = DEFAULT_TIMEOUT_SECONDS * 1000, input, onChunk } = {}) {
  const emit = typeof onChunk === "function" ? onChunk : null;
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const isNodeScript = /\.(?:mjs|cjs|js)$/i.test(executable);
    const actualExecutable = isNodeScript ? process.execPath : executable;
    const actualArgs = isNodeScript ? [executable, ...args] : args;
    const hasInput = typeof input === "string";
    const child = spawn(actualExecutable, actualArgs, {
      env: env || process.env,
      windowsHide: true,
      stdio: [hasInput ? "pipe" : "ignore", "pipe", "pipe"],
    });
    if (hasInput) {
      // sftp -b - 从 stdin 读批处理命令；提前退出时忽略 EPIPE。
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
    const stdout = [];
    const stderr = [];
    const stdoutState = { total: 0, truncated: false };
    const stderrState = { total: 0, truncated: false };
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) {
          child.kill("SIGKILL");
        }
      }, 2000).unref();
    }, timeoutMs);
    timer.unref();

    child.stdout.on("data", (chunk) => {
      appendCaptured(stdout, chunk, stdoutState);
      if (emit) emit({ stream: "stdout", text: chunk.toString("utf8") });
    });
    child.stderr.on("data", (chunk) => {
      appendCaptured(stderr, chunk, stderrState);
      if (emit) emit({ stream: "stderr", text: chunk.toString("utf8") });
    });
    child.on("error", (error) => {
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      settled = true;
      clearTimeout(timer);
      resolve({
        executable,
        exitCode: typeof code === "number" ? code : null,
        signal: signal || null,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdoutTruncated: stdoutState.truncated,
        stderrTruncated: stderrState.truncated,
      });
    });
  });
}

function validateProfileShape(profile) {
  if (!profile || typeof profile !== "object") {
    throw new ToolInputError("未找到 SSH 配置。");
  }
  validateAlias(profile.alias);
  validateHost(profile.host);
  validateUsername(profile.username);
  validatePort(profile.port);
  validateHostKeyPolicy(profile.hostKeyPolicy);
}

// 命令通过 stdin 交给远端 shell（bash -s），不再拼进命令行参数。
// 这样引号、换行、&& 、$、反引号都不会被本地 shell 或 ssh 二次解释；
// stdout / stderr 由 SSH 通道天然分离，退出码就是脚本最后一条命令的退出码。
export async function runRemoteCommand(profile, command, { timeoutSeconds, onChunk } = {}) {
  validateProfileShape(profile);
  const remoteCommand = requireString(command, "command", { maxLength: SAFE_COMMAND_MAX_LENGTH });
  const timeoutMs = validateTimeoutSeconds(timeoutSeconds) * 1000;
  const executable = process.env.SSH_MANAGER_SSH_BIN || "ssh";
  const input = remoteCommand.endsWith("\n") ? remoteCommand : remoteCommand + "\n";
  const shells = [process.env.SSH_MANAGER_REMOTE_SHELL || "bash", "sh"];
  let last = null;
  for (const shell of shells) {
    const args = ["-T", ...connectionArguments(profile), connectionTarget(profile), shell + " -s"];
    const result = await withAskpass(profile, (env) => runProcess(executable, args, { env, timeoutMs, input, onChunk }));
    last = result;
    const missingShell = /command not found|not found|No such file or directory/i.test(result.stderr) &&
      new RegExp("(^|\\W)" + shell + "(:|：)? ?(command )?not found", "i").test(result.stderr);
    if (!missingShell) {
      return result;
    }
  }
  return last;
}

const persistentSessions = new Map();

function persistentSessionKey(profile) {
  return `${profile.alias}|${profile.username}@${profile.host}:${profile.port}`;
}

function sessionResult(startedAt, stdout, stderr, exitCode, timedOut = false) {
  return {
    exitCode,
    signal: null,
    timedOut,
    durationMs: Date.now() - startedAt,
    stdout: stdout.join(""),
    stderr: stderr.join(""),
    stdoutTruncated: false,
    stderrTruncated: false,
    connectionMode: "持久连接",
  };
}

function createPersistentSession(profile) {
  validateProfileShape(profile);
  const executable = process.env.SSH_MANAGER_SSH_BIN || "ssh";
  const isNodeScript = /\.(?:mjs|cjs|js)$/i.test(executable);
  const actualExecutable = isNodeScript ? process.execPath : executable;
  const args = ["-T", ...connectionArguments(profile), connectionTarget(profile)];
  const actualArgs = isNodeScript ? [executable, ...args] : args;
  const askpass = createAskpassContext(profile);
  const child = spawn(actualExecutable, actualArgs, {
    env: askpass.env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let closed = false;
  let cleanupDone = false;
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let current = null;
  let sequence = 0;
  let queue = Promise.resolve();
  const startedAt = Date.now();

  function cleanup() {
    if (!cleanupDone) {
      cleanupDone = true;
      askpass.cleanup();
    }
  }

  function rejectCurrent(error) {
    if (!current || current.settled) {
      return;
    }
    current.settled = true;
    clearTimeout(current.timer);
    current.reject(error);
    current = null;
  }

  function finishCurrent(exitCode, timedOut = false) {
    if (!current || current.settled) {
      return;
    }
    current.settled = true;
    clearTimeout(current.timer);
    const result = sessionResult(current.startedAt, current.stdout, current.stderr, exitCode, timedOut);
    const resolve = current.resolve;
    current = null;
    resolve(result);
  }

  let chunkEmitter = null;

  function handleStdout(chunk) {
    if (chunkEmitter) chunkEmitter({ stream: "stdout", text: chunk.toString("utf8") });
    stdoutBuffer += chunk.toString("utf8");
    while (current) {
      if (!current.started) {
        const startIndex = stdoutBuffer.indexOf(current.startMarker);
        if (startIndex < 0) {
          if (stdoutBuffer.length > 256 * 1024) {
            stdoutBuffer = stdoutBuffer.slice(-16 * 1024);
          }
          return;
        }
        stdoutBuffer = stdoutBuffer.slice(startIndex + current.startMarker.length);
        current.started = true;
      }

      const endIndex = stdoutBuffer.indexOf(current.endPrefix);
      if (endIndex < 0) {
        if (stdoutBuffer.length > 0) {
          current.stdout.push(stdoutBuffer);
          stdoutBuffer = "";
        }
        return;
      }

      current.stdout.push(stdoutBuffer.slice(0, endIndex));
      stdoutBuffer = stdoutBuffer.slice(endIndex + current.endPrefix.length);
      const lineEnd = stdoutBuffer.indexOf("\n");
      if (lineEnd < 0) {
        return;
      }
      const exitText = stdoutBuffer.slice(0, lineEnd).trim();
      stdoutBuffer = stdoutBuffer.slice(lineEnd + 1);
      const exitCode = Number.parseInt(exitText, 10);
      finishCurrent(Number.isInteger(exitCode) ? exitCode : 1);
    }
  }

  function handleStderr(chunk) {
    const text = chunk.toString("utf8");
    if (current && current.started) {
      current.stderr.push(text);
    } else {
      if (chunkEmitter) chunkEmitter({ stream: "stderr", text });
    stderrBuffer += text;
      if (stderrBuffer.length > 64 * 1024) {
        stderrBuffer = stderrBuffer.slice(-8 * 1024);
      }
    }
  }

  child.stdout.on("data", handleStdout);
  child.stderr.on("data", handleStderr);
  child.on("error", (error) => {
    closed = true;
    cleanup();
    rejectCurrent(error);
  });
  child.on("close", (code, signal) => {
    closed = true;
    cleanup();
    persistentSessions.delete(persistentSessionKey(profile));
    if (current && !current.settled) {
      current.signal = signal;
      finishCurrent(typeof code === "number" ? code : 1);
    }
  });

  const session = {
    profile,
    pid: child.pid,
    startedAt: new Date(startedAt).toISOString(),
    lastUsedAt: Date.now(),
    idleMs() {
      return Date.now() - this.lastUsedAt;
    },
    exec(command, options = {}) {
      const run = () => new Promise((resolve, reject) => {
        if (closed || !child.stdin.writable) {
          reject(new Error("持久 SSH 连接已经关闭。"));
          return;
        }
        const remoteCommand = requireString(command, "command", { maxLength: SAFE_COMMAND_MAX_LENGTH });
        const timeoutMs = validateTimeoutSeconds(options.timeoutSeconds) * 1000;
        const id = String(++sequence);
        chunkEmitter = typeof options.onChunk === "function" ? options.onChunk : null;
        const startMarker = `__SSH_MANAGER_BEGIN_${id}__`;
        const endPrefix = `__SSH_MANAGER_END_${id}__:`;
        current = {
          startMarker,
          endPrefix,
          started: false,
          settled: false,
          stdout: [],
          stderr: [],
          startedAt: Date.now(),
          resolve,
          reject,
          timer: setTimeout(() => {
            if (!current || current.settled) {
              return;
            }
            const pending = current;
            current = null;
            pending.settled = true;
            clearTimeout(pending.timer);
            pending.reject(new Error("持久 SSH 命令执行超时。"));
            session.close();
          }, timeoutMs),
        };
        child.stdin.write(
          `printf '\\n%s\\n' '${startMarker}'\n`
          + `${remoteCommand}\n`
          + `__ssh_manager_rc=$?\n`
          + `printf '\\n%s%s\\n' '${endPrefix}' "$__ssh_manager_rc"\n`,
        );
      });
      const result = queue.then(run, run);
      queue = result.catch(() => {});
      return result;
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      cleanup();
      try {
        child.stdin.end("exit\n");
      } catch {
        // Ignore stdin close failures.
      }
      child.kill("SIGTERM");
      const forceTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 2000);
      forceTimer.unref();
    },
    isAlive() {
      return !closed;
    },
    info() {
      return {
        alias: profile.alias,
        host: profile.host,
        username: profile.username,
        port: profile.port,
        pid: child.pid,
        startedAt: new Date(startedAt).toISOString(),
        connected: !closed,
        mode: "OpenSSH 持久连接",
      };
    },
  };

  persistentSessions.set(persistentSessionKey(profile), session);
  return session;
}

export function getPersistentSessionStatus() {
  return [...persistentSessions.values()].filter((session) => session.isAlive()).map((session) => session.info());
}

export function hasPersistentSession(profile) {
  const session = persistentSessions.get(persistentSessionKey(profile));
  return Boolean(session && session.isAlive());
}

export function openPersistentSession(profile) {
  validateProfileShape(profile);
  const key = persistentSessionKey(profile);
  const existing = persistentSessions.get(key);
  if (existing && existing.isAlive()) {
    return existing.info();
  }
  return createPersistentSession(profile).info();
}

export function closePersistentSession(profileOrAlias) {
  const key = typeof profileOrAlias === "string" ? profileOrAlias : persistentSessionKey(profileOrAlias);
  const session = persistentSessions.get(key)
    || [...persistentSessions.values()].find((item) => item.profile.alias === profileOrAlias);
  if (!session) {
    return false;
  }
  const info = session.info();
  session.close();
  persistentSessions.delete(key);
  persistentSessions.delete(persistentSessionKey(session.profile));
  return info;
}

export async function runRemoteCommandPersistent(profile, command, options = {}) {
  const key = persistentSessionKey(profile);
  let session = persistentSessions.get(key);
  // 空闲太久的会话可能已被中间设备断开，主动回收重建。
  if (
    session &&
    session.isAlive() &&
    typeof session.idleMs === "function" &&
    session.idleMs() > PERSISTENT_IDLE_MS
  ) {
    session.close();
    persistentSessions.delete(key);
    session = null;
  }
  if (!session || !session.isAlive()) {
    session = createPersistentSession(profile);
  }
  session.lastUsedAt = Date.now();
  const result = await session.exec(command, options);
  session.lastUsedAt = Date.now();
  return result;
}

const persistentSftpSessions = new Map();

function persistentSftpKey(profile) {
  return `sftp|${profile.alias}|${profile.username}@${profile.host}:${profile.port}`;
}

function sftpQuote(value) {
  const normalized = String(value).replace(/\\/g, "/");
  return `"${normalized.replace(/"/g, '\\"')}"`;
}

function combinePersistentResults(results, startedAt) {
  return {
    exitCode: results.some((item) => item.exitCode !== 0) ? 1 : 0,
    signal: null,
    timedOut: results.some((item) => item.timedOut),
    durationMs: Date.now() - startedAt,
    stdout: results.map((item) => item.stdout || "").join("\n"),
    stderr: results.map((item) => item.stderr || "").join("\n"),
    stdoutTruncated: results.some((item) => item.stdoutTruncated),
    stderrTruncated: results.some((item) => item.stderrTruncated),
    connectionMode: "SFTP 长连接",
  };
}

function createPersistentSftpSession(profile) {
  validateProfileShape(profile);
  const executable = process.env.SSH_MANAGER_SFTP_BIN || "sftp";
  const isNodeScript = /\.(?:mjs|cjs|js)$/i.test(executable);
  const actualExecutable = isNodeScript ? process.execPath : executable;
  const args = ["-q", ...connectionArguments(profile, { includePort: false }), "-P", String(profile.port), connectionTarget(profile)];
  const actualArgs = isNodeScript ? [executable, ...args] : args;
  const askpass = createAskpassContext(profile);
  const child = spawn(actualExecutable, actualArgs, {
    env: askpass.env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let closed = false;
  let cleanupDone = false;
  let stdoutBuffer = "";
  let current = null;
  let sequence = 0;
  let queue = Promise.resolve();
  const startedAt = Date.now();

  function cleanup() {
    if (!cleanupDone) {
      cleanupDone = true;
      askpass.cleanup();
    }
  }

  function finishCurrent(exitCode, timedOut = false) {
    if (!current || current.settled) return;
    current.settled = true;
    clearTimeout(current.timer);
    const result = {
      exitCode,
      signal: null,
      timedOut,
      durationMs: Date.now() - current.startedAt,
      stdout: current.stdout.join(""),
      stderr: current.stderr.join(""),
      stdoutTruncated: false,
      stderrTruncated: false,
      connectionMode: "SFTP 长连接",
    };
    const resolve = current.resolve;
    current = null;
    resolve(result);
  }

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    if (!current) return;
    const index = stdoutBuffer.indexOf(current.marker);
    if (index < 0) {
      current.stdout.push(stdoutBuffer);
      stdoutBuffer = "";
      return;
    }
    current.stdout.push(stdoutBuffer.slice(0, index));
    stdoutBuffer = stdoutBuffer.slice(index + current.marker.length);
    const hasError = /not found|no such file|permission denied|failure|couldn't|error/i.test(current.stderr.join(""));
    finishCurrent(hasError ? 1 : 0);
  });
  child.stderr.on("data", (chunk) => {
    if (current) current.stderr.push(chunk.toString("utf8"));
  });
  child.on("error", (error) => {
    closed = true;
    cleanup();
    if (current && !current.settled) {
      current.settled = true;
      clearTimeout(current.timer);
      current.reject(error);
      current = null;
    }
  });
  child.on("close", () => {
    closed = true;
    cleanup();
    persistentSftpSessions.delete(persistentSftpKey(profile));
    if (current && !current.settled) {
      current.settled = true;
      clearTimeout(current.timer);
      current.reject(new Error("SFTP 长连接已经关闭。"));
      current = null;
    }
  });

  const session = {
    profile,
    pid: child.pid,
    startedAt: new Date(startedAt).toISOString(),
    exec(command, options = {}) {
      const run = () => new Promise((resolve, reject) => {
        if (closed || !child.stdin.writable) {
          reject(new Error("SFTP 长连接已经关闭。"));
          return;
        }
        const timeoutMs = validateTimeoutSeconds(options.timeoutSeconds) * 1000;
        const id = String(++sequence);
        const marker = `__SSH_MANAGER_SFTP_END_${id}__`;
        current = {
          marker,
          started: false,
          settled: false,
          stdout: [],
          stderr: [],
          startedAt: Date.now(),
          resolve,
          reject,
          timer: setTimeout(() => {
            if (!current || current.settled) return;
            const pending = current;
            current = null;
            pending.settled = true;
            clearTimeout(pending.timer);
            pending.reject(new Error("SFTP 长连接命令执行超时。"));
            session.close();
          }, timeoutMs),
        };
        child.stdin.write(`${command}\n!echo ${marker}\n`);
      });
      const result = queue.then(run, run);
      queue = result.catch(() => {});
      return result;
    },
    close() {
      if (closed) return;
      closed = true;
      cleanup();
      try {
        child.stdin.end("exit\n");
      } catch {
        // Ignore stdin close failures.
      }
      child.kill("SIGTERM");
      const forceTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 2000);
      forceTimer.unref();
    },
    isAlive() {
      return !closed;
    },
    info() {
      return {
        alias: profile.alias,
        host: profile.host,
        username: profile.username,
        port: profile.port,
        pid: child.pid,
        startedAt: new Date(startedAt).toISOString(),
        connected: !closed,
        mode: "SFTP 长连接",
      };
    },
  };

  persistentSftpSessions.set(persistentSftpKey(profile), session);
  return session;
}

export function getPersistentSftpStatus() {
  return [...persistentSftpSessions.values()].filter((session) => session.isAlive()).map((session) => session.info());
}

export function hasPersistentSftpSession(profile) {
  const session = persistentSftpSessions.get(persistentSftpKey(profile));
  return Boolean(session && session.isAlive());
}

export function openPersistentSftpSession(profile) {
  validateProfileShape(profile);
  const key = persistentSftpKey(profile);
  const existing = persistentSftpSessions.get(key);
  if (existing && existing.isAlive()) return existing.info();
  return createPersistentSftpSession(profile).info();
}

export function closePersistentSftpSession(profileOrAlias) {
  const targetKey = typeof profileOrAlias === "string" ? profileOrAlias : persistentSftpKey(profileOrAlias);
  const session = persistentSftpSessions.get(targetKey)
    || [...persistentSftpSessions.values()].find((item) => item.profile.alias === profileOrAlias);
  if (!session) return false;
  const info = session.info();
  session.close();
  persistentSftpSessions.delete(persistentSftpKey(session.profile));
  return info;
}

export async function uploadPathsPersistent(profile, localPaths, remoteDirectory, options = {}) {
  const session = persistentSftpSessions.get(persistentSftpKey(profile)) || createPersistentSftpSession(profile);
  const sources = validateLocalInputs(localPaths, Boolean(options.recursive));
  const targetDirectory = validateRemotePath(remoteDirectory, "remoteDirectory");
  const startedAt = Date.now();
  const results = [];
  for (const source of sources) {
    const stat = fs.statSync(source);
    const command = `${stat.isDirectory() ? "put -r" : "put"} ${sftpQuote(source)} ${sftpQuote(targetDirectory)}`;
    results.push(await session.exec(command, options));
  }
  return combinePersistentResults(results, startedAt);
}

export async function downloadPathsPersistent(profile, remotePaths, localDirectory, options = {}) {
  const session = persistentSftpSessions.get(persistentSftpKey(profile)) || createPersistentSftpSession(profile);
  const sources = validateRemoteInputs(remotePaths, Boolean(options.recursive));
  const destination = validateLocalPath(localDirectory, "localDirectory");
  const startedAt = Date.now();
  const results = [];
  for (const source of sources) {
    const command = `${options.recursive ? "get -r" : "get"} ${sftpQuote(source)} ${sftpQuote(destination)}`;
    results.push(await session.exec(command, options));
  }
  return combinePersistentResults(results, startedAt);
}

export function startInteractiveShell(profile, handlers = {}) {
  validateProfileShape(profile);
  const onData = typeof handlers.onData === "function" ? handlers.onData : () => {};
  const onExit = typeof handlers.onExit === "function" ? handlers.onExit : () => {};
  const onError = typeof handlers.onError === "function" ? handlers.onError : () => {};
  const executable = process.env.SSH_MANAGER_SSH_BIN || "ssh";
  const isNodeScript = /\.(?:mjs|cjs|js)$/i.test(executable);
  const actualExecutable = isNodeScript ? process.execPath : executable;
  const args = ["-tt", ...connectionArguments(profile), connectionTarget(profile)];
  const actualArgs = isNodeScript ? [executable, ...args] : args;
  const askpass = createAskpassContext(profile);
  let closed = false;
  let cleanupDone = false;
  let closedByUser = false;

  const child = spawn(actualExecutable, actualArgs, {
    env: askpass.env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  function cleanup() {
    if (!cleanupDone) {
      cleanupDone = true;
      askpass.cleanup();
    }
  }

  child.stdout.on("data", (chunk) => onData(chunk.toString("utf8"), "stdout"));
  child.stderr.on("data", (chunk) => onData(chunk.toString("utf8"), "stderr"));
  child.on("error", (error) => {
    cleanup();
    onError(error);
  });
  child.on("close", (code, signal) => {
    closed = true;
    cleanup();
    onExit({ exitCode: code, signal, closedByUser });
  });

  return {
    pid: child.pid,
    write(data) {
      if (!closed && child.stdin.writable) {
        child.stdin.write(String(data));
      }
    },
    close() {
      if (closed) {
        return;
      }
      closedByUser = true;
      try {
        child.stdin.end();
      } catch {
        // Ignore stdin close failures.
      }
      child.kill("SIGTERM");
      const forceTimer = setTimeout(() => {
        if (!closed) {
          child.kill("SIGKILL");
        }
      }, 2000);
      forceTimer.unref();
    },
    isAlive() {
      return !closed;
    },
  };
}
export async function testConnection(profile, { timeoutSeconds } = {}) {
  return runRemoteCommand(profile, "printf 'SSH_MANAGER_OK\\n'", { timeoutSeconds });
}

function validateLocalInputs(localPaths, recursive) {
  if (!Array.isArray(localPaths) || localPaths.length === 0) {
    throw new ToolInputError("本地路径必须是非空数组。");
  }
  if (localPaths.length > 50) {
    throw new ToolInputError("本地路径最多包含 50 项。");
  }
  return localPaths.map((item) => {
    const resolved = validateLocalPath(item, "localPaths[]");
    const stat = fs.statSync(resolved);
    if (stat.isDirectory() && !recursive) {
      throw new ToolInputError(`localPaths[] 包含目录，但 recursive 为 false：${resolved}`);
    }
    return resolved;
  });
}

function validateRemoteInputs(remotePaths, recursive) {
  if (!Array.isArray(remotePaths) || remotePaths.length === 0) {
    throw new ToolInputError("远程路径必须是非空数组。");
  }
  if (remotePaths.length > 50) {
    throw new ToolInputError("远程路径最多包含 50 项。");
  }
  return remotePaths.map((item) => {
    const remotePath = validateRemotePath(item, "remotePaths[]");
    if ((remotePath.endsWith("/") || remotePath.includes("*")) && !recursive) {
      throw new ToolInputError(`remotePaths[] 需要 recursive=true：${remotePath}`);
    }
    return remotePath;
  });
}

// ===== 传输层 =====
// 设计要点（针对"经常坏 + 原因黑盒"的修复）：
//  1. 用交互式 SFTP 会话执行，不用 `sftp -b` 批处理 —— 批处理模式下单条命令失败会静默中止，
//     错误信息容易被吞掉，退出码也无法区分失败类型。
//  2. 全程收集 stdout + stderr，原样带回给调用方。
//  3. 成败判定基于输出内容 + 传输后校验，不再只看退出码。
//  4. 错误归类为：认证失败 / 连接不通 / 路径不存在 / 权限不足 等，并给出排查提示。

const TRANSFER_ERROR_RULES = [
  {
    kind: "认证失败",
    pattern: /permission denied \(publickey|authentication failed|no supported authentication methods|too many authentication failures|invalid user/i,
    hint: "检查用户名、密码/私钥是否正确，以及服务器允许的认证方式。",
  },
  {
    kind: "主机指纹不匹配",
    pattern: /host key verification failed|remote host identification has changed/i,
    hint: "核对 known_hosts，或把该服务器的主机指纹策略改为『首次连接自动接受』。",
  },
  {
    kind: "域名解析失败",
    pattern: /could not resolve hostname|name or service not known|temporary failure in name resolution/i,
    hint: "检查服务器地址是否写对。",
  },
  {
    kind: "连接不通",
    pattern: /connection refused|connection timed out|operation timed out|no route to host|network is unreachable|connection closed|connection reset|broken pipe|disconnected/i,
    hint: "检查网络、端口、防火墙，或确认服务器在线；也说明常驻会话可能已被中间设备断开。",
  },
  {
    kind: "路径不存在",
    pattern: /no such file or directory|no such file|not found|cannot stat|does not exist/i,
    hint: "核对本地/远端路径；远端目标目录需要事先存在。",
  },
  {
    kind: "权限不足",
    pattern: /permission denied|access denied|not permitted|operation not permitted/i,
    hint: "检查远端目录/文件的读写权限，或换用有权限的账户。",
  },
  {
    kind: "空间不足",
    pattern: /no space left|disk quota exceeded/i,
    hint: "清理远端磁盘空间或调整配额。",
  },
  {
    kind: "传输失败",
    pattern: /failure|failed|couldn\x27t|unable to|is not a regular file|invalid argument/i,
    hint: "查看下方原始输出定位。",
  },
];

// 从子进程输出里判断失败类型；返回 null 表示没发现错误。
function classifyTransferFailure(output) {
  const text = String(output || "");
  for (const rule of TRANSFER_ERROR_RULES) {
    if (rule.pattern.test(text)) {
      return { kind: rule.kind, hint: rule.hint };
    }
  }
  return null;
}

// 交互式执行一组 sftp 命令：每条命令后跟一个 !echo 标记，标记全部出现即视为执行完毕。
function runSftpInteractive(profile, commands, { env, recursive, preserveTimes, timeoutMs }) {
  return new Promise((resolve) => {
    const executable = process.env.SSH_MANAGER_SFTP_BIN || "sftp";
    const isNodeScript = /\.(?:mjs|cjs|js)$/i.test(executable);
    const actualExecutable = isNodeScript ? process.execPath : executable;
    const baseArgs = ["-q", ...connectionArguments(profile, { includePort: false })];
    if (recursive) baseArgs.push("-r");
    if (preserveTimes) baseArgs.push("-p");
    baseArgs.push("-P", String(profile.port), connectionTarget(profile));
    const actualArgs = isNodeScript ? [executable, ...baseArgs] : baseArgs;
    const startedAt = Date.now();
    const child = spawn(actualExecutable, actualArgs, {
      env: env || process.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let exited = false;
    let timer = null;
    const markers = commands.map((_, index) => "__SSH_MANAGER_SFTP_DONE_" + index + "__");

    const finish = (reason) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (!exited) {
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
      }
      const missing = markers.filter((marker) => !stdout.includes(marker));
      resolve({
        executable,
        stdout,
        stderr,
        timedOut,
        exited,
        reason,
        completed: missing.length === 0,
        missingCount: missing.length,
        durationMs: Date.now() - startedAt,
        signal: null,
        stdoutTruncated: false,
        stderrTruncated: false,
      });
    };

    timer = setTimeout(() => { timedOut = true; finish("timeout"); }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (markers.every((marker) => stdout.includes(marker))) finish("completed");
    });
    child.stderr.on("data", (chunk) => { stdout += ""; stderr += chunk.toString("utf8"); });
    child.on("error", (error) => { stderr += "\n" + error.message; finish("error"); });
    child.on("close", (code) => { exited = true; finish("closed:" + code); });

    child.stdin.on("error", () => { /* 子进程提前退出时忽略 EPIPE */ });
    const script = commands.map((command, index) => command + "\n!echo " + markers[index]).join("\n") + "\nexit\n";
    child.stdin.end(script);
  });
}

function transferCommand(direction, source, destination) {
  const verb = direction === "upload" ? "put" : "get";
  return verb + " " + sftpQuote(source) + " " + sftpQuote(destination);
}

function remoteJoin(directory, name) {
  const base = String(directory || "").replace(/\/+$/, "");
  return (base === "" ? "" : base) + "/" + name;
}

// 把原始执行结果整理成调用方要的形态：带输出、带分类、带校验结论。
// 去掉 sftp 会话里用来判定命令完成的内部标记，避免出现在用户可见输出里。
function stripSftpMarkers(text) {
  return String(text || "").replace(/__SSH_MANAGER_SFTP_DONE_\d+__\r?\n?/g, "");
}

function finalizeTransferResult(raw, { direction, expectedRemote, expectedLocal }) {
  raw = { ...raw, stdout: stripSftpMarkers(raw.stdout), stderr: stripSftpMarkers(raw.stderr) };
  const combined = raw.stdout + "\n" + raw.stderr;
  const failure = classifyTransferFailure(combined);
  const missingLocal = direction === "download" ? expectedLocal.filter((item) => !fs.existsSync(item)) : [];
  const verified = missingLocal.length === 0;
  const ok = raw.completed && !failure && verified;
  let failureKind = null;
  let failureHint = null;
  if (failure) {
    failureKind = failure.kind;
    failureHint = failure.hint;
  } else if (raw.timedOut) {
    failureKind = "传输超时";
    failureHint = "可在调用时调大 timeoutSeconds，或检查网络与远端磁盘。";
  } else if (!raw.completed) {
    failureKind = "传输未完成";
    failureHint = "有命令未收到完成确认，连接可能已中断。";
  } else if (missingLocal.length > 0) {
    failureKind = "校验未通过";
    failureHint = "命令已执行但目标文件未落地：" + missingLocal.join("、");
  }
  return {
    exitCode: ok ? 0 : 1,
    signal: null,
    timedOut: raw.timedOut,
    durationMs: raw.durationMs,
    stdout: raw.stdout,
    stderr: raw.stderr,
    stdoutTruncated: false,
    stderrTruncated: false,
    completed: raw.completed,
    verified,
    failureKind,
    failureHint,
    expectedRemote: expectedRemote || [],
  };
}

// 远端路径的 shell 单引号包裹（用于 md5sum / find 这类命令）。
function shellSingleQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

const VERIFY_MAX_FILE_BYTES = 64 * 1024 * 1024;

function localMd5(file) {
  const stat = fs.statSync(file);
  if (stat.size > VERIFY_MAX_FILE_BYTES) {
    return null;
  }
  return crypto.createHash("md5").update(fs.readFileSync(file)).digest("hex");
}

function localTreeSummary(directory) {
  let files = 0;
  let bytes = 0;
  const stack = [directory];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const child of fs.readdirSync(current, { withFileTypes: true })) {
      const childPath = path.join(current, child.name);
      if (child.isDirectory()) {
        stack.push(childPath);
      } else if (child.isFile()) {
        files += 1;
        bytes += fs.statSync(childPath).size;
      }
    }
  }
  return { files, bytes };
}

// 上传后校验：单文件比 md5，目录比"文件数 + 总字节"。
// 返回不匹配的条目，供调用方决定是否重传。
async function verifyUploadedFiles(profile, pairs, { timeoutSeconds }) {
  const notes = [];
  const mismatched = [];
  for (const pair of pairs) {
    if (pair.isDirectory) {
      const local = localTreeSummary(pair.local);
      const command =
        "find " + shellSingleQuote(pair.remote) + " -type f -printf '%s\\n' 2>/dev/null | awk '{n++; s+=$1} END{printf \"%d %d\", n, s}'";
      const result = await runRemoteCommand(profile, command, { timeoutSeconds });
      const [remoteFiles, remoteBytes] = String(result.stdout || "").trim().split(/\s+/);
      const ok = result.exitCode === 0 && Number(remoteFiles) === local.files && Number(remoteBytes) === local.bytes;
      if (!ok) {
        mismatched.push(pair);
      }
      notes.push(
        path.basename(pair.local) +
          "（目录）：本地 " + local.files + " 文件/" + local.bytes + " 字节，远端 " +
          (remoteFiles || "?") + " 文件/" + (remoteBytes || "?") + " 字节" + (ok ? " ✓" : " ✗"),
      );
      continue;
    }
    const expect = localMd5(pair.local);
    if (!expect) {
      notes.push(path.basename(pair.local) + "：文件过大，跳过校验");
      continue;
    }
    const result = await runRemoteCommand(profile, "md5sum " + shellSingleQuote(pair.remote), { timeoutSeconds });
    const actual = String(result.stdout || "").trim().split(/\s+/)[0] || "";
    const ok = result.exitCode === 0 && actual === expect;
    if (!ok) {
      mismatched.push(pair);
    }
    notes.push(
      path.basename(pair.local) + " md5 " + (ok ? "一致" : "不一致（本地 " + expect.slice(0, 8) + "… / 远端 " + (actual ? actual.slice(0, 8) + "…" : "取不到") + "）"),
    );
  }
  return { ok: mismatched.length === 0, mismatched, note: notes.join("；") };
}

export async function uploadPaths(profile, localPaths, remoteDirectory, options = {}) {
  validateProfileShape(profile);
  const recursive = Boolean(options.recursive);
  const preserveTimes = options.preserveTimes !== false;
  const timeoutMs = validateTimeoutSeconds(options.timeoutSeconds) * 1000;
  const sources = validateLocalInputs(localPaths, recursive);
  const targetDirectory = validateRemotePath(remoteDirectory, "remoteDirectory");

  const expectedRemote = [];
  const commands = [];
  for (const source of sources) {
    commands.push(transferCommand("upload", source, targetDirectory));
    expectedRemote.push(remoteJoin(targetDirectory, path.basename(source)));
  }
  // 传输后确认目标确实落地：sftp 的 put 失败时不一定返回非零退出码。
  for (const remotePath of expectedRemote) {
    commands.push("ls -l " + sftpQuote(remotePath));
  }

  const pairs = sources.map((source) => ({
    local: source,
    remote: remoteJoin(targetDirectory, path.basename(source)),
    isDirectory: fs.statSync(source).isDirectory(),
  }));

  let raw = await withAskpass(profile, (env) =>
    runSftpInteractive(profile, commands, { env, recursive, preserveTimes, timeoutMs }),
  );
  let result = finalizeTransferResult(raw, { direction: "upload", expectedRemote });

  if (result.exitCode === 0) {
    let verification = await verifyUploadedFiles(profile, pairs, { timeoutSeconds: options.timeoutSeconds });
    if (!verification.ok) {
      // 校验不一致时自动重传一次（只重传不匹配的条目）。
      const retryCommands = verification.mismatched.map((pair) =>
        transferCommand("upload", pair.local, targetDirectory),
      );
      if (retryCommands.length > 0) {
        raw = await withAskpass(profile, (env) =>
          runSftpInteractive(profile, retryCommands, { env, recursive, preserveTimes, timeoutMs }),
        );
        const retryResult = finalizeTransferResult(raw, { direction: "upload", expectedRemote });
        if (retryResult.exitCode === 0) {
          verification = await verifyUploadedFiles(profile, pairs, { timeoutSeconds: options.timeoutSeconds });
        }
      }
      result = {
        ...result,
        exitCode: verification.ok ? 0 : 1,
        failureKind: verification.ok ? null : "校验不一致",
        failureHint: verification.ok ? null : "远端文件与本地不一致，已自动重传一次仍未通过；建议检查磁盘、网络或改用 ssh_deploy 重试。",
      };
    }
    result.verified = verification.ok;
    result.verifyNote = verification.note;
  }

  return result;
}

export async function downloadPaths(profile, remotePaths, localDirectory, options = {}) {
  validateProfileShape(profile);
  const recursive = Boolean(options.recursive);
  const preserveTimes = options.preserveTimes !== false;
  const timeoutMs = validateTimeoutSeconds(options.timeoutSeconds) * 1000;
  const sources = validateRemoteInputs(remotePaths, recursive);
  const destination = validateLocalPath(localDirectory, "localDirectory");
  if (!fs.statSync(destination).isDirectory()) {
    throw new ToolInputError("本机目标目录必须已存在。");
  }

  const expectedLocal = [];
  const commands = [];
  for (const source of sources) {
    commands.push(transferCommand("download", source, destination));
    const base = path.posix.basename(String(source).replace(/\/+$/, ""));
    if (base && base !== "." && base !== "..") {
      expectedLocal.push(path.join(destination, base));
    }
  }

  const raw = await withAskpass(profile, (env) =>
    runSftpInteractive(profile, commands, { env, recursive, preserveTimes, timeoutMs }),
  );
  return finalizeTransferResult(raw, { direction: "download", expectedLocal });
}
export function describeLocalPaths(localPaths) {
  const entries = [];
  let totalBytes = 0;
  let totalFiles = 0;
  for (const item of localPaths) {
    const resolved = path.resolve(expandHome(String(item)));
    if (!fs.existsSync(resolved)) {
      entries.push({ path: resolved, exists: false });
      continue;
    }
    const stat = fs.statSync(resolved);
    const entry = {
      path: resolved,
      type: stat.isDirectory() ? "directory" : "file",
      bytes: stat.isFile() ? stat.size : undefined,
    };
    if (stat.isFile()) {
      totalBytes += stat.size;
      totalFiles += 1;
      if (stat.size <= 32 * 1024 * 1024) {
        entry.sha256 = crypto.createHash("sha256").update(fs.readFileSync(resolved)).digest("hex");
      }
    } else if (stat.isDirectory()) {
      const stack = [resolved];
      while (stack.length > 0 && totalFiles < 10_000) {
        const current = stack.pop();
        for (const child of fs.readdirSync(current, { withFileTypes: true })) {
          const childPath = path.join(current, child.name);
          if (child.isDirectory()) {
            stack.push(childPath);
          } else if (child.isFile()) {
            const childStat = fs.statSync(childPath);
            totalBytes += childStat.size;
            totalFiles += 1;
          }
        }
      }
    }
    entries.push(entry);
  }
  return { entries, totalBytes, totalFiles };
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "unknown";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[index]}`;
}