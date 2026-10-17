import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
  addTask,
  createProject,
  deleteTask,
  getBoardData,
  reorderTasks,
  setActiveProject,
  setTaskDone,
  syncLastPlan,
  syncPlan,
  syncPlanFromText,
  updateTask,
} from "./lib/planner.mjs";
import { readConfig, readState } from "./lib/store.mjs";

const SERVER_NAME = "todoist";
const SERVER_VERSION = "0.6.9";
const BOARD_URI = "ui://todoist/board.html";
const BOARD_ICON = {
  src: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IiM4ZjhmOGYiIHN0cm9rZS13aWR0aD0iMS43IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxyZWN0IHg9IjMuNSIgeT0iMy41IiB3aWR0aD0iMTciIGhlaWdodD0iMTciIHJ4PSI1Ii8+PHBhdGggZD0ibTggMTIuMiAyLjYgMi42TDE2LjUgOSIvPjwvc3ZnPg==",
  mimeType: "image/svg+xml",
  sizes: ["24x24"],
};
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SSE_TOKEN = crypto.randomBytes(16).toString("hex");
let ssePort = 0;
const sseClients = new Set();
const sseReady = new Promise((resolve) => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname !== `/events/${SSE_TOKEN}`) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write("retry: 2000\n\n");
    sseClients.add(res);
    const ping = setInterval(() => {
      try { res.write(": ping\n\n"); } catch {}
    }, 25000);
    req.on("close", () => {
      clearInterval(ping);
      sseClients.delete(res);
    });
  });
  server.on("error", (error) => {
    process.stderr.write(`[todoist] live server failed: ${error.message}\n`);
    resolve();
  });
  server.listen(0, "127.0.0.1", () => {
    ssePort = server.address().port;
    resolve();
  });
  server.unref?.();
});

function broadcastChange(reason) {
  const payload = `event: changed\ndata: ${JSON.stringify({ reason, at: Date.now() })}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

function boardUiMeta() {
  return {
    ui: { csp: { connectDomains: [`http://127.0.0.1:${ssePort}`] } },
    "openai/ui": {
      preferredDisplayMode: "fullscreen",
      availableDisplayModes: ["inline", "fullscreen"],
    },
  };
}

const JsonRpcError = {
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
};

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function sendToolResult(id, payload, { isError = false } = {}) {
  const text =
    typeof payload === "string"
      ? payload
      : payload?.error
        ? payload.error
        : payload?.message
          ? payload.message
          : JSON.stringify(payload ?? null, null, 2);
  sendResult(id, {
    content: [{ type: "text", text }],
    structuredContent: payload ?? null,
    _meta: payload ?? null,
    isError,
  });
}

const BOARD_TOOL_META = {
  ui: { resourceUri: BOARD_URI, visibility: ["model", "app"] },
  "openai/outputTemplate": BOARD_URI,
  "openai/ui": {
    entrypoints: [
      {
        type: "global",
        quickAction: {
          title: "打开 Todoist",
          icons: [BOARD_ICON],
          target: { type: "tool", name: "todoist_open_board", arguments: {} },
        },
      },
      { type: "thread" },
    ],
  },
};

const TOOLS = [
  {
    name: "todoist_open_board",
    title: "Todoist",
    description:
      "在 Codex 侧边栏或对话侧栏打开任务清单面板，可查看哪些任务已完成、哪些还没做。",
    icons: [BOARD_ICON],
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: BOARD_TOOL_META,
  },
  {
    name: "todoist_board_data",
    title: "读取任务清单",
    description:
      "读取 Codex 任务项目里的全部任务和完成状态。返回 tasks、stats、config、lastPlan，供任务清单面板或模型总结使用。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "todoist_board_version",
    title: "读取任务版本",
    description: "返回任务清单的版本号，用于面板做轻量增量刷新。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "todoist_add_task",
    title: "添加任务",
    description: "往 Codex 任务项目里添加一条待办。",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "任务内容" },
        project_id: { type: "string", description: "目标项目 ID，可选" },
        labels: { type: "array", items: { type: "string" }, description: "标签列表，可选" },
        due_date: { type: "string", description: "截止日期 YYYY-MM-DD，可选" },
        priority: { type: "integer", minimum: 1, maximum: 4, description: "优先级 1-4，1 最高" },
      },
      required: ["content"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "todoist_complete_task",
    title: "完成任务",
    description: "把指定任务标记为完成。",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "任务 ID" },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "todoist_reopen_task",
    title: "恢复任务",
    description: "把已完成的指定任务重新标记为未完成。",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "任务 ID" },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "todoist_sync_plan",
    title: "同步计划到 Todoist",
    description:
      "把一组计划步骤同步成 Todoist 任务：缺失的创建，已完成的自动勾掉。步骤格式为 [{step, status}]，status 可为 pending、inProgress、completed。重复调用不会重复建任务。",
    inputSchema: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          description: "计划步骤",
          items: {
            oneOf: [
              { type: "string" },
              {
                type: "object",
                properties: {
                  step: { type: "string" },
                  status: { type: "string", enum: ["pending", "inProgress", "completed"] },
                },
                required: ["step"],
                additionalProperties: true,
              },
            ],
          },
        },
        session_id: { type: "string", description: "会话 ID，用于区分不同任务的计划" },
        turn_id: { type: "string", description: "轮次 ID，可选" },
      },
      required: ["steps"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "todoist_sync_last_plan",
    title: "同步最近一次计划",
    description:
      "把记录到的 /plan 计划再次同步到 Todoist。传 session_id 时同步该会话的计划；不传时同步最新的一份。没有计划时返回提示。",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "会话 ID，可选；用于同步指定会话的计划" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "todoist_sync_plan_from_hook",
    title: "同步计划（钩子）",
    description:
      "供 PostToolUse 钩子调用：把 update_plan 的计划步骤同步到 Todoist。普通对话不需要直接调用。",
    inputSchema: {
      type: "object",
      properties: {
        steps: { description: "计划步骤数组，通常来自 tool_input.plan" },
        raw: { description: "原始 tool_input，兜底解析" },
        session_id: { type: "string" },
        turn_id: { type: "string" },
      },
      additionalProperties: true,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "todoist_sync_plan_from_text",
    title: "同步计划文本（钩子）",
    description:
      "供 UserPromptSubmit / Stop 钩子调用：从用户提交内容或最后一条助手消息里提取计划清单并同步；没有可提取的计划时跳过，不修改现有任务。",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "最后一条助手消息" },
        session_id: { type: "string" },
        turn_id: { type: "string" },
      },
      additionalProperties: true,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "todoist_update_task",
    title: "编辑任务",
    description: "修改任务内容、截止日期或优先级。priority 为 1-4，1 最高；due_date 用 YYYY-MM-DD，传空字符串表示清除日期。",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "任务 ID" },
        content: { type: "string", description: "新的任务内容" },
        due_date: { type: "string", description: "截止日期 YYYY-MM-DD，空字符串表示清除" },
        priority: { type: "integer", minimum: 1, maximum: 4, description: "优先级，1 最高，4 最低" },
        labels: { type: "array", items: { type: "string" }, description: "标签列表" },
        project_id: { type: "string", description: "移动到指定项目" },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "todoist_delete_task",
    title: "删除任务",
    description: "删除指定任务。删除前请确认用户确实要删。",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "任务 ID" },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },  {
    name: "todoist_set_project",
    title: "切换项目",
    description: "切换当前任务清单显示的项目。project_id 来自 todoist_board_data 返回的 projects。",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "项目 ID" },
      },
      required: ["project_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "todoist_create_project",
    title: "新建项目",
    description: "创建一个新项目，并切换到这个项目。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "项目名称" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "todoist_reorder_tasks",
    title: "重排任务",
    description: "按给定顺序重排任务。task_ids 是任务 ID 数组，数组顺序就是新的显示顺序。",
    inputSchema: {
      type: "object",
      properties: {
        task_ids: {
          type: "array",
          items: { type: "string" },
          description: "按新顺序排列的任务 ID",
        },
      },
      required: ["task_ids"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },  {
    name: "todoist_status",
    title: "查看连接状态",
    description: "检查 Todoist Token 是否已配置、数据目录在哪里、当前使用 Todoist 还是本地演示模式。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

function readBoardHtml() {
  return fs
    .readFileSync(path.join(HERE, "ui", "board.html"), "utf8")
    .replaceAll("__SSE_PORT__", String(ssePort))
    .replaceAll("__SSE_TOKEN__", SSE_TOKEN);
}

let currentToolName = null;
const MUTATION_TOOLS = new Set([
  "todoist_add_task",
  "todoist_complete_task",
  "todoist_reopen_task",
  "todoist_update_task",
  "todoist_delete_task",
  "todoist_reorder_tasks",
  "todoist_sync_plan",
  "todoist_sync_last_plan",
  "todoist_sync_plan_from_hook",
  "todoist_sync_plan_from_text",
  "todoist_set_project",
  "todoist_create_project",
]);

function toolResult(id, payload, options) {
  if (!options?.isError && currentToolName && MUTATION_TOOLS.has(currentToolName)) {
    broadcastChange(currentToolName);
  }
  return sendToolResult(id, payload, options);
}

async function handleToolCall(id, params) {
  const name = params?.name;
  const args = params?.arguments && typeof params.arguments === "object" ? params.arguments : {};
  currentToolName = name;

  try {
    switch (name) {
      case "todoist_open_board":
        return toolResult(id, { ok: true, message: "任务清单已打开" });

      case "todoist_board_data":
        return toolResult(id, await getBoardData());

      case "todoist_board_version": {
        const state = readState();
        return toolResult(id, { version: Number(state.revision) || 0 });
      }

      case "todoist_add_task":
        return toolResult(
          id,
          await addTask(args.content, {
            projectId: args.project_id,
            labels: args.labels,
            dueDate: args.due_date,
            priority: args.priority,
          }),
        );

      case "todoist_complete_task":
        return toolResult(id, await setTaskDone(args.task_id, true));

      case "todoist_reopen_task":
        return toolResult(id, await setTaskDone(args.task_id, false));

      case "todoist_sync_plan":
        return toolResult(
          id,
          await syncPlan({
            steps: args.steps,
            sessionId: args.session_id || "default",
            turnId: args.turn_id || null,
            source: "tool",
          }),
        );

      case "todoist_sync_last_plan":
        return toolResult(id, await syncLastPlan(args.session_id || null));

      case "todoist_sync_plan_from_hook": {
        const hookSteps = Array.isArray(args.steps) ? args.steps : args.raw;
        return toolResult(
          id,
          await syncPlan({
            steps: hookSteps,
            sessionId: args.session_id || "hook",
            turnId: args.turn_id || null,
            source: "hook",
          }),
        );
      }
      case "todoist_sync_plan_from_text":
        return toolResult(
          id,
          await syncPlanFromText({
            text: args.text,
            sessionId: args.session_id || "hook",
            turnId: args.turn_id || null,
          }),
        );

      case "todoist_update_task":
        return toolResult(
          id,
          await updateTask(args.task_id, {
            content: args.content,
            due_date: args.due_date,
            priority: args.priority,
            labels: args.labels,
            project_id: args.project_id,
          }),
        );

      case "todoist_delete_task":
        return toolResult(id, await deleteTask(args.task_id));
      case "todoist_set_project":
        return toolResult(id, await setActiveProject(args.project_id));

      case "todoist_create_project":
        return toolResult(id, await createProject(args.name));

      case "todoist_reorder_tasks":
        return toolResult(id, await reorderTasks(args.task_ids));
      case "todoist_status": {
        const config = readConfig();
        return toolResult(id, {
          ok: true,
          mode: config.tokenConfigured ? "todoist" : "local",
          tokenConfigured: config.tokenConfigured,
          projectName: config.projectName,
          configPath: config.configPath,
        });
      }

      default:
        return toolResult(id, { ok: false, error: `未知工具：${name}` }, { isError: true });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[todoist] tool ${name} failed: ${message}\n`);
    return toolResult(id, { ok: false, error: message }, { isError: true });
  } finally {
    currentToolName = null;
  }
}

async function handleRequest(message) {
  const { id, method, params } = message;

  if (method === "initialize") {
    sendResult(id, {
      protocolVersion: params?.protocolVersion || "2025-11-25",
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION, icons: [BOARD_ICON] },
      instructions:
        "Todoist 插件。用 todoist_sync_plan 把计划步骤同步到 Todoist；用 todoist_open_board 打开侧边栏面板。不要重复创建同名计划任务。",
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
    await handleToolCall(id, params);
    return;
  }

  if (method === "resources/list") {
    await sseReady;
    sendResult(id, {
      resources: [
        {
          uri: BOARD_URI,
          name: "Todoist 面板",
          description: "查看任务完成情况、添加任务、勾选完成。",
          mimeType: "text/html;profile=mcp-app",
          _meta: boardUiMeta(),
        },
      ],
    });
    return;
  }

  if (method === "resources/read") {
    const uri = params?.uri;
    if (uri !== BOARD_URI) {
      sendError(id, JsonRpcError.INVALID_PARAMS, `未知资源：${uri}`);
      return;
    }
    await sseReady;
    sendResult(id, {
      contents: [
        {
          uri: BOARD_URI,
          mimeType: "text/html;profile=mcp-app",
          text: readBoardHtml(),
          _meta: boardUiMeta(),
        },
      ],
    });
    return;
  }

  if (method === "resources/templates/list" || method === "prompts/list") {
    sendResult(id, method === "prompts/list" ? { prompts: [] } : { resourceTemplates: [] });
    return;
  }

  if (
    method === "notifications/initialized" ||
    method === "notifications/cancelled" ||
    method === "notifications/progress"
  ) {
    return;
  }

  if (id !== undefined) {
    sendError(id, JsonRpcError.METHOD_NOT_FOUND, `未找到方法：${method}`);
  }
}

let requestQueue = Promise.resolve();

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("close", () => process.exit(0));
lines.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line.replace(/^\uFEFF/, ""));
  } catch (error) {
    process.stderr.write(`[todoist] 忽略无效 JSON-RPC 行：${error instanceof Error ? error.message : String(error)}\n`);
    return;
  }
  if (message.method === undefined && message.id !== undefined) return;
  requestQueue = requestQueue.then(() => handleRequest(message)).catch((error) => {
    const text = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[todoist] request failed: ${text}\n`);
    if (message.id !== undefined) {
      sendError(message.id, JsonRpcError.INTERNAL_ERROR, text);
    }
  });
});