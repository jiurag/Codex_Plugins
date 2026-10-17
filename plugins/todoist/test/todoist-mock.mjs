import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import assert from "node:assert/strict";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "..");
const dataDir = path.join(pluginRoot, ".tmp-test-todoist");
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

const store = { projects: [], items: [], seq: 1, authHeaders: [] };

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch {
        const params = new URLSearchParams(raw);
        resolve(Object.fromEntries(params.entries()));
      }
    });
  });
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

const mock = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  store.authHeaders.push(req.headers.authorization || "");
  const body = await readBody(req);

  if (req.method === "POST" && url.pathname === "/api/v1/sync") {
    if (body.commands) {
      let commands = [];
      try { commands = JSON.parse(body.commands); } catch {}
      const syncStatus = {};
      for (const command of commands) {
        if (command.type === "item_reorder") {
          for (const entry of command.args.items) {
            const item = store.items.find((row) => row.id === entry.id);
            if (item) item.child_order = entry.child_order;
          }
        }
        syncStatus[command.uuid] = "ok";
      }
      return json(res, 200, { sync_status: syncStatus, items: store.items, projects: store.projects });
    }
    return json(res, 200, { sync_token: "s1", full_sync: true, items: store.items, projects: store.projects });
  }
  if (req.method === "GET" && url.pathname === "/api/v1/projects") {
    return json(res, 200, { results: store.projects, next_cursor: null });
  }
  if (req.method === "POST" && url.pathname === "/api/v1/projects") {
    const project = { id: "p" + store.seq++, name: body.name, is_deleted: false, is_archived: false };
    store.projects.push(project);
    return json(res, 200, project);
  }
  if (req.method === "POST" && url.pathname === "/api/v1/tasks") {
    const item = {
      id: "t" + store.seq++,
      content: body.content,
      description: body.description || "",
      project_id: body.project_id || null,
      checked: 0,
      child_order: store.items.length + 1,
      added_at: new Date().toISOString(),
      is_deleted: false,
      labels: Array.isArray(body.labels) ? body.labels : [],
      priority: Number(body.priority) || 4,
      due: body.due_date ? { date: body.due_date, string: body.due_date } : null,
    };
    store.items.push(item);
    return json(res, 200, item);
  }
  const close = url.pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/close$/);
  if (req.method === "POST" && close) {
    const item = store.items.find((entry) => entry.id === decodeURIComponent(close[1]));
    if (!item) return json(res, 404, { error: "not found" });
    item.checked = 1;
    item.completed_at = new Date().toISOString();
    res.writeHead(204); return res.end();
  }
  const reopen = url.pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/reopen$/);
  if (req.method === "POST" && reopen) {
    const item = store.items.find((entry) => entry.id === decodeURIComponent(reopen[1]));
    if (!item) return json(res, 404, { error: "not found" });
    item.checked = 0;
    item.completed_at = null;
    res.writeHead(204); return res.end();
  }
  const update = url.pathname.match(/^\/api\/v1\/tasks\/([^/]+)$/);
  if (req.method === "POST" && update) {
    const item = store.items.find((entry) => entry.id === decodeURIComponent(update[1]));
    if (!item) return json(res, 404, { error: "not found" });
    if (body.project_id) item.project_id = body.project_id;
    if (body.content) item.content = body.content;
    if (body.priority) item.priority = body.priority;
    if (body.due_date) item.due = { date: body.due_date, string: body.due_date };
    if (body.due_string === "no date") item.due = null;
    return json(res, 200, item);
  }
  if (req.method === "DELETE" && update) {
    const index = store.items.findIndex((entry) => entry.id === decodeURIComponent(update[1]));
    if (index < 0) return json(res, 404, { error: "not found" });
    store.items.splice(index, 1);
    res.writeHead(204); return res.end();
  }
  return json(res, 404, { error: "unhandled " + req.method + " " + url.pathname });
});

await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
const port = mock.address().port;

const child = spawn(process.execPath, [path.join(pluginRoot, "mcp", "server.mjs")], {
  cwd: pluginRoot,
  env: {
    ...process.env,
    TODOIST_PLANNER_HOME: dataDir,
    TODOIST_API_TOKEN: "test-token",
    TODOIST_API_BASE: `http://127.0.0.1:${port}/api/v1`,
    TODOIST_PROJECT_NAME: "Codex 任务",
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let buffer = "";
let nextId = 1;
const pending = new Map();
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id != null && pending.has(message.id)) {
      const item = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) item.reject(new Error(message.error.message));
      else item.resolve(message.result);
    }
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => process.stderr.write(chunk));

function rpc(method, params, timeout = 15000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("timeout " + method)); }, timeout);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function tool(name, args = {}) {
  return rpc("tools/call", { name, arguments: args }).then((result) => {
    assert.equal(result.isError, false, `${name}: ${result.content?.[0]?.text}`);
    return result.structuredContent;
  });
}

await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mock", version: "1" } });
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");

const status = await tool("todoist_status");
assert.equal(status.mode, "todoist");
console.log("PASS token mode");

const sync1 = await tool("todoist_sync_plan", {
  steps: [
    { step: "接口 A", status: "pending" },
    { step: "接口 B", status: "completed" },
  ],
  session_id: "mock-session",
});
assert.equal(sync1.created, 2);
assert.equal(store.projects.length, 1);
assert.equal(store.projects[0].name, "Codex 任务");
assert.equal(store.items.length, 2);
assert.ok(store.items.every((item) => item.project_id === store.projects[0].id));
assert.equal(store.items.filter((item) => item.checked === 1).length, 1);
assert.ok(store.authHeaders.every((header) => header === "Bearer test-token"));
console.log("PASS create tasks + auth + project mapping");

let board = await tool("todoist_board_data");
assert.equal(board.stats.total, 2);
assert.equal(board.stats.completed, 1);
assert.equal(board.config.mode, "todoist");
console.log("PASS board data from sync api");

await tool("todoist_add_task", { content: "手动任务" });
assert.equal(store.items.length, 3);
assert.equal(store.items[2].project_id, store.projects[0].id);

const manualId = store.items[2].id;
const updated = await tool("todoist_update_task", {
  task_id: manualId,
  content: "手动任务（已编辑）",
  priority: 2,
  due_date: "2026-10-20",
});
assert.equal(updated.ok, true);
assert.equal(store.items[2].content, "手动任务（已编辑）");
assert.equal(store.items[2].priority, 2);
assert.equal(store.items[2].due.date, "2026-10-20");

const updatedBoard = await tool("todoist_board_data");
const editedRow = updatedBoard.tasks.find((item) => item.id === manualId);
assert.equal(editedRow.content, "手动任务（已编辑）");
assert.equal(editedRow.dueDate, "2026-10-20");

await tool("todoist_delete_task", { task_id: manualId });
assert.equal(store.items.length, 2);
const afterDelete = await tool("todoist_board_data");
assert.equal(afterDelete.stats.total, 2);
console.log("PASS update/delete against todoist");

const taskA = board.tasks.find((item) => item.content === "接口 A");
await tool("todoist_complete_task", { task_id: taskA.id });
board = await tool("todoist_board_data");
assert.equal(board.stats.completed, 2);
await tool("todoist_reopen_task", { task_id: taskA.id });
board = await tool("todoist_board_data");
assert.equal(board.stats.completed, 1);
console.log("PASS complete/reopen against todoist");

const labeled = await tool("todoist_add_task", {
  content: "标签任务",
  labels: ["工作", "紧急"],
  due_date: "2026-10-21",
  priority: 2,
});
const labeledItem = store.items.find((item) => item.id === labeled.id);
assert.deepEqual(labeledItem.labels, ["工作", "紧急"]);
assert.equal(labeledItem.due.date, "2026-10-21");
assert.equal(labeledItem.priority, 2);
await tool("todoist_delete_task", { task_id: labeled.id });
console.log("PASS labels/due/priority against todoist");

const codexProjectId = store.projects[0].id;
const createdProject = await tool("todoist_create_project", { name: "第二个项目" });
assert.equal(createdProject.ok, true);
let projectBoard = await tool("todoist_board_data");
assert.equal(projectBoard.activeProjectId, createdProject.project.id);
assert.equal(projectBoard.stats.total, 0);
await tool("todoist_set_project", { project_id: codexProjectId });
projectBoard = await tool("todoist_board_data");
assert.equal(projectBoard.activeProjectId, codexProjectId);
assert.equal(projectBoard.stats.total, 2);
console.log("PASS projects against todoist");

const orderedIds = store.items.map((item) => item.id).reverse();
await tool("todoist_reorder_tasks", { task_ids: orderedIds });
const reordered = store.items.slice().sort((a, b) => a.child_order - b.child_order).map((item) => item.id);
assert.deepEqual(reordered, orderedIds);
console.log("PASS reorder against todoist");

const sync2 = await tool("todoist_sync_plan", {
  steps: [
    { step: "接口 A", status: "pending" },
    { step: "接口 B", status: "completed" },
  ],
  session_id: "mock-session",
});
assert.equal(sync2.created, 0);
assert.equal(store.items.length, 2);
console.log("PASS idempotent todoist sync");

child.stdin.end();
child.kill();
await new Promise((resolve) => mock.close(resolve));
fs.rmSync(dataDir, { recursive: true, force: true });
console.log("\nALL TODOIST MOCK TESTS PASSED");