// vlancore 只剩两件事：把一份 wg.conf 装成虚拟网卡（隧道服务），以及把它卸掉。
// 监听新成员、成员列表、分配 IP 这些都搬到 Node 侧了，这里不再碰注册协议。
//
// 用法：
//   vlancore                                  起本地 HTTP 服务（127.0.0.1:7400）
//   vlancore up   -name vlan-hub  -conf a.conf  （-conf - 表示从 stdin 读）
//   vlancore down -name vlan-hub
//   vlancore list
//
// HTTP：
//   POST /tunnel/up    {"name":"vlan-hub","conf":"[Interface]..."}
//   POST /tunnel/down  {"name":"vlan-hub"}
//   GET  /tunnel/list  → {"tunnels":[...],"wireguard":"C:\\...\\wireguard.exe"}
//   POST /shutdown     → 退出进程（不碰已装的隧道）
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

const listenAddr = "127.0.0.1:7400"

var nameRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

var (
	mu      sync.Mutex
	tunnels = map[string]string{} // 隧道名 -> conf 绝对路径
	confDir string
)

// —— 找 wireguard.exe ——
// 顺序：应用自带的（<exe目录>\wg）→ PATH → 系统默认安装目录。
// 注意：隧道服务的 ImagePath 会指向实际使用的那个绝对路径，所以安装目录不能随便挪（挪之前先卸隧道）。
// 自带的排在前面，但如果它的服务起不来（例如应用装在含中文/空格的路径下），
// tunnelUp 会自动换下一个候选，不影响使用。
func wireguardCandidates() []string {
	var out []string
	seen := map[string]bool{}
	bundledDir := filepath.Join(exeDir(), "wg")

	add := func(p string) {
		if p == "" {
			return
		}
		// PATH 里可能有相对项（"wireguard.exe"），统一转成绝对路径再用
		if !filepath.IsAbs(p) {
			if abs, err := filepath.Abs(p); err == nil {
				p = abs
			} else {
				return
			}
		}
		key := strings.ToLower(p)
		if seen[key] {
			return
		}
		seen[key] = true
		if !fileExists(p) {
			return
		}
		out = append(out, p)
	}

	add(filepath.Join(bundledDir, "wireguard.exe"))

	if p, err := exec.LookPath("wireguard.exe"); err == nil {
		add(p)
	}

	add(`C:\Program Files\WireGuard\wireguard.exe`)
	add(`C:\Program Files (x86)\WireGuard\wireguard.exe`)

	// 含非 ASCII 字符的路径照样参与：能不能启动由 tunnelUp 实测，起不来再自动换下一个候选。
	// （实测路径含中文时隧道服务会以「拒绝访问」退出，事件日志 7023，但那属于运行时失败，不是这里该预判的）
	for _, p := range out {
		if !isASCII(p) {
			log.Printf("注意：%s 路径含非 ASCII 字符，若隧道服务起不来会自动改用下一个候选", p)
		}
	}

	return out
}

func isASCII(s string) bool {
	for _, r := range s {
		if r > 127 {
			return false
		}
	}
	return true
}

func wireguardExe() string {
	if list := wireguardCandidates(); len(list) > 0 {
		return list[0]
	}
	return ""
}

func tunnelsDir() string {
	if confDir != "" {
		return confDir
	}
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		base = os.TempDir()
	}
	confDir = filepath.Join(base, "vlan", "tunnels")
	return confDir
}

// 装虚拟网卡：写 conf → 先卸旧的（忽略失败）→ installtunnelservice
// WireGuard 的隧道服务名就是 conf 文件名，所以路径必须叫 <name>.conf
func tunnelUp(name, conf string, port int) (string, error) {
	if !nameRe.MatchString(name) {
		return "", fmt.Errorf("隧道名只能包含字母数字下划线短横线: %q", name)
	}
	if strings.TrimSpace(conf) == "" {
		return "", fmt.Errorf("conf 内容为空")
	}
	exes := wireguardCandidates()
	if len(exes) == 0 {
		// 自带的那份因为路径含中文被跳过了：给出能看懂的原因，别报"找不到 wireguard.exe"
		if !isASCII(exeDir()) && fileExists(filepath.Join(exeDir(), "wg", "wireguard.exe")) {
			return "", fmt.Errorf(
				"程序路径含中文/非 ASCII 字符（%s），Windows 隧道服务无法从这里启动 wireguard.exe；请把程序移到纯英文路径，或安装 WireGuard 以使用系统那份",
				exeDir(),
			)
		}
		return "", fmt.Errorf("找不到 wireguard.exe（应用自带目录 wg\\、PATH 和 Program Files 都没有）")
	}

	dir := tunnelsDir()
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", fmt.Errorf("建隧道目录失败: %v", err)
	}
	p := filepath.Join(dir, name+".conf")
	if err := os.WriteFile(p, []byte(conf), 0600); err != nil {
		return "", fmt.Errorf("写 conf 失败: %v", err)
	}

	// 逐个候选尝试：自带的排在前面，但它的服务可能起不来（例如应用装在含中文/空格的路径下，
	// 隧道服务的 ImagePath 指向那里会启动失败）。一个候选失败就卸载干净换下一个。
	var lastErr error

	for i, exe := range exes {
		// 旧隧道还在跑时 install 会直接失败（Tunnel already installed），先卸干净
		runWG(exe, "/uninstalltunnelservice", name)

		out, err := runWG(exe, "/installtunnelservice", p)
		if err != nil {
			lastErr = fmt.Errorf("%s 安装失败: %v %s", exe, err, firstLine(out))
			continue
		}

		// installtunnelservice 只要把服务注册上就返回 0 —— 配置有问题/路径不合适时服务会立刻退出，
		// 网卡根本不会出现，但调用方看到的是成功。这里必须再确认服务真的 RUNNING。
		// 非最后一个候选少等一会儿：失败的常见形态就是立刻停，没必要每条都等满 6 秒。
		wait := 3 * time.Second
		if i == len(exes)-1 {
			wait = 6 * time.Second
		}

		if err := waitTunnelRunning(name, wait); err != nil {
			runWG(exe, "/uninstalltunnelservice", name) // 别留一个起不来的服务
			lastErr = fmt.Errorf("%s: %v%s", filepath.Base(filepath.Dir(exe)), err, tunnelLogTail(name))
			continue
		}

		log.Printf("wireguard.exe = %s", exe)
		mu.Lock()
		tunnels[name] = p
		mu.Unlock()
		log.Printf("tunnel up: %s -> %s", name, p)
		return p, nil
	}

	return "", lastErr
}

// 轮询服务状态，直到 RUNNING / 超时
func waitTunnelRunning(name string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	last := "unknown"

	for {
		state, err := tunnelServiceState(name)
		if err != nil {
			last = err.Error()
		} else {
			last = state
			if state == "RUNNING" {
				return nil
			}
		}

		if time.Now().After(deadline) {
			return fmt.Errorf("隧道服务没有跑起来（状态 %s），常见原因：Address/ListenPort 和已有隧道冲突、PrivateKey 非法、端口被占用", last)
		}
		time.Sleep(250 * time.Millisecond)
	}
}

// sc query WireGuardTunnel$<name> → RUNNING / STOPPED / START_PENDING …
func tunnelServiceState(name string) (string, error) {
	out, err := exec.Command("sc.exe", "query", "WireGuardTunnel$"+name).CombinedOutput()
	text := string(out)
	if err != nil && !strings.Contains(text, "STATE") {
		return "", fmt.Errorf("查不到服务: %s", strings.TrimSpace(firstLine(text)))
	}
	// STATE              : 4  RUNNING
	for _, line := range strings.Split(text, "\n") {
		if !strings.Contains(line, "STATE") {
			continue
		}
		fields := strings.Fields(strings.SplitN(line, ":", 2)[1])
		if len(fields) >= 2 {
			return fields[1], nil
		}
	}
	return "", fmt.Errorf("无法解析服务状态")
}

// 隧道日志：C:\Program Files\WireGuard\Data\Logs\<name>.log，读不到就返回空
func tunnelLogTail(name string) string {
	p := filepath.Join(`C:\Program Files\WireGuard\Data\Logs`, name+".log")
	b, err := os.ReadFile(p)
	if err != nil || len(b) == 0 {
		return ""
	}
	lines := strings.Split(strings.TrimRight(string(b), "\r\n"), "\n")
	if len(lines) > 8 {
		lines = lines[len(lines)-8:]
	}
	return "\n最近日志:\n" + strings.Join(lines, "\n")
}

// PowerShell 的报错第一行才有用，后面全是 CIM 查询细节，日志里留一句就够
func firstLine(s string) string {
	normalized := strings.ReplaceAll(s, "\r", "\n")

	for _, raw := range strings.Split(normalized, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}

		for _, prefix := range []string{"Get-NetIPAddress :", "Set-NetIPInterface :", "Get-NetIPInterface :"} {
			line = strings.TrimSpace(strings.TrimPrefix(line, prefix))
		}

		if i := strings.Index(strings.ToUpper(line), "CIM"); i == 0 {
			continue // 整行都是 CIM 细节，换下一行
		} else if i > 0 {
			line = strings.TrimSpace(line[:i])
		}

		if line != "" {
			return line
		}
	}

	return ""
}

// 关虚拟网卡
func tunnelDown(name string) error {
	if !nameRe.MatchString(name) {
		return fmt.Errorf("隧道名非法: %q", name)
	}
	exe := wireguardExe()
	if exe == "" {
		return fmt.Errorf("找不到 wireguard.exe")
	}

	// 服务本来就不存在：当作成功（幂等）
	if _, err := tunnelServiceState(name); err != nil {
		mu.Lock()
		delete(tunnels, name)
		mu.Unlock()
		return nil
	}

	out, err := runWG(exe, "/uninstalltunnelservice", name)

	mu.Lock()
	delete(tunnels, name)
	mu.Unlock()

	if err != nil && !strings.Contains(strings.ToLower(out), "not installed") &&
		!strings.Contains(strings.ToLower(out), "does not exist") {
		return fmt.Errorf("卸载隧道失败: %v %s", err, strings.TrimSpace(out))
	}
	log.Printf("tunnel down: %s", name)
	return nil
}

func runWG(exe string, args ...string) (string, error) {
	b, err := exec.Command(exe, args...).CombinedOutput()
	return string(b), err
}

func listTunnels() map[string]interface{} {
	mu.Lock()
	defer mu.Unlock()

	items := make([]map[string]string, 0, len(tunnels))
	for k, v := range tunnels {
		items = append(items, map[string]string{"name": k, "conf": v})
	}
	return map[string]interface{}{"tunnels": items, "wireguard": wireguardExe()}
}

// —— HTTP ——
func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

type upReq struct {
	Name string `json:"name"`
	Conf string `json:"conf"`
	Port int    `json:"port"`
}

type downReq struct {
	Name string `json:"name"`
}

type peerReq struct {
	Name string `json:"name"`
	Conf string `json:"conf"`
}

type forwardReq struct {
	IP     string `json:"ip"`
	Enable *bool  `json:"enable"` // 省略 = true
}

// —— IPv4 转发开关 ——
// 必须由核心来做：核心是提权进程，渲染层里 spawn 的 PowerShell 是普通用户，
// Set-NetIPInterface 会直接被拒（Access is denied）。
// 转发是网卡属性，隧道每次重装接口都会重建，所以每次 up 之后都要重新打开。
func setForwarding(ip string, enable bool) error {
	if ip == "" {
		return fmt.Errorf("缺少 ip")
	}

	action := "Enabled"
	if !enable {
		action = "Disabled"
	}

	script := fmt.Sprintf(`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$addr = Get-NetIPAddress -IPAddress '%s' -AddressFamily IPv4 -ErrorAction Stop | Select-Object -First 1
Set-NetIPInterface -InterfaceIndex $addr.InterfaceIndex -AddressFamily IPv4 -Forwarding %s -ErrorAction Stop
$r = Get-NetIPInterface -InterfaceIndex $addr.InterfaceIndex -AddressFamily IPv4
if ($r.Forwarding -ne '%s') { throw 'verify failed: forwarding not %s' }
Write-Output 'ok'
`, ip, action, action, action)

	out, err := exec.Command(
		"powershell.exe",
		"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
		"-Command", script,
	).CombinedOutput()

	text := strings.TrimSpace(string(out))
	if err != nil {
		return fmt.Errorf("设置 %s 转发失败: %v %s", ip, err, firstLine(text))
	}

	log.Printf("forwarding: %s -> %v", ip, enable)
	return nil
}

// —— 热更新 peers：不重装隧道，直接 wg set ——// conf 会照样落盘（下次重装时不会丢成员），运行中的接口用 wg.exe 增量同步：
//   wg set <name> peer <pub> allowed-ips <...> [endpoint <...>] [persistent-keepalive N]
//   不在新 conf 里的旧 peer 用 `peer <pub> remove` 删掉
type wgPeer struct {
	publicKey  string
	allowedIPs string
	endpoint   string
	keepalive  string
}

func parsePeers(conf string) []wgPeer {
	var peers []wgPeer
	inPeer := false

	for _, raw := range strings.Split(conf, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}
		if strings.HasPrefix(line, "[") {
			inPeer = strings.HasPrefix(strings.ToLower(line), "[peer]")
			if inPeer {
				peers = append(peers, wgPeer{})
			}
			continue
		}
		if !inPeer {
			continue
		}
		kv := strings.SplitN(line, "=", 2)
		if len(kv) != 2 {
			continue
		}
		key := strings.ToLower(strings.TrimSpace(kv[0]))
		val := strings.TrimSpace(kv[1])
		cur := &peers[len(peers)-1]
		switch key {
		case "publickey":
			cur.publicKey = val
		case "allowedips":
			cur.allowedIPs = val
		case "endpoint":
			cur.endpoint = val
		case "persistentkeepalive":
			cur.keepalive = val
		}
	}
	return peers
}

func wgExePath() string {
	// 1) 应用自带
	if p := filepath.Join(exeDir(), "wg", "wg.exe"); fileExists(p) {
		return p
	}
	// 2) 跟 wireguard.exe 同目录（自带或系统装的都在同一份安装里）
	if w := wireguardExe(); w != "" {
		cand := filepath.Join(filepath.Dir(w), "wg.exe")
		if fileExists(cand) {
			return cand
		}
	}
	// 3) PATH
	if p, err := exec.LookPath("wg.exe"); err == nil {
		return p
	}
	for _, p := range []string{`C:\Program Files\WireGuard\wg.exe`, `C:\Program Files (x86)\WireGuard\wg.exe`} {
		if fileExists(p) {
			return p
		}
	}
	return ""
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

// exeDir 当前可执行文件所在目录（开发时是 core\，打包后是 resources\core\）
func exeDir() string {
	ex, err := os.Executable()
	if err != nil {
		return "."
	}
	return filepath.Dir(ex)
}

func tunnelSetPeers(name, conf string) (map[string]interface{}, error) {
	if !nameRe.MatchString(name) {
		return nil, fmt.Errorf("隧道名非法: %q", name)
	}

	wg := wgExePath()
	if wg == "" {
		return nil, fmt.Errorf("找不到 wg.exe（应用自带目录 wg\\、PATH 和 Program Files 都没有）")
	}
	log.Printf("wg.exe = %s", wg)

	// 1) conf 落盘：下次 /tunnel/up 重装时成员还在
	dir := tunnelsDir()
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, fmt.Errorf("建隧道目录失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, name+".conf"), []byte(conf), 0600); err != nil {
		return nil, fmt.Errorf("写 conf 失败: %v", err)
	}

	want := parsePeers(conf)
	if len(want) == 0 {
		return nil, fmt.Errorf("conf 里没有 [Peer]")
	}

	// 2) 现有 peer（隧道没装或没跑会失败，直接报给调用方）
	out, err := exec.Command(wg, "show", name, "peers").CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("隧道 %s 不在运行（%v）%s", name, err, strings.TrimSpace(string(out)))
	}

	current := map[string]bool{}
	for _, line := range strings.Split(string(out), "\n") {
		if k := strings.TrimSpace(line); k != "" {
			current[k] = true
		}
	}

	// 3) 逐个 upsert
	wantSet := map[string]bool{}
	for _, p := range want {
		if p.publicKey == "" || p.allowedIPs == "" {
			continue
		}
		wantSet[p.publicKey] = true

		args := []string{"set", name, "peer", p.publicKey, "allowed-ips", p.allowedIPs}
		if p.endpoint != "" {
			args = append(args, "endpoint", p.endpoint)
		}
		if p.keepalive != "" {
			args = append(args, "persistent-keepalive", p.keepalive)
		}
		if o, e := exec.Command(wg, args...).CombinedOutput(); e != nil {
			return nil, fmt.Errorf("wg set 失败: %v %s", e, strings.TrimSpace(string(o)))
		}
	}

	// 4) 删掉已经不在名单里的 peer
	removed := 0
	for pk := range current {
		if wantSet[pk] {
			continue
		}
		if o, e := exec.Command(wg, "set", name, "peer", pk, "remove").CombinedOutput(); e != nil {
			return nil, fmt.Errorf("移除旧 peer 失败: %v %s", e, strings.TrimSpace(string(o)))
		}
		removed++
	}

	log.Printf("tunnel peers: %s 更新 %d 个，移除 %d 个", name, len(wantSet), removed)
	return map[string]interface{}{"peers": len(wantSet), "removed": removed}, nil
}

func serve() {
	mux := http.NewServeMux()

	mux.HandleFunc("/ping", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]string{"pong": "1"})
	})

	mux.HandleFunc("/tunnel/list", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, listTunnels())
	})

	mux.HandleFunc("/tunnel/up", func(w http.ResponseWriter, r *http.Request) {
		var req upReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, 400, map[string]string{"error": "bad_request: " + err.Error()})
			return
		}
		p, err := tunnelUp(req.Name, req.Conf, req.Port)
		if err != nil {
			writeJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]interface{}{"ok": true, "name": req.Name, "conf": p})
	})

	mux.HandleFunc("/tunnel/down", func(w http.ResponseWriter, r *http.Request) {
		var req downReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, 400, map[string]string{"error": "bad_request: " + err.Error()})
			return
		}
		if err := tunnelDown(req.Name); err != nil {
			writeJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]interface{}{"ok": true, "name": req.Name})
	})

	mux.HandleFunc("/tunnel/peer", func(w http.ResponseWriter, r *http.Request) {
		var req peerReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, 400, map[string]string{"error": "bad_request: " + err.Error()})
			return
		}
		stat, err := tunnelSetPeers(req.Name, req.Conf)
		if err != nil {
			writeJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]interface{}{"ok": true, "name": req.Name, "stat": stat})
	})

	mux.HandleFunc("/tunnel/forward", func(w http.ResponseWriter, r *http.Request) {
		var req forwardReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, 400, map[string]string{"error": "bad_request: " + err.Error()})
			return
		}

		enable := true
		if req.Enable != nil {
			enable = *req.Enable
		}

		if err := setForwarding(req.IP, enable); err != nil {
			writeJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]interface{}{"ok": true, "ip": req.IP, "enable": enable})
	})

	mux.HandleFunc("/shutdown", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]string{"ok": "1"})
		go func() {
			// 这里不主动卸隧道：隧道是系统服务，进程退出不该连带断网
			os.Exit(0)
		}()
	})

	log.Printf("vlancore 监听 %s", listenAddr)
	if err := http.ListenAndServe(listenAddr, withCORS(mux)); err != nil {
		log.Printf("HTTP 退出: %v", err)
	}
}

// —— CLI ——
func main() {
	log.SetFlags(0)

	if len(os.Args) < 2 {
		serve()
		return
	}

	switch os.Args[1] {
	case "up":
		name, conf := "", ""
		args := os.Args[2:]
		for i := 0; i < len(args); i++ {
			switch args[i] {
			case "-name":
				if i+1 < len(args) {
					name = args[i+1]
					i++
				}
			case "-conf":
				if i+1 < len(args) {
					conf = args[i+1]
					i++
				}
			}
		}
		if name == "" || conf == "" {
			log.Fatal("用法: vlancore up -name <隧道名> -conf <文件路径|->")
		}
		var data []byte
		var err error
		if conf == "-" {
			data, err = io.ReadAll(os.Stdin)
		} else {
			data, err = os.ReadFile(conf)
		}
		if err != nil {
			log.Fatal(err)
		}
		p, err := tunnelUp(name, string(data), 0)
		if err != nil {
			log.Fatal(err)
		}
		fmt.Println(p)

	case "down":
		name := ""
		args := os.Args[2:]
		for i := 0; i < len(args); i++ {
			if args[i] == "-name" && i+1 < len(args) {
				name = args[i+1]
				i++
			}
		}
		if name == "" {
			log.Fatal("用法: vlancore down -name <隧道名>")
		}
		if err := tunnelDown(name); err != nil {
			log.Fatal(err)
		}
		fmt.Println("ok")

	case "list":
		b, _ := json.MarshalIndent(listTunnels(), "", "  ")
		fmt.Println(string(b))

	default:
		log.Fatalf("未知命令: %s（可用: up / down / list，或直接不带参数起 HTTP）", os.Args[1])
	}
}
