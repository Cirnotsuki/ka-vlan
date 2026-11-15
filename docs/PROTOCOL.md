# WireGuard 虚拟局域网组网协议 v0.1

基于 wireguard-windows（Go）改造。服务器 = 中心节点（自己入网，地址池第一个 IP），客户端 Join 后全互联。

## 常量

| 项 | 默认值 |
|---|---|
| 地址池 | `10.84.111.0/24`（服务器固定 `10.84.111.1`） |
| 注册端口（TCP/HTTP） | `:8080` |
| WireGuard 端口（UDP） | `51820`（客户端可自定义，注册时上报） |
| 心跳间隔 | 30s |

## 角色与状态

- **Server**：持有 WG 接口（10.84.111.1）+ 注册服务。内存态：成员表 `map[publicKey]Member`、封禁表 `map[publicKey + 来源IP]`、地址池游标。
- **Client**：持有 WG 接口（分到的内网 IP）+ peer 列表。状态机：`Idle → Joining → Joined`。

### Member 结构（服务端内存 + 推送载荷通用）

```json
{
  "id": "string，匿名时服务端生成 uuid 前 8 位",
  "public_key": "base64 44 字符",
  "vpn_ip": "10.84.111.x",
  "endpoint": "1.2.3.4:51820，服务端从 TCP 连接对端地址 + body 上报端口拼出",
  "joined_at": 1699999999
}
```

## 报文格式

全部 JSON，`Content-Type: application/json`。版本字段 `v` 放最外层，服务端不认识直接 400。

### 1. Join 请求  `POST /join`

```json
{ "v": 1, "public_key": "...", "id": "可选，空则匿名", "wg_port": 51820 }
```

服务端处理：
1. 校验 public_key 格式；命中封禁表（key 或来源 IP）→ `403 { "error": "banned" }`。
2. ID 为空 → 生成 `anon-xxxxxxxx`；ID 重复 → 追加 `-2` 后缀。
3. 分配地址池下一个空闲 IP；池满 → `507 { "error": "pool_exhausted" }`。
4. 服务端把自己的 WG 接口也 `wg set` 加上这个新 peer（AllowedIPs = 新成员 vpn_ip/32）。
5. 向**所有老成员**推送 ADD（见 §3）。
6. 返回给新成员：

### Join 响应  `200`

```json
{
  "v": 1,
  "you": { "id": "...", "vpn_ip": "10.84.111.5" },
  "server": { "public_key": "服务端公钥", "vpn_ip": "10.84.111.1", "endpoint": "公网IP:51820" },
  "peers": [ /* 全量 Member，不含自己 */ ]
}
```

客户端拿到后本地完成配置（见 §4）。

### 2. Leave 请求  `POST /leave`

```json
{ "v": 1, "public_key": "..." }
```

正常退出（程序退出前尽力调用）。服务端摘 peer、广播 REMOVE。非 Members 调用返回 404 但不报错处理（幂等）。

### 3. 服务端推送（Server → Client）

老成员客户端 Join 成功后立即向服务端再开一条 **长连接**：`GET /events`（HTTP 长轮询或 SSE，第一版用 **长轮询**：客户端带 `?since=<seq>`，服务端 hold 至多 25s，有事件即回）。

事件格式（信封）：

```json
{ "v": 1, "seq": 42, "type": "add" | "remove" | "kick", "member": { /* Member */ } }
```

- `add`：新成员加入，老成员 `wg set` 添加该 peer。
- `remove`：成员正常离开，删除 peer。
- `kick`：被封禁/删除，删除 peer；客户端收到后回 Idle 态。
- 心跳：hold 超时无事件回 `204`，客户端立即重连（等效心跳）。

seq 单调递增；客户端断线重连时带本地最大 seq 补拉，服务端只保留最近 256 条事件，落后太多 → 返回 `410`，客户端**重新走一遍 Join**（幂等：同 public_key 重新 Join = 更新 endpoint/IP 不变）。

### 4. 客户端本地配置动作

收到 Join 响应后依次执行：
1. 生成/加载本地密钥对（Join 前已生成）。
2. 创建隧道接口 `wintun`，地址 = `you.vpn_ip/24`，DNS 不动。
3. `wg.SetConfig`：PrivateKey = 本地私钥；ListenPort = wg_port；
   Peer(server) = server.public_key，AllowedIPs = `10.84.111.1/32`（第一版不全场代理，只通内网段），Endpoint = server.endpoint，PersistentKeepalive = 25。
4. 对 peers 逐个：Peer(member.public_key)，AllowedIPs = `member.vpn_ip/32`，Endpoint = member.endpoint，Keepalive = 25。

> NAT 兜底：两个客户端互相直连失败时，因为双方都连着服务器且各自 AllowedIPs 只含精确 /32，流量不会自动绕行。**v0.1 行为**：直连不通即不通；v0.2 再考虑服务端代理兜底（把客户端 peer 的 AllowedIPs 扩成 /24 走服务器）。

### 5. 管理操作（Server 本地 UI → 自己的服务）

- 删除：摘 peer + 广播 `remove`。
- 封禁：publicKey + 注册来源 IP 进封禁表 → 摘 peer + 广播 `kick`。解封 = 从封禁表移除（UI 暂不做，CLI 留口）。

## 安全边界（v0.1 明确不做）

- 注册接口无鉴权：任何知道 地址:8080 的人可占一个 IP。地址池 /24 只有 ~250 个坑，属可接受损耗；封禁表提供事后处置。
- JSON 明文传输：publicKey/ID 非敏感；后续可加 HTTPS 或预共享 token。
- 重放/伪造：伪造 Join 需要受害者 publicKey，且只能「顶替注册」（同 key Join 是幂等更新），不破坏已有连接。

## 时序总览

```
Server(UI: Start Serve)                Client(UI: Join Serve)
  生成密钥对，起 WG 接口 10.84.111.1
  起 :8080 注册服务
  UI 切管理列表                            生成密钥对
                                           POST /join {pk, id?, wg_port}
  校验→分配 IP→自己加 peer
  广播 add 给所有老成员
  ←———————————— 200 {you, server, peers} ————
                                           配置自身接口 + 全部 peer
                                           GET /events?since=0 （长轮询挂住）
  （管理列表显示 ID/IP/删除/封禁）
```
