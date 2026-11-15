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

// —— 找 wireguard.exe：PATH 优先，其次默认安装目录 ——
func wireguardExe() string {
	if p, err := exec.LookPath("wireguard.exe"); err == nil {
		return p
	}
	for _, p := range []string{
		`C:\Program Files\WireGuard\wireguard.exe`,
		`C:\Program Files (x86)\WireGuard\wireguard.exe`,
	} {
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p
		}
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
	exe := wireguardExe()
	if exe == "" {
		return "", fmt.Errorf("找不到 wireguard.exe（PATH 和 Program Files 都没有）")
	}

	dir := tunnelsDir()
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", fmt.Errorf("建隧道目录失败: %v", err)
	}
	p := filepath.Join(dir, name+".conf")
	if err := os.WriteFile(p, []byte(conf), 0600); err != nil {
		return "", fmt.Errorf("写 conf 失败: %v", err)
	}

	// 旧隧道还在跑时 install 会直接失败（Tunnel already installed），先卸干净
	runWG(exe, "/uninstalltunnelservice", name)

	if out, err := runWG(exe, "/installtunnelservice", p); err != nil {
		return "", fmt.Errorf("安装隧道失败: %v %s", err, strings.TrimSpace(out))
	}

	// installtunnelservice 只要把服务注册上就返回 0 —— 配置有问题时服务会立刻退出，
	// 网卡根本不会出现，但调用方看到的是成功。这里必须再确认服务真的 RUNNING。
	if err := waitTunnelRunning(name, 6*time.Second); err != nil {
		runWG(exe, "/uninstalltunnelservice", name) // 别留一个起不来的服务
		return "", fmt.Errorf("%v%s", err, tunnelLogTail(name))
	}

	mu.Lock()
	tunnels[name] = p
	mu.Unlock()
	log.Printf("tunnel up: %s -> %s", name, p)
	return p, nil
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

func firstLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	return lines[0]
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
