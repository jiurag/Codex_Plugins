import crypto from "node:crypto";
import http from "node:http";

const MAX_OPERATIONS = 500;
const HEARTBEAT_MS = 15_000;

let server = null;
let serverInfo = null;
let operations = [];
let terminalController = null;
const clients = new Set();

function redact(value) {
  if (typeof value !== "string") {
    return value;
  }
  return value
    .replace(/(password|passwd|token|secret|api[_-]?key|private[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=***")
    .slice(0, 128 * 1024);
}

function sanitizeOperation(operation) {
  const output = {};
  for (const [key, value] of Object.entries(operation || {})) {
    if (/password|passphrase|privatekey/i.test(key)) {
      continue;
    }
    if (typeof value === "string") {
      output[key] = redact(value);
    } else {
      output[key] = value;
    }
  }
  output.id = output.id || crypto.randomUUID();
  output.timestamp = output.timestamp || new Date().toISOString();
  return output;
}

export function primeOperations(records) {
  operations = (Array.isArray(records) ? records : [])
    .slice(-MAX_OPERATIONS)
    .map(sanitizeOperation);
}

export function recordOperation(operation) {
  const safeOperation = sanitizeOperation(operation);
  operations.push(safeOperation);
  if (operations.length > MAX_OPERATIONS) {
    operations = operations.slice(-MAX_OPERATIONS);
  }
  const message = `event: operation\ndata: ${JSON.stringify(safeOperation)}\n\n`;
  for (const client of clients) {
    client.write(message);
  }
  return safeOperation;
}

export function getDashboardStatus() {
  return serverInfo
    ? {
        status: "运行中",
        url: serverInfo.url,
        host: "127.0.0.1",
        port: serverInfo.port,
        operationCount: operations.length,
        clientCount: clients.size,
      }
    : {
        status: "未启动",
        operationCount: operations.length,
        clientCount: 0,
      };
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function tokenMatches(requestUrl, token) {
  return requestUrl.searchParams.get("token") === token;
}

function cookieTokenMatches(request, token) {
  const cookieHeader = request.headers.cookie || "";
  return cookieHeader.split(";").some((part) => {
    const [name, value] = part.trim().split("=");
    return name === "ssh_manager_token" && value === token;
  });
}

function readJsonBody(request, maximumBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    request.on("data", (chunk) => {
      total += chunk.length;
      if (total > maximumBytes) {
        reject(new Error("请求内容过大"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("请求 JSON 无效"));
      }
    });
    request.on("error", reject);
  });
}

async function handleTerminalRequest(request, response, requestUrl) {
  if (!requestUrl.pathname.startsWith("/api/terminal/")) {
    return false;
  }
  if (!terminalController) {
    sendJson(response, 503, { status: "错误", error: "交互式终端未启用" });
    return true;
  }

  try {
    if (requestUrl.pathname === "/api/terminal/profiles") {
      sendJson(response, 200, { status: "正常", profiles: terminalController.listProfiles() });
      return true;
    }
    if (requestUrl.pathname === "/api/terminal/list") {
      sendJson(response, 200, { status: "正常", terminals: terminalController.list() });
      return true;
    }
    if (requestUrl.pathname === "/api/terminal/start") {
      const body = await readJsonBody(request);
      const result = terminalController.start(body.alias);
      sendJson(response, 200, result);
      return true;
    }
    if (requestUrl.pathname === "/api/terminal/input") {
      const body = await readJsonBody(request);
      const result = terminalController.write(body.terminalId, body.data ?? "");
      sendJson(response, 200, result);
      return true;
    }
    if (requestUrl.pathname === "/api/terminal/close") {
      const body = await readJsonBody(request);
      const result = terminalController.close(body.terminalId);
      sendJson(response, 200, result);
      return true;
    }
    if (requestUrl.pathname === "/api/terminal/read") {
      const terminalId = requestUrl.searchParams.get("id") || "";
      sendJson(response, 200, terminalController.read(terminalId));
      return true;
    }
    if (requestUrl.pathname === "/api/terminal/events") {
      const terminalId = requestUrl.searchParams.get("id") || "";
      const snapshot = terminalController.snapshot(terminalId);
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      response.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
      const unsubscribe = terminalController.subscribe(terminalId, (data) => {
        response.write(`event: output\ndata: ${JSON.stringify({ data })}\n\n`);
      });
      request.on("close", unsubscribe);
      return true;
    }
    sendJson(response, 404, { status: "错误", error: "未找到终端接口" });
    return true;
  } catch (error) {
    sendJson(response, 400, {
      status: "错误",
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}

async function handleRequest(request, response, token) {
  const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
  const hasQueryToken = tokenMatches(requestUrl, token);
  const hasCookieToken = cookieTokenMatches(request, token);
  if (!hasQueryToken && !hasCookieToken) {
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("访问令牌无效。请使用完整面板地址，或先通过完整地址访问一次以记住令牌。");
    return;
  }

  if (await handleTerminalRequest(request, response, requestUrl)) {
    return;
  }

  if (requestUrl.pathname === "/" || requestUrl.pathname === "/index.html") {
    const body = dashboardHtml(token);
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Set-Cookie": `ssh_manager_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`,
      "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
    });
    response.end(body);
    return;
  }

  if (requestUrl.pathname === "/health") {
    sendJson(response, 200, { status: "正常", operationCount: operations.length, clientCount: clients.size });
    return;
  }

  if (requestUrl.pathname === "/api/operations") {
    const limit = Math.max(1, Math.min(500, Number.parseInt(requestUrl.searchParams.get("limit") || "200", 10) || 200));
    sendJson(response, 200, { operations: operations.slice(-limit) });
    return;
  }

  if (requestUrl.pathname === "/events") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.write(`event: snapshot\ndata: ${JSON.stringify(operations.slice(-200))}\n\n`);
    clients.add(response);
    const heartbeat = setInterval(() => {
      response.write(`: heartbeat ${Date.now()}\n\n`);
    }, HEARTBEAT_MS);
    heartbeat.unref();
    request.on("close", () => {
      clearInterval(heartbeat);
      clients.delete(response);
    });
    return;
  }

  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("未找到页面");
}

function listenServer(nextServer, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      nextServer.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      nextServer.off("error", onError);
      resolve();
    };
    nextServer.once("error", onError);
    nextServer.once("listening", onListening);
    nextServer.listen(port, "127.0.0.1");
  });
}

export async function startDashboard(options = {}) {
  if (server && serverInfo) {
    return getDashboardStatus();
  }
  if (options.terminalController) {
    terminalController = options.terminalController;
  }

  const token = options.token || crypto.randomBytes(24).toString("hex");
  const requestedPort = Number.isInteger(options.port) && options.port > 0 ? options.port : 8765;
  const nextServer = http.createServer((request, response) => {
    void handleRequest(request, response, token).catch((error) => {
      if (!response.headersSent) {
        response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        response.end(`面板内部错误：${error instanceof Error ? error.message : String(error)}`);
      } else {
        response.end();
      }
    });
  });

  try {
    await listenServer(nextServer, requestedPort);
  } catch (error) {
    if (error?.code !== "EADDRINUSE") {
      throw error;
    }
    await listenServer(nextServer, 0);
  }

  const address = nextServer.address();
  const port = typeof address === "object" && address ? address.port : 0;
  server = nextServer;
  serverInfo = {
    port,
    token,
    url: `http://127.0.0.1:${port}/?token=${token}`,
  };
  server.on("close", () => {
    server = null;
    serverInfo = null;
    clients.clear();
  });
  return getDashboardStatus();
}

export async function stopDashboard() {
  for (const client of clients) {
    try {
      client.end();
    } catch {
      // 忽略关闭连接时的异常。
    }
  }
  clients.clear();
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  server = null;
  serverInfo = null;
  return { status: "已停止", operationCount: operations.length };
}
function dashboardHtml(token) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SSH 实时操作面板</title>
<style>
:root{color-scheme:dark;--bg:#08111f;--panel:#101c2f;--panel2:#14233a;--line:#29415f;--text:#e8f0fa;--muted:#8ea4bf;--green:#38d39f;--yellow:#f5c451;--red:#ff6b7a;--blue:#54a7ff;--purple:#b88cff}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top left,#14325b 0,var(--bg) 38%);color:var(--text);font:14px/1.5 "Microsoft YaHei",system-ui,sans-serif}
header{position:sticky;top:0;z-index:2;background:rgba(8,17,31,.92);backdrop-filter:blur(14px);border-bottom:1px solid var(--line);padding:18px 24px}
h1{margin:0;font-size:22px}.sub{color:var(--muted);margin-top:4px}.bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:14px}
input,select{background:var(--panel);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:9px 11px;outline:none}input{min-width:220px}
.dot{width:9px;height:9px;border-radius:50%;background:var(--yellow);box-shadow:0 0 10px currentColor}.dot.on{background:var(--green)}.dot.off{background:var(--red)}
.count{margin-left:auto;color:var(--muted)}main{min-width:0;padding:20px 24px 60px}.layout{display:grid;grid-template-columns:280px minmax(0,1fr);max-width:1600px;margin:0 auto}.sessions{border-right:1px solid var(--line);padding:20px 14px;position:sticky;top:122px;height:calc(100vh - 122px);overflow:auto}.session{display:block;width:100%;text-align:left;background:transparent;border:1px solid transparent;color:var(--text);border-radius:10px;padding:10px 12px;margin:4px 0;cursor:pointer}.session:hover{background:var(--panel)}.session.active{background:var(--panel2);border-color:var(--blue)}.session-name{font-weight:700}.session-meta{color:var(--muted);font-size:12px;margin-top:3px}@media(max-width:900px){.layout{grid-template-columns:1fr}.sessions{position:static;height:auto;border-right:0;border-bottom:1px solid var(--line)}}
.op{background:linear-gradient(180deg,var(--panel),#0d1828);border:1px solid var(--line);border-radius:14px;padding:15px 16px;margin:12px 0;box-shadow:0 10px 30px rgba(0,0,0,.18)}
.op.ok{border-left:4px solid var(--green)}.op.bad{border-left:4px solid var(--red)}.op.warn{border-left:4px solid var(--yellow)}
.row{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap}.action{font-weight:700;color:var(--blue)}.time{color:var(--muted);margin-left:auto}.target{color:var(--purple);margin-top:6px}.summary{margin-top:8px;white-space:pre-wrap;word-break:break-word}
.what{margin-top:8px;font-weight:700;color:var(--green)}.summary{margin-top:5px;color:var(--muted)}.badge{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:2px 8px;color:var(--muted);font-size:12px;margin:7px 6px 0 0}.status{font-weight:700}.status.ok{color:var(--green)}.status.bad{color:var(--red)}.status.warn{color:var(--yellow)}.line{display:flex;gap:10px;margin-top:8px}.label{color:var(--muted);flex:0 0 44px}.instruction{font-family:Consolas,monospace;color:#d7e6ff;white-space:pre-wrap;word-break:break-word;max-height:84px;overflow:auto}.summary-text{color:var(--text);white-space:pre-wrap}
details{margin-top:10px;border-top:1px solid var(--line);padding-top:9px}summary{cursor:pointer;color:var(--muted)}pre{background:#07101d;border:1px solid var(--line);border-radius:10px;padding:12px;overflow:auto;max-height:420px;white-space:pre-wrap;word-break:break-word}
.empty{text-align:center;color:var(--muted);padding:70px 20px}.hidden{display:none}.terminal-panel{max-width:1600px;margin:16px auto 0;padding:0 24px}.terminal-box{background:#06101c;border:1px solid var(--line);border-radius:14px;overflow:hidden}.terminal-head{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:10px 12px;border-bottom:1px solid var(--line);background:var(--panel)}.terminal-head select{min-width:180px}.terminal-output{margin:0;padding:12px;height:260px;overflow:auto;white-space:pre-wrap;word-break:break-word;background:#040a12;color:#d7e6ff;font:13px/1.45 Consolas,monospace}.terminal-input{display:flex;gap:8px;padding:10px 12px;border-top:1px solid var(--line)}.terminal-input input{flex:1;min-width:0}.terminal-status{color:var(--muted);margin-left:auto}
</style>
</head>
<body>
<header>
  <h1>SSH 实时操作面板</h1>
  <div class="sub">实时显示 Codex 通过 SSH 执行的命令、上传、下载、部署和结果。页面数据只来自本机加密审计仓库。</div>
  <div class="bar">
    <span id="conn" class="dot"></span><span id="connText">正在连接实时事件流...</span>
    <input id="search" placeholder="搜索服务器、命令、路径">
    <select id="action"><option value="">全部操作</option></select>
    <select id="status"><option value="">全部状态</option><option value="成功">成功</option><option value="失败">失败</option><option value="已拒绝">已拒绝</option><option value="已阻止">已阻止</option></select>
    <span id="count" class="count">0 条操作</span>
  </div>
</header>
<section class="terminal-panel">
  <div class="terminal-box">
    <div class="terminal-head">
      <strong>交互式 SSH 终端</strong>
      <select id="terminalProfile"></select>
      <button id="terminalStart">连接</button>
      <button id="terminalClose">关闭</button>
      <span id="terminalStatus" class="terminal-status">未连接</span>
    </div>
    <pre id="terminalOutput" class="terminal-output">请选择服务器并点击“连接”。</pre>
    <div class="terminal-input">
      <input id="terminalInput" placeholder="输入命令后按回车" disabled>
      <button id="terminalSend" disabled>发送</button>
    </div>
  </div>
</section>
<div class="layout"><aside id="sessions" class="sessions"></aside><main id="list"><div class="empty">暂无操作。执行一次 SSH 命令后，这里会实时出现记录。</div></main></div>
<script>
const token = ${JSON.stringify(token)};
let operations = [];
let currentSession = 'all';
const list = document.getElementById('list');
const sessionsEl = document.getElementById('sessions');
const conn = document.getElementById('conn');
const connText = document.getElementById('connText');
const search = document.getElementById('search');
const actionFilter = document.getElementById('action');
const statusFilter = document.getElementById('status');
const count = document.getElementById('count');
const terminalProfile = document.getElementById('terminalProfile');
const terminalStart = document.getElementById('terminalStart');
const terminalClose = document.getElementById('terminalClose');
const terminalStatus = document.getElementById('terminalStatus');
const terminalOutput = document.getElementById('terminalOutput');
const terminalInput = document.getElementById('terminalInput');
const terminalSend = document.getElementById('terminalSend');
let terminalId = null;
let terminalSource = null;

function stripAnsi(value){
  return String(value || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '');
}
function appendTerminal(value){
  const text = stripAnsi(value);
  if (!text) return;
  terminalOutput.textContent += text;
  if (terminalOutput.textContent.length > 260000) terminalOutput.textContent = terminalOutput.textContent.slice(-260000);
  terminalOutput.scrollTop = terminalOutput.scrollHeight;
}
async function terminalJson(url, options){
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || '请求失败');
  return payload;
}
async function loadTerminalProfiles(){
  try {
    const payload = await terminalJson('/api/terminal/profiles?token=' + encodeURIComponent(token));
    terminalProfile.innerHTML = (payload.profiles || []).map(p => '<option value="'+esc(p.alias)+'">'+esc(p.alias)+' · '+esc(p.username)+'@'+esc(p.host)+'</option>').join('');
    if (!(payload.profiles || []).length) terminalProfile.innerHTML = '<option value="">没有已保存服务器</option>';
  } catch (error) {
    terminalStatus.textContent = '读取服务器失败：' + error.message;
  }
}
async function startTerminal(){
  if (!terminalProfile.value) return;
  try {
    terminalStatus.textContent = '正在连接...';
    const payload = await terminalJson('/api/terminal/start?token=' + encodeURIComponent(token), {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({alias: terminalProfile.value}),
    });
    terminalId = payload.terminalId;
    terminalOutput.textContent = '';
    terminalInput.disabled = false;
    terminalSend.disabled = false;
    terminalStatus.textContent = '已连接：' + payload.alias;
    terminalInput.focus();
    if (terminalSource) terminalSource.close();
    terminalSource = new EventSource('/api/terminal/events?id=' + encodeURIComponent(terminalId) + '&token=' + encodeURIComponent(token));
    terminalSource.addEventListener('snapshot', event => {
      const snapshot = JSON.parse(event.data || '{}');
      if (snapshot.output) appendTerminal(snapshot.output);
    });
    terminalSource.addEventListener('output', event => {
      const payload = JSON.parse(event.data || '{}');
      appendTerminal(payload.data || '');
    });
    terminalSource.onerror = () => { terminalStatus.textContent = '终端连接中断'; };
  } catch (error) {
    terminalStatus.textContent = '连接失败：' + error.message;
  }
}
async function sendTerminalInput(){
  if (!terminalId || !terminalInput.value) return;
  const data = terminalInput.value + '\n';
  terminalInput.value = '';
  try {
    await terminalJson('/api/terminal/input?token=' + encodeURIComponent(token), {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({terminalId, data}),
    });
  } catch (error) {
    appendTerminal('\n[发送失败] ' + error.message + '\n');
  }
}
async function closeTerminal(){
  if (!terminalId) return;
  try {
    await terminalJson('/api/terminal/close?token=' + encodeURIComponent(token), {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({terminalId}),
    });
  } catch {}
  if (terminalSource) terminalSource.close();
  terminalSource = null;
  terminalId = null;
  terminalInput.disabled = true;
  terminalSend.disabled = true;
  terminalStatus.textContent = '已关闭';
}
terminalStart.addEventListener('click', startTerminal);
terminalClose.addEventListener('click', closeTerminal);
terminalSend.addEventListener('click', sendTerminalInput);
terminalInput.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); sendTerminalInput(); } });
loadTerminalProfiles();

function esc(value){return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function sessionKey(op){return op.sessionId || '__default__';}
function sessionName(op){return op.sessionName || '未命名会话';}
function approvalText(op){
  if (op.approved === true) return '已确认';
  if (op.approved === false) return '未确认';
  if (op.approved === '无需确认') return '无需确认';
  return '';
}

function commandTarget(op){
  const user = op.username || '';
  const host = op.host || op.alias || '';
  return (user ? user + '@' : '') + host;
}
function shellQuote(value){
  return '"' + String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$') + '"';
}
function sshCommand(op, command){
  const port = String(op.port || 22);
  return 'ssh -p ' + port + ' ' + commandTarget(op) + ' ' + shellQuote(command);
}
function scpFlags(d){
  const flags = [];
  if (d.recursive) flags.push('-r');
  if (d.preserveTimes !== false) flags.push('-p');
  return flags;
}
function scpCommand(op, d, remoteTargets, destination){
  const flags = scpFlags(d);
  const parts = ['scp', '-P', String(op.port || 22), ...flags];
  parts.push(...remoteTargets, destination);
  return parts.join(' ');
}
function instructionText(op){
  const d = op.details || {};
  const target = commandTarget(op);
  if (op.action === '远程命令') return sshCommand(op, d.command || '');
  if (op.action === '远程上传') return scpCommand(op, d, Array.isArray(d.localPaths) ? d.localPaths : [], target + ':' + (d.remoteDirectory || ''));
  if (op.action === '远程部署'){
    const lines = [scpCommand(op, d, Array.isArray(d.localPaths) ? d.localPaths : [], target + ':' + (d.remoteDirectory || ''))];
    if (d.postCommand) lines.push(sshCommand(op, d.postCommand));
    return lines.join('\n');
  }
  if (op.action === '远程下载') return scpCommand(op, d, (d.remotePaths || []).map(item => target + ':' + item), d.localDirectory || '');
  if (op.action === '连接测试') return sshCommand(op, "printf 'SSH_MANAGER_OK\\n'");
  if (op.action === '交互式终端') return 'ssh -tt -p ' + (op.port || 22) + ' ' + target;
  if (op.action === '打开持久连接') return 'ssh -T -p ' + (op.port || 22) + ' ' + target;
  return op.summary || op.action || '未知指令';
}

function humanSummary(op){
  const d = op.details || {};
  if (d.purpose) return d.purpose;
  const paths = Array.isArray(d.localPaths) ? d.localPaths : [];
  if (op.action === '远程上传') return '上传 ' + paths.length + ' 个本地项到 ' + (d.remoteDirectory || '远程目录');
  if (op.action === '远程部署') return '部署 ' + paths.length + ' 个本地项到 ' + (d.remoteDirectory || '远程目录') + (d.postCommand ? '，然后执行部署命令' : '');
  if (op.action === '远程下载') return '从远程下载 ' + ((d.remotePaths || []).length || 1) + ' 项到 ' + (d.localDirectory || '本机目录');
  if (op.action === '远程命令') return '执行远程命令' + (d.command ? '：' + String(d.command).slice(0, 160) : '');
  return op.summary || op.action || '未知操作';
}
function textOf(op){
  return [op.alias,op.host,op.username,op.action,op.result,op.summary,JSON.stringify(op.details||{})].join(' ');
}
function statusClass(op){
  if ((op.result||'').includes('失败') || (op.result||'').includes('错误')) return 'bad';
  if ((op.result||'').includes('拒绝') || (op.result||'').includes('阻止')) return 'warn';
  return 'ok';
}
function refreshActionOptions(){
  const current = actionFilter.value;
  const values = [...new Set(operations.map(op => op.action).filter(Boolean))].sort();
  actionFilter.innerHTML = '<option value="">全部操作</option>' + values.map(v => '<option value="'+esc(v)+'">'+esc(v)+'</option>').join('');
  actionFilter.value = current;
}
function renderSessions(){
  const grouped = new Map();
  for (const op of operations){
    const key = sessionKey(op);
    const item = grouped.get(key) || {key,name:sessionName(op),count:0,last:null};
    item.count += 1;
    if (!item.last || op.timestamp > item.last) item.last = op.timestamp;
    grouped.set(key, item);
  }
  const sessions = [...grouped.values()].sort((a,b) => (b.last||'').localeCompare(a.last||''));
  const rows = [
    '<button class="session active" data-session="all"><div class="session-name">全部会话</div><div class="session-meta">'+operations.length+' 条操作</div></button>'
  ];
  for (const item of sessions){
    rows.push('<button class="session" data-session="'+esc(item.key)+'"><div class="session-name">'+esc(item.name)+'</div><div class="session-meta">'+item.count+' 条 · '+esc(item.last?new Date(item.last).toLocaleString('zh-CN'):'')+'</div></button>');
  }
  sessionsEl.innerHTML = rows.join('');
  const active = sessionsEl.querySelector('[data-session="'+CSS.escape(currentSession)+'"]');
  if (active) active.classList.add('active');
}

function render(){
  const keyword = search.value.trim().toLowerCase();
  const action = actionFilter.value;
  const status = statusFilter.value;
  const shown = operations.filter(op => {
    if (currentSession !== 'all' && sessionKey(op) !== currentSession) return false;
    if (keyword && !textOf(op).toLowerCase().includes(keyword)) return false;
    if (action && op.action !== action) return false;
    if (status && !(op.result||'').includes(status)) return false;
    return true;
  }).slice().reverse();
  count.textContent = shown.length + ' 条操作 / 共 ' + operations.length + ' 条';
  if (!shown.length){ list.innerHTML = '<div class="empty">没有符合条件的操作。</div>'; return; }
  list.innerHTML = shown.map(op => {
    const instruction = instructionText(op);
    const summary = humanSummary(op);
    const resultClass = statusClass(op);
    const server = (op.username ? op.username + '@' : '') + (op.host || '');
    return '<article class="op '+resultClass+'">'
      + '<div class="row"><span class="action">'+esc(op.action||'未知操作')+'</span><span class="status '+resultClass+'">'+esc(op.result||'未知')+'</span><span class="time">'+esc(new Date(op.timestamp).toLocaleString('zh-CN'))+'</span></div>'
      + '<div class="target">服务器　'+esc(server||op.alias||'')+'</div>'
      + '<div class="line"><span class="label">命令</span><span class="instruction">'+esc(instruction)+'</span></div>'
      + '<div class="line"><span class="label">总结</span><span class="summary-text">'+esc(summary||op.action||'')+'</span></div>'
      + '</article>';
  }).join('');
}
function addOperation(op){operations.push(op); if(operations.length>500) operations=operations.slice(-500); refreshActionOptions(); renderSessions(); render();}
function setConnected(on,text){conn.className='dot '+(on?'on':'off');connText.textContent=text;}
const source = new EventSource('/events?token='+encodeURIComponent(token));
source.addEventListener('snapshot', event => {operations=JSON.parse(event.data||'[]');refreshActionOptions();renderSessions();render();setConnected(true,'实时连接中，持续接收操作事件');});
source.addEventListener('operation', event => {addOperation(JSON.parse(event.data));setConnected(true,'实时连接中，持续接收操作事件');});
source.onerror = () => setConnected(false,'实时连接已断开，正在自动重连...');
sessionsEl.addEventListener('click', event => {const button=event.target.closest('.session');if(!button)return;currentSession=button.dataset.session||'all';renderSessions();render();}); search.addEventListener('input', render); actionFilter.addEventListener('change', render); statusFilter.addEventListener('change', render);
</script>
</body>
</html>`;
}
