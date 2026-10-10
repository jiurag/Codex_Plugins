import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(testDir, "..");
const serverPath = path.join(pluginRoot, "mcp", "server.mjs");
const tempRoot = path.join(pluginRoot, ".test-rpc");
const vaultHome = path.join(tempRoot, "vault");
const fakeSsh = path.join(tempRoot, "fake-ssh.mjs");
const fakeSftp = path.join(tempRoot, "fake-sftp.mjs");
const callLog = path.join(tempRoot, "calls.log");
const sftpFailFlag = path.join(tempRoot, "sftp-session-broken");

function resetTemp() {
  fs.rmSync(tempRoot, { recursive: true, force: true });
  fs.mkdirSync(tempRoot, { recursive: true });
}

function createFakeBinaries() {
  const sshSource = `import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";
const args = process.argv.slice(2);
const localRoot = ${JSON.stringify(tempRoot)};
fs.appendFileSync(${JSON.stringify(callLog)}, "ssh " + args.join(" ") + "\\n");
if (args.includes("-tt")) {
  process.stdout.write("FAKE_INTERACTIVE_READY\\n");
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    process.stdout.write("FAKE_ECHO:" + line + "\\n");
    if (line === "exit") process.exit(0);
  });
} else {
  // 命令现在通过 stdin 传入（bash -s / sh -s），这里读脚本后模拟执行。
  let script = "";
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => { script += line + "\\n"; fs.appendFileSync(${JSON.stringify(callLog)}, "  script: " + line + "\\n"); });
  rl.on("close", () => {
    const body = script.split("\\n").map((l) => l.trim()).filter(Boolean).join("\\n");
    const md5 = /md5sum \x27([^\x27]*)\x27/.exec(body);
    if (md5) {
      const remote = md5[1];
      const base = remote.split("/").filter(Boolean).pop() || "";
      const local = path.join(localRoot, base);
      if (fs.existsSync(local)) {
        process.stdout.write(crypto.createHash("md5").update(fs.readFileSync(local)).digest("hex") + "  " + remote + "\\n");
      } else {
        process.stderr.write("md5sum: " + remote + ": No such file or directory\\n");
        process.exitCode = 1;
      }
      return;
    }
    if (body.includes("FAIL_ME")) {
      process.stdout.write("partial before failure\\n");
      process.stderr.write("simulated failure reason\\n");
      process.exitCode = 7;
      return;
    }
    if (body.includes("awk")) {
      process.stdout.write("0 0");
      return;
    }
    process.stdout.write("FAKE_SSH " + (body.split("\\n")[0] || "") + "\\n");
  });
}
`;
  const sftpSource = `import fs from "node:fs";\nimport path from "node:path";\nimport readline from "node:readline";\nconst args = process.argv.slice(2);\nconst isBatch = args.includes("-b");\nconst failFlag = ${JSON.stringify(sftpFailFlag)};\nfs.appendFileSync(${JSON.stringify(callLog)}, "sftp " + args.join(" ") + "\\n");\n/* 不回显参数：真实 sftp 也不会这样做，且会污染失败判定 */\nconst rl = readline.createInterface({ input: process.stdin, terminal: false });\nrl.on("line", (line) => {\n  fs.appendFileSync(${JSON.stringify(callLog)}, "  " + line + "\\n");\n  if (fs.existsSync(failFlag) && /^(put|get)\\b/.test(line.trim())) {\n    fs.rmSync(failFlag, { force: true });\n    fs.appendFileSync(${JSON.stringify(callLog)}, "  [FAKE_SFTP_SESSION_BROKEN]\\n");\n    process.stderr.write("Connection closed by remote host\\r\\n");\n    process.exit(1);\n  }\n  const getMatch = /^get(?: -r)? "([^"]*)" "([^"]*)"$/.exec(line.trim());\n  if (getMatch) {\n    const base = getMatch[1].split("/").filter(Boolean).pop() || "file";\n    try { fs.mkdirSync(getMatch[2], { recursive: true }); fs.writeFileSync(path.join(getMatch[2], base), "fake"); } catch {}\n  }\n  if (line.startsWith("!echo ")) { process.stdout.write(line.slice(6) + "\\n"); }\n  else if (line.trim() && line.trim() !== "exit") { process.stdout.write("FAKE_SFTP_CMD:" + line + "\\n"); }\n});\nrl.on("close", () => process.exit(0));\n`;
  fs.writeFileSync(fakeSsh, sshSource, "utf8");
  fs.writeFileSync(fakeSftp, sftpSource, "utf8");
}

// Codex 确认表单只接受受限 JSON Schema 子集。若混入数组、writeOnly、format:"password" 等
// 不受支持的字段，整个 elicitation 请求会被客户端拒绝，所有需要确认的操作都会失败。
const ALLOWED_ELICITATION_KEYS = {
  boolean: new Set(["type", "title", "description", "default"]),
  string: new Set(["type", "title", "description", "minLength", "maxLength", "format", "default", "enum", "enumNames", "oneOf"]),
  number: new Set(["type", "title", "description", "minimum", "maximum", "default"]),
  integer: new Set(["type", "title", "description", "minimum", "maximum", "default"]),
};
const ALLOWED_ELICITATION_FORMATS = new Set(["email", "uri", "date", "date-time"]);

// 确认表单的 message 是渲染在选项上方的文本，Codex 按内容换行后按需撑高面板。
// message 过长会把选项挤出可视区域（"选项被遮挡"），因此这里锁死预算防止回归。
const APPROVAL_MESSAGE_HEAD_ROWS = 9;
const APPROVAL_MESSAGE_TAIL_ROWS = 3;
const APPROVAL_MESSAGE_MAX_ROWS = APPROVAL_MESSAGE_HEAD_ROWS + APPROVAL_MESSAGE_TAIL_ROWS + 1;
const APPROVAL_MESSAGE_MAX_CHARS = 2400;

function collectApprovalMessageViolations(params) {
  const violations = [];
  if (!params?.requestedSchema?.properties?.decision) return violations;
  const message = typeof params.message === 'string' ? params.message : '';
  const lines = message.split('\n');
  if (lines.length > APPROVAL_MESSAGE_MAX_ROWS) {
    violations.push('message 行数 ' + lines.length + ' 超过 ' + APPROVAL_MESSAGE_MAX_ROWS);
  }
  if (message.length > APPROVAL_MESSAGE_MAX_CHARS) {
    violations.push('message 字符数 ' + message.length + ' 超过 ' + APPROVAL_MESSAGE_MAX_CHARS);
  }
  return violations;
}

function collectElicitationSchemaViolations(params) {
  const violations = [];
  const schema = params?.requestedSchema;
  if (schema?.type !== "object") return ["requestedSchema.type 必须是 object"];
  for (const [field, property] of Object.entries(schema.properties ?? {})) {
    const allowed = ALLOWED_ELICITATION_KEYS[property.type];
    if (!allowed) {
      violations.push(field + ": 不支持的类型 " + property.type);
      continue;
    }
    for (const key of Object.keys(property)) {
      if (!allowed.has(key)) violations.push(field + ": 不支持的关键字 " + key);
    }
    if (property.format !== undefined && !ALLOWED_ELICITATION_FORMATS.has(property.format)) {
      violations.push(field + ": 不支持的 format " + property.format);
    }
    if (property.oneOf !== undefined) {
      if (!Array.isArray(property.oneOf) || property.oneOf.length === 0) {
        violations.push(field + ": oneOf 必须是非空数组");
        continue;
      }
      for (const option of property.oneOf) {
        const keys = Object.keys(option ?? {});
        if (!keys.every((key) => key === "const" || key === "title")) {
          violations.push(field + ": oneOf 选项只允许 const 和 title");
        }
        if (typeof option?.const !== "string" || typeof option?.title !== "string") {
          violations.push(field + ": oneOf 选项必须包含字符串 const 和 title");
        }
      }
    }
  }
  return violations;
}

class RpcClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.onElicitation = async () => ({ action: "cancel" });
    this.lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on("line", (line) => {
      if (!line.trim()) return;
      const message = JSON.parse(line);
      if (message.method === "elicitation/create" && message.id !== undefined) {
        void this.onElicitation(message.params).then((result) => {
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
        });
        return;
      }
      if (message.id !== undefined && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      }
    });
  }

  call(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  tool(name, args = {}) {
    return this.call("tools/call", { name, arguments: args });
  }

  close() {
    this.lines.close();
    this.child.stdin.end();
  }
}

async function waitForExit(child, timeoutMs = 5000) {
  return Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error("server did not exit")), timeoutMs)),
  ]);
}

async function main() {
  resetTemp();
  createFakeBinaries();
  const env = {
    ...process.env,
    SSH_MANAGER_HOME: vaultHome,
    SSH_MANAGER_SSH_BIN: fakeSsh,
    SSH_MANAGER_SFTP_BIN: fakeSftp,
    // 测试聚焦一次性路径；常驻复用的降级逻辑与传输层一致。
    SSH_MANAGER_EXEC_REUSE: "0",
  };
  const child = spawn(process.execPath, [serverPath], {
    cwd: pluginRoot,
    env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const client = new RpcClient(child);

  const init = await client.call("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "ssh-manager-smoke", version: "1.0.0" },
  });
  assert.equal(init.serverInfo.name, "Codex SSH 管理器");

  const listed = await client.call("tools/list");
  const toolNames = listed.tools.map((tool) => tool.name);
  assert.ok(toolNames.includes("ssh_profile_upsert"));
  assert.ok(toolNames.includes("ssh_deploy"));
  assert.ok(toolNames.includes("ssh_exec"));
  assert.ok(toolNames.includes("ssh_set_approval_mode"));
  assert.ok(toolNames.includes("ssh_session_register"));
  assert.ok(toolNames.includes("ssh_operation_dashboard"));
  assert.ok(toolNames.includes("ssh_terminal_open"));
  assert.ok(toolNames.includes("ssh_terminal_write"));
  assert.ok(toolNames.includes("ssh_terminal_read"));
  assert.ok(toolNames.includes("ssh_terminal_close"));

  const session = await client.tool("ssh_session_register", { name: "测试会话" });
  assert.equal(session._meta.status, "已注册");
  assert.equal(session._meta.sessionName, "测试会话");

  let elicitationCount = 0;
  let approvalDecision = "confirm";
  const elicitationSchemaViolations = [];
  const approvalMessageViolations = [];
  let lastApprovalMessage = "";
  client.onElicitation = async (params) => {
    elicitationCount += 1;
    elicitationSchemaViolations.push(...collectElicitationSchemaViolations(params));
    approvalMessageViolations.push(...collectApprovalMessageViolations(params));
    lastApprovalMessage = typeof params.message === "string" ? params.message : "";
    if (params.message.includes("新增 SSH 服务器配置")) {
      return {
        action: "accept",
        content: {
          approve: true,
          alias: "测试服务器",
          host: "127.0.0.1",
          port: "22",
          username: "root",
          authMethod: "password",
          password: "s3cr3t-value",
          privateKeyPath: "",
          privateKeyPassphrase: "",
          defaultRemoteDir: "/srv/app",
          hostKeyPolicy: "accept-new",
          description: "smoke test",
        },
      };
    }
    return { action: "accept", content: { decision: approvalDecision } };
  };

  const saved = await client.tool("ssh_profile_upsert", { alias: "测试服务器" });
  assert.deepEqual(elicitationSchemaViolations, [], "elicitation 表单必须符合 Codex 受限 schema 子集");
  assert.equal(saved._meta.status, "已保存");
  assert.equal(saved._meta.profile.password, undefined);
  assert.equal(saved._meta.profile.hasPassword, true);
  assert.equal(elicitationCount, 1);

  const rawVault = fs.readFileSync(path.join(vaultHome, "vault.json"), "utf8");
  assert.equal(rawVault.includes("s3cr3t-value"), false, "vault file must not contain the plaintext password");

  const profiles = await client.tool("ssh_profile_list");
  assert.equal(profiles._meta.count, 1);
  assert.equal(profiles._meta.profiles[0].password, undefined);

  const status = await client.tool("ssh_vault_status");
  assert.match(status._meta.protection, /AES-256-GCM/);

  const dashboard = await client.tool("ssh_operation_dashboard", { action: "打开" });
  assert.equal(dashboard._meta.status, "运行中");
  const dashboardUrl = new URL(dashboard._meta.url);
  const token = dashboardUrl.searchParams.get("token");
  const healthResponse = await fetch(`http://127.0.0.1:${dashboardUrl.port}/health?token=${token}`);
  assert.equal(healthResponse.status, 200);
  const operationResponse = await fetch(`http://127.0.0.1:${dashboardUrl.port}/api/operations?token=${token}`);
  const operationPayload = await operationResponse.json();
  assert.ok(Array.isArray(operationPayload.operations));
  assert.ok(operationPayload.operations.some(op => op.sessionName === '测试会话'));
  const eventResponse = await fetch(`http://127.0.0.1:${dashboardUrl.port}/events?token=${token}`);
  assert.equal(eventResponse.status, 200);
  const reader = eventResponse.body.getReader();
  const firstEvent = await reader.read();
  const firstEventText = new TextDecoder().decode(firstEvent.value || new Uint8Array());
  assert.ok(firstEventText.includes("event: snapshot"));
  await reader.cancel();

  const terminalProfilesResponse = await fetch(`http://127.0.0.1:${dashboardUrl.port}/api/terminal/profiles?token=${token}`);
  const terminalProfilesPayload = await terminalProfilesResponse.json();
  assert.ok(terminalProfilesPayload.profiles.some(profile => profile.alias === "测试服务器"));

  approvalDecision = "confirm";
  const terminalOpen = await client.tool("ssh_terminal_open", { alias: "测试服务器" });
  assert.equal(terminalOpen._meta.status, "已连接");
  const terminalId = terminalOpen._meta.terminalId;
  await new Promise((resolve) => setTimeout(resolve, 150));
  await client.tool("ssh_terminal_write", { terminalId, data: "echo hello\n" });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const terminalRead = await client.tool("ssh_terminal_read", { terminalId });
  assert.match(terminalRead._meta.data, /FAKE_ECHO:echo hello/);
  await client.tool("ssh_terminal_close", { terminalId });

  const beforeSafe = fs.existsSync(callLog) ? fs.readFileSync(callLog, "utf8") : "";
  const safe = await client.tool("ssh_exec", { alias: "测试服务器", command: "pwd", purpose: "检查当前目录" });
  assert.equal(safe._meta.status, "已执行");
  assert.equal(safe._meta.approval, "无需确认");
  const safeText = (safe.content || []).find(item => item.type === "text")?.text || "";
  assert.match(safeText, /^\$ pwd/m, "命令回显应简化为 $ command");
  assert.match(safeText, /exit=0/, "正文必须带退出码");
  assert.match(safeText, /总结：检查当前目录/);
  assert.match(safeText, /FAKE_SSH/, "命令成功时也必须回传 stdout");
  const afterSafe = fs.existsSync(callLog) ? fs.readFileSync(callLog, "utf8") : "";
  assert.ok(afterSafe.length > beforeSafe.length);
  assert.ok(afterSafe.includes("pwd"));

  elicitationCount = 0;
  approvalDecision = "cancel";
  const beforeDenied = fs.existsSync(callLog) ? fs.readFileSync(callLog, "utf8") : "";
  const denied = await client.tool("ssh_exec", {
    alias: "测试服务器",
    command: "systemctl restart demo-service",
    purpose: "deny test",
  });
  assert.equal(denied._meta.status, "已拒绝");
  assert.equal(elicitationCount, 1);
  assert.equal(fs.existsSync(callLog) ? fs.readFileSync(callLog, "utf8") : "", beforeDenied, "denied command must not invoke ssh");

  approvalDecision = "confirm";
  const failedExec = await client.tool("ssh_exec", {
    alias: "测试服务器",
    command: "FAIL_ME",
    purpose: "失败路径回归测试",
  });
  assert.equal(failedExec._meta.status, "失败");
  const failedText = (failedExec.content || []).find((item) => item.type === "text")?.text || "";
  assert.match(failedText, /exit=7/, "失败正文必须带退出码");
  assert.match(failedText, /simulated failure reason/, "失败正文必须带 stderr");
  assert.match(failedText, /partial before failure/, "失败时也要保留已产生的 stdout");

  const approved = await client.tool("ssh_exec", {
    alias: "测试服务器",
    command: "systemctl restart demo-service",
    purpose: "approval test",
  });
  assert.equal(approved._meta.status, "已执行");
  const approvedText = (approved.content || []).find(item => item.type === "text")?.text || "";
  assert.match(approvedText, /^\$ systemctl restart demo-service/m, "命令回显应简化为 $ command");
  assert.match(approvedText, /exit=0/, "正文必须带退出码");
  assert.match(approvedText, /总结：approval test/);
  assert.ok(fs.readFileSync(callLog, "utf8").includes("systemctl restart demo-service"));

  // 超长命令必须仍能把选项留在可视区域内
  elicitationCount = 0;
  approvalDecision = "cancel";
  const longCommand = [
    "systemctl restart demo-service",
    ...Array.from({ length: 40 }, (_, index) => "# padding line " + index + " " + "x".repeat(90)),
  ].join("\n");
  const longCommandResult = await client.tool("ssh_exec", {
    alias: "测试服务器",
    command: longCommand,
    purpose: "超长命令确认表单预算测试",
  });
  assert.equal(longCommandResult._meta.status, "已拒绝");
  assert.equal(elicitationCount, 1);
  assert.ok(lastApprovalMessage.includes("已省略"), "超长命令的确认表单应给出省略提示");
  assert.ok(lastApprovalMessage.length < 1000, "省略后的 message 应显著变短");

  elicitationCount = 0;
  approvalDecision = "confirm_and_auto";
  const autoApproved = await client.tool("ssh_exec", {
    alias: "测试服务器",
    command: "systemctl restart auto-session-service",
    purpose: "确认并开启会话免询问测试",
  });
  assert.equal(autoApproved._meta.status, "已执行");
  assert.equal(elicitationCount, 1);
  const autoStatus = await client.tool("ssh_vault_status");
  assert.equal(autoStatus._meta.approvalMode, "会话免确认");

  elicitationCount = 0;
  approvalDecision = "cancel";
  const sessionExec = await client.tool("ssh_exec", {
    alias: "测试服务器",
    command: "systemctl restart session-service",
    purpose: "会话免确认测试",
  });
  assert.equal(sessionExec._meta.status, "已执行");
  assert.equal(elicitationCount, 0);

  const readOnlyMode = await client.tool("ssh_set_approval_mode", { mode: "只读免确认" });
  assert.equal(readOnlyMode._meta.mode, "只读免确认");
  const beforeBlocked = fs.readFileSync(callLog, "utf8");
  elicitationCount = 0;
  const blocked = await client.tool("ssh_exec", {
    alias: "测试服务器",
    command: "systemctl restart blocked-service",
    purpose: "只读模式阻断测试",
  });
  assert.equal(blocked._meta.status, "已阻止");
  assert.equal(elicitationCount, 0);
  assert.equal(fs.readFileSync(callLog, "utf8"), beforeBlocked);

  await client.tool("ssh_set_approval_mode", { mode: "默认执行" });
  approvalDecision = "confirm";

  const localFile = path.join(tempRoot, "index.html");
  fs.writeFileSync(localFile, "<h1>ok</h1>", "utf8");
  const deploy = await client.tool("ssh_deploy", {
    alias: "测试服务器",
    localPaths: [localFile],
    remoteDirectory: "/srv/app",
    postCommand: "systemctl restart demo-service",
    purpose: "smoke deploy",
  });
  assert.equal(deploy._meta.status, "已部署");
  const deployText = (deploy.content || []).find((item) => item.type === "text")?.text || "";
  assert.match(deployText, /FAKE_SSH/, "部署后命令的 stdout 也必须回传");
  const logAfterDeploy = fs.readFileSync(callLog, "utf8");
  assert.ok(logAfterDeploy.includes("sftp "));
  assert.ok(logAfterDeploy.includes("put "), "上传应通过 sftp 的 put 指令完成");
  assert.match(deployText, /上传 1 项/, "上传展示应为可读形式");

  // 先真正打开常驻会话（SSH + SFTP），否则降级路径不会被触发
  const opened = await client.tool("ssh_session_open", { alias: "测试服务器" });
  assert.equal(opened._meta.status, "已连接");
  assert.ok(opened._meta.sftp, "常驻 SFTP 会话应建立成功，错误：" + (opened._meta.sftpError || "无"));

  // 常驻 SFTP 会话静默断开后，应丢弃坏会话并自动改用一次性连接重试
  fs.writeFileSync(sftpFailFlag, "1");
  const beforeFallback = fs.readFileSync(callLog, "utf8");
  const fallbackUpload = await client.tool("ssh_upload", {
    alias: "测试服务器",
    localPaths: [localFile],
    remoteDirectory: "/srv/app",
    purpose: "常驻会话断开降级测试",
  });
  assert.equal(fallbackUpload._meta.status, "已上传", "常驻会话断开后应自动降级并成功");
  const fallbackSegment = fs.readFileSync(callLog, "utf8").slice(beforeFallback.length);
  assert.ok(fallbackSegment.includes("FAKE_SFTP_SESSION_BROKEN"), "应命中模拟的常驻会话断开");
  const reconnectCount = (fallbackSegment.match(/^sftp /gm) || []).length;
  assert.ok(reconnectCount >= 1, "降级后应重新建立 sftp 连接（实际 " + reconnectCount + " 次）");
  fs.rmSync(sftpFailFlag, { force: true });
  assert.equal(logAfterDeploy.toLowerCase().includes("scp"), false, "不得再调用 scp");
  assert.ok(logAfterDeploy.includes("systemctl restart demo-service"));
  assert.equal(deploy._meta.uploadResult?.verified, true, "上传后必须通过校验");

  await client.tool("ssh_operation_dashboard", { action: "停止" });

  approvalDecision = "cancel";
  const removeDenied = await client.tool("ssh_profile_remove", { alias: "测试服务器" });
  assert.equal(removeDenied._meta.status, "已拒绝");
  const stillThere = await client.tool("ssh_profile_list");
  assert.equal(stillThere._meta.count, 1);

  assert.deepEqual(approvalMessageViolations, [], "确认表单 message 必须符合可视预算");

  // 日志系统：应生成日志文件、内容脱敏、且能通过工具读回
  const logDir = path.join(vaultHome, "logs");
  assert.ok(fs.existsSync(logDir), "应创建日志目录");
  const logFiles = fs.readdirSync(logDir).filter((name) => name.endsWith(".log"));
  assert.ok(logFiles.length > 0, "应生成日志文件");
  const logText = logFiles.map((name) => fs.readFileSync(path.join(logDir, name), "utf8")).join("\n");
  assert.ok(logText.includes("ssh_profile_upsert"), "日志应记录工具调用");
  assert.ok(logText.includes("ssh_upload"), "日志应记录上传调用");
  assert.equal(logText.includes("s3cr3t-value"), false, "日志必须脱敏，不得出现明文密码");
  const logRead = await client.tool("ssh_log_read", { limit: 5 });
  assert.equal(logRead._meta.status, "正常");
  assert.ok(logRead._meta.returned > 0, "ssh_log_read 应返回日志条目");
  const logReadText = (logRead.content || []).find((item) => item.type === "text")?.text || "";
  assert.match(logReadText, /stdout/, "ssh_log_read 的渲染里应带出 stdout");
  const failedLogs = await client.tool("ssh_log_read", { limit: 20, onlyErrors: true });
  assert.equal(failedLogs._meta.onlyErrors, true);
  const fullLogs = await client.tool("ssh_log_read", { limit: 5, full: true });
  assert.equal(fullLogs._meta.full, true);
  const sinceLogs = await client.tool("ssh_log_read", { limit: 5, since: "1h" });
  assert.equal(sinceLogs._meta.since, "1h");
  assert.ok(sinceLogs._meta.returned > 0, "since 过滤后仍应返回最近日志");
  const oldLogs = await client.tool("ssh_log_read", { limit: 5, since: "1999-01-01T00:00:00Z" });
  assert.ok(oldLogs._meta.returned > fullLogs._meta.returned - 1, "极早的 since 应返回全部");


  client.close();
  await waitForExit(child);
  assert.equal(stderr, "", `server stderr should be empty: ${stderr}`);
  fs.rmSync(tempRoot, { recursive: true, force: true });

  console.log("SSH_MANAGER_SMOKE_OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
  // 断言失败时子进程可能仍在运行，这里确保测试进程能退出。
  setTimeout(() => process.exit(1), 500);
});
