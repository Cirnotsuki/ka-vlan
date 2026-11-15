<template>
    <div id="vlan-page">
        <div id="wrap">
            <!-- 左栏 -->
            <div class="panel" v-if="mode !== 'join'">
                <!-- Join 表单（serve 模式时隐藏） -->
                <div v-if="mode === 'idle' || mode === 'joining'" class="col grow">
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
                    <el-button type="primary" @click="doJoin" :disabled="mode === 'joining'">加入服务器</el-button>
                </div>

                <!-- Join 状态面板 -->
                <div v-if="mode === 'starting'" class="col grow">
                    <h2>连接中</h2>

                    <div class="card">
                        <div class="kv">
                            <span>正在启动服务器, 监听端口: {{ wgPort }}</span>
                        </div>
                    </div>
                </div>

                <!-- Hub 管理列表（serve 模式显示） -->
                <div v-if="mode === 'serve'" class="col grow">
                    <h2>{{ networkName }} · 成员管理（注册服务端口 :{{ serverPort }}）</h2>

                    <div class="scroll">
                        <el-table :data="members" size="small" border stripe height="100%" empty-text="暂无成员" style="width: 100%">
                            <el-table-column prop="id" label="ID" min-width="30" />
                            <el-table-column label="昵称" min-width="120">
                                <template slot-scope="scope">
                                    <el-popover trigger="hover" placement="top">
                                        <el-descriptions class="margin-top" :column="1" size="small " border>
                                            <el-descriptions-item>
                                                <template slot="label"> 公钥: </template>
                                                <span> {{ scope.row.public_key }}</span>
                                            </el-descriptions-item>
                                            <el-descriptions-item>
                                                <template slot="label"> IP: </template>
                                                <span> {{ scope.row.ip }}</span>
                                            </el-descriptions-item>
                                            <el-descriptions-item>
                                                <template slot="label"> 上次握手时间: </template>
                                                <span> {{ scope.row.lastConnect ? new Date() : "-" }}</span>
                                            </el-descriptions-item>
                                        </el-descriptions>
                                        <div slot="reference" class="name-wrapper">
                                            <el-tag
                                                style="width: 100%"
                                                :type="scope.row.status === 0 ? 'danger' : scope.row.online ? 'success' : 'info'"
                                                >{{ scope.row.name }}</el-tag
                                            >
                                        </div>
                                    </el-popover>
                                </template>
                            </el-table-column>

                            <el-table-column prop="vpn_ip" label="内网 IP" min-width="120">
                                <template slot-scope="scope">
                                    <el-input
                                        v-model="scope.row.vpn_ip"
                                        placeholder="端口"
                                        style="width: 100%"
                                        @change="updateVpnIp(scope.row)"
                                    />
                                </template>
                            </el-table-column>

                            <el-table-column label="操作" width="160" fixed="right">
                                <template slot-scope="scope">
                                    <el-button type="success" size="mini" @click="resume(scope.row)" v-if="scope.row.status === 0"
                                        >恢复</el-button
                                    >
                                    <el-button type="warning" size="mini" @click="ban(scope.row)" v-if="scope.row.status === 1"
                                        >封禁</el-button
                                    >
                                    <el-button type="danger" size="mini" @click="remove(scope.row)">删除</el-button>
                                </template>
                            </el-table-column>
                        </el-table>
                    </div>
                </div>
            </div>

            <!-- 右栏 -->
            <div class="panel">
                <!-- Start Serve 表单 -->
                <div v-if="mode === 'serve' || mode === 'starting' || mode === 'idle'" class="col grow">
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
                        <el-form-item label="注册端口号">
                            <el-input
                                v-model="serverPort"
                                placeholder="请输入端口"
                                style="width: 100%"
                                :disabled="mode === 'serve'"
                                clearable
                            />
                        </el-form-item>
                    </el-form>

                    <el-button type="success" @click="doStartServe" v-if="mode !== 'serve'" :disabled="mode !== 'idle'">开启服务</el-button>
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
                            <span>{{ serverKey || "-" }}</span>
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
                            <el-descriptions class="margin-top" :column="3" size="mini" style="width: 100%;" border>
                                <template v-for="(user, index) in peers">
                                    <el-descriptions-item :key="'name-' + index">
                                        <template slot="label">昵称</template>
                                        <span> {{ user.name }}</span>
                                    </el-descriptions-item>
                                    <el-descriptions-item :key="'last-' + index">
                                        <template slot="label"> 上次握手时间</template>
                                        <span>
                                            {{
                                                user.lastConnect ? formatDate(new Date(user.lastConnect), "yyyy年MM月dd日 HH:mm:ss") : "-"
                                            }}</span
                                        >
                                    </el-descriptions-item>
                                    <el-descriptions-item :key="'online-' + index">
                                        <template slot="label">在线</template>
                                        <el-tag :type="user.online ? 'success' : 'danger'">{{ user.online ? "是" : "否" }}</el-tag>
                                    </el-descriptions-item>
                                </template>
                            </el-descriptions>
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
import './home.less';
import Server from '../utils/server';
import { getMachineGuid, formatDate } from '../utils/helper';
// 对应 ui/index.html 的 Vue 页面版：
// 状态全部走 vlancore 的 127.0.0.1:7400 HTTP API
import {
    DEFAULT_WG_PORT, DEFAULT_SERVER_PORT, SERVER_VPN_IP, NETWORK_NAME, LOCAL_NAME,
} from '../constants';

// 轮询在主进程里跑，这里只通过 ipc 起停 + 收结果（nodeIntegration 开着，可直接 require）
const { ipcRenderer } = require('electron');

// const res = {
//     vpnIp: '',
//     wgPort: '',
//     serverKey: '',
//     peers: [
//         {
//             id: 0,
//             name: '匿名',
//             lastConnect: 0,
//             online: false,
//         },
//     ],
// };
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
            serverKey: '',
            serverPort: `${DEFAULT_SERVER_PORT}`,
            wgPort: `${DEFAULT_WG_PORT}`,
            networkName: NETWORK_NAME,
            members: [],

            memberCount: 0,
            // 加入服务器后的节点状态（主进程轮询 /api/state 推送）
            peers: [],

            portOK: false,
            latencyMs: 0,

            selfPublicKey: '',
            selfPrivateKey: '',

            joinErr: '',
            statusMsg: '',
            serverState: '',
            machineGuid: '',

            timer: null,
            // Node 侧的注册服务实例（成员表在 sqlite），tunnel 起停都围绕它
            serverInst: null,
            // 当前虚拟网卡是否已装（关窗兜底只看这个）
            tunnelUp: false,
            // 核心（vlancore:7400）连通性，由主进程轮询后推送
            coreOnline: false,
            // 测试用的客户端网卡是否已装
            testTunnelUp: false,
            // 上次灌进 WireGuard 的服务端 conf，用来判断 peers 有没有真的变（没变就不重装隧道）
            lastTunnelConf: '',
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
        this.init();
        this.pollState();

        // 轮询全部搬去主进程：这里只挂接收器，主进程用 webContents.send 推结果回来
        ipcRenderer.on('poll:core', this.onCoreStatus);
        ipcRenderer.on('poll:state', this.onNodeState);
        ipcRenderer.send('poll:core:start', { url: this.$api, intervalMs: 2000 });

        // 关窗/刷新的兜底：页面卸载前把虚拟网卡卸掉
        window.addEventListener('beforeunload', this.onWindowClose);
    },
    beforeDestroy() {
        ipcRenderer.removeListener('poll:core', this.onCoreStatus);
        ipcRenderer.removeListener('poll:state', this.onNodeState);
        ipcRenderer.send('poll:core:stop');
        ipcRenderer.send('poll:state:stop');

        window.removeEventListener('beforeunload', this.onWindowClose);
    },
    methods: {
        async init() {
            await this.$db.init();
            const info = await Server.getLocalInfo(this.$db, LOCAL_NAME, SERVER_VPN_IP, '');
            this.machineGuid = ((await getMachineGuid()) || '').replace(/-/g, '');

            this.nickName = info.name || '';
            this.vpnIp = info.vpn_ip || SERVER_VPN_IP;
            const [ip = '', port = ''] = (info.ip || '').split(':');

            this.ipParts = ip.split('.').map((p) => String(p || '').trim());
            this.serverPort = port || DEFAULT_SERVER_PORT;
            this.selfPublicKey = info.public_key || '';
            this.selfPrivateKey = info.private_key || '';
        },

        formatDate,

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
        // base 省略时打本机核心（7400）；访问远端服务器要显式传 base
        async post(path, body, base) {
            const res = await fetch((base || this.$api) + path, {
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

            let conf = `
[Interface]
PrivateKey = ${self.private_key}
ListenPort = ${this.wgPort}
Address = ${SERVER_VPN_IP}/24
MTU = 1280
PostUp = iptables -A FORWARD -o wg0 -j ACCEPT
PostDown = iptables -D FORWARD -o wg0 -j ACCEPT`;

            // 注意 .join('')：直接 conf += 数组 会走 Array.toString()，每个 [Peer] 之间插一个逗号，
            // WireGuard 解析到只有 "," 的行就报错，隧道服务注册成功后立刻退出（状态 STOPPED）
            conf += (await this.serverInst.members())
                .map(
                    (u) => `

[Peer]
PublicKey = ${u.public_key}
AllowedIPs = ${u.vpn_ip}/32`,
                )
                .join('\n');

            console.log(conf);
            return conf;
        },
        async buildClientConf() {
            const info = await Server.getLocalInfo(this.$db, this.networkName, SERVER_VPN_IP, '');
            if (!info.private_key) throw new Error('客户端密钥对还没生成');
            if (!this.serverKey) throw new Error('服务端未开启，无法连接');

            const vpnIps = this.vpnIp.replace(/\d+$/, '');
            const conf = `
[Interface]
PrivateKey = ${info.private_key}
Address = ${this.vpnIp}/24
MTU = 1280

[Peer]
PublicKey = ${this.serverKey}
AllowedIPs = ${vpnIps}0/24
Endpoint = ${this.ip}:${this.wgPort}
PersistentKeepalive = 25`;

            console.log(conf);
            return conf;
        },

        // 每段只留数字；超过 255 压回。跳转交给 Tab / 鼠标，不在这里碰 DOM
        onIpInput(index, value) {
            const raw = String(value === undefined || value === null ? this.ipParts[index] || '' : value);
            let digits = raw.replace(/[^\d]/g, '');

            if (digits.length > 3) digits = digits.slice(0, 3);
            if (digits !== '' && Number(digits) > 255) digits = String(Number(digits.slice(0, 2)) || 0);

            if (digits !== raw) this.$set(this.ipParts, index, digits);
        },

        // 主进程推来的核心连通性（原 pollState 里的 pingCore）
        onCoreStatus(payload) {
            const online = !!(payload && payload.online);
            this.coreOnline = online;

            if (!online) {
                this.statusMsg = '核心未连接（界面可用）';
                this.joinErr = '';
            } else if (this.statusMsg === '核心未连接（界面可用）') {
                this.statusMsg = this.serverInst ? '核心就绪' : '';
            }
        },

        // 主进程推来的节点状态（加入服务器后按 4 秒 / 长轮询拉 /api/state）
        async onNodeState(payload) {
            if (!payload) return;

            if (!payload.ok) {
                this.joinErr = payload.error || '获取节点状态失败';
                return;
            }

            if (payload.empty) return; // 长轮询心跳，没有变化

            try {
                const stat = payload.data || {};
                const startAt = +payload.startAt;
                const at = +payload.at;

                this.joinErr = stat.joinErr || '';
                if (stat.wgPort) this.wgPort = stat.wgPort;
                if (stat.vpnIp) this.vpnIp = stat.vpnIp;
                if (stat.serverKey) this.serverKey = stat.serverKey;
                if (Array.isArray(stat.peers)) {
                    this.memberCount = stat.peers.length; // peers 包含自己的
                    this.peers = stat.peers;
                }
                if (Number.isFinite(startAt) && Number.isFinite(at)) this.latencyMs = at - startAt;

                const conf = await this.buildClientConf();
                if (conf !== this.lastTunnelConf) {
                    await this.hotUpdateServerPeers(conf);
                }
            } catch (e) {
                // 这里抛出去会变成 unhandledrejection（IPC 回调没人 await）
                this.joinErr = this.translateErr(e.message);
            }
        },
        async refreshMenbers() {
            if (!this.serverInst) return;
            await this.serverInst.ready;

            this.members = await this.serverInst.users();

            const conf = await this.buildServerConf();
            if (conf !== this.lastTunnelConf) {
                await this.hotUpdateServerPeers(conf);
            }
        },

        async onConnect() {
            await this.refreshMenbers();
        },

        // 独立的热更新：不重装隧道，把 conf 里的 [Peer] 增量同步进运行中的接口。
        // 服务端传 buildServerConf 的结果，客户端传 buildClientConf 的结果；不传就按当前模式算。
        async hotUpdateServerPeers(conf) {
            if (!this.tunnelUp) return { peers: 0, removed: 0 };

            const res = await fetch(`${this.$api}/tunnel/peer`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: this.networkName, conf }),
            });
            const result = await res.json();
            if (!res.ok || result.error) {
                throw new Error(result.error || `peer 热更新失败（HTTP ${res.status}）`);
            }

            this.lastTunnelConf = conf;
            return result.stat || { peers: 0, removed: 0 };
        },

        async doStartServe() {
            const serverPort = parseInt(this.serverPort, 10) || DEFAULT_WG_PORT;
            try {
                this.mode = 'starting';
                // 1) Node 侧先把注册服务立起来（成员表落在 sqlite）
                if (!this.serverInst) {
                    this.serverInst = new Server(this.$db, serverPort);
                    await this.serverInst.ready;
                }

                // 2) 再装虚拟网卡
                const conf = await this.buildServerConf();
                await this.startTunnel(this.networkName, conf);
                this.tunnelUp = true;
                this.serverKey = (this.serverInst.self && this.serverInst.self.public_key) || '';
                this.serverInst.onConnect = this.onConnect;
                await this.refreshMenbers();

                this.mode = 'serve';

                this.serverState = this.serverInst.state || '注册服务已就绪';
            } catch (e) {
                this.mode = 'idle';
                this.$message.error(this.translateErr(e.message));
            }
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

            ipcRenderer.send('poll:state:stop');
            this.mode = 'idle';
            this.statusMsg = '';
            this.members = [];
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
                const info = await Server.updateLocalInfo(this.$db, this.nickName || '', this.vpnIp, `${this.ip}:${serverPort}`);
                // 注意 base：/api/join 在远端服务器上，不是本机 7400 核心
                const res = await this.post('/api/join', {
                    nickName: this.nickName,
                    publicKey: info.public_key,
                    guid: this.machineGuid,
                }, `http://${this.ip}:${serverPort}`);

                this.vpnIp = res.vpnIp;
                this.serverKey = res.serverKey;
                this.wgPort = res.wgPort;
                this.memberCount = res.peers.length;
                this.peers = res.peers;

                // this.serverKey = info.public_key;
                // this.peers = await Server.testPeer(this.$db);

                await Server.updateLocalInfo(this.$db, this.nickName || '', this.vpnIp, `${this.ip}:${serverPort}`);

                const conf = await this.buildClientConf();
                await this.startTunnel(this.networkName, conf);
                this.tunnelUp = true;

                if (res.error) {
                    this.$message.error(res.error);
                    this.mode = 'idle';
                    return;
                }
                this.mode = 'join';

                // 加入成功：把真实的 /api/state 地址交给主进程去轮询（4 秒一轮，长轮询）
                // 带上 publicKey：服务端要按它算"我是谁"、返回我的 vpn_ip
                ipcRenderer.send('poll:state:start', {
                    url: `http://${this.ip}:${serverPort}/api/state?publicKey=${encodeURIComponent(info.public_key)}`,
                    intervalMs: 4000,
                    longPoll: true,
                });
            } catch (e) {
                this.$message.error(this.translateErr(e.message));
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

            // 走人了就别再轮询那台服务器的状态
            ipcRenderer.send('poll:state:stop');
            this.peers = [];
            this.memberCount = null;
            this.mode = 'idle';

            this.pollState();
        },

        // —— 虚拟网卡：起/停都委托给 vlancore（127.0.0.1:7400）——
        // 它只认两件事：给一段 wg.conf 就 /installtunnelservice，给个名字就 /uninstalltunnelservice。
        // 装之前先自检：WireGuard 配置写错时只会表现为"服务没跑起来"，错误信息一点用都没有
        assertConf(conf) {
            const text = String(conf || '');

            if (!/^\s*\[Interface\]/m.test(text)) throw new Error('conf 缺少 [Interface] 段');
            if (!/^\s*PrivateKey\s*=\s*\S+/m.test(text)) throw new Error('conf 缺少 PrivateKey（或为空）');

            const blocks = text.split(/\[Peer\]/i).slice(1);
            blocks.forEach((block, i) => {
                const pk = (block.match(/^\s*PublicKey\s*=\s*(\S*)\s*$/im) || [])[1];
                if (!pk) throw new Error(`第 ${i + 1} 个 [Peer] 的 PublicKey 为空`);

                const ep = (block.match(/^\s*Endpoint\s*=\s*(.+)$/im) || [])[1];
                if (ep && !/^[^\s:]+:\d+$/.test(ep.trim())) {
                    throw new Error(`第 ${i + 1} 个 [Peer] 的 Endpoint 格式不对：${ep.trim()}（应为 host:port，不能有空格）`);
                }
            });
        },

        async startTunnel(name, conf) {
            this.assertConf(conf);

            const res = await fetch(`${this.$api}/tunnel/up`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, conf }),
            });
            const result = await res.json();
            if (!res.ok || result.error) {
                throw new Error(result.error || `启动隧道失败（HTTP ${res.status}）`);
            }

            this.lastTunnelConf = conf;
            return result;
        },

        async stopTunnel(name) {
            this.lastTunnelConf = '';

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

        async updateVpnIp(row) {
            if (!this.serverInst) return;
            await this.serverInst.ready;

            try {
                await this.serverInst.updateUserVpnIp(row.vpn_ip, row.id);
                await this.refreshMenbers();
            } catch (e) {
                this.$message.error(this.translateErr(e.message));
            }
            this.pollState();
        },

        async resume(row) {
            if (!this.serverInst) return;
            await this.serverInst.ready;

            try {
                await this.serverInst.resume(row.public_key);
                await this.refreshMenbers();
            } catch (e) {
                this.$message.error(this.translateErr(e.message));
            }
            this.pollState();
        },

        async ban(row) {
            if (!this.serverInst) return;
            await this.serverInst.ready;

            try {
                await this.serverInst.ban(row.public_key);
                await this.refreshMenbers();
            } catch (e) {
                this.$message.error(this.translateErr(e.message));
            }
            this.pollState();
        },
        async remove(row) {
            if (!this.serverInst) return;
            await this.serverInst.ready;

            try {
                await this.$confirm(`删除用户: ${row.name}(${row.vpn_ip})？`, '确认', { type: 'warning' });
            } catch (e) {
                return; // 用户取消
            }

            try {
                await this.serverInst.remove(row.public_key);
                await this.refreshMenbers();
            } catch (e) {
                this.$message.error(this.translateErr(e.message));
            }
            this.pollState();
        },

        // 本地刷一次（Serve 模式下成员表在 serverInst 里，不走 HTTP）
        async pollState() {
            if (!this.serverInst) return;

            try {
                const stat = await this.serverInst.getState();
                this.members = stat.members || [];
                this.statusMsg = stat.statusMsg || '核心就绪';
            } catch (e) {
                // 注册服务自身出错不影响核心判定
            }
        },
    },
};
</script>
