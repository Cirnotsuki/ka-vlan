// VLAN 注册服务（纯 Node http 版，替代原来的 Go vlancore）
//
// 点 Start Server → new Server(db, port)：起 http 监听，并确保 users 表里有服务器自身那行（id=0，含 X25519 密钥）
// 客户端 Join → POST /api/join：注册/幂等重入、分配 10.84.111.x、返回服务器密钥与成员列表
//
// 注意：这里刻意只用 db.exec()，不走 db.query()/db.run() 的 .parameter 绑定。
// 现版本 sqlite3.exe 下 `.parameter init` 会把帮助文本打到 stdout（JSON.parse 直接炸），
// 且 CAST(X'..' AS TEXT) 绑进来的值是 NULL；所以 SQL 字面量在这里自行转义拼接，读结果时只取 JSON 行。
import http from 'http';
import {
    sqlStr, sqlNum, generateKeyPair, isPublicKey, readBody, send,
} from './helper';

import {
    PROTO_VERSION,
    DEFAULT_WG_PORT,
    DEFAULT_SERVER_PORT,
    VPN_PREFIX,
    POOL_FIRST,
    POOL_LAST,
    LOCAL_ID,
    LOCAL_NAME,
    SERVER_VPN_IP,
    ST_DELETED,
    ST_BANNED,
    ST_NORMAL,
    IS_LOST_CONNECT,
} from '../constants';

export default class Server {
    // db 是 ./sqlite.js 导出的实例（子进程式 sqlite3 封装）
    constructor(db, serverPort = DEFAULT_SERVER_PORT, wgPort = DEFAULT_WG_PORT) {
        if (!db) throw new Error('Missing SQLiteManager instance');

        this.db = db;
        this.serverPort = serverPort;
        this.wgPort = wgPort;
        this.self = null;
        this.startedAt = 0;

        this.httpServer = http.createServer((req, res) => this._handle(req, res));
        // 与旧实现一致：构造即监听；要等就 await this.ready
        this.ready = this.start();
        this.state = '';
        this.userStat = new Map();
        this.banUsers = [];
        this.onConnect = () => {};
    }

    // —— 生命周期 ——
    async start() {
        await this.db.init();
        await this._ensureSelf();
        await this._listen();
        this.banUsers = await this._getBanUsers();
        this.startedAt = Date.now();
        this.state = `注册服务已监听:${this.serverPort}\n服务器公钥:${this.self.public_key}`;
        return this;
    }

    _listen() {
        return new Promise((resolve, reject) => {
            const onError = (e) => reject(e);
            this.httpServer.once('error', onError);
            this.httpServer.listen(this.serverPort, '0.0.0.0', () => {
                this.httpServer.removeListener('error', onError);
                resolve();
            });
        });
    }

    async stop() {
        if (!this.httpServer || !this.httpServer.listening) return;
        await new Promise((resolve) => {
            this.httpServer.close(() => resolve());
            if (this.httpServer.closeAllConnections) this.httpServer.closeAllConnections();
        });
    }

    // —— 查询：.mode json 打出的数组可能跨多行（一条记录一行），按方括号切出来再解析 ——
    // 写操作后取受影响行数
    async _changes(sql) {
        const rows = await this.db.all(`${sql.trim().replace(/;+\s*$/, '')};
SELECT changes() AS changes;`);
        return (rows[0] && rows[0].changes) || 0;
    }

    // —— 服务器自身（id=0）：没有就生成密钥写进去，之后一直复用 ——
    async _ensureSelf() {
        this.self = await Server.getLocalInfo(this.db, LOCAL_NAME, SERVER_VPN_IP);
        return this.self;
    }

    static async getLocalInfo(db, nickName = LOCAL_NAME, serverVpnIp = SERVER_VPN_IP, ip = '') {
        const rows = await db.all(`SELECT id, name, public_key, private_key, vpn_ip, ip FROM users WHERE id = ${LOCAL_ID} LIMIT 1`);

        if (rows.length) {
            return rows[0];
        }

        const keys = generateKeyPair();

        await db.exec(
            `INSERT INTO users (id, name, public_key, private_key, ip, vpn_ip, status, create_date)
             VALUES (${LOCAL_ID}, ${sqlStr(nickName)}, ${sqlStr(keys.publicKey)}, ${sqlStr(keys.privateKey)},
                     ${sqlStr(ip)}, ${sqlStr(serverVpnIp)}, ${ST_NORMAL}, datetime('now'));`,
        );

        return {
            id: LOCAL_ID,
            name: nickName,
            public_key: keys.publicKey,
            private_key: keys.privateKey,
            vpn_ip: serverVpnIp,
            ip,
        };
    }

    static async updateLocalInfo(db, nickName = LOCAL_NAME, vpnIp = SERVER_VPN_IP, ip = '') {
        const info = await Server.getLocalInfo(db, nickName, vpnIp, ip);

        await db.exec(
            `UPDATE users SET name = ${sqlStr(nickName)}, ip = ${sqlStr(ip)}, vpn_ip = ${sqlStr(vpnIp)}
             WHERE id = ${info.id};`,
        );

        return {
            id: info.id,
            name: nickName,
            public_key: info.public_key,
            private_key: info.private_key,
            vpn_ip: vpnIp,
            ip,
        };
    }

    async updateUserVpnIp(vpnIp, id) {
        return this._changes(
            `UPDATE users SET vpn_ip = ${sqlStr(vpnIp)}
             WHERE id = ${sqlNum(id)};`,
        );
    }

    async _getBanUsers() {
        const banUsers = await this.db.all(
            `SELECT  public_key, ip, guid FROM users
              WHERE status = ${ST_BANNED} AND id <> ${LOCAL_ID};`,
        );
        return banUsers.map((user) => ({
            ip: user.ip,
            publicKey: user.public_key,
            guid: user.guid,
        }));
    }

    // —— 路由 ——
    async _handle(req, res) {
        const url = new URL(req.url, 'http://127.0.0.1');

        if (req.method === 'OPTIONS') {
            send(res, 204, {});
            return;
        }

        try {
            if (url.pathname === '/api/state') {
                // GET 带 ?publicKey= 也能用：主进程轮询是无 body 的 GET
                const body = await readBody(req).catch(() => ({}));
                const publicKey = body.publicKey || url.searchParams.get('publicKey') || '';

                send(res, 200, await this.getState({ ...body, publicKey }));
                return;
            }
            if (url.pathname === '/api/join' && req.method === 'POST') {
                send(res, 200, await this.onJoin(await readBody(req), req));
                return;
            }

            send(res, 404, { error: 'not_found' });
        } catch (e) {
            const code = e && e.status ? e.status : 500;
            send(res, code, { error: (e && e.message) || String(e) });
        }
    }

    // Client 轮询用
    async getState(body) {
        const { publicKey = '' } = body;
        if (!isPublicKey(publicKey)) {
            throw Object.assign(new Error('设备信息出错'), { status: 400 });
        }

        this._refreshStat(publicKey);
        const members = await this.members();

        let joinErr = '';
        if (this.banUsers.some((u) => u.publicKey === publicKey)) {
            joinErr = '此设备已被封禁';
        }

        const me = members.find((u) => u.public_key === publicKey) || {};

        return {
            joinErr,
            wgPort: this.wgPort,
            vpnIp: me.vpn_ip || '',
            serverKey: this.self ? this.self.public_key : '',
            peers: members.map((u) => this._toMember(u)),
        };
    }

    // —— 客户端 Join：注册 / 幂等重入 ——
    async onJoin(body = {}, req) {
        const { nickName = '', publicKey = '', guid = '' } = body;

        if (!isPublicKey(publicKey) || !guid) {
            throw Object.assign(new Error('设备信息出错'), { status: 400 });
        }

        const userIp = this._getRemoteIp(req);

        if (this.banUsers.some((u) => u.guid === guid || u.publicKey === publicKey || u.ip.indexOf(userIp) >= 0)) {
            throw Object.assign(new Error('被封禁的用户不能加入'), { status: 403 });
        }

        const exist = await this.db.all(
            `SELECT id, name, public_key, vpn_ip, ip, status FROM users
            WHERE public_key = ${sqlStr(publicKey)} AND status <> ${ST_DELETED} LIMIT 1`,
        );

        const result = {
            vpnIp: '',
            wgPort: '',
            serverKey: '',
            peers: [],
        };

        if (exist.length) {
            const row = exist[0];

            // 幂等：同 key 再 Join 只刷新 name / endpoint
            await this.db.exec(
                `UPDATE users SET 
                    name = ${sqlStr(nickName || row.name)},
                    ip = ${sqlStr(userIp || row.ip)},
                    guid = ${sqlStr(guid || row.guid)},
                    status = ${ST_NORMAL} 
                WHERE id = ${sqlNum(row.id)};`,
            );

            result.vpnIp = row.vpn_ip;
        } else {
            const vpnIp = await this._allocIp();
            if (!vpnIp) {
                throw Object.assign(new Error('可分配地址已耗尽'), { status: 507 });
            }

            // last_insert_rowid() 是连接级的，必须和 INSERT 放在同一次 exec 里取，否则另起进程拿到 0
            await this.db.all(
                `INSERT INTO users (name, public_key, private_key, ip, vpn_ip, guid, status, create_date)
                 VALUES (
                    ${sqlStr(nickName)}, 
                    ${sqlStr(publicKey)}, 
                    NULL,
                    ${sqlStr(userIp)},
                    ${sqlStr(vpnIp)}, 
                    ${sqlStr(guid)}, 
                    ${ST_NORMAL}, 
                    datetime('now')
                );`,
            );

            result.vpnIp = vpnIp;
        }

        result.serverKey = this.self.public_key;
        result.wgPort = this.wgPort;
        result.peers = (await this.members()).map(this._toMember);

        this.onConnect();
        return result;
    }

    _refreshStat(publicKey) {
        if (!this.userStat.has(publicKey)) {
            this.userStat.set(publicKey, {
                lastConnect: +new Date(),
                lastHeartBeat: +new Date(),
            });
        }
        this.userStat.get(publicKey).lastHeartBeat = +new Date();
    }

    // 获取客户端真实 IP
    _getRemoteIp(req) {
        if (!req || !req.socket) {
            return '';
        }

        const socketIp = req.socket.remoteAddress;

        if (typeof socketIp !== 'string' || !socketIp.trim()) {
            return '';
        }

        // 只有明确配置了可信反向代理，才允许读取代理头
        let ip = socketIp;

        if (this.config && this.config.trustProxy === true && req.headers) {
            const realIp = req.headers['x-real-ip'];
            const forwardedFor = req.headers['x-forwarded-for'];

            if (typeof realIp === 'string' && realIp.trim()) {
                ip = realIp.trim();
            } else if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
                ip = forwardedFor.split(',')[0].trim();
            }
        }

        // 处理 IPv4-mapped IPv6
        ip = ip.replace(/^::ffff:/i, '');

        return ip;
    }

    // 对外只暴露界面需要的字段
    _toMember(row) {
        const stat = {
            lastConnect: 0,
            lastHeartBeat: 0,
            ...this.userStat.get(row.public_key),
        };

        const curTime = +new Date();
        const keepHeartBeat = curTime - stat.lastHeartBeat < IS_LOST_CONNECT;
        const banded = this.banUsers.some((u) => u.guid === row.guid || u.publicKey === row.public_key || u.ip.indexOf(row.ip) >= 0);

        return {
            id: row.id,
            name: row.name || '匿名',
            lastConnect: stat.lastConnect,
            online: keepHeartBeat && !banded,
        };
    }

    /**
     * 测试对等连接的静态异步方法
     * 从数据库中获取所有状态正常的用户信息，并映射为指定格式的对等节点信息
     * @returns {Array} 返回包含对等节点信息的数组，每个节点包含id、名称、最后连接时间和在线状态
     */
    static async testPeer(db) {
        // 从数据库查询所有状态为正常的用户，排除本地用户
        const peers = await db.all(
            `SELECT id, name, public_key, vpn_ip, ip, status FROM users
            WHERE status = ${ST_NORMAL} AND id <> ${LOCAL_ID};`,
        );

        // 将查询结果映射为指定格式的对象数组
        return peers.map((u) => ({
            id: u.id, // 用户ID
            name: u.name, // 用户名称
            // 随机生成一个过去30天内的最后连接时间
            lastConnect: +new Date() - Math.random() * 1000 * 60 * 60 * 24 * 30,
            // 假设ID大于2的用户为在线状态
            online: u.id > 2,
        }));
    }

    async members() {
        const rows = await this.db.all(
            `SELECT id, name, public_key, vpn_ip, ip, guid, status FROM users
              WHERE status = ${ST_NORMAL} AND id <> ${LOCAL_ID} ORDER BY id ASC`,
        );
        return rows;
    }

    async users() {
        const rows = await this.db.all(
            `SELECT id, name, public_key, vpn_ip, ip, guid, status FROM users
            WHERE status IN (${ST_BANNED}, ${ST_NORMAL}) AND id <> ${LOCAL_ID} ORDER BY id ASC`,
        );
        return rows.map((u) => ({
            ...u,
            ...this._toMember(u),
        }));
    }

    // 池内最小空闲 IP（10.84.111.2 ~ 254）
    async _allocIp() {
        const rows = await this.db.all(
            `SELECT vpn_ip FROM users WHERE status <> ${ST_DELETED} AND vpn_ip LIKE ${sqlStr(`${VPN_PREFIX}%`)}`,
        );

        const used = new Set(rows.map((r) => parseInt(String(r.vpn_ip).split('.').pop(), 10)).filter((n) => !Number.isNaN(n)));

        for (let host = POOL_FIRST; host <= POOL_LAST; host += 1) {
            if (!used.has(host)) return `${VPN_PREFIX}${host}`;
        }

        return '';
    }

    // —— 封禁：id 或 publicKey 都收 ——
    async ban(publicKey = '', id = 0) {
        return this._setStatus(id, publicKey, ST_BANNED);
    }

    // —— 删除（软删除，保留整行以便审计）——
    async remove(publicKey = '', id = 0) {
        return this._setStatus(id, publicKey, ST_DELETED);
    }

    async resume(publicKey = '', id = 0) {
        return this._setStatus(id, publicKey, ST_NORMAL);
    }

    async _setStatus(id, publicKey, status) {
        const byId = Number(id);

        if (!isPublicKey(publicKey) && !byId) return false;

        const where = isPublicKey(publicKey) ? `public_key = ${sqlStr(publicKey)}` : `id = ${sqlNum(byId)} AND id <> ${LOCAL_ID}`;
        const changes = await this._changes(`UPDATE users SET status = ${sqlNum(status)} WHERE ${where}`);

        this._getBanUsers().then((list) => {
            this.banUsers = list;
        });

        return changes > 0;
    }
}
