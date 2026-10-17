import { spawn } from "node:child_process";
import http from "node:http";
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

function openSse(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      assert.equal(response.statusCode, 200);
      let data = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { data += chunk; });
      resolve({ request, response, getData: () => data });
    });
    request.on("error", reject);
  });
}

async function waitUntil(check, timeout = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("waitUntil timeout");
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
for (const name of ["todoist_open_board", "todoist_board_data", "todoist_board_version", "todoist_add_task", "todoist_complete_task", "todoist_sync_plan", "todoist_sync_last_plan", "todoist_sync_plan_from_hook"]) {
  assert.ok(names.includes(name), "missing tool " + name);
}
const openBoard = tools.tools.find((item) => item.name === "todoist_open_board");
assert.equal(openBoard.title, "Todoist");
assert.equal(openBoard._meta.ui.resourceUri, "ui://todoist/board.html");
assert.ok(Array.isArray(openBoard.icons) && openBoard.icons.length > 0, "tool icons missing");
const globalEntry = openBoard._meta["openai/ui"].entrypoints.find((item) => item.type === "global");
assert.ok(globalEntry);
assert.equal(globalEntry.quickAction.title, "打开 Todoist");
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
assert.ok(html.includes("fluid-cloud"), "fluid cloud missing");
assert.ok(html.includes("card-grid"), "card grid missing");
assert.ok(html.includes("task-card"), "task cards missing");
assert.ok(html.includes("sessionList"), "session category list missing");
assert.ok(html.includes("session-rail"), "session rail missing");
assert.ok(html.includes("hero-cloud"), "hero cloud missing");
assert.ok(html.includes("command-dock"), "command dock missing");
assert.ok(html.includes("sessionLabels"), "session title map missing");
const liveConfig = html.match(/const LIVE_CONFIG = \{ port: Number\("(\d+)"\), token: "([^"]+)" \};/);
assert.ok(liveConfig, "live config missing");
const sse = await openSse(`http://127.0.0.1:${liveConfig[1]}/events/${liveConfig[2]}`);
const beforeVersion = (await tool("todoist_board_version")).structuredContent.version;
const sseTask = await tool("todoist_add_task", { content: "SSE 测试任务" });
const afterVersion = (await tool("todoist_board_version")).structuredContent.version;
assert.ok(afterVersion > beforeVersion, "revision did not increase");
await waitUntil(() => sse.getData().includes("event: changed"));
sse.request.destroy();
await tool("todoist_delete_task", { task_id: sseTask.structuredContent.id });
console.log("PASS live refresh");

const textPlan = "## 计划\n1. 文本步骤 A\n2. 文本步骤 B";
const textSync = await tool("todoist_sync_plan_from_text", { text: textPlan, session_id: "text-test" });
assert.equal(textSync.structuredContent.created, 2);
const textSyncAgain = await tool("todoist_sync_plan_from_text", { text: textPlan, session_id: "text-test" });
assert.equal(textSyncAgain.structuredContent.created, 0);
const textBoard = (await tool("todoist_board_data")).structuredContent;
const textTasks = textBoard.tasks.filter((item) => item.content.startsWith("文本步骤"));
assert.equal(textTasks.length, 2);
for (const item of textTasks) await tool("todoist_delete_task", { task_id: item.id });
const noPlan = await tool("todoist_sync_plan_from_text", { text: "这是一条普通消息，没有计划。", session_id: "text-test" });
assert.equal(noPlan.structuredContent.ok, true);
assert.equal(noPlan.structuredContent.skipped, true);
assert.equal(noPlan.structuredContent.created, 0);
const noPlanBoard = (await tool("todoist_board_data")).structuredContent;
assert.equal(noPlanBoard.stats.total, 0, "non-plan text must not resurrect the last plan");
console.log("PASS no-plan text does not resync");
console.log("PASS text plan auto-sync");
const implementationPrompt = "PLEASE IMPLEMENT THIS PLAN:\n# 三步验收\n\n## 计划\n1. 用户提交步骤 A\n2. 用户提交步骤 B\n3. 用户提交步骤 C";
const promptSync = await tool("todoist_sync_plan_from_text", { text: implementationPrompt, session_id: "prompt-test" });
assert.equal(promptSync.structuredContent.created, 3);
const promptBoard = (await tool("todoist_board_data")).structuredContent;
const promptTasks = promptBoard.tasks.filter((item) => item.content.startsWith("用户提交步骤"));
assert.equal(promptTasks.length, 3);
for (const item of promptTasks) await tool("todoist_delete_task", { task_id: item.id });
console.log("PASS implementation prompt sync");
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
assert.ok(board.sessionLabels && typeof board.sessionLabels === "object", "session labels map missing");

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