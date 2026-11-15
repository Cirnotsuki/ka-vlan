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
    }

    // —— 生命周期 ——
    async start() {
        await this.db.init();
        await this._ensureSelf();
        await this._listen();
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
        this.self = await Server.getInfo(this.db, LOCAL_NAME, SERVER_VPN_IP);
        return this.self;
    }

    static async getInfo(db, nickName = LOCAL_NAME, serverVpnIp = SERVER_VPN_IP, ip = '') {
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

    static async updateInfo(db, nickName = LOCAL_NAME, serverVpnIp = SERVER_VPN_IP, ip = '') {
        const info = await Server.getInfo(db, nickName, serverVpnIp, ip);

        await db.exec(
            `UPDATE users SET name = ${sqlStr(nickName)}, ip = ${sqlStr(ip)}, vpn_ip = ${sqlStr(serverVpnIp)}
             WHERE id = ${info.id};`,
        );

        return {
            id: info.id,
            name: nickName,
            public_key: info.public_key,
            private_key: info.private_key,
            vpn_ip: serverVpnIp,
            ip,
        };
    }

    // —— 路由 ——
    async _handle(req, res) {
        const url = new URL(req.url, 'http://127.0.0.1');

        if (req.method === 'OPTIONS') {
            send(res, 204, {});
            return;
        }

        try {
            if (url.pathname === '/api/heart-beat') {
                send(res, 200, await readBody(req), req);
                return;
            }
            if (url.pathname === '/api/state' && req.method === 'GET') {
                send(res, 200, await this.getState(await readBody(req)));
                return;
            }
            if (url.pathname === '/api/join' && req.method === 'POST') {
                send(res, 200, await this.onRegist(await readBody(req), req));
                return;
            }
            if (url.pathname === '/api/ban' && req.method === 'POST') {
                const body = await readBody(req);
                const ok = await this.ban(body.id !== undefined ? body.id : body.publicKey || body.public_key);
                send(res, 200, { ok: ok ? '1' : '', error: ok ? '' : '成员不存在' });
                return;
            }
            if (url.pathname === '/api/delete' && req.method === 'POST') {
                const body = await readBody(req);
                const ok = await this.remove(body.id !== undefined ? body.id : body.publicKey || body.public_key);
                send(res, 200, { ok: ok ? '1' : '', error: ok ? '' : '成员不存在' });
                return;
            }
            if (url.pathname === '/api/stop-serve' && req.method === 'POST') {
                send(res, 200, { ok: '1' });
                setTimeout(() => this.stop().catch(() => {}), 50);
                return;
            }
            if (url.pathname === '/api/shutdown' && req.method === 'POST') {
                send(res, 200, { ok: '1' });
                setTimeout(() => this.stop().catch(() => {}), 50);
                return;
            }

            send(res, 404, { error: 'not_found' });
        } catch (e) {
            const code = e && e.status ? e.status : 500;
            send(res, code, { error: (e && e.message) || String(e) });
        }
    }

    // —— Start Server 后 UI 轮询用 ——
    async getState() {
        const members = await this.members();
        return {
            joinErr: '',
            port: this.wgPort,
            publicKey: this.self ? this.self.public_key : '',
            memberCount: members.length,
            members,
            uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
        };
    }

    // 对外只暴露界面需要的字段
    _toMember(row) {
        const lastConnect = this.userStat.get(row.public_key) || 0;
        const curTime = +new Date();
        return {
            id: row.id,
            name: row.name || '匿名',
            online: curTime - lastConnect < IS_LOST_CONNECT,
        };
    }

    async members() {
        const rows = await this.db.all(
            `SELECT id, name, public_key, vpn_ip, ip, guid, status FROM users
              WHERE status = ${ST_NORMAL} AND id <> ${LOCAL_ID}`,
        );
        return rows;
    }

    async onHeartBeat(body = {}) {
        const { publicKey = '' } = body;
        this._refreshStat(publicKey);
        const peers = await this.members();

        return {
            menbers: peers.map(this._toMember),
        };
    }

    // —— 客户端 Join：注册 / 幂等重入 ——
    async onRegist(body = {}, req) {
        const { nickName = '', publicKey = '', guid = '' } = body;

        if (!isPublicKey(publicKey) || !guid) {
            throw Object.assign(new Error('设备信息出错'), { status: 400 });
        }

        const userIp = this._getRemoteIp(req);

        const banUsers = await this.db.all(
            `SELECT  public_key, ip, guid FROM users
              WHERE status = ${ST_BANNED} AND id <> ${LOCAL_ID};`,
        );

        if (banUsers.some((u) => u.guid === guid || u.public_key === publicKey || u.ip.indexOf(userIp) >= 0)) {
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
        result.peers = await this.members();

        return result;
    }

    _refreshStat(publicKey) {
        this.userStat.set(publicKey, +new Date());
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
    async ban(idOrKey) {
        return this._setStatus(idOrKey, ST_BANNED);
    }

    // —— 删除（软删除，保留整行以便审计）——
    async remove(idOrKey) {
        return this._setStatus(idOrKey, ST_DELETED);
    }

    async _setStatus(idOrKey, status) {
        if (idOrKey === undefined || idOrKey === null || idOrKey === '') return false;

        const byId = Number(idOrKey);
        const where = Number.isInteger(byId) ? `id = ${sqlNum(byId)} AND id <> ${LOCAL_ID}` : `public_key = ${sqlStr(String(idOrKey))}`;

        const changes = await this._changes(`UPDATE users SET status = ${sqlNum(status)} WHERE ${where}`);
        return changes > 0;
    }
}
