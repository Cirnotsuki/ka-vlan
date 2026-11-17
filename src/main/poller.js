// 主进程里的轮询器：渲染层只负责收结果，不再自己 setInterval。
//
// 两条独立的循环，都用 setTimeout 串起来（上一轮结束才排下一轮，不会堆积）：
//   core  —— 定时打核心的 /ping，判断 vlancore 是否活着
//   state —— 用户加入服务器后，按 4 秒或长轮询拉 /api/state，主要取 vpn_ip
const http = require('http');
const https = require('https');
const { URL } = require('url');

const DEBUG = process.env.NODE_ENV === 'development';

function requestOnce(target, { timeout = 4000 } = {}) {
    return new Promise((resolve, reject) => {
        let url;
        try {
            url = new URL(target);
        } catch (e) {
            reject(new Error(`URL 非法: ${target}`));
            return;
        }

        const mod = url.protocol === 'https:' ? https : http;
        const req = mod.get(url, { timeout }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                resolve({
                    status: res.statusCode,
                    body: Buffer.concat(chunks).toString('utf8'),
                });
            });
        });

        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
    });
}

export default class Poller {
    constructor(getWindow) {
        this.getWindow = getWindow; // () => BrowserWindow | null

        this.coreTimer = null;
        this.stateTimer = null;

        this.coreOpts = null;
        this.stateOpts = null;

        this.disposed = false;
    }

    _send(channel, payload) {
        if (this.disposed) return;

        const win = this.getWindow();
        if (!win || win.isDestroyed() || !win.webContents) return;

        try {
            win.webContents.send(channel, payload);
        } catch (e) {
            if (DEBUG) console.warn('[poller] send 失败:', channel, e.message);
        }
    }

    // —— 核心探活 ——
    startCore({ url = 'http://127.0.0.1:7400', intervalMs = 2000, path: pingPath = '/ping' } = {}) {
        this.stopCore();
        this.coreOpts = { url, intervalMs, path: pingPath };
        this._loopCore();
    }

    stopCore() {
        if (this.coreTimer) {
            clearTimeout(this.coreTimer);
            this.coreTimer = null;
        }
        this.coreOpts = null;
    }

    async _loopCore() {
        if (!this.coreOpts) return;

        const { url, intervalMs, path } = this.coreOpts;
        const at = Date.now();
        let online = false;

        try {
            const res = await requestOnce(`${url}${path}`, { timeout: Math.min(intervalMs, 1500) });
            online = res.status >= 200 && res.status < 300;
        } catch (e) {
            online = false;
            if (DEBUG) console.warn('[poller] core 探测失败:', e.message);
        }

        // 轮询期间可能被 stop 掉，别把过期结果发出去
        if (!this.coreOpts) return;

        this._send('poll:core', { online, at });

        this.coreTimer = setTimeout(() => this._loopCore(), intervalMs);
    }

    // —— 节点状态（加入服务器后）——
    // longPoll=true 时：服务端回 204（心跳）或 200 都立刻发下一轮，回错误才等 intervalMs
    startState({ url, intervalMs = 4000, longPoll = true } = {}) {
        this.stopState();
        if (!url) return;

        this.stateOpts = { url, intervalMs, longPoll };
        this._loopState();
    }

    stopState() {
        if (this.stateTimer) {
            clearTimeout(this.stateTimer);
            this.stateTimer = null;
        }
        this.stateOpts = null;
    }

    async _loopState() {
        if (!this.stateOpts) return;

        const { url, intervalMs, longPoll } = this.stateOpts;
        let next = intervalMs;

        try {
            // 长轮询允许服务端长时间保持连接
            const timeout = longPoll ? Math.max(intervalMs, 6000) : Math.min(intervalMs, 4000);
            const startAt = Date.now();
            const res = await requestOnce(url, { timeout });

            if (!this.stateOpts) return;

            // 长轮询响应后稍作等待，避免高频重连
            const nextInterval = longPoll ? Math.max(1000, Math.min(intervalMs, 3000)) : intervalMs;

            if (res.status === 204) {
                next = nextInterval;

                this._send('poll:state', { ok: true, empty: true, at: Date.now() });
            } else if (res.status >= 200 && res.status < 300) {
                let data = null;
                try {
                    data = res.body ? JSON.parse(res.body) : null;
                } catch (e) {
                    data = null;
                }
                this._send('poll:state', {
                    ok: true, data, at: Date.now(), startAt,
                });

                next = nextInterval;
            } else {
                next = intervalMs;

                this._send('poll:state', {
                    ok: false,
                    error: `HTTP ${res.status}`,
                    at: Date.now(),
                });
            }
        } catch (e) {
            next = intervalMs;

            this._send('poll:state', { ok: false, error: e.message || String(e), at: Date.now() });
        }

        if (!this.stateOpts) return;
        this.stateTimer = setTimeout(() => this._loopState(), next);
    }

    stopAll() {
        this.stopCore();
        this.stopState();
    }

    dispose() {
        this.disposed = true;
        this.stopAll();
    }
}
