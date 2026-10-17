import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_DATA_DIR = path.join(os.homedir(), ".codex", "todoist");
const LEGACY_DATA_DIR = path.join(os.homedir(), ".codex", "todoist-planner");

function migrateLegacyData() {
  try {
    if (fs.existsSync(DEFAULT_DATA_DIR)) return;
    if (!fs.existsSync(LEGACY_DATA_DIR)) return;
    fs.mkdirSync(DEFAULT_DATA_DIR, { recursive: true });
    for (const name of ["state.json", "config.json"]) {
      const source = path.join(LEGACY_DATA_DIR, name);
      if (fs.existsSync(source)) {
        fs.copyFileSync(source, path.join(DEFAULT_DATA_DIR, name));
      }
    }
  } catch {
    // Migration is best effort; fall back to a fresh data directory.
  }
}

export function dataDir() {
  const override = process.env.TODOIST_PLANNER_HOME || process.env.TODOIST_HOME;
  if (override) return override;
  migrateLegacyData();
  return DEFAULT_DATA_DIR;
}

export function ensureDataDir() {
  fs.mkdirSync(dataDir(), { recursive: true });
  return dataDir();
}

export function statePath() {
  return path.join(dataDir(), "state.json");
}

export function configPath() {
  return path.join(dataDir(), "config.json");
}

const DEFAULT_STATE = {
  version: 2,
  revision: 0,
  projectId: null,
  projects: [],
  labels: [],
  activeProjectId: null,
  planMap: {},
  localTasks: [],
  lastPlan: null,
  lastPlans: {},
};

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(raw);
  } catch {
    return structuredClone(fallback);
  }
}

export function readState() {
  const parsed = readJson(statePath(), DEFAULT_STATE);
  return { ...structuredClone(DEFAULT_STATE), ...(parsed && typeof parsed === "object" ? parsed : {}) };
}

export function writeState(state) {
  ensureDataDir();
  const file = statePath();
  const tmp = file + "." + process.pid + "." + Date.now() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

export function updateState(mutator) {
  const state = readState();
  const result = mutator(state);
  writeState(state);
  return result;
}

export function readSessionLabels(sessionIds = []) {
  const wanted = new Set((Array.isArray(sessionIds) ? sessionIds : []).map(String).filter(Boolean));
  const labels = {};
  if (wanted.size === 0) return labels;
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const indexPath = path.join(codexHome, "session_index.jsonl");
  try {
    const lines = fs.readFileSync(indexPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        const id = String(entry.id || "");
        if (wanted.has(id) && entry.thread_name) {
          labels[id] = String(entry.thread_name).trim();
        }
      } catch {}
    }
  } catch {}
  return labels;
}

export function readAssistantTextForTurn(transcriptPath, turnId = null) {
  if (!transcriptPath) return "";
  try {
    const lines = fs.readFileSync(transcriptPath, "utf8").split(/\r?\n/);
    const messages = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        const payload = obj && obj.payload;
        if (!payload || payload.type !== "message" || payload.role !== "assistant") continue;
        const meta = payload.internal_chat_message_metadata_passthrough || obj.metadata?.internal_chat_message_metadata_passthrough;
        const messageTurn = meta && meta.turn_id ? String(meta.turn_id) : "";
        if (turnId && messageTurn && messageTurn !== String(turnId)) continue;
        const text = Array.isArray(payload.content)
          ? payload.content.map((item) => item && typeof item.text === "string" ? item.text : "").join("\n")
          : "";
        if (text.trim()) messages.push(text);
      } catch {}
    }
    return messages.join("\n\n");
  } catch { return ""; }
}

export function readConfig() {
  const cfg = readJson(configPath(), {});
  const token = String(process.env.TODOIST_API_TOKEN || cfg.token || "").trim();
  const projectName = String(process.env.TODOIST_PROJECT_NAME || cfg.projectName || "Codex 任务").trim() || "Codex 任务";
  return {
    token,
    projectName,
    configPath: configPath(),
    tokenConfigured: token.length > 0,
  };
}

export function describeDataDir() {
  return { dataDir: dataDir(), statePath: statePath(), configPath: configPath() };
}