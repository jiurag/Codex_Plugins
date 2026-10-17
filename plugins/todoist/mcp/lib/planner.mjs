import crypto from "node:crypto";
import { readConfig, readState, writeState } from "./store.mjs";
import * as todoist from "./todoist.mjs";

export function planKey(sessionId, step) {
  return crypto
    .createHash("sha1")
    .update(String(sessionId || "default") + "|" + String(step || ""))
    .digest("hex")
    .slice(0, 16);
}

function normalizeStatus(value) {
  const status = String(value || "pending").toLowerCase();
  if (/complete|done|finish/.test(status)) return "completed";
  if (/progress|running|active|doing/.test(status)) return "inProgress";
  return "pending";
}

export function normalizeSteps(input) {
  let raw = null;

  if (Array.isArray(input)) {
    raw = input;
  } else if (input && Array.isArray(input.plan)) {
    raw = input.plan;
  } else if (input && Array.isArray(input.steps)) {
    raw = input.steps;
  } else if (input && typeof input.plan === "string") {
    raw = input.plan
      .split(/\r?\n/)
      .map((line) => {
        const checkbox = line.match(/^\s*[-*]\s*\[( |x|X)\]\s*(.+?)\s*$/);
        if (checkbox) {
          return { step: checkbox[2], status: checkbox[1].toLowerCase() === "x" ? "completed" : "pending" };
        }
        const numbered = line.match(/^\s*\d+[.)]\s+(.+?)\s*$/);
        if (numbered) return { step: numbered[1], status: "pending" };
        return null;
      })
      .filter(Boolean);
  }

  if (!raw) return [];

  const steps = [];
  for (const item of raw) {
    if (typeof item === "string") {
      const text = item.trim();
      if (text) steps.push({ step: text, status: "pending" });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const text = String(item.step ?? item.text ?? item.content ?? "").trim();
    if (!text) continue;
    steps.push({ step: text, status: normalizeStatus(item.status) });
  }
  return steps;
}

/* ------------------------------------------------------------------ */
/* Local (standalone, no login)                                       */
/* ------------------------------------------------------------------ */

function localId(prefix) {
  return prefix + "-" + crypto.randomUUID();
}

function ensureLocalProject(state) {
  state.projects = Array.isArray(state.projects) ? state.projects : [];
  if (state.projects.length === 0) {
    state.projects.push({
      id: localId("proj"),
      name: "任务",
      order: 1,
      createdAt: Date.now(),
    });
  }
  let active = state.projects.find((project) => project.id === state.activeProjectId);
  if (!active) {
    active = state.projects[0];
    state.activeProjectId = active.id;
  }
  return active;
}

function localTasksFor(state, projectId) {
  const tasks = Array.isArray(state.localTasks) ? state.localTasks : [];
  for (const task of tasks) {
    if (!task.projectId) task.projectId = projectId;
  }
  return tasks
    .filter((task) => task.projectId === projectId)
    .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
}

function localTaskToBoard(task, project, planEntry) {
  return {
    id: String(task.id),
    content: String(task.content || ""),
    checked: Boolean(task.completed),
    due: task.due || "",
    dueDate: task.due || "",
    priority: Number(task.priority) || 4,
    labels: Array.isArray(task.labels) ? task.labels : [],
    projectId: project.id,
    projectName: project.name,
    source: task.source === "plan" ? "plan" : "manual",
    planStatus: planEntry?.status || (task.completed ? "completed" : "pending"),
    sessionId: task.sessionId || planEntry?.sessionId || null,
    order: Number(task.order) || 0,
    createdAt: task.createdAt || null,
    completedAt: task.completedAt || null,
  };
}

function localBoardData(state) {
  const project = ensureLocalProject(state);
  const tasks = localTasksFor(state, project.id);
  const boardTasks = tasks.map((task) => {
    const entry = task.planKey ? state.planMap?.[task.planKey] : null;
    return localTaskToBoard(task, project, entry);
  });
  const completed = boardTasks.filter((task) => task.checked).length;
  const labels = Array.from(new Set(boardTasks.flatMap((task) => task.labels))).sort();

  return {
    tasks: boardTasks,
    projects: state.projects.map((item) => ({ id: item.id, name: item.name, isInbox: false })),
    activeProjectId: project.id,
    labels,
    stats: {
      total: boardTasks.length,
      completed,
      active: boardTasks.length - completed,
      percent: boardTasks.length ? Math.round((completed / boardTasks.length) * 100) : 0,
    },
    config: {
      mode: "local",
      projectName: project.name,
      tokenConfigured: false,
      connected: false,
    },
    lastPlan: state.lastPlan || null,
    lastPlans: state.lastPlans || {},
    updatedAt: new Date().toISOString(),
  };
}

function nextLocalOrder(state, projectId) {
  const tasks = localTasksFor(state, projectId);
  return tasks.reduce((max, task) => Math.max(max, Number(task.order) || 0), 0) + 1;
}

function createLocalTask(state, projectId, options) {
  const task = {
    id: localId("task"),
    projectId,
    content: String(options.content || "").trim(),
    completed: false,
    due: options.due || "",
    priority: Number(options.priority) || 4,
    labels: Array.isArray(options.labels) ? options.labels.filter(Boolean) : [],
    source: options.source === "plan" ? "plan" : "manual",
    sessionId: options.sessionId || null,
    planKey: options.planKey || null,
    order: nextLocalOrder(state, projectId),
    createdAt: Date.now(),
    completedAt: null,
  };
  state.localTasks = Array.isArray(state.localTasks) ? state.localTasks : [];
  state.localTasks.push(task);
  return task;
}

function localAddTask(state, content, options) {
  const text = String(content || "").trim();
  if (!text) return { ok: false, error: "任务内容不能为空" };
  const project = options.projectId
    ? state.projects.find((item) => item.id === options.projectId) || ensureLocalProject(state)
    : ensureLocalProject(state);
  const task = createLocalTask(state, project.id, {
    content: text,
    labels: options.labels,
    due: options.dueDate,
    priority: options.priority,
  });
  writeState(state);
  return { ok: true, id: task.id, mode: "local", projectId: project.id };
}

function localUpdateTask(state, taskId, patch) {
  const task = (state.localTasks || []).find((item) => String(item.id) === String(taskId));
  if (!task) return { ok: false, error: "找不到任务" };

  if (patch.content !== undefined) {
    const content = String(patch.content || "").trim();
    if (!content) return { ok: false, error: "任务内容不能为空" };
    task.content = content;
  }
  if (patch.due_date !== undefined) task.due = String(patch.due_date || "");
  if (patch.priority !== undefined) task.priority = Number(patch.priority) || 4;
  if (patch.labels !== undefined) {
    task.labels = Array.isArray(patch.labels) ? patch.labels.map((label) => String(label).trim()).filter(Boolean) : [];
  }
  if (patch.project_id !== undefined) {
    const project = state.projects.find((item) => item.id === patch.project_id);
    if (!project) return { ok: false, error: "找不到项目" };
    task.projectId = project.id;
    task.order = nextLocalOrder(state, project.id);
  }
  if (task.planKey && state.planMap?.[task.planKey] && patch.content !== undefined) {
    state.planMap[task.planKey].content = task.content;
    state.planMap[task.planKey].updatedAt = Date.now();
  }
  writeState(state);
  return { ok: true, mode: "local" };
}

function localDeleteTask(state, taskId) {
  const tasks = state.localTasks || [];
  const index = tasks.findIndex((item) => String(item.id) === String(taskId));
  if (index < 0) return { ok: false, error: "找不到任务" };
  tasks.splice(index, 1);
  for (const [key, entry] of Object.entries(state.planMap || {})) {
    if (String(entry.taskId) === String(taskId)) delete state.planMap[key];
  }
  writeState(state);
  return { ok: true, mode: "local" };
}

function localSetDone(state, taskId, done) {
  const task = (state.localTasks || []).find((item) => String(item.id) === String(taskId));
  if (!task) return { ok: false, error: "找不到任务" };
  task.completed = Boolean(done);
  task.completedAt = done ? Date.now() : null;
  for (const entry of Object.values(state.planMap || {})) {
    if (String(entry.taskId) === String(taskId)) entry.done = Boolean(done);
  }
  writeState(state);
  return { ok: true, mode: "local" };
}

function localReorder(state, taskIds) {
  const ids = Array.isArray(taskIds) ? taskIds.map(String) : [];
  if (ids.length === 0) return { ok: false, error: "缺少 task_ids" };
  ids.forEach((id, index) => {
    const task = (state.localTasks || []).find((item) => String(item.id) === id);
    if (task) task.order = index + 1;
  });
  writeState(state);
  return { ok: true, mode: "local" };
}

function localCreateProject(state, name) {
  const text = String(name || "").trim();
  if (!text) return { ok: false, error: "项目名称不能为空" };
  const project = {
    id: localId("proj"),
    name: text,
    order: (state.projects || []).length + 1,
    createdAt: Date.now(),
  };
  state.projects = Array.isArray(state.projects) ? state.projects : [];
  state.projects.push(project);
  state.activeProjectId = project.id;
  writeState(state);
  return { ok: true, project: { id: project.id, name: project.name }, mode: "local" };
}

function localSetProject(state, projectId) {
  const project = (state.projects || []).find((item) => item.id === projectId);
  if (!project) return { ok: false, error: "找不到项目" };
  state.activeProjectId = project.id;
  writeState(state);
  return { ok: true, project: { id: project.id, name: project.name }, mode: "local" };
}
/* ------------------------------------------------------------------ */
/* Todoist (optional sync)                                            */
/* ------------------------------------------------------------------ */

function todoistTaskFromItem(item, planEntry) {
  return {
    id: String(item.id),
    content: String(item.content || ""),
    checked: item.checked === 1 || item.checked === true,
    due: item.due?.string || item.due?.date || "",
    dueDate: item.due?.date || "",
    priority: Number(item.priority) || 4,
    labels: Array.isArray(item.labels) ? item.labels : [],
    projectId: String(item.project_id || ""),
    projectName: "",
    source: planEntry ? "plan" : "manual",
    planStatus: planEntry?.status || null,
    sessionId: planEntry?.sessionId || null,
    order: Number(item.child_order) || 0,
    createdAt: item.added_at || null,
    completedAt: item.completed_at || null,
  };
}

async function resolveTodoistProject(state, config, snapshot) {
  const projects = snapshot.projects.filter((project) => !project.is_deleted && !project.is_archived);
  let project = projects.find((item) => String(item.id) === String(state.activeProjectId));
  if (!project) project = projects.find((item) => item.name === config.projectName);
  if (!project) project = projects.find((item) => item.inbox_project);
  if (!project) {
    project = await todoist.createProject(config.projectName);
    projects.push(project);
    snapshot.projects.push(project);
  }
  state.activeProjectId = String(project.id);
  return project;
}

async function todoistBoardData(state, config) {
  const snapshot = await todoist.syncRead();
  const project = await resolveTodoistProject(state, config, snapshot);
  const projects = snapshot.projects
    .filter((item) => !item.is_deleted && !item.is_archived)
    .map((item) => ({ id: String(item.id), name: item.name, isInbox: Boolean(item.inbox_project) }));

  const entryByTaskId = new Map();
  for (const entry of Object.values(state.planMap || {})) {
    if (entry?.taskId) entryByTaskId.set(String(entry.taskId), entry);
  }

  const items = snapshot.items.filter(
    (item) => !item.is_deleted && String(item.project_id || "") === String(project.id),
  );

  const tasks = [];
  const seen = new Set();
  for (const item of items) {
    const entry = entryByTaskId.get(String(item.id));
    const task = todoistTaskFromItem(item, entry);
    task.projectName = project.name;
    if (entry) {
      entry.done = task.checked;
      entry.content = task.content || entry.content;
    }
    seen.add(task.id);
    tasks.push(task);
  }

  for (const entry of Object.values(state.planMap || {})) {
    if (!entry?.taskId || seen.has(String(entry.taskId)) || entry.done !== true) continue;
    if (entry.projectId && String(entry.projectId) !== String(project.id)) continue;
    tasks.push({
      id: String(entry.taskId),
      content: String(entry.content || ""),
      checked: true,
      due: "",
      dueDate: "",
      priority: 4,
      labels: [],
      projectId: String(project.id),
      projectName: project.name,
      source: "plan",
      planStatus: "completed",
      sessionId: entry.sessionId || null,
      order: 0,
      createdAt: null,
      completedAt: null,
    });
  }

  tasks.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
  const completed = tasks.filter((task) => task.checked).length;
  const labels = Array.from(new Set(tasks.flatMap((task) => task.labels))).sort();

  return {
    tasks,
    projects,
    activeProjectId: String(project.id),
    labels,
    stats: {
      total: tasks.length,
      completed,
      active: tasks.length - completed,
      percent: tasks.length ? Math.round((completed / tasks.length) * 100) : 0,
    },
    config: {
      mode: "todoist",
      projectName: project.name,
      tokenConfigured: true,
      connected: true,
    },
    lastPlan: state.lastPlan || null,
    lastPlans: state.lastPlans || {},
    updatedAt: new Date().toISOString(),
  };
}

async function todoistSyncPlan(state, config, steps, sessionId, turnId, source) {
  const snapshot = await todoist.syncRead();
  const project = await resolveTodoistProject(state, config, snapshot);
  let created = 0;
  let completed = 0;

  for (const step of steps) {
    const key = planKey(sessionId, step.step);
    let entry = state.planMap[key];
    const wantsDone = step.status === "completed";

    if (!entry) {
      const task = await todoist.createTask({
        content: step.step,
        description: `Codex 计划步骤 · ${new Date().toISOString()}`,
        projectId: project.id,
      });
      entry = {
        taskId: String(task.id),
        content: step.step,
        status: step.status,
        done: false,
        sessionId,
      };
      state.planMap[key] = entry;
      created += 1;
    }

    entry.content = step.step;
    entry.status = step.status;
    entry.sessionId = sessionId;
    entry.projectId = String(project.id);
    entry.updatedAt = Date.now();

    if (wantsDone && entry.done !== true) {
      await todoist.closeTask(entry.taskId);
      entry.done = true;
      completed += 1;
    }
  }

  const record = {
    steps,
    sessionId,
    turnId,
    source,
    updatedAt: Date.now(),
  };
  state.lastPlans = state.lastPlans && typeof state.lastPlans === "object" ? state.lastPlans : {};
  state.lastPlans[sessionId] = record;
  state.lastPlan = record;
  writeState(state);

  return {
    ok: true,
    total: steps.length,
    created,
    completed,
    reopened: 0,
    mode: "todoist",
  };
}
/* ------------------------------------------------------------------ */
/* Unified API                                                        */
/* ------------------------------------------------------------------ */

export async function getBoardData() {
  const config = readConfig();
  const state = readState();
  const data = config.tokenConfigured
    ? await todoistBoardData(state, config)
    : localBoardData(state);
  writeState(state);
  return data;
}

export async function addTask(content, options = {}) {
  const text = String(content || "").trim();
  if (!text) return { ok: false, error: "任务内容不能为空" };

  const config = readConfig();
  const state = readState();

  if (!config.tokenConfigured) {
    return localAddTask(state, text, options);
  }

  const snapshot = await todoist.syncRead();
  const active = await resolveTodoistProject(state, config, snapshot);
  let projectId = active.id;
  if (options.projectId) {
    const target = snapshot.projects.find((item) => String(item.id) === String(options.projectId));
    if (target) projectId = target.id;
  }
  const task = await todoist.createTask({
    content: text,
    projectId,
    labels: options.labels,
    dueDate: options.dueDate,
    priority: options.priority,
  });
  writeState(state);
  return { ok: true, id: String(task.id), mode: "todoist", projectId: String(projectId) };
}

export async function updateTask(taskId, patch = {}) {
  const config = readConfig();
  const state = readState();

  if (!config.tokenConfigured) {
    return localUpdateTask(state, taskId, patch);
  }

  const body = {};
  if (patch.content !== undefined) {
    const content = String(patch.content || "").trim();
    if (!content) return { ok: false, error: "任务内容不能为空" };
    body.content = content;
  }
  if (patch.due_date !== undefined) {
    if (patch.due_date) body.due_date = patch.due_date;
    else body.due_string = "no date";
  }
  if (patch.priority !== undefined) body.priority = Number(patch.priority);
  if (patch.labels !== undefined) {
    body.labels = Array.isArray(patch.labels)
      ? patch.labels.map((label) => String(label).trim()).filter(Boolean)
      : [];
  }
  if (patch.project_id !== undefined) body.project_id = patch.project_id;

  if (Object.keys(body).length > 0) {
    await todoist.updateTask(taskId, body);
  }
  if (patch.content !== undefined) {
    for (const entry of Object.values(state.planMap || {})) {
      if (String(entry.taskId) === String(taskId)) {
        entry.content = body.content;
        entry.updatedAt = Date.now();
      }
    }
  }
  writeState(state);
  return { ok: true, mode: "todoist" };
}

export async function deleteTask(taskId) {
  const config = readConfig();
  const state = readState();

  if (!config.tokenConfigured) {
    return localDeleteTask(state, taskId);
  }

  await todoist.deleteTask(taskId);
  for (const [key, entry] of Object.entries(state.planMap || {})) {
    if (String(entry.taskId) === String(taskId)) delete state.planMap[key];
  }
  writeState(state);
  return { ok: true, mode: "todoist" };
}

export async function setTaskDone(taskId, done) {
  const config = readConfig();
  const state = readState();

  if (!config.tokenConfigured) {
    return localSetDone(state, taskId, done);
  }

  if (done) await todoist.closeTask(taskId);
  else await todoist.reopenTask(taskId);

  for (const entry of Object.values(state.planMap || {})) {
    if (String(entry.taskId) === String(taskId)) entry.done = Boolean(done);
  }
  writeState(state);
  return { ok: true, mode: "todoist" };
}

export async function reorderTasks(taskIds) {
  const config = readConfig();
  const state = readState();

  if (!config.tokenConfigured) {
    return localReorder(state, taskIds);
  }

  await todoist.reorderTasks(taskIds);
  writeState(state);
  return { ok: true, mode: "todoist" };
}
export async function createProject(name) {
  const text = String(name || "").trim();
  if (!text) return { ok: false, error: "项目名称不能为空" };

  const config = readConfig();
  const state = readState();

  if (!config.tokenConfigured) {
    return localCreateProject(state, text);
  }

  const project = await todoist.createProject(text);
  state.activeProjectId = String(project.id);
  writeState(state);
  return {
    ok: true,
    mode: "todoist",
    project: { id: String(project.id), name: project.name },
  };
}

export async function setActiveProject(projectId) {
  const config = readConfig();
  const state = readState();

  if (!config.tokenConfigured) {
    return localSetProject(state, projectId);
  }

  const snapshot = await todoist.syncRead();
  const project = snapshot.projects.find(
    (item) => String(item.id) === String(projectId) && !item.is_deleted && !item.is_archived,
  );
  if (!project) return { ok: false, error: "找不到项目" };
  state.activeProjectId = String(project.id);
  writeState(state);
  return {
    ok: true,
    mode: "todoist",
    project: { id: String(project.id), name: project.name },
  };
}

export async function syncPlan({ steps, sessionId = "default", turnId = null, source = "tool" } = {}) {
  const normalized = normalizeSteps(steps);
  if (normalized.length === 0) {
    return { ok: false, error: "没有可同步的计划步骤" };
  }

  const config = readConfig();
  const state = readState();

  if (config.tokenConfigured) {
    return todoistSyncPlan(state, config, normalized, sessionId, turnId, source);
  }

  const project = ensureLocalProject(state);
  let created = 0;
  let completed = 0;

  for (const step of normalized) {
    const key = planKey(sessionId, step.step);
    let entry = state.planMap[key];
    const wantsDone = step.status === "completed";

    if (!entry) {
      const task = createLocalTask(state, project.id, {
        content: step.step,
        source: "plan",
        sessionId,
        planKey: key,
      });
      entry = {
        taskId: task.id,
        content: step.step,
        status: step.status,
        done: false,
        sessionId,
        projectId: project.id,
      };
      state.planMap[key] = entry;
      created += 1;
    }

    entry.content = step.step;
    entry.status = step.status;
    entry.sessionId = sessionId;
    entry.projectId = project.id;
    entry.updatedAt = Date.now();

    const task = state.localTasks.find((item) => String(item.id) === String(entry.taskId));
    if (task && wantsDone && !task.completed) {
      task.completed = true;
      task.completedAt = Date.now();
      completed += 1;
    }
    if (task) entry.done = task.completed;
  }

  const record = {
    steps: normalized,
    sessionId,
    turnId,
    source,
    updatedAt: Date.now(),
  };
  state.lastPlans = state.lastPlans && typeof state.lastPlans === "object" ? state.lastPlans : {};
  state.lastPlans[sessionId] = record;
  state.lastPlan = record;
  writeState(state);

  return {
    ok: true,
    total: normalized.length,
    created,
    completed,
    reopened: 0,
    mode: "local",
  };
}

export async function syncLastPlan(sessionId = null) {
  const state = readState();
  const plans = state.lastPlans && typeof state.lastPlans === "object" ? state.lastPlans : {};
  let plan = sessionId && plans[sessionId] ? plans[sessionId] : null;

  if (!plan) {
    const candidates = Object.values(plans).filter(
      (item) => item && Array.isArray(item.steps) && item.steps.length,
    );
    candidates.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    plan = candidates[0] || state.lastPlan || null;
  }

  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
    return { ok: false, error: "还没有记录到 /plan 的计划，先在对话里生成一个计划吧" };
  }

  return syncPlan({
    steps: plan.steps,
    sessionId: plan.sessionId || sessionId || "default",
    turnId: plan.turnId,
    source: "manual",
  });
}
export function extractPlanFromText(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const steps = [];
  let inCode = false;
  let inPlan = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^```/.test(trimmed)) {
      inCode = !inCode;
      continue;
    }
    if (inCode || !trimmed) continue;

    if (/^#{1,6}\s*(计划|plan|步骤|steps)(?:\s|$|[:：])/i.test(trimmed) || /^(计划|plan|步骤|steps)[:：]?\s*$/i.test(trimmed)) {
      inPlan = true;
      continue;
    }
    if (inPlan && /^#{1,6}\s+/.test(trimmed) && !/计划|plan|步骤|steps/i.test(trimmed)) {
      inPlan = false;
    }

    const checkbox = trimmed.match(/^[-*]\s*\[( |x|X)\]\s+(.+?)\s*$/);
    if (checkbox) {
      steps.push({
        step: checkbox[2],
        status: checkbox[1].toLowerCase() === "x" ? "completed" : "pending",
      });
      continue;
    }

    if (inPlan) {
      const numbered = trimmed.match(/^\d+[.)]\s+(.+?)\s*$/);
      if (numbered) steps.push({ step: numbered[1], status: "pending" });
    }
  }

  return steps.slice(0, 50);
}

export async function syncPlanFromText({ text, sessionId = "default", turnId = null } = {}) {
  const steps = extractPlanFromText(text);
  if (steps.length > 0) {
    return syncPlan({ steps, sessionId, turnId, source: "hook-text" });
  }
  return syncLastPlan(sessionId);
}