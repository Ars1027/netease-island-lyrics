# 参与贡献

感谢你愿意改进云岛歌词。

## 开始之前

- 运行环境：Windows 10 1809+、Node.js 18+。
- 媒体识别问题请先确认网易云已提供 SMTC 会话；BetterNCM 用户需启用 SMTC 插件。
- 大功能或交互改动建议先开 Issue，说明动机、预期行为和兼容性影响。

## 本地开发

```powershell
npm ci
npm test
npm run demo
```

需要构建 portable 时：

```powershell
npm run dist
```

原生监听器使用 .NET Framework C# 编译器构建。请勿提交 `node_modules`、`dist`、测试用户目录、运行截图或本机设置。

## 提交要求

1. 一个提交只处理一类问题，提交信息简洁说明结果。
2. 新增逻辑应补充纯 Node 测试，避免必须启动真实 Electron 才能验证。
3. 保持 `contextIsolation`、sandbox、IPC 来源校验和最小 preload API。
4. 动画优先使用 `transform` / `opacity`，不要恢复常驻高刷 JS 循环。
5. 调整 SMTC、监听器或启动项时，需要覆盖停止、重启、回滚和重复调用场景。

## 报告问题

请使用仓库的问题模板，并尽量提供：

- Windows 与网易云版本；
- 是否使用 BetterNCM，以及 SMTC 插件状态；
- 云岛版本与 SHA-256；
- 可复现步骤、预期结果、实际结果；
- 必要的截图或日志（请先移除隐私信息）。
