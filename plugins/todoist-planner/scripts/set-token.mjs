import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const configDir = path.join(os.homedir(), ".codex", "todoist-planner");
const configPath = path.join(configDir, "config.json");

function finish(token) {
  const value = String(token || "").trim();
  if (value.length < 20) {
    process.stderr.write("\nToken 看起来太短了，请确认复制完整。\n");
    process.exit(1);
  }
  fs.mkdirSync(configDir, { recursive: true });
  let config = {};
  try { config = JSON.parse(fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, "")); } catch {}
  config.token = value;
  config.projectName = config.projectName || "Codex 任务";
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  try { fs.chmodSync(configPath, 0o600); } catch {}
  process.stdout.write(`\n已保存到 ${configPath}\n重启 Codex 后生效。\n`);
  process.exit(0);
}

const stdin = process.stdin;
const stdout = process.stdout;

if (!stdin.isTTY) {
  let raw = "";
  stdin.setEncoding("utf8");
  stdin.on("data", (chunk) => { raw += chunk; });
  stdin.on("end", () => finish(raw));
} else {
  stdout.write("粘贴 Todoist API Token（输入不回显，回车确认）：");
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  let token = "";
  stdin.on("data", (chunk) => {
    for (const ch of chunk) {
      if (ch === "\r" || ch === "\n") {
        stdin.setRawMode(false);
        finish(token);
        return;
      }
      if (ch === "\u0003") {
        stdout.write("\n已取消。\n");
        process.exit(1);
      }
      if (ch === "\u007f" || ch === "\b") {
        if (token) { token = token.slice(0, -1); stdout.write("\b \b"); }
        continue;
      }
      token += ch;
      stdout.write("*");
    }
  });
}