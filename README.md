# Codex Plugins

个人维护的 Codex 插件集合，以 **marketplace** 形式分发。

## 包含的插件

| 插件 | 版本 | 说明 |
| --- | --- | --- |
| [`ssh-manager`](./plugins/ssh-manager) | 0.1.2 | Codex 本地 SSH 服务器与部署管理：加密保存服务器凭据，只读命令直接执行，敏感操作确认后执行 |

## 安装

### 1. 添加插件市场

```bash
codex plugin marketplace add jiurag/Codex_Plugins
```

### 2. 安装插件

```bash
codex plugin add ssh-manager@jiura-plugins
```

### 3. 确认

```bash
codex plugin list
```

装完后**新开一个 Codex 任务**才会加载插件提供的工具。

也可以只添加市场，然后在 Codex CLI 里输入 `/plugins` 浏览安装；ChatGPT 桌面版的 Plugins 标签页同样能看到这个市场。

## 运行前提

`ssh-manager` 需要：

- Codex CLI 0.161+（或 Codex 桌面版）
- Node.js 18+（MCP 服务用它运行）
- 系统 OpenSSH 客户端（`ssh` / `scp`）

自查：

```powershell
codex --version
node -v
ssh -V
```

## 更新插件

```bash
codex plugin marketplace upgrade
```

市场名可用 `codex plugin marketplace list` 查看（本仓库为 `jiura-plugins`）。

> 注意：`upgrade` 只对 Git 来源的市场生效；如果是从本地目录添加的，需要重新解压并重启 Codex。

## 目录结构

```
.
├── .agents/plugins/marketplace.json    # 市场清单
├── plugins/
│   └── ssh-manager/                    # 插件本体
│       ├── .codex-plugin/plugin.json   # 插件清单
│       ├── .mcp.json                   # MCP 服务定义
│       ├── mcp/                        # MCP 服务实现
│       ├── skills/ssh-manager/         # 技能说明
│       ├── scripts/
│       └── test/                       # 冒烟测试
└── INSTALL.md                          # 面向使用者的安装说明
```

## 许可

各插件以其目录内的 `LICENSE` 为准；`ssh-manager` 为 MIT。