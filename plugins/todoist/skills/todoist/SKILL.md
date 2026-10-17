---
name: todoist
description: 把 Codex 的计划步骤同步成 Todoist 任务，并在侧边栏任务清单里查看完成情况。用户提到待办、任务清单、Todoist、/plan 同步、哪些做完了时使用。
---

# Todoist

这个技能负责三件事：把计划变成待办、查看完成进度、维护 Todoist 项目。

## 什么时候用

- 用户说“记一下待办”“把计划同步到 Todoist”“看看哪些做完了”“打开任务清单”。
- 你刚完成一个多步骤计划、准备开始执行时。计划一旦确定，先调用一次 `todoist_sync_plan`，再开始执行，不要等用户提醒。
- 用户用 `/plan` 生成了计划，之后需要把步骤落到 Todoist。

## 同步计划

调用 `todoist_sync_plan`：

```json
{
  "steps": [
    { "step": "梳理现有代码", "status": "completed" },
    { "step": "实现同步逻辑", "status": "inProgress" },
    { "step": "补测试", "status": "pending" }
  ],
  "session_id": "当前会话 id（不知道就省略）"
}
```

规则：

1. 同一会话里，同样的步骤文字重复同步不会重复建任务。
2. 步骤完成后把 `status` 改成 `completed`，插件会自动去 Todoist 勾掉。
3. 不要一次建一堆模糊的大任务，尽量拆成能勾掉的小步骤。
4. 如果计划有变化，重新调用一次完整步骤列表，不要只传新增的。
5. 多会话场景下优先用 `todoist_sync_plan` 并传当前 `session_id`；`todoist_sync_last_plan` 默认同步最新一份计划，传 `session_id` 才同步指定会话。
6. 每轮结束的 `Stop` 钩子会先尝试从助手消息里提取计划清单，再回退到本会话最近一次计划；正常情况下不需要手动点“同步”。

## 查看清单

调用 `todoist_board_data`，返回 `tasks`、`stats`、`config`、`lastPlan`。
回答用户时优先用 `stats.completed / stats.total` 和未完成任务列表。

## 打开面板

调用 `todoist_open_board`。面板会出现在 Codex 侧边栏或对话侧栏，支持勾选、添加任务、编辑内容/截止日期/优先级、删除任务、同步最近计划。

## 本地模式

默认不需要登录、不需要 Token、不需要网络。任务、项目、标签都存在本机 `~/.codex/todoist/state.json`。可以直接使用 `todoist_create_project`、`todoist_set_project`、`todoist_add_task`、`todoist_update_task`、`todoist_reorder_tasks` 等工具。

## 配置 Token（可选）

只有想同步到 Todoist 账号时才需要配置。没有 Token 时完全走本地模式，不会碰真实账号。配置方法：

1. 打开 Todoist → 设置 → 集成 → 开发者 → API token，复制 Token。
2. 在终端运行 `node C:\Users\jiura\plugins\todoist\scripts\set-token.mjs`，粘贴 Token（不回显）。
3. 或者手动新建 `~/.codex/todoist/config.json`：

```json
{
  "token": "你的 Todoist API Token",
  "projectName": "Codex 任务"
}
```

3. 重启 Codex 或重新加载插件。

永远不要把 Token 打印到对话里，也不要提交到仓库。

## 注意

- Todoist 项目默认叫“Codex 任务”，可以在 config.json 里改 `projectName`。
- 只操作用户自己的 Todoist 账号，不要猜测或使用别人的 Token。
- 写操作失败时如实告诉用户，不要假装成功。