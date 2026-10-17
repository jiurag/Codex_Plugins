import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import assert from "node:assert/strict";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "..");
const dataDir = path.join(pluginRoot, ".tmp-test");

fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

const child = spawn(process.execPath, [path.join(pluginRoot, "mcp", "server.mjs")], {
  cwd: pluginRoot,
  env: { ...process.env, TODOIST_PLANNER_HOME: dataDir, TODOIST_API_TOKEN: "", TODOIST_PROJECT_NAME: "" },
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
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("timeout: " + method));
    }, timeout);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

function tool(name, args = {}) {
  return rpc("tools/call", { name, arguments: args }).then((result) => {
    assert.equal(result.isError, false, `${name} returned an error: ${result.content?.[0]?.text}`);
    return result;
  });
}

const init = await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "smoke", version: "1.0.0" },
});
assert.equal(init.serverInfo.name, "todoist");
assert.ok(Array.isArray(init.serverInfo.icons) && init.serverInfo.icons.length > 0, "serverInfo icons missing");
console.log("PASS initialize");

notify("notifications/initialized", {});

const tools = await rpc("tools/list", {});
const names = tools.tools.map((item) => item.name);
for (const name of ["todoist_open_board", "todoist_board_data", "todoist_add_task", "todoist_complete_task", "todoist_sync_plan", "todoist_sync_last_plan", "todoist_sync_plan_from_hook"]) {
  assert.ok(names.includes(name), "missing tool " + name);
}
const openBoard = tools.tools.find((item) => item.name === "todoist_open_board");
assert.equal(openBoard._meta.ui.resourceUri, "ui://todoist/board.html");
assert.ok(Array.isArray(openBoard.icons) && openBoard.icons.length > 0, "tool icons missing");
const globalEntry = openBoard._meta["openai/ui"].entrypoints.find((item) => item.type === "global");
assert.ok(globalEntry);
assert.ok(Array.isArray(globalEntry.quickAction.icons) && globalEntry.quickAction.icons.length > 0, "quickAction icons missing");
assert.ok(openBoard._meta["openai/ui"].entrypoints.some((item) => item.type === "thread"));
console.log("PASS tools/list");

const resources = await rpc("resources/list", {});
assert.equal(resources.resources.length, 1);
assert.equal(resources.resources[0].mimeType, "text/html;profile=mcp-app");
const read = await rpc("resources/read", { uri: "ui://todoist/board.html" });
const html = read.contents[0].text;
assert.ok(html.length > 10000, "board html too small");
assert.ok(html.includes("ui/initialize"));
assert.ok(html.includes("tools/call"));
console.log("PASS resources/read");

const plan = [
  { step: "步骤 A", status: "pending" },
  { step: "步骤 B", status: "inProgress" },
  { step: "步骤 C", status: "completed" },
];
const sync1 = await tool("todoist_sync_plan", { steps: plan, session_id: "test" });
assert.equal(sync1.structuredContent.created, 3);
console.log("PASS sync plan");

let board = (await tool("todoist_board_data")).structuredContent;
assert.equal(board.stats.total, 3);
assert.equal(board.stats.completed, 1);
assert.equal(board.stats.active, 2);
assert.equal(board.config.mode, "local");

const taskB = board.tasks.find((item) => item.content === "步骤 B");
await tool("todoist_complete_task", { task_id: taskB.id });
board = (await tool("todoist_board_data")).structuredContent;
assert.equal(board.stats.completed, 2);

const taskC = board.tasks.find((item) => item.content === "步骤 C");
await tool("todoist_reopen_task", { task_id: taskC.id });
board = (await tool("todoist_board_data")).structuredContent;
assert.equal(board.stats.completed, 1);
console.log("PASS complete/reopen");

assert.ok(Array.isArray(board.projects) && board.projects.length >= 1);
assert.ok(board.activeProjectId);
const originalProjectId = board.activeProjectId;

const labeled = await tool("todoist_add_task", {
  content: "带标签任务",
  labels: ["工作", "紧急"],
  due_date: "2026-10-20",
  priority: 2,
});
board = (await tool("todoist_board_data")).structuredContent;
const labeledTask = board.tasks.find((item) => item.id === labeled.structuredContent.id);
assert.deepEqual(labeledTask.labels, ["工作", "紧急"]);
assert.equal(labeledTask.dueDate, "2026-10-20");
assert.equal(labeledTask.priority, 2);
await tool("todoist_delete_task", { task_id: labeled.structuredContent.id });
board = (await tool("todoist_board_data")).structuredContent;
assert.equal(board.stats.total, 3);
console.log("PASS labels/due/priority");

const createdProject = await tool("todoist_create_project", { name: "第二个项目" });
assert.equal(createdProject.structuredContent.ok, true);
board = (await tool("todoist_board_data")).structuredContent;
assert.equal(board.activeProjectId, createdProject.structuredContent.project.id);
assert.equal(board.stats.total, 0);
await tool("todoist_set_project", { project_id: originalProjectId });
board = (await tool("todoist_board_data")).structuredContent;
assert.equal(board.activeProjectId, originalProjectId);
assert.equal(board.stats.total, 3);
console.log("PASS projects");

await tool("todoist_add_task", { content: "手动任务" });
board = (await tool("todoist_board_data")).structuredContent;
assert.equal(board.stats.total, 4);

const manual = board.tasks.find((item) => item.content === "手动任务");
await tool("todoist_update_task", { task_id: manual.id, content: "手动任务（已编辑）", priority: 2, due_date: "2026-10-20" });
board = (await tool("todoist_board_data")).structuredContent;
const edited = board.tasks.find((item) => item.id === manual.id);
assert.equal(edited.content, "手动任务（已编辑）");
assert.equal(edited.priority, 2);
assert.equal(edited.dueDate, "2026-10-20");

await tool("todoist_delete_task", { task_id: manual.id });
board = (await tool("todoist_board_data")).structuredContent;
assert.equal(board.stats.total, 3);
console.log("PASS update/delete");

const sync2 = await tool("todoist_sync_plan", { steps: plan, session_id: "test" });
assert.equal(sync2.structuredContent.created, 0);
assert.equal(sync2.structuredContent.total, 3);
board = (await tool("todoist_board_data")).structuredContent;
assert.equal(board.stats.total, 3, "sync must not duplicate tasks");
console.log("PASS idempotent sync");

const orderA = await tool("todoist_add_task", { content: "排序 A" });
const orderB = await tool("todoist_add_task", { content: "排序 B" });
board = (await tool("todoist_board_data")).structuredContent;
const manualIds = board.tasks.filter((item) => item.source === "manual").map((item) => item.id);
const reversed = [...manualIds].reverse();
await tool("todoist_reorder_tasks", { task_ids: reversed });
board = (await tool("todoist_board_data")).structuredContent;
assert.deepEqual(board.tasks.filter((item) => item.source === "manual").map((item) => item.id), reversed);
console.log("PASS reorder");
await tool("todoist_delete_task", { task_id: orderA.structuredContent.id });
await tool("todoist_delete_task", { task_id: orderB.structuredContent.id });

const last = await tool("todoist_sync_last_plan");
assert.equal(last.structuredContent.ok, true);
console.log("PASS sync last plan");

await tool("todoist_sync_plan", {
  steps: [{ step: "另一个会话的步骤", status: "pending" }],
  session_id: "other",
});
const lastTest = await tool("todoist_sync_last_plan", { session_id: "test" });
assert.equal(lastTest.structuredContent.ok, true);
assert.equal(lastTest.structuredContent.total, 3, "session-scoped last plan should use the test session");
board = (await tool("todoist_board_data")).structuredContent;
assert.ok(board.lastPlans.test, "test session plan missing");
assert.ok(board.lastPlans.other, "other session plan missing");
console.log("PASS per-session last plan");

const hook = await tool("todoist_sync_plan_from_hook", {
  raw: { plan: [{ step: "步骤 D", status: "pending" }] },
  session_id: "hook-test",
});
assert.equal(hook.structuredContent.ok, true);
assert.equal(hook.structuredContent.created, 1);
console.log("PASS hook sync");

child.stdin.end();
child.kill();
fs.rmSync(dataDir, { recursive: true, force: true });
console.log("\nALL TESTS PASSED");