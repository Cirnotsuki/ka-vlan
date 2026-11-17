[简体中文](README.md) | [English](README.en.md)

# KA-VLAN

**KA-VLAN** is a Windows desktop application for creating virtual LANs (VLANs) between devices. It uses **WireGuard** to establish secure connections between network members.

One device acts as the server (Hub), while other devices join the network by entering the server IP address and port. Once connected, all members can communicate with one another through their assigned virtual IP addresses, just as if they were on the same local network.

- **Repository:** <https://github.com/Cirnotsuki/ka-vlan>
- **Author:** Kuzuki Azusa

## Features and Implementation

- Creates a Hub-centered virtual LAN and supports member registration and IP address allocation.
- Uses a WireGuard virtual network adapter to carry traffic between devices.
- Stores member information, keys, and virtual IP addresses in a local SQLite database.
- Supports member status queries, blocking, and hot updates of WireGuard peers.
- Uses a standalone Go core to manage WireGuard tunnels, while the Electron application handles the UI and application logic.

The UI is built with **Electron + Vue 2 + Element UI**. The desktop application handles member registration, address allocation, and member data management. A lightweight Go program, `vlancore`, handles virtual adapter installation, removal, and peer updates.

## Requirements

| Component | Requirement |
|---|---|
| Operating system | Windows 10/11 x64 |
| WireGuard | WireGuard for Windows |
| Permissions | Administrator privileges |
| Node.js | 16+ (development only) |
| Go | 1.16+ (development only) |

WireGuard is installed by default in `C:\Program Files\WireGuard`. The application uses `wireguard.exe` and `wg.exe` from this directory.

> **Permissions:** Installing and removing tunnel services, running `wg set`, and enabling IPv4 forwarding require administrator privileges. The main process launches `vlancore` with elevated permissions through `RunAs`.

### Optional: Bundle WireGuard with the Application

A release can include WireGuard binaries so users do not need to install WireGuard for Windows separately. Place `wireguard.exe` and `wg.exe` in `core/wg/`.

`vlancore` searches for the executables in the following order:

1. `core\wg\`
2. The system `PATH`
3. `C:\Program Files\WireGuard`

If an executable cannot be used at one location, the application automatically tries the next one. During packaging, `core/` is copied to `resources/core`, so bundled files are included in the release.

**Security notice:** The bundled WireGuard files are not currently verified by hash. The application trusts the release package as a whole. To avoid using the bundled version, delete the executable files in `core/wg/`; the application will fall back to the system installation. See [`core/wg/README.md`](core/wg/README.md) for details.

## Network Configuration

| Setting | Default | Description |
|---|---:|---|
| Virtual subnet | `10.84.111.0/24` | Virtual subnet shared by all members |
| Server virtual IP | `10.84.111.1` | Reserved for the Hub |
| Member IP addresses | Starting at `10.84.111.2` | Allocated by the server |
| Registration service port | `12580/TCP` | Member registration and status queries |
| WireGuard port | `1212/UDP` | WireGuard tunnel listening port |
| Core control port | `7400/TCP` | Local control API for `vlancore` |

Default port values are defined by constants such as `DEFAULT_SERVER_PORT` and `DEFAULT_WG_PORT`. Refer to the source code for the actual values.

## Architecture

The application consists primarily of an Electron desktop client and a Go core:

<img width="1536" height="1024" alt="ad7c99f0-3ea3-4e81-ba2d-db03ba67e8ea" src="https://github.com/user-attachments/assets/c2bcb94d-93dc-48fe-905a-a68e321e1119" />


### Why Is Polling Handled by the Main Process?

`setInterval` in the renderer process may be throttled when the page is reloaded or loses focus. On slow networks, it can also cause requests to pile up. The main process therefore uses serial `setTimeout` polling: it schedules the next poll only after the previous one has completed, then sends the results to the page through `webContents.send('poll:state' / 'poll:core')`.

## Directory Structure

```text
core/                       Go core and related tools
  cmd/vlancore/main.go      HTTP service and CLI (up / down / list)
  sqlite3.exe               SQLite command-line tool
  build.bat                 Build script; generates core\\vlancore.exe
  _legacy-go.zip            Backup of the earlier Go registration service/GUI; not used in current builds

src/main/                   Electron main process
  index.js                  Window, single-instance lock, vlancore startup, IPC
  poller.js                 Core health checks and member status polling

src/renderer/               Vue renderer
  pages/home.vue            Main page
  utils/server.js           Registration service, member list, IP allocation, and blocking
  utils/sqlite.js           SQLite wrapper (child-process mode)
  utils/helper.js           Key, conf, and tunnel utilities
  constants.js              Subnet, port, adapter name, status codes, and other shared definitions

database.db                 Database (created automatically at runtime)
```

**Database location:** `getRootFolder('database.db')` points to `database.db` in the project root. In a packaged build, it is located alongside the resources directory, not under `%APPDATA%`.

## Development and Build

Install dependencies and start the development environment:

```bash
npm install
# If you encounter peer dependency conflicts, try:
npm install --legacy-peer-deps

# Start the development environment (webpack watches port 9080 and launches Electron)
npm run dev
```

Build and package the application:

```bash
npm run build  # Build the renderer and main process
npm run pack   # Generate an unpacked application directory (electron-builder --dir)
```

The Go core must be built separately:

```bat
cd core
build.bat
```

After the build completes, `core\vlancore.exe` will be generated. Restart the application after modifying the Go code. Changes to the main process require running `npm run dev` again so webpack can rebuild `dist/main.js`.

## Network Ports

| Port | Protocol | Purpose |
|---:|---|---|
| `12580` | TCP | Registration service: `/api/join`, `/api/state` |
| `1212` | UDP | WireGuard listening port |
| `7400` | TCP | Local `vlancore` control API; listens on `127.0.0.1` only |

When deploying or troubleshooting connectivity, make sure the firewall allows the required traffic. The registration service listens on `0.0.0.0`, so it accepts connections from network interfaces.

## API Reference

### Registration Service

The registration service runs in the renderer process and listens on `0.0.0.0:<serverPort>`.

**Join the Network**

```http
POST /api/join
Content-Type: application/json

{
  "nickName": "Member name",
  "publicKey": "WireGuard public key",
  "guid": "Device identifier"
}
```

Successful response:

```json
{
  "vpnIp": "Assigned virtual IP address",
  "wgPort": "WireGuard port",
  "serverKey": "Server public key",
  "peers": []
}
```

Possible status codes: `403` means the member is blocked; `507` means the address pool is exhausted.

**Query Status**

```http
GET /api/state?publicKey=<key>
```

The response includes `joinErr`, `wgPort`, `vpnIp`, `serverKey`, and `peers[]`.

`peers[]` is used by the UI for display only. It contains fields such as member `id`, `name`, `lastConnect`, and `online`, and is not used to generate the client configuration. The client's `[Peer]` entry points only to the server. `AllowedIPs = 10.84.111.0/24` routes traffic for the entire virtual subnet through the Hub.

### Go Core API

The core service listens only on the local address `127.0.0.1:7400`.

| Method | Path | Parameters / Description |
|---|---|---|
| `POST` | `/tunnel/up` | `{ name, conf }`: installs a tunnel; removes an existing tunnel with the same name first, and returns the conf file path |
| `POST` | `/tunnel/down` | `{ name }`: removes a tunnel; supports idempotent calls |
| `POST` | `/tunnel/peer` | `{ name, conf }`: hot-updates peers through a temporary conf file and `wg.exe set`, without intentionally disconnecting the tunnel |
| `GET` | `/tunnel/list` | Lists tunnels currently managed by the core |
| `GET` | `/ping` | Health check used by the main process |
| `POST` | `/shutdown` | Exits the core process without removing installed tunnels |

After running `installtunnelservice`, `/tunnel/up` also verifies that the service has actually reached the `RUNNING` state. If startup fails, the core removes the service and returns an error. This prevents cases where WireGuard returns exit code `0` for an invalid conf file but does not create a working network adapter.

## Database Schema

The current member table is `users`:

```sql
CREATE TABLE users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        VARCHAR(32),
  public_key  TEXT,
  private_key TEXT,
  ip          VARCHAR(32),
  vpn_ip      VARCHAR(32),
  guid        TEXT,
  status      TINYINT,   -- -1 deleted / 0 blocked / 1 active
  create_date DATE
);
```

### Field Conventions

- `id = 0` represents the local machine.
- The meaning of the `ip` field depends on the device role:
  - **Server:** left empty; the server's own address is not stored.
  - **Client:** stores `server IP:port` for automatic restoration on the next startup.
- For regular member records, `ip` stores the source address observed during registration. It is used for blocking checks and display in the UI.
- `vpn_ip` has a unique index and is combined with in-process serialized allocation to prevent duplicate addresses during concurrent joins.

## Troubleshooting

### No Network Adapter Appears After Clicking "Start Service"

Check the status of the corresponding WireGuard tunnel service:

```bat
sc query WireGuardTunnel$UsagiNetwork
```

If the status is `STOPPED`, the service was registered but its process exited. An invalid conf file is a common cause. The error returned by `/tunnel/up` includes the tail of the WireGuard log, which should help identify the problem.

Common configuration issues include:

- A line containing only `,` between `[Peer]` sections.
- An empty `PublicKey`.
- A space after the colon in `Endpoint`.

### "Tunnel Service Failed to Start (Status STOPPED)"

Do not start two tunnels with the same private key on the same machine, as this may conflict with an existing tunnel. Also make sure the `ListenPort` is not already in use. Try changing the private key, port, or subnet if necessary.

### Port 7400 Is Occupied and the Rebuilt Core Does Not Take Effect

An older `vlancore.exe` process is usually still running. The core may have been started by an elevated process, so a non-elevated terminal may not be able to terminate it.

Find and terminate the process from an administrator terminal:

```bat
taskkill /F /PID <pid>
```

The main process uses `/ping` to detect an existing core. If it finds an older version, restarting the application alone will not replace it; terminate the old process first.

### Members Cannot Ping Each Other

IPv4 forwarding must be enabled on the Hub. When you click "Start Service", the application calls `enableForwarding` automatically. If this fails, the status area displays "IPv4 forwarding is disabled".

To check the WireGuard adapter by its configured virtual IP address (replace the example IP if your server uses a different one):

```powershell
$interface = Get-NetIPAddress -IPAddress '10.84.111.1' -AddressFamily IPv4 -ErrorAction SilentlyContinue
if ($interface) { Get-NetIPInterface -InterfaceIndex $interface.InterfaceIndex -AddressFamily IPv4 }
```

If the application fails to enable IPv4 forwarding automatically, open PowerShell as an administrator and run the following commands.

```powershell
[System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$interface = Get-NetIPAddress -IPAddress '10.84.111.1' -AddressFamily IPv4 -ErrorAction Stop | Select-Object -First 1
Set-NetIPInterface -InterfaceIndex $interface.InterfaceIndex -AddressFamily IPv4 -Forwarding Enabled -ErrorAction Stop
$result = Get-NetIPInterface -InterfaceIndex $interface.InterfaceIndex -AddressFamily IPv4
if ($result.Forwarding -ne 'Enabled') { throw 'IPv4 forwarding verification failed.' }
Write-Output 'IPv4 forwarding enabled.'
```

If the application fails to enable IPv4 forwarding automatically, open PowerShell as an administrator and run the following commands.

### curl Cannot Reach the Local API

If a system proxy is configured (for example, `127.0.0.1:1080`), it may interfere with requests to local addresses. Explicitly bypass the proxy when debugging:

```bash
curl --noproxy "*" http://127.0.0.1:7400/ping
```

## Known Limitations and Notes

- WireGuard tunnels run as Windows services and are **not automatically removed when the application exits**. The renderer attempts to remove the tunnel through a synchronous XHR request in `beforeunload`, but an abnormal exit may leave the service behind.
- Changing the address, listening port, or private key in `[Interface]` requires reinstalling the tunnel. The connection will be interrupted briefly (approximately 1–3 seconds).
- Changes limited to Peer settings can be applied through `/tunnel/peer` without intentionally disconnecting the tunnel.
- IPv4 only is currently supported.
- The registration service listens on `0.0.0.0` and CORS is unrestricted. Use it only in trusted network environments.
- The legacy Go registration service and GUI in `core/_legacy-go.zip` are deprecated and retained for historical reference only. They are not included in the current build.

## Author

**Kuzuki Azusa**

Repository: [Cirnotsuki/ka-vlan](https://github.com/Cirnotsuki/ka-vlan)
