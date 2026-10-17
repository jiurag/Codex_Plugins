# Todoist（Codex 插件）

把 Codex 的 `/plan` 计划步骤同步成 Todoist 任务，并在 Codex 侧边栏用面板查看“哪些做了、哪些没做”。

## 两种模式

- **本地模式（默认）**：不需要登录、不需要 Token、不需要网络。任务、项目、标签都存在 `C:\Users\jiura\.codex\todoist\state.json`。
- **Todoist 同步（可选）**：在 `config.json` 里配置 API Token 后，读写你的 Todoist 账号。不是登录流程。

## 能力

- **计划同步**：计划步骤自动创建成任务；每完成一步，Codex 会回写 `completed` 状态并自动勾掉对应任务。
- **侧边栏面板**：自然流光玻璃界面，左侧会话分类栏显示会话标题；会话下混排计划与手动任务，双列卡片自适应。
- **项目管理**：切换项目、新建项目、把任务移动到别的项目。
- **标签**：给任务加标签，任务行会显示标签。
- **搜索和筛选**：按文字/标签搜索，按进行中、已完成、今天、计划、独立筛选。
- **拖拽排序**：拖动任务行调整顺序，顺序会保存。
- **完整编辑**：勾选、添加、改内容、截止日期、优先级、标签、项目、删除。
- **/plan 联动**：`PostToolUse` 钩子匹配 `update_plan`；`UserPromptSubmit` 钩子在提交“实现这个计划”时立即同步；`Stop` 钩子会读取当前 turn 的 transcript，兼容 Plan 模式生成的 `<proposed_plan>`。普通回复不会重放旧计划。
- **实时刷新**：插件内变更和计划同步通过本地 SSE 立即推送；如果宿主拦截 SSE，每 1.5 秒做一次轻量版本检查，变更后立即重读。状态栏显示「· 实时」或「· 自动」。
- **本地优先**：没有 Token 时完全离线，不会误写真实账号。

## 从 jiura-plugins 安装（推荐）

```bash
codex plugin add todoist@jiura-plugins
```

## 本地开发安装（personal marketplace）

1. 把 `todoist` 文件夹放到 `C:\Users\jiura\plugins\todoist`。
2. 在 `C:\Users\jiura\.agents\plugins\marketplace.json` 的 `plugins` 数组里加：

```json
{
  "name": "todoist",
  "source": { "source": "local", "path": "./plugins/todoist" },
  "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
  "category": "效率工具"
}
```

3. 重启 Codex，在 Plugins 里安装并启用。
4. 打开 `/hooks` 审阅并信任插件钩子（首次需要手动信任）。

## 配置 Todoist

1. Todoist → 设置 → 集成 → 开发者 → API token，复制 Token。
2. 在终端运行（输入不会回显，也不会进聊天记录）：

```powershell
node C:\Users\jiura\plugins\todoist\scripts\set-token.mjs
```

也可以手动新建 `C:\Users\jiura\.codex\todoist\config.json`：

```json
{
  "token": "你的 Token",
  "projectName": "Codex 任务"
}
```

3. 重启 Codex。侧边栏面板顶部会显示“Todoist 已连接”。

## 手动测试 MCP 服务

```powershell
node .\test\smoke.mjs
```

## 已知边界

- `/plan` 联动依赖 Codex 调用 `update_plan` 工具；如果某次计划没有触发钩子，可以在对话里让 Codex “同步计划到 Todoist”，它会调用 `todoist_sync_plan`。
- 面板是插件自己的 MCP App，不是把 Todoist 官方网页嵌进来。
- Todoist 任务完成后由 Sync API 读取，已完成的计划任务会保留在“已完成”分组。