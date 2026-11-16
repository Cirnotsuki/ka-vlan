# core/wg —— 应用自带的 WireGuard（可选）

这个目录**平时是空的**。`vlancore` 找 `wireguard.exe` / `wg.exe` 的顺序是：

1. `<vlancore 所在目录>\wg\wireguard.exe`、`...\wg\wg.exe` ← 也就是这里
2. `PATH`
3. `C:\Program Files\WireGuard`（以及 x86 版本）

所以想在发行版里"自带 WireGuard、用户不用预装"，把下面三个文件丢进这个目录即可：

```
core/wg/
  wireguard.exe     ← C:\Program Files\WireGuard\wireguard.exe
  wg.exe            ← C:\Program Files\WireGuard\wg.exe
  wintun.dll        ← C:\Program Files\WireGuard\wintun.dll
```

`electron-builder` 已经把 `core/` 整个目录拷进 `resources/core`，所以打包后它们会自动出现在
`resources\core\wg\`，`vlancore` 的 `exeDir()` 正好指向 `resources\core`。

## 信任模型

**不做哈希校验**——这是有意的取舍。程序连安装包一起分发，用户信任的是整个发布物；
与在包内塞一个别的可执行文件相比，替换 `core\wg` 下的 WireGuard 并不是更现实的威胁，
为它维护一套「换版本就得同步哈希/重编核心」的机制不划算。

如果不希望使用随包携带的这份，直接删掉本目录下的两个 exe：`vlancore` 会自动回退到
`C:\Program Files\WireGuard`（系统安装版），功能完全一致。

查找顺序（`core/cmd/vlancore/main.go` 的 `wireguardCandidates` / `wgExePath`）：

```
core\wg\wireguard.exe → PATH → C:\Program Files\WireGuard → C:\Program Files (x86)\WireGuard
core\wg\wg.exe        → wireguard.exe 同目录 → PATH → Program Files ...
```

前一个候选装不上（例如路径含中文导致服务起不来）会自动卸载并换下一个，不需要人工干预。

**升级 WireGuard**：替换这两个文件即可，不用改代码、不用重编 `vlancore`。

## 注意

- **许可**：`wireguard.exe` 是 MIT；`wg.exe` 来自 wireguard-tools，是 **GPL-2.0**。
  随包分发 `wg.exe` 需要附上 GPL 文本并提供对应源码（或书面 offer）。不想处理就只放
  `wireguard.exe`，此时 `/tunnel/peer`（peer 热更新）会因为找不到 `wg.exe` 报错，
  退化成"重装隧道"。
- **路径会被写死**：`wireguard.exe /installtunnelservice` 会把**当前 exe 的绝对路径**写进
  `WireGuardTunnel$<name>` 服务的 ImagePath。移动/升级应用目录之前，必须先卸掉隧道，
  否则服务指向一个不存在的文件，启动时静默失败。
- **中文路径**：隧道服务以 LocalSystem 启动，从含中文/非 ASCII 的路径加载 exe 会以
  「拒绝访问」退出（事件日志 7023）。开发环境会自动回退到系统版；发行版启动时会弹窗提示并退出。
- **版本同步**：跟着官方升级（安全修复），换文件必须同步更新 `SHA256SUMS`。
- **杀软**：签名文件本身没问题，但整个目录里混着你自己未签名的 exe 时，个别杀软会更敏感。

## 部署形态对比

| | 自带（本目录） | 依赖系统安装 |
|---|---|---|
| 用户 | 装完即用 | 需先装 WireGuard |
| 包体 | +10MB 左右 | 无 |
| 许可 | `wg.exe` 需遵守 GPL-2.0 | 无 |
| 维护 | 需跟随官方升级 | 用户自行升级 |
