# KA-VLAN

**KA-VLAN** 是一款面向 Windows 的桌面端虚拟局域网组网工具，基于 **WireGuard** 实现设备间互联。

一台设备作为服务端（Hub），其他设备通过填写服务端 IP 和端口加入网络。连接成功后，所有成员都可以通过分配到的虚拟 IP 互相访问，就像处于同一个局域网中一样。

- **项目地址：** <https://github.com/Cirnotsuki/ka-vlan>
- **作者：** Kuzuki Azusa

## 功能与实现

- 以 Hub 为中心建立虚拟局域网，支持成员加入和地址分配。
- 使用 WireGuard 虚拟网卡承载设备间通信。
- 本地 SQLite 数据库保存成员信息、密钥及虚拟 IP。
- 支持成员状态查询、封禁及 Peer 热更新。
- 通过独立的 Go 核心程序管理 WireGuard 隧道，Electron 主程序负责界面和业务逻辑。

项目界面使用 **Electron + Vue 2 + Element UI** 实现。成员注册、地址分配和成员数据管理由桌面端完成；虚拟网卡的安装、卸载及 Peer 更新则交由轻量级 Go 程序 `vlancore` 处理。

## 运行环境

| 项目 | 要求 |
|---|---|
| 操作系统 | Windows 10/11 x64 |
| WireGuard | 已安装 WireGuard for Windows |
| 权限 | 管理员权限 |
| Node.js | 16+（开发环境） |
| Go | 1.16+（开发环境） |

WireGuard 默认安装目录为 `C:\Program Files\WireGuard`，程序需要使用其中的 `wireguard.exe` 和 `wg.exe`。

> **权限说明：** 安装和卸载隧道服务、执行 `wg set` 以及开启 IPv4 转发均需要管理员权限。主进程会通过 `RunAs` 提权启动 `vlancore`。

### 可选：随程序附带 WireGuard

发行版可以选择内置 WireGuard，用户便不必预先安装 WireGuard for Windows。将 `wireguard.exe` 和 `wg.exe` 放入 `core/wg/` 即可。

`vlancore` 按以下顺序查找可执行文件：

1. `core\wg\`
2. 系统 `PATH`
3. `C:\Program Files\WireGuard`

如果前一个位置的程序无法使用，会自动尝试下一个位置。打包时 `core/` 会复制到 `resources/core`，因此内置文件也会一并带入发行版。

**安全提示：** 当前不会对内置 WireGuard 文件进行哈希校验，程序信任整个发布物。如果不希望使用内置版本，删除 `core/wg/` 下的 exe 即可，程序会回退到系统安装版本。详见 [`core/wg/README.md`](core/wg/README.md)。

## 网络配置

| 配置项 | 默认值 | 说明 |
|---|---:|---|
| 虚拟网段 | `10.84.111.0/24` | 所有成员使用的虚拟网段 |
| 服务端虚拟 IP | `10.84.111.1` | 固定分配给 Hub |
| 成员 IP | 从 `10.84.111.2` 开始 | 由服务端分配 |
| 注册服务端口 | `12580/TCP` | 成员注册与状态查询 |
| WireGuard 端口 | `1212/UDP` | WireGuard 隧道监听端口 |
| 核心控制端口 | `7400/TCP` | `vlancore` 本地控制接口 |

端口默认值分别由 `DEFAULT_SERVER_PORT` 和 `DEFAULT_WG_PORT` 等常量定义，具体以项目代码为准。

## 项目架构

项目主要由 Electron 桌面端和 Go 核心组成：

```text
┌────────────────────────────── 渲染进程（Vue，nodeIntegration: true）──────────────────────────────┐
│  src/renderer/pages/home.vue    界面：加入服务器 / 开启服务 / 成员表 / 网卡开关                    │
│  src/renderer/utils/server.js   注册服务：/api/join、/api/state                                   │
│  src/renderer/utils/sqlite.js   调用 core\\sqlite3.exe 读写 database.db                            │
│  src/renderer/utils/helper.js   密钥生成、conf 工具、隧道启停、IPv4 转发                           │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘
                 │ IPC                                      │ HTTP 127.0.0.1:7400
                 ▼                                          ▼
┌──────────────────────────────┐              ┌────────────────────────────────────────────────────┐
│       Electron 主进程        │              │              Go 核心 vlancore                     │
│  窗口、单实例、核心生命周期  │              │  /tunnel/up、/tunnel/down、/tunnel/peer           │
│  poller.js 状态轮询           │              │  对 wireguard.exe / wg.exe 的轻量封装             │
└──────────────────────────────┘              └────────────────────────────────────────────────────┘
```

### 为什么轮询由主进程负责？

渲染进程中的 `setInterval` 可能在页面重载或失焦时受到节流，慢网络下也容易出现请求堆积。因此，主进程使用 `setTimeout` 串行轮询：只有上一轮完成后才安排下一轮，再通过 `webContents.send('poll:state' / 'poll:core')` 将结果推送给页面。

## 目录结构

```text
core/                       Go 核心及相关工具
  cmd/vlancore/main.go      HTTP 服务与 CLI（up / down / list）
  sqlite3.exe               SQLite 命令行工具
  build.bat                 构建脚本，生成 core\\vlancore.exe
  _legacy-go.zip            早期 Go 版注册服务/GUI 备份，不参与当前构建

src/main/                   Electron 主进程
  index.js                  窗口、单实例锁、启动 vlancore、IPC
  poller.js                 核心探活与节点状态轮询

src/renderer/               Vue 渲染层
  pages/home.vue            主页面
  utils/server.js           注册服务、成员表、IP 分配与封禁
  utils/sqlite.js           SQLite 数据库封装（子进程模式）
  utils/helper.js           密钥、conf 与隧道工具
  constants.js              网段、端口、网卡名、状态码等约定

database.db                 数据库（运行时自动创建）
```

**数据库位置：** `getRootFolder('database.db')` 指向项目根目录下的 `database.db`；打包后位于资源目录同级，而不是 `%APPDATA%`。

## 开发与构建

安装依赖并启动开发环境：

```bash
npm install
# 如遇 peer 依赖冲突，可尝试：
npm install --legacy-peer-deps

# 启动开发环境（webpack 监听 9080，并启动 Electron）
npm run dev
```

构建与打包：

```bash
npm run build  # 构建渲染层和主进程
npm run pack   # 生成免安装目录（electron-builder --dir）
```

Go 核心需要单独构建：

```bat
cd core
build.bat
```

构建完成后会生成 `core\vlancore.exe`。修改 Go 代码后，重启应用即可生效；修改主进程代码则需要重新执行 `npm run dev`，由 webpack 重新编译 `dist/main.js`。

## 网络端口

| 端口 | 协议 | 用途 |
|---:|---|---|
| `12580` | TCP | 注册服务：`/api/join`、`/api/state` |
| `1212` | UDP | WireGuard 监听端口 |
| `7400` | TCP | `vlancore` 本地控制接口，仅监听 `127.0.0.1` |

部署或排查连接问题时，请确认防火墙允许相应端口通信。注册服务监听 `0.0.0.0`，因此会接受来自网络接口的连接。

## 接口说明

### 注册服务

注册服务由渲染进程运行，监听 `0.0.0.0:<serverPort>`。

**加入网络**

```http
POST /api/join
Content-Type: application/json

{
  "nickName": "成员名称",
  "publicKey": "WireGuard 公钥",
  "guid": "设备标识"
}
```

成功返回：

```json
{
  "vpnIp": "分配到的虚拟 IP",
  "wgPort": "WireGuard 端口",
  "serverKey": "服务端公钥",
  "peers": []
}
```

可能的状态码：`403` 表示成员已被封禁，`507` 表示地址池耗尽。

**查询状态**

```http
GET /api/state?publicKey=<key>
```

返回内容包含 `joinErr`、`wgPort`、`vpnIp`、`serverKey` 和 `peers[]`。

`peers[]` 仅供界面展示，包含成员的 `id`、`name`、`lastConnect` 和 `online` 等信息，不参与客户端 conf 生成。客户端的 `[Peer]` 只指向服务端，并通过 `AllowedIPs = 10.84.111.0/24` 将整个虚拟网段的流量交给 Hub。

### Go 核心接口

核心服务仅监听本机地址 `127.0.0.1:7400`。

| 方法 | 路径 | 参数 / 作用 |
|---|---|---|
| `POST` | `/tunnel/up` | `{ name, conf }`：安装隧道；先卸载同名旧隧道，返回 conf 文件路径 |
| `POST` | `/tunnel/down` | `{ name }`：卸载隧道，支持幂等调用 |
| `POST` | `/tunnel/peer` | `{ name, conf }`：通过临时 conf 和 `wg.exe set` 热更新 Peer，不主动断开连接 |
| `GET` | `/tunnel/list` | 获取当前由核心管理的隧道 |
| `GET` | `/ping` | 存活探测，供主进程检查核心状态 |
| `POST` | `/shutdown` | 退出核心进程，不卸载已经安装的隧道 |

`/tunnel/up` 在执行 `installtunnelservice` 后会进一步确认服务确实处于 `RUNNING` 状态。如果启动失败，会自动卸载并返回错误。这样可以避免 WireGuard 对非法 conf 返回退出码 `0`，却没有真正创建可用网卡的情况。

## 数据库结构

当前成员表 `users`：

```sql
CREATE TABLE users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        VARCHAR(32),
  public_key  TEXT,
  private_key TEXT,
  ip          VARCHAR(32),
  vpn_ip      VARCHAR(32),
  guid        TEXT,
  status      TINYINT,   -- -1 删除 / 0 封禁 / 1 正常
  create_date DATE
);
```

### 字段约定

- `id = 0` 表示本机记录。
- `ip` 字段根据设备角色有不同含义：
  - **服务端：** 留空，不记录服务端自身地址。
  - **客户端：** 保存 `服务端IP:端口`，用于下次启动时自动回填。
- 普通成员记录中的 `ip` 是注册时的来源地址，用于封禁判定和界面展示。
- `vpn_ip` 建有唯一索引，并配合进程内的分配串行化，避免并发加入时分配到重复地址。

## 常见问题

### 点击「开启服务」后，网络连接中没有出现网卡

查询对应的 WireGuard 隧道服务状态：

```bat
sc query WireGuardTunnel$UsagiNetwork
```

如果状态为 `STOPPED`，说明服务注册成功后进程退出，通常是 conf 配置非法。`/tunnel/up` 的错误信息会包含 WireGuard 日志尾部，可以优先检查具体报错。

常见配置问题包括：

- `[Peer]` 配置块之间出现只有 `,` 的行。
- `PublicKey` 为空。
- `Endpoint` 的冒号后面带有空格。

### 提示「隧道服务没有跑起来（状态 STOPPED）」

同一台机器上不要使用同一个私钥启动两个隧道，否则可能与已有隧道冲突；同时确认 `ListenPort` 没有被其他程序占用。可以尝试更换私钥、端口或网段。

### 7400 端口被占用，重新编译的核心没有生效

通常是旧版 `vlancore.exe` 仍在运行。核心可能由提权进程启动，普通权限无法结束它。

在管理员终端中查找并结束对应进程：

```bat
taskkill /F /PID <pid>
```

主进程会通过 `/ping` 检测已有核心。如果检测到的是旧版本，仅重启应用无法替换它，需要先结束旧进程。

### 成员之间无法互相 ping 通

Hub 必须开启 IPv4 转发。点击界面中的「开启服务」后，程序会自动调用 `enableForwarding`；如果失败，状态区会显示「IPv4 转发未开启」。

可以使用 PowerShell 检查 WireGuard 网卡：

```powershell
Get-NetIPInterface -AddressFamily IPv4 |
  Where-Object { $_.InterfaceAlias -like '*Usagi*' }
```

### curl 调用本地接口没有响应

如果系统配置了代理（例如 `127.0.0.1:1080`），代理可能会影响对本地地址的请求。调试时可以显式绕过代理：

```bash
curl --noproxy "*" http://127.0.0.1:7400/ping
```

## 已知限制与注意事项

- WireGuard 隧道以系统服务形式运行，应用进程退出时**不会自动卸载隧道**。渲染层会在 `beforeunload` 中通过同步 XHR 尝试卸载，但异常退出时仍可能留下残留服务。
- 修改 `[Interface]` 中的地址、监听端口或私钥，需要重新安装隧道，期间会短暂断开连接（约 1～3 秒）。
- 仅修改 Peer 配置时可使用 `/tunnel/peer` 热更新，无需主动断开隧道。
- 当前仅支持 IPv4。
- 注册服务监听 `0.0.0.0`，且 CORS 未作限制，仅建议在可信网络环境中使用。
- `core/_legacy-go.zip` 中的旧版 Go 注册服务和 GUI 已废弃，仅作为历史参考，不参与当前构建。

## 作者

**Kuzuki Azusa**

项目地址：[Cirnotsuki/ka-vlan](https://github.com/Cirnotsuki/ka-vlan)
