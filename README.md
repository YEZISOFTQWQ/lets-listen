# lets-listen

面向直播的桌面节目工具：本地播放音频/视频，在节目画面中显示封面、频谱、可滚动的歌曲简介和多人评分。支持内置 RTMP 推流。

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
npm run test:e2e
```

`npm test` 运行单元测试；`npm run test:e2e` 在 Windows 桌面启动 Electron，检查后台编辑、简介滚动与显隐、本地多人评分与改分、即时导出、坏媒体报错、真实音视频播放和视频模式。它还会录制 10 秒 MP4，并把音频节目和真实视频节目分别推送到 `127.0.0.1` 的临时 RTMP 接收端；不会向外网推流。端到端测试需要可用的 FFmpeg 和图形桌面会话。

生成 Windows 发行目录：

```powershell
npm run dist
```

打包会使用 `npm install` 安装在本地的 Electron 发行文件，避免重复下载和解压 Electron。

可执行文件位于 `dist/win-unpacked/`。分发时将整个目录压缩为 ZIP，解压后运行其中的 `品味大战.exe`。



## 保存与导入歌单

在主窗口左侧或直播后台点击“保存歌单”，选择一个 `.json` 文件；以后点击“导入歌单”即可恢复曲目顺序、当前选曲、曲名、作曲、投稿人、曲风、简介及其显隐状态、手动封面。导入会替换当前播放队列；评分和播放进度不属于歌单，不会恢复。

歌单保存媒体文件和手动封面的相对路径与原始绝对路径，不复制音视频本体。把歌单和媒体一起移动时会优先使用相对路径；找不到的媒体会在导入确认时提示并跳过，找不到的手动封面会退回媒体内嵌封面（如有）。请在编辑曲目信息后先点击保存，再保存歌单。


## 存档位置

原始 JSONL 默认写入：

```text
用户文档\品味大战存档
```

每一行都是一个独立 JSON 事件，即使程序异常退出，已经写入的记录仍然有效。点击“导出存档”可把本场评分导出为 CSV。旧版存档中的评论记录不会被删除。
新存档使用 `trackId`，CSV 列名为 `track_id`；导出器也能读取旧版 `roundId` 记录。

## 目录

```text
src/main.cjs                    Electron 主进程与 IPC
src/preload.cjs                 最小权限渲染层桥接
src/lib/archive-store.cjs       JSONL 存档与 CSV 导出
src/renderer/                   节目画面、播放器、简介和本地评分
test/                           评分指令与存档等单元测试
scripts/e2e.cjs                 Electron 桌面端到端测试
```
