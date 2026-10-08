import crypto from "node:crypto";
import { readVault } from "./vault.mjs";
import {
  publicProfile,
  startInteractiveShell,
  validateAlias,
} from "./ssh.mjs";

const MAX_TERMINAL_BUFFER = 256 * 1024;

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
  throw new Error(`未找到 SSH 配置：${alias}`);
}

function trimBuffer(value) {
  return value.length > MAX_TERMINAL_BUFFER ? value.slice(-MAX_TERMINAL_BUFFER) : value;
}

export function createTerminalController() {
  const sessions = new Map();

  function listProfiles() {
    return Object.values(readVault().profiles)
      .map(publicProfile)
      .sort((left, right) => left.alias.localeCompare(right.alias));
  }

  function broadcast(session, data) {
    if (!data) {
      return;
    }
    session.unread = trimBuffer(session.unread + data);
    session.output = trimBuffer(session.output + data);
    for (const listener of session.listeners) {
      try {
        listener(data);
      } catch {
        // Ignore a broken terminal subscriber.
      }
    }
  }

  function start(alias) {
    const vault = readVault();
    const profile = resolveProfile(vault, alias);
    const id = crypto.randomUUID();
    const session = {
      id,
      alias: profile.alias,
      profile: publicProfile(profile),
      output: "",
      unread: "",
      listeners: new Set(),
      alive: true,
      startedAt: new Date().toISOString(),
      exit: null,
      process: null,
    };

    session.process = startInteractiveShell(profile, {
      onData(chunk) {
        broadcast(session, chunk);
      },
      onExit(exit) {
        session.alive = false;
        session.exit = exit;
        broadcast(session, `\n[SSH 会话结束，退出码 ${exit.exitCode ?? "未知"}]\n`);
      },
      onError(error) {
        session.alive = false;
        broadcast(session, `\n[SSH 终端错误] ${error.message}\n`);
      },
    });

    sessions.set(id, session);
    return {
      status: "已连接",
      terminalId: id,
      alias: session.alias,
      profile: session.profile,
      pid: session.process.pid,
      startedAt: session.startedAt,
    };
  }

  function write(id, data) {
    const session = sessions.get(id);
    if (!session || !session.alive) {
      throw new Error("SSH 终端不存在或已结束。");
    }
    session.process.write(data);
    return { status: "已发送", terminalId: id };
  }

  function read(id) {
    const session = sessions.get(id);
    if (!session) {
      throw new Error("SSH 终端不存在。");
    }
    const data = session.unread;
    session.unread = "";
    return {
      status: session.alive ? "运行中" : "已结束",
      terminalId: id,
      alias: session.alias,
      data,
      output: session.output,
      exit: session.exit,
    };
  }

  function snapshot(id) {
    const session = sessions.get(id);
    if (!session) {
      throw new Error("SSH 终端不存在。");
    }
    return {
      status: session.alive ? "运行中" : "已结束",
      terminalId: id,
      alias: session.alias,
      output: session.output,
      exit: session.exit,
    };
  }

  function subscribe(id, listener) {
    const session = sessions.get(id);
    if (!session) {
      throw new Error("SSH 终端不存在。");
    }
    session.listeners.add(listener);
    return () => session.listeners.delete(listener);
  }

  function close(id) {
    const session = sessions.get(id);
    if (!session) {
      throw new Error("SSH 终端不存在。");
    }
    session.process.close();
    session.alive = false;
    return { status: "已关闭", terminalId: id, alias: session.alias };
  }

  function list() {
    return [...sessions.values()].map((session) => ({
      terminalId: session.id,
      alias: session.alias,
      status: session.alive ? "运行中" : "已结束",
      startedAt: session.startedAt,
      exit: session.exit,
    }));
  }

  return {
    listProfiles,
    start,
    write,
    read,
    snapshot,
    subscribe,
    close,
    list,
  };
}