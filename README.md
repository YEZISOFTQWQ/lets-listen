# lets-listen

面向哔哩哔哩直播的桌面节目工具：本地播放音频/视频，在直播画面中显示封面、频谱、观众评论和多人评分，并通过官方直播开放平台读取弹幕。

## 已实现

- 多选或拖放导入音频/视频，自动生成带轮次编号的播放队列
- 读取常见音频标签和内嵌封面，也可为每首曲目单独导入封面、修改曲名和投稿人
- 16:9 节目输出画面和全屏节目模式，可由 OBS/直播姬窗口捕获
- 视频播放时自动隐藏封面、频谱、评分卡和指令，只保留视频与可调透明度的评论栏
- 模拟弹幕，无开发者密钥也能完成全部 UI 和业务联调
- 官方 `/v2/app/start`、WebSocket 鉴权、双 20 秒心跳和 `/v2/app/end`
- 解析普通及 zlib/Brotli 压缩的长链数据包，支持单帧多个协议包
- 使用 `msg_id` 去重、使用 `open_id` 实现同一账号同一轮最后一次评分生效，评论栏也只保留其最新评分气泡
- 原始弹幕、评论、评分、切歌事件以 JSONL 实时留档，并可导出带 BOM 的 CSV
- `access_secret` 使用 Electron `safeStorage` 调用 Windows 系统凭据加密保存

## 本地运行

需要 Node.js 22 或更高版本。

```powershell
npm install
npm start
```

开发模式会自动打开开发者工具：

```powershell
npm run dev
```

运行检查和测试：

```powershell
npm run check
npm test
```

生成 Windows 便携版：

```powershell
npm run dist
```

输出位于 `dist/`。

## 在没有密钥时测试

1. 导入一首音乐或视频。
2. 点击播放队列中的曲目。
3. 如需补充资料，点击“编辑当前曲目信息”导入封面并填写投稿人。
4. 在底部“模拟弹幕”中输入：
   - `#01 8.5`
   - `#01评 前奏很惊艳`
5. 同一测试昵称再次评分时会覆盖此前分数和评分气泡，但两次输入仍会写入原始存档。
6. 切换测试昵称即可模拟多位观众。

命令也支持省略轮次，例如 `评分 8.5`、`评论 鼓点很有张力`，此时自动归属当前曲目。

## 连接哔哩哔哩直播

准备以下信息：

- 项目的数值型 `app_id`
- 开发者 `access_key`
- 开发者 `access_secret`
- 本场主播身份码 `code`

点击左下角“直播接入设置”，保存前三项，再输入本场身份码并连接。身份码只用于本次连接，不会写入配置文件。

接入生命周期：

1. 签名调用 `https://live-open.biliapi.com/v2/app/start`
2. 使用返回的 `auth_body` 连接 `wss_link`
3. WebSocket 与应用 API 均每 20 秒发送心跳
4. 处理 `LIVE_OPEN_PLATFORM_DM`
5. 主动断开或退出软件时调用 `/v2/app/end`


## OBS / 直播姬建议

1. 在软件右上角点击“进入节目模式”。
2. OBS 添加“窗口采集”，选择“品味大战”。
3. OBS 添加“应用程序音频采集”，选择本软件进程。
4. 画布建议使用 1920×1080。
5. 为避免下一曲自动播放时串场，画面会持续显示明确的 `ROUND` 编号。

## 存档位置

原始 JSONL 默认写入：

```text
用户文档\品味大战存档
```

每一行都是一个独立 JSON 事件，即使程序异常退出，已经写入的记录仍然有效。点击“导出存档”可把本场评论和评分导出为 CSV。

## 目录

```text
src/main.cjs                    Electron 主进程与 IPC
src/preload.cjs                 最小权限渲染层桥接
src/lib/bilibili-client.cjs     官方 API 签名、场次和长连接
src/lib/bili-protocol.cjs       二进制协议与压缩包解析
src/lib/archive-store.cjs       JSONL 存档与 CSV 导出
src/renderer/                   节目画面、播放器和弹幕业务
test/                           协议、签名、指令与存档测试
```
