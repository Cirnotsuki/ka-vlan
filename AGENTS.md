# 工作区指令（wireguard-vlan）

（本文件由 DSH 自动加载；**全局规则在 `$DSH_HOME/AGENTS.md`**（Token 经济守则、缓存守则都在那里），本文件只放「本工作区的外部记忆」与项目特定约定。）

## 踩坑账本

- 「置顶索引」就在本文件底部，随系统提示加载，**不用读整份 `docs/PITFALLS.md`**。
- 记账（自动回写索引）：`node %USERPROFILE%\.dsh\toolbox\pitfall.mjs add --title "标题" --symptom "现象" --rule "结论" --never "别再试"`
- 压缩 / 换会话**之前**必须落账：负面知识压缩后最易丢、也最容易重犯。
- 索引只留最近 12 条，旧条目自动沉到正文。

<!-- INDEX:START -->
- 2026-11-14 · goroutine 调 walk Synchronize 会让进程静默退出(code 0)… — 本机 go1.16.3 + lxn/walk 2021-01 组合下该路径必死，CGO 开关无关。UI 定时刷新一律改 win.SetTimer(主窗口句柄…
- 2026-11-14 · Windows 桌面堆耗尽：僵尸 GUI 进程让所有新窗口程序死在 TTM_ADDTOOL — 多轮 Start-Process GUI 测试会在 executor 卡死时留下僵尸进程占着桌面堆，之后所有新 GUI 进程 tooltip 注册必败；用 taskkill…
<!-- INDEX:END -->
