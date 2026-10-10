# Codex SSH 管理插件

Codex 本地 SSH 管理插件：保存服务器、账户、密码/私钥口令，并在后续连接、上传、部署时直接使用已保存的凭据，不再重复询问服务器和账户密码。每次执行 SSH 操作前，插件会先用一句简短中文说明接下来要对哪台服务器做什么；默认执行只读操作，敏感操作按当前模式确认或执行。

## 输出格式

每次调用的正文统一为：

```text
$ hostname
总结：检查主机名
输出：
exit=0
ai
```

- `$ 命令` 是命令回显（多行命令只显示首行）。
- `exit=N` 是远程命令的真实退出码，自动化可直接判断，不必解析中文文案。
- 命令本身没有输出时显示 `（无输出）`，用来和"输出丢失"区分开。
- 输出过长会截断并提示，完整内容用 `ssh_log_read` 查看。
- 失败时额外给出「失败类型」「建议」和原始 stdout/stderr。
- 命令通过 stdin 交给远端 shell 执行（`bash -s`，无 bash 时自动退回 `sh -s`），不再受多层引号转义影响。

## 执行提示

- 无论默认执行还是会话免确认，执行前都会先输出一句简短话术。
- 例如：“正在检查 `生产服务器` 的 Nginx 状态。”
- 例如：“正在把 `E:\project\dist` 部署到 `生产服务器:/srv/app`。”

## 功能

- 保存多个 SSH 服务器配置，按别名调用。
- 支持密码、私钥和 SSH 代理认证。
- 密码/私钥口令使用 AES-256-GCM 加密落盘；Windows 优先使用当前用户 DPAPI 保护密钥。
- 凭据不会通过 MCP 工具返回给模型或聊天上下文。
- 严格白名单的只读诊断可直接运行，例如 `pwd`、`systemctl status`、`docker ps`。
- 默认模式下远程写操作会确认。确认表单提供“确认本次执行”和“确认并开启本次会话免询问”两个选项；选择后者会立即执行当前操作，并让本次任务的后续敏感操作免询问。
- 通过系统 OpenSSH 的 `ssh` 和 `sftp` 执行，无额外 npm/Python 依赖。
- 传输走交互式 SFTP 会话；失败时区分为连接不通 / 认证失败 / 路径不存在 / 权限不足等类型，并附带原始输出。

## 工具

| 工具 | 用途 | 是否确认 |
| --- | --- | --- |
| `ssh_profile_list` | 列出已保存服务器（不含密码） | 否 |
| `ssh_vault_status` | 查看本地仓库位置、加密模式和当前操作模式 | 否 |
| `ssh_session_open` | 打开 OpenSSH 持久连接 | 否 |
| `ssh_session_close` | 关闭 OpenSSH 持久连接 | 否 |
| `ssh_session_status` | 查看 OpenSSH 持久连接 | 否 |
| `ssh_session_register` | 注册可切换的 SSH 操作会话 | 否 |
| `ssh_set_approval_mode` | 切换默认执行、只读免确认或会话免确认 | 否 |
| `ssh_operation_dashboard` | 打开/停止 SSH 实时操作面板 | 否 |
| `ssh_log_read` | 读取本地操作日志（JSONL、已脱敏、含原始输出） | 否 |
| `ssh_terminal_open` | 打开持续连接的交互式 SSH 终端 | 默认确认一次 |
| `ssh_terminal_write` | 向交互式终端发送输入 | 打开后直接发送 |
| `ssh_terminal_read` | 读取交互式终端新输出 | 否 |
| `ssh_terminal_close` | 关闭交互式终端 | 否 |
| `ssh_profile_upsert` | 安全表单添加/更新服务器凭据 | 是，表单提交即确认 |
| `ssh_profile_remove` | 删除本地配置 | 默认确认；会话免确认时直接执行 |
| `ssh_test_connection` | 使用保存凭据测试连接 | 否 |
| `ssh_exec` | 执行远程命令 | 只读否；变更默认确认；会话免确认否 |
| `ssh_upload` | SFTP 上传文件/目录 | 默认确认；会话免确认时直接执行 |
| `ssh_deploy` | 上传并可选执行部署后命令 | 默认确认；会话免确认时直接执行 |
| `ssh_download` | SFTP 下载文件/目录 | 默认确认；会话免确认时直接执行 |

## 安装

在仓库或工作区中生成个人插件市场条目后，从 Codex 插件列表安装：

```powershell
codex plugin add ssh-manager@personal
```

安装后建议新建一个 Codex 任务，让 Codex 重新加载 MCP 工具。

## 交互式终端

- 可以在实时面板中选择服务器并连接持续 SSH shell。
- 支持连续发送命令、保留 shell 状态。
- 全屏 TUI 程序可能无法完整渲染。

## 实时操作面板

- 打开后面板会实时显示 SSH 命令、上传、下载、部署、退出码和输出。
- 每个操作都会显示一条“做了什么”摘要。
- 只监听本机 127.0.0.1，并使用随机访问令牌。
- 面板支持按服务器、操作类型和状态筛选。
- 左侧可以自由切换全部会话或任意单独会话。

## OpenSSH 持久连接

- ssh_session_open 会保持一个常驻 OpenSSH 远程 shell。
- 连接建立后，远程命令、部署后命令、上传和下载自动复用长连接。
- ssh_session_close 用于关闭长连接。
- Windows OpenSSH 不支持 ControlMaster，因此使用常驻 SSH shell 和常驻 SFTP 进程实现复用。

## 操作模式

- 默认执行：只读命令无需询问，敏感操作仍确认；确认时可直接选择“确认并开启本次会话免询问”。
- 只读免确认：只执行只读命令，变更操作会被阻止。
- 会话免确认：用户明确要求后，本次任务内所有操作直接执行。

## 首次使用

先保存服务器：

```text
请添加服务器：
别名 生产服务器
服务器 203.0.113.10
账户 deploy
端口 22
```

`ssh_profile_upsert` 会打开安全表单填写密码。不要在聊天里发送密码。

之后可以直接说：

```text
检查 生产服务器 的 Nginx 状态
```

或部署：

```text
把 E:\projects\my-app 部署到 生产服务器 的 /srv/my-app，部署后重启 nginx
```

执行前，插件会显示服务器、本地路径、远程目录、部署后命令和影响范围，等待你确认。

## 本地仓库

默认位置：

```text
%USERPROFILE%\.codex\ssh-manager\
```

主要文件：

- `vault.json`：AES-256-GCM 加密后的配置和凭据。
- `vault.key`：DPAPI 保护的密钥；受限 Windows 会话下使用当前用户 ACL 保护的密钥文件。
- `known_hosts`：插件独立的主机指纹文件。

可用环境变量覆盖仓库位置：

```powershell
$env:SSH_MANAGER_HOME = "D:\secure\ssh-manager"
```

## 安全边界

- 插件只保护“静态存储”和“授权流程”，不能防止当前 Windows 账户或管理员权限的恶意软件读取本机配置。
- `ssh_exec` 的只读白名单是为了让诊断命令无需确认；任何不属于白名单的命令都会进入确认流程。
- `hostKeyPolicy=accept-new` 会在首次连接时接受新主机指纹。生产环境建议在接受后切换为 `strict`。
- 部署账户应遵循最小权限；自动化部署优先使用专用账户、密钥认证和受控的 sudo 规则。
- 如果确认表单被取消、拒绝或不可用，MCP 服务不会执行敏感操作。

## 测试

```powershell
node .\test\server.smoke.mjs
```

该测试使用假的 `ssh`/`sftp` 进程验证：凭据加密存储、只读命令直执行、敏感命令拒绝后不执行、批准后执行、部署确认流程。
