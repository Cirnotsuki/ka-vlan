# VLAN 组网

Windows 桌面端的 WireGuard 组网工具：一台机器开服务（Hub），其他机器填 IP 加入，加入后通过虚拟网卡互相访问。

界面用 Electron + Vue 2 + Element UI；成员注册、地址分配、成员表落在本机 SQLite；真正操作虚拟网卡的部分交给一个很小的 Go 程序（`vlancore`），它只做三件事：装隧道、卸隧道、热更新 peers。

---

## 运行要求

- Windows 10/11 x64
- 已安装 [WireGuard for Windows](https://www.wireguard.com/install/)（默认路径 `C:\Program Files\WireGuard`，需要 `wireguard.exe` 和 `wg.exe`）
- **管理员权限**：装卸隧道服务、`wg set`、开 IPv4 转发都要提权，`vlancore` 是由主进程用 `RunAs` 拉起的
- 开发环境：Node.js 16+、Go 1.16+

### 自带 WireGuard（可选）

发行版可以做成「用户不用预装 WireGuard」：把 `wireguard.exe` / `wg.exe` 丢进 `core/wg/`，
`vlancore` 的查找顺序是 **`core\wg\` → PATH → `C:\Program Files\WireGuard`**，找到哪份就用哪份；
前一份装不上会自动换下一份。打包时 `core/` 会被拷进 `resources/core`，这两个文件也就自动就位。

**不做哈希校验**：信任范围是整个发布物，不单独校验包内的 WireGuard。不放心的话删掉
`core/wg/` 下的 exe，程序会自动回退到系统安装版。细节见 [core/wg/README.md](core/wg/README.md)。

---

## 三层结构

```
┌─────────────────────────────── 渲染进程（Vue，nodeIntegration: true）───────────────────────────────┐
│  src/renderer/pages/home.vue    界面：加入服务器 / 开启服务 / 成员表 / 网卡开关                       │
│  src/renderer/utils/server.js   Node 内置 http 实现的注册服务（/api/join、/api/state）              │
│  src/renderer/utils/sqlite.js   子进程调 core\sqlite3.exe 读写 database.db                          │
│  src/renderer/utils/helper.js   密钥生成、conf 工具、startTunnel/stopTunnel、enableForwarding       │
└──────────────────────────────────────────────────────────────────────────────────────────────────────┘
                │ ipc                                            │ HTTP 127.0.0.1:7400
                ▼                                                ▼
┌──── 主进程 src/main ────┐                        ┌──────── Go 核心 core\cmd\vlancore ────────┐
│ 窗口、单实例、核心生命周期 │                        │ /tunnel/up、/tunnel/down、/tunnel/peer     │
│ poller.js 轮询（setTimeout）│                      │ 只是 wireguard.exe / wg.exe 的薄封装       │
└──────────────────────────┘                        └───────────────────────────────────────────┘
```

为什么轮询放在主进程：渲染层 `setInterval` 在页面重载/失焦时会被节流，且慢网络下请求会堆叠；主进程用 `setTimeout` 串行（上一轮有结果才排下一轮），结果通过 `webContents.send('poll:state' / 'poll:core')` 推回页面。

---

## 目录结构

```
core/                     Go 核心（只有一个功能：开关虚拟网卡）
  cmd/vlancore/main.go      HTTP 服务 + CLI（up / down / list）
  sqlite3.exe               SQLite 命令行，被渲染层调用
  build.bat                 构建 → core\vlancore.exe
  _legacy-go.zip            早期版本（Go 版注册服务/GUI）备份，不再参与构建
src/main/                 主进程
  index.js                  窗口、单实例锁、拉起 vlancore、ipc
  poller.js                 核心探活 + 节点状态轮询
src/renderer/             渲染层
  pages/home.vue            主页面
  utils/server.js           注册服务（成员表、IP 分配、封禁）
  utils/sqlite.js           数据库封装（子进程模式）
  utils/helper.js           密钥/conf/隧道工具
  constants.js              所有约定：网段、端口、网卡名、状态码
database.db               数据库（项目根目录，运行时自动创建）
```

**数据库位置**：`getRootFolder('database.db')` → 项目根目录的 `database.db`（打包后是资源目录同级），不是 `%APPDATA%`。

---

## 开发与构建

```bash
npm install                 # 如遇 peer 依赖冲突：npm install --legacy-peer-deps
npm run dev                 # webpack 起 9080 + 拉起 electron
npm run build               # 打包渲染层/主进程
npm run pack                # 出免安装目录（electron-builder --dir）
```

Go 核心单独构建：

```bat
cd core
build.bat                   :: 产出 core\vlancore.exe
```

改完 Go 代码、重启应用即可生效；主进程改动必须重新 `npm run dev`（webpack 编译 `dist/main.js`）。

---

## 端口

| 端口 | 协议 | 用途 |
|---|---|---|
| 12580 | TCP | 注册服务（`/api/join`、`/api/state`），默认值见 `DEFAULT_SERVER_PORT` |
| 1212 | UDP | WireGuard 监听端口（`DEFAULT_WG_PORT`） |
| 7400 | TCP | `vlancore` 本地控制接口，只监听 `127.0.0.1` |

网段 `10.84.111.0/24`，`.1` 固定给服务端，成员从 `.2` 开始分配。

---

## 接口

### 注册服务（跑在渲染进程，监听 `0.0.0.0:<serverPort>`）

```
POST /api/join   { nickName, publicKey, guid }
  → 200 { vpnIp, wgPort, serverKey, peers[] }
    403 已封禁  507 地址池耗尽

GET  /api/state?publicKey=<key>
  → 200 { joinErr, wgPort, vpnIp, serverKey, peers[] }
```

`peers[]` 只用于界面展示（`id / name / lastConnect / online`），不参与客户端 conf 生成——客户端的 `[Peer]` 只指向服务端，靠 `AllowedIPs = 10.84.111.0/24` 把整段流量交给 Hub。

### 核心（`127.0.0.1:7400`）

```
POST /tunnel/up    { name, conf }       装隧道（先卸同名旧隧道），返回 conf 落盘路径
POST /tunnel/down  { name }             卸隧道（幂等）
POST /tunnel/peer  { name, conf }       热更新 peers：写临时 conf + wg.exe set，不断连
GET  /tunnel/list                       当前托管的隧道
GET  /ping                              存活探测（主进程探活用这个）
POST /shutdown                          退出核心（不卸载已装隧道）
```

`/tunnel/up` 会在 `installtunnelservice` 之后**确认服务真的 RUNNING**，起不来就自动卸载并报错——`wireguard.exe` 对非法 conf 只返回 0，不查状态会得到一个「注册成功但没网卡」的假成功。

---

## 数据表

```sql
users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        VARCHAR(32),
  public_key  TEXT,
  private_key TEXT,
  ip          VARCHAR(32),
  vpn_ip      VARCHAR(32),
  guid        TEXT,
  status      TINYINT,   -- -1 删除 / 0 封禁 / 1 正常
  create_date DATE
)
```

`id = 0` 是**本机**那一行，`ip` 列语义按角色不同：

- 服务端：留空（服务端不记录自己的地址）；
- 客户端：存 `服务端IP:端口`，用于下次启动自动回填。

普通成员行的 `ip` 是注册时的来源地址，只用于封禁判定和展示。

`vpn_ip` 上有唯一索引，配合进程内的分配串行化，避免并发加入撞地址。

---

## 常见问题

**点了「开启服务」但网络连接里没有网卡**

```bat
sc query WireGuardTunnel$UsagiNetwork
```

`STOPPED` 说明服务注册成功但进程退出，基本是 conf 非法。`/tunnel/up` 的报错里会带 WireGuard 日志尾部，先看那句。踩过的坑：`[Peer]` 之间多出只有 `,` 的行、`PublicKey` 为空、`Endpoint` 冒号后带空格。

**提示「隧道服务没有跑起来（状态 STOPPED）」**

同一台机器上不要用同一个私钥开两个隧道（会撞已有隧道）；`ListenPort` 也不能被占用。换私钥/端口/网段再试。

**7400 端口被占，新编译的核心不生效**

旧的 `vlancore.exe` 还在跑（通常是提权进程，普通权限杀不掉）：

```bat
taskkill /F /PID <pid>          :: 管理员终端
```

主进程现在用 `/ping` 探活，能识别已有核心；如果探测到的是旧版本，重启应用也没用，必须先杀掉。

**成员之间 ping 不通**

Hub 需要开启 IPv4 转发。界面「开启服务」后会自动调用 `enableForwarding`，失败会在状态区显示「IPv4 转发未开启」。手动核对：

```powershell
Get-NetIPInterface -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -like '*Usagi*' }
```

**curl 调本地接口没反应**

系统代理（如 `127.0.0.1:1080`）会拦 `127.0.0.1`，调试时加 `--noproxy "*"`。

---

## 已知限制

- 隧道是系统服务，进程退出**不会**自动卸载；渲染层在 `beforeunload` 里用同步 XHR 兜底卸一次，异常退出会留残留。
- 改 `[Interface]`（地址、监听端口、私钥）必须重装隧道（断 1~3 秒）；只改 peers 走 `/tunnel/peer`，不断连。
- 仅支持 IPv4。
- 注册服务监听 `0.0.0.0` 且 CORS 全开，只适合可信内网使用。
- `core/_legacy-go.zip` 里的旧版注册服务与 GUI 已废弃，仅作参考。
