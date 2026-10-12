---
name: image-shrink
description: "把图片和截图压小后再放进上下文，避免对话请求体超过 API 体积上限（DeepSeek /responses 实测 48 MiB，超限返回 413 Payload Too Large，整个会话立刻卡死）。当用户上传或粘贴截图、要求查看或分析图片、或 Codex 自己截图（浏览器截图、桌面截图、computer-use）之后需要看图时使用。"
---

# 图片体积守卫

## 为什么需要这个 skill

Codex 每次请求都会把**整段对话历史的原样**发给模型，包括历史里出现过的每一张图。图片在请求体里是 base64，体积约为源文件大小的 1.33 倍，而且**每一轮对话都要重发一遍**，不是一次性成本。

实测（DeepSeek `https://api.deepseek.com/responses`，2026-10，黑盒探测）：

| 请求体大小 | 结果 |
| --- | --- |
| ≤ 50,331,648 字节（48 MiB） | 正常，进入业务逻辑 |
| 略超 48 MiB | `413` `Failed to buffer the request body: length limit exceeded` |
| ≥ 64 MiB | 前置 nginx 返回 HTML 版 `413 Request Entity Too Large` |

换算一下：**一个会话里图片文件的累计总量到 35 MB 左右，就会触顶**（35 MB × 1.33 ≈ 48 MB）。一旦触发，这个会话再也发不出任何请求，只能新开。

## 必须遵守的规则

1. **自己截图后，先压缩再读。** 浏览器截图、桌面截图、computer-use 截图，一律先落到文件、先压缩，再读进上下文。绝不直接读取原图。
2. **读取本地图片文件前先压缩**，尤其是 > 1 MB 或长边 > 1600 px 的。
3. **只放进去当前真正需要看的那几张**，不要为了"上下文完整"把一批图全读进来。
4. **主动提醒用户**：当这个会话已经出现过较多图片时，告诉用户"图片会累积放大请求体，建议开新会话或先压缩再贴"。
5. **遇到 413 的处置**：不要重试，不要绕过，也不要假装能救。直接告诉用户——这个会话的图片历史已经撑爆请求体，需要**新开会话**，并说明以后贴图前先压缩。

## 能力边界（不要夸大）

用户直接粘贴进输入框的图片，是客户端在发请求时直接塞进请求体的，**你没有办法在它进入上下文之前拦截**。对这种场景你只能在事后提醒用户压缩后再贴、或者换新会话。

你能真正管住的只有两件事：**你自己截图后的图**，以及**你主动读取的图片文件**。

## 工具

`scripts/shrink-image.ps1`（Windows PowerShell，无需额外依赖）

```powershell
# 推荐用法：自动压到目标体积以内（会自己迭代质量和尺寸）
powershell -ExecutionPolicy Bypass -File scripts/shrink-image.ps1 -Path "C:\shots\a.png" -MaxBytes 400KB

# 批量压缩一个文件夹
powershell -ExecutionPolicy Bypass -File scripts/shrink-image.ps1 -Path "C:\shots\*.png" -MaxBytes 400KB

# 指定长边和质量，不控制目标体积
powershell -ExecutionPolicy Bypass -File scripts/shrink-image.ps1 -Path "C:\shots\a.png" -MaxWidth 1280 -Quality 70

# 输出到指定目录
powershell -ExecutionPolicy Bypass -File scripts/shrink-image.ps1 -Path "C:\shots\*.png" -OutDir "C:\shots\small"
```

输出文件名是 `原文件名.small.jpg`，默认放在原图旁边。典型压缩率 5~20 倍（实测：1920x1080 的 6.23 MB PNG → 1280x720 的 0.35 MB JPEG，剩 6%）。

`-MaxWidth` 建议 1280；如果图上小字看不清，调到 1600。

## 参考

- `references/limits.md`：完整实测数据、探测方法、以及 `scripts/probe-body-limit.ps1` 的用法。