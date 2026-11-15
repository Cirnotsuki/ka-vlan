<template>
    <div id="vlan-page">
        <div id="wrap">
            <!-- 左栏 -->
            <div class="panel" v-if="mode !== 'join'">
                <!-- Join 表单（serve 模式时隐藏） -->
                <div v-if="mode !== 'serve'" class="col grow">
                    <h2>加入服务器</h2>
                    <el-form label-position="top" :disabled="mode === 'joining'">
                        <el-form-item label="昵称（留空 = 匿名）">
                            <el-input v-model="nickName" placeholder="匿名" clearable />
                        </el-form-item>

                        <el-form-item label="网卡名称">
                            <el-input v-model="networkName" placeholder="请输入网卡名称" style="width: 100%" clearable />
                        </el-form-item>

                        <el-form-item label="服务器地址">
                            <div class="ip-octets">
                                <template v-for="i in 4">
                                    <el-input
                                        :key="`ip${i}`"
                                        v-model.trim="ipParts[i - 1]"
                                        maxlength="3"
                                        placeholder="0"
                                        class="ip-octet"
                                        @input="onIpInput(i - 1, $event)"
                                    />
                                    <span v-if="i < 4" :key="`dot${i}`" class="ip-dot">.</span>
                                </template>
                                <span class="ip-dot">端口</span>
                                <el-input v-model="serverPort" placeholder="端口" style="width: 100px" />
                            </div>
                        </el-form-item>
                    </el-form>
                    <el-button type="primary" @click="doJoin" v-if="mode !== 'joining'">加入服务器</el-button>
                </div>

                <!-- Hub 管理列表（serve 模式显示） -->
                <div v-if="mode === 'serve'" class="col grow">
                    <h2>{{ networkName }} · 成员管理（注册服务端口 :{{ serverPort }}）</h2>

                    <div class="scroll">
                        <el-table :data="members" size="small" border stripe height="100%" empty-text="暂无成员" style="width: 100%">
                            <!-- <el-table-column prop="id" label="ID" min-width="65" /> -->
                            <el-table-column prop="name" label="昵称" min-width="120" />

                            <el-table-column prop="vpn_ip" label="内网 IP" min-width="120" />

                            <el-table-column prop="public_key" label="公钥" min-width="140" show-overflow-tooltip />

                            <el-table-column label="操作" width="100" fixed="right">
                                <template slot-scope="scope">
                                    <el-button type="text" style="color: #f56c6c" size="mini" @click="del(scope.row.public_key)">
                                        删除
                                    </el-button>

                                    <el-button type="text" size="mini" class="ban" @click="ban(scope.row.public_key)"> 封禁 </el-button>
                                </template>
                            </el-table-column>
                        </el-table>
                    </div>
                </div>
            </div>

            <!-- 右栏 -->
            <div class="panel">
                <!-- Start Serve 表单 -->
                <div v-if="mode === 'serve' || mode === 'idle'" class="col grow">
                    <h2>开启服务</h2>
                    <!-- <span class="spacer"></span> -->

                    <el-form label-position="top">
                        <el-form-item label="网卡名称">
                            <el-input
                                v-model="networkName"
                                placeholder="请输入网卡名称"
                                style="width: 100%"
                                :disabled="mode === 'serve'"
                                clearable
                            />
                        </el-form-item>
                        <el-form-item label="监听端口号">
                            <el-input
                                v-model="wgPort"
                                placeholder="请输入端口"
                                style="width: 100%"
                                :disabled="mode === 'serve'"
                                clearable
                            />
                        </el-form-item>
                        <el-form-item label="服务端口号">
                            <el-input
                                v-model="serverPort"
                                placeholder="请输入端口"
                                style="width: 100%"
                                :disabled="mode === 'serve'"
                                clearable
                            />
                        </el-form-item>
                    </el-form>

                    <el-button type="success" @click="doStartServe" v-if="mode !== 'serve'">开启服务</el-button>
                    <el-button type="danger" @click="stopServe" v-if="mode === 'serve'">停止服务</el-button>
                    <!-- <el-button type="primary" @click="testJoin" v-if="mode === 'serve'">测试加入</el-button> -->

                    <span class="spacer"></span>
                    <div class="card" v-if="mode === 'serve'">
                        <template v-if="serverState">
                            <div v-for="(html, index) in serverState.split('\n')" :key="index" class="kv">
                                <span v-for="(text, index) in html.split(':')" :key="index">{{ text }}</span>
                            </div>
                        </template>

                        <!-- <div class="kv">
                            <span>信息</span>
                            <span>公网服务器 · 管理所有成员 · 需放行 TCP+UDP 端口</span>
                        </div> -->
                    </div>
                </div>

                <!-- Join 状态面板 -->
                <div v-if="mode === 'joining'" class="col grow">
                    <h2>连接中</h2>

                    <div class="card">
                        <div class="kv">
                            <span>正在加入服务器 {{ ip || "..." }}</span>
                        </div>
                    </div>
                </div>

                <!-- Join 状态面板 -->
                <div v-if="mode === 'join'" class="col grow">
                    <h2>服务器状态</h2>

                    <div class="card">
                        <div class="kv">
                            <span>服务器</span>
                            <span>{{ ip }}:{{ wgPort }}</span>
                        </div>

                        <div class="kv">
                            <span>服务器公钥</span>
                            <span>{{ serveKey || "-" }}</span>
                        </div>

                        <div class="kv">
                            <span></span>
                        </div>

                        <div class="kv">
                            <span>我的内网 IP</span>
                            <span>{{ vpnIp || "-" }}</span>
                        </div>

                        <div class="kv">
                            <span>我的公钥</span>
                            <span>{{ selfPublicKey || "-" }}</span>
                        </div>

                        <div class="kv">
                            <span></span>
                        </div>

                        <div class="kv">
                            <span>成员数</span>
                            <span>{{ memberCount || "-" }}</span>
                        </div>

                        <div class="kv">
                            <span>延迟</span>
                            <span :class="portOK ? 'ok' : 'bad'">
                                {{ portOK ? latencyMs + " ms" : "无法连接" }}
                            </span>
                        </div>

                        <div class="kv">
                            <span>端口状态</span>
                            <span :class="portOK ? 'ok' : 'bad'">
                                {{ portOK ? "畅通" : "禁用" }}
                            </span>
                        </div>
                    </div>

                    <el-button type="danger" @click="doDisconnect"> 断开 </el-button>
                </div>

                <!-- <span class="spacer"></span> -->
                <!-- <span class="muted">{{ mode }}</span>
                <span class="muted">{{ statusLine }}</span> -->
            </div>
        </div>
    </div>
</template>

<script>
import './home.css';
import Server from '../utils/server';
import { generateKeyPair, getMachineGuid } from '../utils/helper';
// 对应 ui/index.html 的 Vue 页面版：
// 状态全部走 vlancore 的 127.0.0.1:7400 HTTP API
import {
    DEFAULT_WG_PORT, DEFAULT_SERVER_PORT, SERVER_VPN_IP, NETWORK_NAME,
} from '../constants';

// 虚拟网卡（WireGuard 隧道服务）名字：只在这个页面定义。
// conf 文件名就是它，系统服务名是 WireGuardTunnel$<这个值>，改动时服务端/客户端要一致。

// 「测试加入」用的客户端网卡名：只在测试时存在，关窗会跟主网卡一起卸掉
const TEST_TUNNEL_NAME = 'vlan-test';
export default {
    name: 'vlan-page',
    data() {
        return {
            mode: 'idle',

            nickName: '',
            // 服务器 IP 拆成 4 段，最后用点拼起来（见 computed.ip）
            ipParts: ['', '', '', ''],
            vpnIp: SERVER_VPN_IP,
            serveKey: '',
            serverPort: `${DEFAULT_SERVER_PORT}`,
            wgPort: `${DEFAULT_WG_PORT}`,
            networkName: NETWORK_NAME,
            members: [],

            memberCount: 0,
            portOK: false,
            latencyMs: 0,

            selfPublicKey: '',
            selfPrivateKey: '',

            st: {},
            joinErr: '',
            statusMsg: '',
            serverState: '',
            machineGuid: '',

            timer: null,
            // Node 侧的注册服务实例（成员表在 sqlite），tunnel 起停都围绕它
            serverInst: null,
            // 当前虚拟网卡是否已装（关窗兜底只看这个）
            tunnelUp: false,
            // 核心（vlancore:7400）连通性，pollState 每 2 秒刷一次
            coreOnline: false,
            // 测试用的客户端网卡是否已装
            testTunnelUp: false,

        };
    },
    computed: {
        statusLine() {
            if (this.joinErr) return `${this.statusMsg || ''}：${this.joinErr}`;
            return this.statusMsg || this.mode || '选择角色';
        },
        // 四段用点连起来，doJoin / 显示都直接用这个
        ip() {
            return this.ipParts.map((p) => String(p || '').trim()).join('.');
        },
        ipValid() {
            return (
                this.ipParts.length === 4
                && this.ipParts.every((p) => {
                    const v = String(p || '').trim();
                    return /^\d{1,3}$/.test(v) && Number(v) <= 255;
                })
            );
        },
    },
    mounted() {
        this.pollState();
        this.init();
        this.timer = setInterval(() => this.pollState(), 2000);
        // 关窗/刷新的兜底：页面卸载前把虚拟网卡卸掉
        window.addEventListener('beforeunload', this.onWindowClose);
    },
    beforeDestroy() {
        clearInterval(this.timer);
        window.removeEventListener('beforeunload', this.onWindowClose);
    },
    methods: {
        async init() {
            await this.$db.init();
            const info = await Server.getInfo(this.$db, this.networkName, SERVER_VPN_IP, '');
            this.machineGuid = (await getMachineGuid() || '').replace(/-/g, '');

            this.nickName = info.name || '';
            this.vpnIp = info.vpn_ip || SERVER_VPN_IP;
            const [ip = '', port = ''] = (info.ip || '').split(':');

            this.ipParts = ip.split('.').map((p) => String(p || '').trim());
            this.serverPort = port || DEFAULT_SERVER_PORT;
            this.selfPublicKey = info.public_key || '';
            this.selfPrivateKey = info.private_key || '';
        },

        translateErr(message) {
            if (message.includes('Failed to fetch')) {
                return '无法连接到服务器，请检查网络或服务器状态。';
            }
            if (message.includes('NetworkError when attempting to fetch resource.')) {
                return '网络错误，无法获取资源，请检查网络连接。';
            }
            if (message.includes('Unexpected token')) {
                return '服务器返回了无效的响应，请检查服务器状态。';
            }
            return message; // 返回原始错误信息
        },

        // 关闭窗口（或刷新）时执行：必须把虚拟网卡卸掉，
        // 否则系统里会留一个 WireGuardTunnel$<networkName> 服务占着端口，下次启动会撞上
        onWindowClose() {
            if (!this.tunnelUp && !this.testTunnelUp) return;

            // 1) 正常路径：走 stopTunnel。它是异步 fetch，页面卸载时可能被丢弃，所以下面还有兜底
            try {
                this.stopTunnel.call(this, this.networkName).catch(() => {});
            } catch (e) {
                /* 卸载路径不能抛 */
            }

            // 2) 同步 XHR 兜底：浏览器会等它返回再关页面，保证核心真的收到 /tunnel/down
            try {
                const xhr = new XMLHttpRequest();
                xhr.open('POST', `${this.$api}/tunnel/down`, false);
                xhr.setRequestHeader('Content-Type', 'application/json');
                if (this.tunnelUp) {
                    xhr.send(JSON.stringify({ name: this.networkName }));
                    this.tunnelUp = false;
                }
                // 测试用的客户端网卡一起收掉，不然下次点「测试加入」会撞到已存在的隧道
                if (this.testTunnelUp) {
                    xhr.send(JSON.stringify({ name: TEST_TUNNEL_NAME }));
                    this.testTunnelUp = false;
                }
            } catch (e) {
                /* 关窗路径不弹窗 */
            }
        },
        async post(path, body) {
            const res = await fetch(this.$api + path, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body || {}),
            });

            if (res.ok) {
                return res.json();
            }
            throw new Error('无法连接到服务器，请检查网络或服务器状态。');
        },

        // hub 的 wg.conf：私钥用 sqlite 里 id=0 那行（server.js 的 _ensureSelf 已经准备好了）
        async buildServerConf() {
            await this.serverInst.ready;
            const self = (this.serverInst && this.serverInst.self) || {};
            if (!self.private_key) throw new Error('服务器密钥还没生成');

            const peers = (await this.serverInst.members()).map(u => `
[Peer]
PublicKey = ${u.public_key}
AllowedIPs = ${u.vpn_ip}/32
            `);

            return `
[Interface]
PrivateKey = ${self.private_key}
ListenPort = ${this.wgPort}
Address = ${SERVER_VPN_IP}/24
MTU = 1280
PostUp = iptables -A FORWARD -o wg0 -j ACCEPT
PostDown = iptables -D FORWARD -o wg0 -j ACCEPT

${peers}`;
        },

        async buildClientConf(publicKey, vpnIp = SERVER_VPN_IP, endPoint = `${this.ip}:${this.wgPort}`) {
            const info = await Server.getInfo(this.$db, this.networkName, SERVER_VPN_IP, '');
            if (!info.public_key) throw new Error('服务器公钥还没生成');
            const vpnIps = vpnIp.replace(/\d+$/, '');
            return `
[Interface]
PrivateKey = ${info.private_key}
Address = ${vpnIp}/24
MTU = 1280

[Peer]
PublicKey = ${publicKey}
AllowedIPs = ${vpnIps}0/24
Endpoint = ${endPoint}
PersistentKeepalive = 25
            `;
        },

        // 每段只留数字；超过 255 压回。跳转交给 Tab / 鼠标，不在这里碰 DOM
        onIpInput(index, value) {
            const raw = String(value === undefined || value === null ? this.ipParts[index] || '' : value);
            let digits = raw.replace(/[^\d]/g, '');

            if (digits.length > 3) digits = digits.slice(0, 3);
            if (digits !== '' && Number(digits) > 255) digits = String(Number(digits.slice(0, 2)) || 0);

            if (digits !== raw) this.$set(this.ipParts, index, digits);
        },

        async doStartServe() {
            const serverPort = parseInt(this.serverPort, 10) || DEFAULT_WG_PORT;
            try {
                // 1) Node 侧先把注册服务立起来（成员表落在 sqlite）
                if (!this.serverInst) {
                    this.serverInst = new Server(this.$db, serverPort);
                    await this.serverInst.ready;
                }

                // 2) 再装虚拟网卡
                await this.startTunnel(this.networkName, await this.buildServerConf());
                this.tunnelUp = true;
                this.serveKey = (this.serverInst.self && this.serverInst.self.public_key) || '';
                this.mode = 'serve';

                this.serverState = this.serverInst.state || '注册服务已就绪';
            } catch (e) {
                this.$message.error(this.translateErr(e.message));
            }
            this.pollState();
        },

        async doJoin() {
            if (!this.ipValid) {
                this.$message.warning('请填写完整的服务器 IP（四段都要 0-255）');
                return;
            }
            this.mode = 'joining';

            const serverPort = parseInt(this.serverPort, 10) || 1212;
            try {
                const info = await Server.updateInfo(this.$db, this.nickName || '', this.vpnIp, `${this.ip}:${serverPort}`);
                // const res = await this.post('/api/join', {
                //     nickName: this.nickName, publicKey: info.public_key, guid: this.machineGuid,
                // });
                // await Server.updateInfo(this.$db, this.nickName || '', res.server, `${this.ip}:${serverPort}`);
                // this.wgPort = res.port;
                const conf = await this.buildClientConf('pk', '10.100.0.2', `${this.ip}:${this.wgPort}`);
                console.log(conf);

                await this.startTunnel(this.networkName, conf);
                this.tunnelUp = true;

                // if (res.error) {
                //     this.$message.error(res.error);
                //     this.mode = 'idle';
                //     return;
                // }
                this.mode = 'join';
            } catch (e) {
                this.$message.error(`核心未就绪：${this.translateErr(e.message)}`);
                this.mode = 'idle';
                console.error(e);
            }
            this.pollState();
        },

        async doDisconnect() {
            try {
                // 先卸虚拟网卡（这一步要管理员权限），再关 Node 的注册服务
                await this.stopTunnel(this.networkName);
                this.tunnelUp = false;
            } catch (e) {
                this.$message.error(this.translateErr(e.message));
            }
            this.mode = 'idle';

            this.pollState();
        },
        async stopServe() {
            try {
                await this.$confirm('停止服务并关闭端口？', '确认', { type: 'warning' });
            } catch (e) {
                return; // 用户取消
            }

            try {
                // 先卸虚拟网卡（这一步要管理员权限），再关 Node 的注册服务
                await this.stopTunnel(this.networkName);
                this.tunnelUp = false;
            } catch (e) {
                this.$message.error(this.translateErr(e.message));
            }

            if (this.serverInst) {
                await this.serverInst.stop().catch(() => {});
                this.serverInst = null;
            }

            this.mode = 'idle';
            this.statusMsg = '';
            this.members = [];
            this.pollState();
        },

        // —— 虚拟网卡：起/停都委托给 vlancore（127.0.0.1:7400）——
        // 它只认两件事：给一段 wg.conf 就 /installtunnelservice，给个名字就 /uninstalltunnelservice。
        async startTunnel(name, conf) {
            const res = await fetch(`${this.$api}/tunnel/up`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, conf }),
            });
            const result = await res.json();
            if (!res.ok || result.error) {
                throw new Error(result.error || `启动隧道失败（HTTP ${res.status}）`);
            }
            return result;
        },

        async stopTunnel(name) {
            const res = await fetch(`${this.$api}/tunnel/down`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name }),
            });
            const result = await res.json();
            if (!res.ok || result.error) {
                throw new Error(result.error || `关闭隧道失败（HTTP ${res.status}）`);
            }
            return result;
        },

        async ban(pk) {
            await this.post('/api/ban', { publicKey: pk }).catch(() => {});
            this.pollState();
        },
        async del(pk) {
            await this.post('/api/delete', { publicKey: pk }).catch(() => {});
            this.pollState();
        },

        // 只测连通性：/ping 有响应 = 核心在线；成员表顺带从 serverInst 刷（没有就保持不动）
        async pollState() {
            this.coreOnline = await this.pingCore();

            if (!this.coreOnline) {
                this.st = {};
                this.members = [];
                this.statusMsg = '核心未连接（界面可用）';
                this.joinErr = '';
                return;
            }

            if (this.serverInst) {
                try {
                    const s = await this.serverInst.getState();
                    this.st = s;
                    this.members = s.members || [];
                    this.statusMsg = s.statusMsg || '核心就绪';
                    return;
                } catch (e) {
                    // 注册服务自身出错也不能把核心判成离线
                }
            }

            if (!this.statusMsg) this.statusMsg = '核心就绪';
        },

        // 1.5 秒没响应就当离线，免得 2 秒一轮的轮询互相叠住
        async pingCore() {
            const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
            const timer = ctrl ? setTimeout(() => ctrl.abort(), 1500) : null;

            try {
                const res = await fetch(`${this.$api}/ping`, {
                    cache: 'no-store',
                    signal: ctrl ? ctrl.signal : undefined,
                });
                return res.ok;
            } catch (e) {
                return false;
            } finally {
                if (timer) clearTimeout(timer);
            }
        },
    },
};
</script>

<style scoped>
/* 四个 IP 段：均分可用宽度，点夹在中间，整体与右侧端口框同高 */
.ip-octets {
    display: flex;
    align-items: center;
    background-color: #f5f7fa;
    border: 1px solid #dcdfe6;
    border-radius: 4px;
}
.ip-octets .ip-octet {
    flex: 1 1 0;
    min-width: 0;
}
.ip-octets .ip-dot {
    flex: none;
    font-weight: 600;
    user-select: none;
    background-color: #f5f7fa;
    color: #909399;
    vertical-align: middle;
    display: table-cell;
    position: relative;
    padding: 0 6px;
    white-space: nowrap;
}
.ip-octets ::v-deep .el-input__inner {
    text-align: center;
    padding: 0 2px;
    font-variant-numeric: tabular-nums;
    letter-spacing: 1px;
}
</style>
