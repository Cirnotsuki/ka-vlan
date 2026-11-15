# vlancore ↔ Node 对接契约（pipeline）

Go 核心 = `vlancore.exe`（无界面，纯命令行/API）。Electron 壳负责拉起它并消费下面的 HTTP API。

## 启动方式

- 监听固定 `127.0.0.1:7400`（仅回环，不出网）。
- 需要**管理员权限**运行（隧道安装用）；Electron 壳用 PowerShell `Start-Process -Verb RunAs` 提权拉起。
- 就绪探测：`GET /api/state` 返回 200 即就绪。

## 状态机

```
idle ──start-serve──▶ serve ──stop-serve──▶ serve(端口已关，可再开)
idle ──join─────────▶ joining ──成功──▶ join ──disconnect/被踢/断线──▶ idle
serve 模式下不接受 join，join 模式下不接受 start-serve（返回 error 字段）
```

## 端点

| 方法 | 路径 | 入参 | 返回 |
|---|---|---|---|
| GET | `/api/state` | - | `{mode, statusMsg, joinErr, members?, memberCount?, latencyMs?, portOK?, server?, self?, peers?}` |
| POST | `/api/start-serve` | `{port}` | `{ok, publicKey, port}` 或 `{error}` |
| POST | `/api/stop-serve` | - | `{ok}`（关闭监听端口；再次 start-serve 同端口可重启） |
| POST | `/api/join` | `{nick, ip, port}` | `{ok, self, server}` 或 `{error}`；完成后 state 里有 peers |
| POST | `/api/disconnect` | - | `{ok}` |
| GET | `/api/members` | - | `Member[]`（serve=管理列表；join=peers） |
| POST | `/api/ban` | `{publicKey}` | `{ok}` 或 `{error}` |
| POST | `/api/delete` | `{publicKey}` | `{ok}` 或 `{error}` |
| POST | `/api/shutdown` | - | `{ok}` 后核心自动退出（Electron 关窗时调用） |
| GET | `/` | - | 渲染层 `index.html`（Electron 也可以直接 loadURL 到 7400，同源免 CORS） |

`Member = {id, public_key, vpn_ip, endpoint, joined_at}`

## UI 轮询约定

- 前端每 2s 轮询 `/api/state` 刷新界面；`portOK=false` 时延迟/端口状态显示红色。
- GPU 渲染问题与核心无关；Electron 侧如需禁硬解设环境变量 `VLAN_DISABLE_GPU=1`。

## 已知限制（v0.1）

- join 是阻塞式网络调用（等服务器响应），期间 `/api/state` 的 mode=joining。
- 单实例：端口 7400 被占用 = 已有核心在跑，Electron 直接复用。
- 认证/鉴权：无（回环地址本机任意进程可调用，v0.1 接受）。
