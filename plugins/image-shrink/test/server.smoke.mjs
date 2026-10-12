#!/usr/bin/env node
// 冒烟测试：黑盒。只通过 stdio 发 JSON-RPC 请求，观察返回，不看服务内部实现。
// 用法：node test/server.smoke.mjs

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, "..", "mcp", "server.mjs");

let pass = 0;
let fail = 0;
function check(cond, label, detail) {
  if (cond) {
    pass++;
    console.log("  PASS  " + label);
  } else {
    fail++;
    console.log("  FAIL  " + label + (detail ? "  -> " + detail : ""));
  }
}

// ---- 造一张有噪声的 PNG，不用任何图像库 ----
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
function makeNoisyPng(width, height) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  let s = 123456789;
  for (let y = 0; y < height; y++) {
    const base = y * stride;
    raw[base] = 0;
    for (let x = 0; x < width * 3; x++) {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      raw[base + 1 + x] = (s >>> 16) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- 起服务，按行读响应 ----
const child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
let stderr = "";
child.stderr.on("data", (d) => {
  stderr += d.toString("utf8");
});
const responses = new Map();
let buffer = "";
child.stdout.on("data", (d) => {
  buffer += d.toString("utf8");
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined) responses.set(msg.id, msg);
    } catch {
      // 非 JSON 行忽略
    }
  }
});

function request(id, method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
}
function waitFor(id, timeoutMs) {
  const limit = timeoutMs || 240000;
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (responses.has(id)) {
        clearInterval(timer);
        resolve(responses.get(id));
      } else if (Date.now() - started > limit) {
        clearInterval(timer);
        reject(new Error("等待响应超时，id=" + id));
      }
    }, 100);
  });
}

function textOf(resp) {
  try {
    return resp.result.content.map((c) => c.text || "").join("\n");
  } catch {
    return "";
  }
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "image-shrink-smoke-"));
const imagePath = path.join(workDir, "shot.png");

try {
  console.log("server: " + SERVER);
  console.log("workdir: " + workDir);
  console.log("");

  console.log("[1] initialize");
  request(1, "initialize", { protocolVersion: "2025-11-25", clientInfo: { name: "smoke", version: "1.0.0" } });
  const init = await waitFor(1);
  check(!!init.result, "有 result");
  check(init.result && init.result.serverInfo && init.result.serverInfo.name === "Codex 图片体积守卫", "serverInfo 正确", JSON.stringify(init.result && init.result.serverInfo));
  check(init.result && init.result.capabilities && !!init.result.capabilities.tools, "声明 tools 能力");

  console.log("[2] tools/list");
  request(2, "tools/list", {});
  const list = await waitFor(2);
  const tools = (list.result && list.result.tools) || [];
  const names = tools.map((t) => t.name).sort();
  check(tools.length === 2, "工具数量=2", "实际 " + tools.length);
  check(names.join(",") === "check_payload_budget,compress_image", "工具名正确", names.join(","));
  check(tools.every((t) => t.description && t.description.length > 20), "每个工具都有描述");

  fs.writeFileSync(imagePath, makeNoisyPng(1600, 900));
  const originalSize = fs.statSync(imagePath).size;
  console.log("     测试图 " + originalSize + " 字节");

  console.log("[3] check_payload_budget");
  request(3, "tools/call", { name: "check_payload_budget", arguments: { paths: [imagePath] } });
  const budget = await waitFor(3);
  const budgetText = textOf(budget);
  check(!budget.result.isError, "不是错误");
  check(budgetText.includes("48 MiB"), "提到 48 MiB 上限");
  check(budgetText.includes("1 张图片"), "统计到 1 张图片");

  console.log("[4] compress_image");
  request(4, "tools/call", { name: "compress_image", arguments: { paths: [imagePath], maxBytes: "400KB" } });
  const compressed = await waitFor(4);
  const compressedText = textOf(compressed);
  if (process.platform === "win32") {
    check(!compressed.result.isError, "不是错误", compressedText.slice(0, 200));
    const outputPath = path.join(workDir, "shot.small.jpg");
    check(fs.existsSync(outputPath), "生成了 shot.small.jpg");
    if (fs.existsSync(outputPath)) {
      const outSize = fs.statSync(outputPath).size;
      check(outSize <= 409600, "体积达标 (<=400KB)", outSize + " 字节");
      check(outSize < originalSize, "确实变小了", originalSize + " -> " + outSize);
    }
    check(compressedText.includes("占 48 MiB 上限"), "报告了请求体占比");
  } else {
    console.log("  SKIP  非 Windows，压缩不可用（预期返回不支持提示）");
    check(compressed.result.isError, "非 Windows 下返回错误而不是崩溃");
  }

  console.log("[5] 错误路径");
  request(5, "tools/call", { name: "compress_image", arguments: { paths: [path.join(workDir, "nope.png")] } });
  const missing = await waitFor(5);
  check(missing.result.isError === true, "找不到文件时返回 isError");

  console.log("[6] 未知工具");
  request(6, "tools/call", { name: "no_such_tool", arguments: {} });
  const unknown = await waitFor(6);
  check(unknown.result.isError === true, "未知工具返回 isError");

  console.log("");
  console.log("结果：" + pass + " 通过，" + fail + " 失败");
  if (stderr.trim()) console.log("stderr: " + stderr.trim().slice(0, 500));
} catch (err) {
  fail++;
  console.log("");
  console.log("测试中断：" + (err && err.message ? err.message : String(err)));
} finally {
  try {
    child.stdin.end();
  } catch {}
  try {
    child.kill();
  } catch {}
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch {}
}

process.exit(fail === 0 ? 0 : 1);