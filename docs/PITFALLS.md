# 踩坑账本（负面知识 / 外部记忆）

> 为什么存在：压缩会把「试过但失败」这类负面知识丢得最干净（实测摘要只保留 12~25% 的标识符）。这份文件不随压缩消失，是压缩后的外部记忆。
>
> 用法：开工先看工作区 `AGENTS.md` 里的「置顶索引」（已随系统提示加载）；踩坑当场用 `node %USERPROFILE%\.dsh\toolbox\pitfall.mjs add ...` 记账；压缩前必须把未记账的负面知识落账。
> 索引由脚本生成，只留最近 12 条；旧条目沉在本文件，不要删。

## 记录（新→旧）

### 2026-11-14 · goroutine 调 walk Synchronize 会让进程静默退出(code 0)，改用 win32 SetTimer+子类化 WndProc

- 现象：后台 goroutine 调 mainWin.Synchronize(fn) 后整个 GUI 进程 2-3 秒内无声退出，stderr 空且无 WER 事件，任何 recover 都接不到
- 结论：本机 go1.16.3 + lxn/walk 2021-01 组合下该路径必死，CGO 开关无关。UI 定时刷新一律改 win.SetTimer(主窗口句柄)+SetWindowLongPtr 子类化 WndProc 在 WM_TIMER 里直接刷新；后台 goroutine 只做纯内存计算
- 别再试：别再在这个环境用 goroutine+Synchronize 驱动 walk UI 刷新；GUI 测试进程退出码要防 cmd %ERRORLEVEL% 展开时机陷阱

### 2026-11-14 · Windows 桌面堆耗尽：僵尸 GUI 进程让所有新窗口程序死在 TTM_ADDTOOL

- 现象：walk 应用启动即无声退出或弹 TTM_ADDTOOL failed，连最小 hello-walk 也挂，且与代码无关
- 结论：多轮 Start-Process GUI 测试会在 executor 卡死时留下僵尸进程占着桌面堆，之后所有新 GUI 进程 tooltip 注册必败；用 taskkill 全清僵尸即恢复。判别法：拿最小 hello-walk 复测，若它也挂就是环境不是代码
- 别再试：别再对着一个所有对照实验都失败的环境调试代码；GUI 测试进程要即时收尸

