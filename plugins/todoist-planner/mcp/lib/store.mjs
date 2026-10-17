import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_DATA_DIR = path.join(os.homedir(), ".codex", "todoist-planner");

export function dataDir() {
  return process.env.TODOIST_PLANNER_HOME || DEFAULT_DATA_DIR;
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