import crypto from "node:crypto";
import { readConfig } from "./store.mjs";

const API_BASE = process.env.TODOIST_API_BASE || "https://api.todoist.com/api/v1";

export class TodoistError extends Error {
  constructor(message, status = 0, body = "") {
    super(message);
    this.name = "TodoistError";
    this.status = status;
    this.body = body;
  }
}

export async function request(pathname, { method = "GET", json, form } = {}) {
  const { token } = readConfig();
  if (!token) {
    throw new TodoistError("还没有配置 Todoist API Token", 0);
  }

  const headers = { Authorization: `Bearer ${token}` };
  let body;
  if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  } else if (form !== undefined) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(form).toString();
  }

  let response;
  try {
    response = await fetch(API_BASE + pathname, { method, headers, body });
  } catch (error) {
    throw new TodoistError(`连接 Todoist 失败：${error instanceof Error ? error.message : String(error)}`, 0);
  }

  const text = await response.text();
  if (!response.ok) {
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text);
      detail = parsed.error || parsed.message || detail;
    } catch {
      // keep raw text
    }
    if (response.status === 401 || response.status === 403) {
      throw new TodoistError("Todoist Token 无效或没有权限，请到 Todoist 设置里重新复制 API Token", response.status, text);
    }
    throw new TodoistError(`Todoist 请求失败 (${response.status})：${detail}`, response.status, text);
  }

  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Full sync read. The Sync API returns every item, including completed ones,
 * which the REST /tasks endpoint does not.
 */
export async function syncRead() {
  const data = await request("/sync", {
    method: "POST",
    form: {
      sync_token: "*",
      resource_types: JSON.stringify(["items", "projects"]),
    },
  });
  return {
    items: Array.isArray(data?.items) ? data.items : [],
    projects: Array.isArray(data?.projects) ? data.projects : [],
    syncToken: data?.sync_token || null,
    fullSync: Boolean(data?.full_sync),
  };
}

export async function listProjects() {
  const data = await request("/projects?limit=200");
  return Array.isArray(data?.results) ? data.results : Array.isArray(data) ? data : [];
}

export async function createProject(name) {
  return request("/projects", { method: "POST", json: { name } });
}

export async function createTask({ content, description, projectId, labels, dueDate, priority }) {
  const body = { content };
  if (description) body.description = description;
  if (projectId) body.project_id = projectId;
  if (Array.isArray(labels) && labels.length > 0) body.labels = labels;
  if (dueDate) body.due_date = dueDate;
  if (priority) body.priority = Number(priority);
  return request("/tasks", { method: "POST", json: body });
}

export async function closeTask(taskId) {
  return request(`/tasks/${encodeURIComponent(taskId)}/close`, { method: "POST" });
}

export async function reopenTask(taskId) {
  return request(`/tasks/${encodeURIComponent(taskId)}/reopen`, { method: "POST" });
}
export async function updateTask(taskId, body) {
  return request(`/tasks/${encodeURIComponent(taskId)}`, { method: "POST", json: body });
}

export async function deleteTask(taskId) {
  return request(`/tasks/${encodeURIComponent(taskId)}`, { method: "DELETE" });
}
export async function reorderTasks(taskIds) {
  const ids = Array.isArray(taskIds) ? taskIds.map(String) : [];
  if (ids.length === 0) return null;
  const items = ids.map((id, index) => ({ id, child_order: index + 1 }));
  const commands = [
    {
      type: "item_reorder",
      uuid: crypto.randomUUID(),
      args: { items },
    },
  ];
  return request("/sync", {
    method: "POST",
    form: { commands: JSON.stringify(commands) },
  });
}