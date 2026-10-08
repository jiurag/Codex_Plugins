# 安装说明

本仓库是 Codex 插件市场（marketplace），包含 `ssh-manager` 插件。

---

## 方式一：直接从 GitHub 安装（推荐）

### 1. 添加插件市场

```bash
codex plugin marketplace add jiurag/Codex_Plugins
```

### 2. 安装插件

```bash
codex plugin add ssh-manager@jiura-plugins
```

### 3. 确认安装

```bash
codex plugin list
```

应看到 `ssh-manager@jiura-plugins  installed, enabled  0.1.2`。

### 4. 重新加载

**重要**：已经打开的 Codex 任务不会加载新工具，请新开一个任务再使用。

---

## 方式二：离线安装

如果目标机器不能访问 GitHub，把本仓库打包（或解压压缩包）后：

```powershell
codex plugin marketplace add "D:\路径\Codex_Plugins"
codex plugin add ssh-manager@jiura-plugins
```

要点：

- 给 `marketplace add` 的必须是**仓库根目录**（含 `.agents` 的那一层）；
- `.agents` 是以点开头的目录，Windows 资源管理器默认可能不显示，用 `dir -Force` 确认存在；
- 路径含空格时记得加引号。

---

## 运行前提

```powershell
codex --version     # Codex CLI 0.161+（或 Codex 桌面版）
node -v             # 必须有 Node.js（建议 18+）
ssh -V              # 系统 OpenSSH 客户端
```

三者缺一不可。

---

## 开始使用

先保存一台服务器：

```
请添加服务器：
别名 生产服务器
服务器 203.0.113.10
账户 deploy
端口 22
```

插件会弹出安全表单让你填密码——**不要在聊天里直接发送密码**。

之后可以直接说：

```
检查 生产服务器的 Nginx 状态
把 E:\projects\my-app 部署到 生产服务器的 /srv/my-app，部署后重启 nginx
```

默认行为：只读命令直接执行；写操作、上传、部署需要确认。确认表单会显示目标服务器、关键路径与影响范围，过长内容会自动折叠（完整信息可在实时操作面板查看）。

---

## 凭据存放位置

```
%USERPROFILE%\.codex\ssh-manager\
```

- `vault.json`：AES-256-GCM 加密后的服务器配置与凭据
- `vault.key`：由当前 Windows 用户 DPAPI 保护的密钥
- `known_hosts`：插件独立的主机指纹文件

只存在本机，不会上传，也不会回传给模型。可用 `SSH_MANAGER_HOME` 环境变量改变位置。

---

## 更新与卸载

```bash
# 更新（Git 来源的市场）
codex plugin marketplace upgrade

# 卸载
codex plugin remove ssh-manager
codex plugin marketplace remove jiura-plugins
```

如需连本地凭据一起清除，再删除 `%USERPROFILE%\.codex\ssh-manager\` 目录。

---

## 常见问题

**Q：报找不到 marketplace？**
确认给的是仓库根目录（含 `.agents` 的那一层），而不是 `plugins\ssh-manager`。

**Q：装完在 Codex 里看不到工具？**
新开一个任务。仍不行就 `codex plugin list` 确认状态是 `installed, enabled`，并确认 `node -v` 可用。

**Q：确认表单里的命令显示不全？**
这是有意设计：确认面板高度有限，过长内容会被折叠，避免选项被挤出屏幕。完整命令与输出可在实时操作面板（`ssh_operation_dashboard`）中查看。