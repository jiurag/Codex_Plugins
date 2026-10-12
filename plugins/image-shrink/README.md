# image-shrink · 图片体积守卫

Codex 每次请求都会把**整段对话历史的原样**发给模型，包括历史里出现过的每一张图。
图片在请求体里是 base64，体积约为源文件的 **1.33 倍**，而且**每一轮都要重发一遍**。

实测 DeepSeek `https://api.deepseek.com/responses` 的请求体上限是 **48 MiB（50,331,648 字节）**，超过就返回：

```
413 Payload Too Large: Failed to buffer the request body: length limit exceeded
```

一旦触发，这个会话再也发不出任何请求，只能新开。按 48 MiB ÷ 1.33 换算，
**一个会话里图片文件的累计总量到 35 MB 左右就会触顶**。

本插件让 Codex 知道这件事，并把压缩变成它可以直接调用的工具。

## 包含什么

| 内容 | 说明 |
| --- | --- |
| MCP 服务 `mcp/server.mjs` | 提供两个工具，零外部依赖 |
| 工具 `compress_image` | 压缩图片/截图，支持目标体积自动迭代 |
| 工具 `check_payload_budget` | 估算一批图片的请求体体积，以及距离 48 MiB 还有多远 |
| `skills/image-shrink/SKILL.md` | 规则：自己截图和读图之前先压缩；图多了提醒换会话；遇到 413 不重试 |
| `scripts/shrink-image.ps1` | 压缩脚本（MCP 工具不可用时的退路，也是 MCP 的实际压缩机） |
| `scripts/probe-body-limit.ps1` | 黑盒探测任意 Responses 端点的请求体上限 |
| `references/limits.md` | 完整实测数据和探测方法 |

## 工具用法

模型在**查看任何图片之前**应当先调用 `compress_image`，然后只读压缩后的 `.small.jpg`：

```
compress_image(paths: ["C:\\shots\\a.png"], maxBytes: "400KB")
check_payload_budget(paths: ["C:\\shots"])
```

实测压缩效果：1920x1080 的 6.23 MB PNG → 1280x720 的 0.35 MB JPEG（压掉 94%）。
同一张图，原本几张就能撑爆请求体，压完能放上百张。

## 能力边界

**能自动管住**：Codex 自己截图（浏览器 / 桌面 / computer-use）、Codex 主动读取的图片文件、
会话里图片累积过多的提醒、413 的处置方式。

**管不住**：用户直接粘贴进输入框的图片。那是客户端直接塞进请求体的，模型没有机会在
它进入请求体之前插手。这种情况只能贴之前先压缩。

## 运行前提

- **Node.js 18+**（运行 MCP 服务）
- **Windows**：压缩由 PowerShell + .NET System.Drawing 完成，无需额外依赖。
  其他平台当前会返回明确的不支持提示。

## 许可

MIT