#!/usr/bin/env node
// Codex 图片体积守卫 · MCP 服务
// 传输：换行分隔的 JSON-RPC over stdio。零外部依赖。

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SERVER_NAME = "Codex 图片体积守卫";
const SERVER_VERSION = "0.2.0";

// DeepSeek /responses 的请求体上限，实测值（见 skills/image-shrink/references/limits.md）。
const BODY_LIMIT_BYTES = 50331648; // 48 MiB
const BASE64_RATIO = 1.33;
const DEFAULT_MAX_BYTES = 409600; // 400 KB

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"]);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHRINK_SCRIPT = path.resolve(HERE, "..", "skills", "image-shrink", "scripts", "shrink-image.ps1");

const TOOLS = [
  {
    name: "compress_image",
    description:
      "把图片/截图压小后再放进上下文。Codex 每次请求都会把历史里出现过的图片重新发一遍（base64，体积约源文件的 1.33 倍），请求体一旦超过 48 MiB 就会返回 413 Payload Too Large，整个会话彻底卡死、只能新开。查看任何截图或图片之前，先用这个工具压缩它，然后只读取压缩后的 .small.jpg。",
    inputSchema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "图片文件路径，或包含图片的目录。目录会自动取其下的图片文件。",
        },
        maxBytes: { type: "string", description: "单张图的目标体积上限，如 400KB / 1MB。默认 400KB。", default: "400KB" },
        maxWidth: { type: "integer", description: "最长边目标像素。默认 1600；小字看不清可调到 2000。", default: 1600 },
        quality: { type: "integer", description: "JPEG 起始质量 1-100。默认 80。", default: 80 },
        outDir: { type: "string", description: "输出目录。不填则输出到原图旁边。" },
      },
      required: ["paths"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "check_payload_budget",
    description:
      "估算一批图片放进请求体后的体积，以及距离 48 MiB 上限还有多远。用户要一次贴多张图、或怀疑当前会话图片太多时调用它，先算清楚再决定要不要压缩或开新会话。只读，不改任何文件。",
    inputSchema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "图片文件路径，或包含图片的目录。",
        },
      },
      required: ["paths"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function ok(text) {
  return { content: [{ type: "text", text }] };
}

function fail(text) {
  return { isError: true, content: [{ type: "text", text }] };
}

function formatBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1048576) return (v / 1048576).toFixed(2) + " MB";
  if (v >= 1024) return (v / 1024).toFixed(1) + " KB";
  return Math.round(v) + " B";
}

function parseSize(text, fallback) {
  if (text === undefined || text === null || text === "") return fallback;
  const m = /^([0-9]+(?:\.[0-9]+)?)\s*(kb|mb|b)?$/i.exec(String(text).trim());
  if (!m) return fallback;
  const v = Number(m[1]);
  const unit = (m[2] || "b").toLowerCase();
  if (unit === "mb") return Math.round(v * 1048576);
  if (unit === "kb") return Math.round(v * 1024);
  return Math.round(v);
}

function budget(totalBytes) {
  const inBody = Math.round(totalBytes * BASE64_RATIO);
  const pct = (inBody / BODY_LIMIT_BYTES) * 100;
  let risk = "安全";
  if (pct >= 90) risk = "危险，再贴几张就会 413";
  else if (pct >= 60) risk = "偏高";
  else if (pct >= 25) risk = "需要留意";
  return { inBody, pct, risk };
}

function expandImages(inputs) {
  const files = [];
  for (const raw of inputs) {
    if (!raw || typeof raw !== "string") continue;
    const p = path.resolve(raw);
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(p)) {
        const full = path.join(p, name);
        try {
          if (fs.statSync(full).isFile() && IMAGE_EXTS.has(path.extname(full).toLowerCase())) files.push(full);
        } catch {
          // 单个文件读不到就跳过。
        }
      }
    } else if (st.isFile()) {
      files.push(p);
    }
  }
  return files;
}

function outputPathFor(file, outDir) {
  const dir = outDir || path.dirname(file);
  return path.join(dir, path.basename(file, path.extname(file)) + ".small.jpg");
}

async function runShrink(files, options) {
  if (process.platform !== "win32") {
    throw new Error(
      "压缩目前只在 Windows 上实现（PowerShell + System.Drawing）。macOS 可以用 sips，Linux 可以用 ImageMagick，请手动压缩，或把图片换成更小的版本。"
    );
  }
  if (!fs.existsSync(SHRINK_SCRIPT)) {
    throw new Error("找不到压缩脚本：" + SHRINK_SCRIPT);
  }
  const args = [
    "-ExecutionPolicy", "Bypass",
    "-NoProfile",
    "-File", SHRINK_SCRIPT,
    "-Path", files.join(","),
    "-MaxWidth", String(options.maxWidth),
    "-Quality", String(options.quality),
  ];
  if (options.maxBytes > 0) args.push("-MaxBytes", String(options.maxBytes));
  if (options.outDir) args.push("-OutDir", options.outDir);
  await execFileAsync("powershell", args, { windowsHide: true, timeout: 180000, maxBuffer: 32 * 1024 * 1024 });
}

async function toolCompressImage(args) {
  const inputs = Array.isArray(args.paths) ? args.paths : [args.paths].filter(Boolean);
  if (inputs.length === 0) return fail("请提供 paths：图片文件路径或包含图片的目录。");
  const files = expandImages(inputs);
  if (files.length === 0) return fail("在这些路径里没有找到任何图片文件。");

  const maxWidth = Number(args.maxWidth) > 0 ? Math.round(Number(args.maxWidth)) : 1600;
  const quality = Number(args.quality) > 0 ? Math.max(1, Math.min(100, Math.round(Number(args.quality)))) : 80;
  const maxBytes = parseSize(args.maxBytes, DEFAULT_MAX_BYTES);
  const outDir = args.outDir ? path.resolve(String(args.outDir)) : null;

  const before = files.map((f) => fs.statSync(f).size);
  const beforeTotal = before.reduce((a, b) => a + b, 0);

  try {
    await runShrink(files, { maxWidth, quality, maxBytes, outDir });
  } catch (err) {
    return fail("压缩失败：" + (err && err.message ? err.message : String(err)));
  }

  const lines = [];
  let afterTotal = 0;
  let failed = 0;
  files.forEach((file, i) => {
    const target = outputPathFor(file, outDir);
    let after = null;
    try {
      after = fs.statSync(target).size;
    } catch {
      after = null;
    }
    if (after === null) {
      failed++;
      lines.push("- " + path.basename(file) + "：没有生成压缩文件，失败");
      return;
    }
    afterTotal += after;
    const saved = before[i] > 0 ? Math.round((1 - after / before[i]) * 100) : 0;
    lines.push("- " + path.basename(file) + "：" + formatBytes(before[i]) + " → " + formatBytes(after) + "（省 " + saved + "%）");
  });

  const b0 = budget(beforeTotal);
  const b1 = budget(afterTotal);
  const head = [
    "压缩完成：" + files.length + " 张" + (failed > 0 ? "（失败 " + failed + " 张）" : "") + "，目标单张 ≤ " + formatBytes(maxBytes),
    "图片总体积：" + formatBytes(beforeTotal) + " → " + formatBytes(afterTotal),
    "放进请求体后：" + formatBytes(b0.inBody) + " → " + formatBytes(b1.inBody) + "（占 48 MiB 上限 " + b0.pct.toFixed(1) + "% → " + b1.pct.toFixed(1) + "%，" + b1.risk + "）",
    "",
    "接下来只看压缩后的 .small.jpg，不要再读原图。",
    "",
  ].join("\n");

  return ok(head + lines.join("\n") + "\n\n输出文件：\n" + files.map((f) => "- " + outputPathFor(f, outDir)).join("\n"));
}

async function toolCheckBudget(args) {
  const inputs = Array.isArray(args.paths) ? args.paths : [args.paths].filter(Boolean);
  if (inputs.length === 0) return fail("请提供 paths：图片文件路径或包含图片的目录。");
  const files = expandImages(inputs);
  if (files.length === 0) return fail("在这些路径里没有找到任何图片文件。");

  const sizes = files.map((f) => ({ file: f, size: fs.statSync(f).size }));
  const total = sizes.reduce((a, s) => a + s.size, 0);
  const b = budget(total);

  const lines = sizes
    .sort((a, c) => c.size - a.size)
    .map((s) => "- " + path.basename(s.file) + "：" + formatBytes(s.size));

  const advice =
    b.pct >= 90
      ? "先压缩，或者分成几个会话处理，不要直接全部贴进对话。"
      : b.pct >= 60
      ? "建议先压缩再贴；如果本来就在一个很长的会话里，考虑开新会话。"
      : "体积可控，但仍建议压缩后再贴，因为图片成本每轮都会重复计入。";

  return ok(
    [
      "共 " + files.length + " 张图片，合计 " + formatBytes(total),
      "base64 进请求体后约 " + formatBytes(b.inBody) + "，占 48 MiB 上限的 " + b.pct.toFixed(1) + "%（" + b.risk + "）",
      "注意：上面算的是这一批的体积；会话里已有的图片会额外叠加。",
      "",
      advice,
      "",
      lines.join("\n"),
    ].join("\n")
  );
}

const HANDLERS = {
  compress_image: toolCompressImage,
  check_payload_budget: toolCheckBudget,
};

async function handleToolCall(id, params) {
  const name = params && params.name;
  const args = (params && params.arguments) || {};
  const handler = HANDLERS[name];
  if (!handler) {
    sendResult(id, fail("未知工具：" + (name || "")));
    return;
  }
  try {
    sendResult(id, await handler(args));
  } catch (err) {
    sendResult(id, fail("工具执行出错：" + (err && err.message ? err.message : String(err))));
  }
}

async function handleRequest(message) {
  const { id, method, params } = message;

  if (method === "initialize") {
    sendResult(id, {
      protocolVersion: (params && params.protocolVersion) || "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions:
        "处理图片和截图之前，先调用 compress_image 压缩，然后只读压缩后的 .small.jpg。用户要一次贴多张图、或怀疑会话图片过多时，先调用 check_payload_budget 估算请求体体积。",
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
    if (id === undefined) return;
    await handleToolCall(id, params);
    return;
  }

  if (method === "notifications/initialized" || method === "notifications/cancelled") {
    return;
  }

  if (id !== undefined) {
    sendError(id, -32601, "未找到方法：" + method);
  }
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("close", () => process.exit(0));
lines.on("line", (line) => {
  if (line.trim().length === 0) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  Promise.resolve(handleRequest(message)).catch((err) => {
    if (message && message.id !== undefined) {
      sendError(message.id, -32603, "内部错误：" + (err && err.message ? err.message : String(err)));
    }
  });
});