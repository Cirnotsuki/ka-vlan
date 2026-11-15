import { getRootFolder } from './helper';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
/**
 * 子进程式 SQLite 封装（调 sqlite3.exe，不依赖原生模块）
 *
 * 几个必须绕开的 CLI 坑（都实测过）：
 *   1. `.parameter set` 只吃字面量：传 CAST(X'..' AS TEXT) 绑进去是 NULL；
 *      而 `.parameter init` 在某些版本会把帮助文本打到 stdout，把 JSON 输出污染掉。
 *      → 干脆不用 .parameter，参数在 JS 侧做字面量化后内联。
 *   2. 字符串一律编码成 CAST(X'<utf8 hex>' AS TEXT)：既不用拼引号转义，
 *      也不受控制台代码页影响，中文昵称不会乱码。
 *   3. `.mode json` 的多行输出：一条记录一行，整体才是一个数组 →
 *      不能按行 JSON.parse，要按首尾方括号切出来整体解析。
 */
export default class SQLiteManager {
    constructor() {
        this.initialized = false;
        this.queue = Promise.resolve();

        this.dbPath = getRootFolder('database.db');
        this.sqlitePath = getRootFolder('core', 'sqlite3.exe');
    }

    // 初始化数据库
    async init() {
        if (this.initialized) return;

        fs.mkdirSync(path.dirname(this.dbPath), {
            recursive: true,
        });

        if (!fs.existsSync(this.sqlitePath)) {
            throw new Error(`SQLite executable not found: ${this.sqlitePath}`);
        }

        await this._execute('SELECT 1 AS ready;');
        await this._initTable();

        this.initialized = true;

        console.log('[SQLite] Initialized:', this.dbPath);
    }

    async _initTable() {
        const sql = /* sql */ `

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name VARCHAR(32),
    public_key TEXT,
    private_key TEXT,
    ip VARCHAR(32),
    vpn_ip VARCHAR(32),
    guid VARCHAR(32),
    status TINYINT, -- 0: 禁用 1: 正常 2: 离线
    create_date DATE
);

-- 按状态查询
CREATE INDEX IF NOT EXISTS idx_users_status
ON users(status);

-- 按 VPN IP 查询
CREATE INDEX IF NOT EXISTS idx_users_vpn_ip
ON users(vpn_ip);`;

        await this._execute(sql);
    }

    // 把 JS 值转成 SQL 字面量：字符串走 hex，彻底避开引号/编码问题
    // eslint-disable-next-line class-methods-use-this
    _formatParam(value) {
        if (value === null || value === undefined) {
            return 'NULL';
        }

        if (typeof value === 'boolean') {
            return value ? '1' : '0';
        }

        if (typeof value === 'number') {
            if (!Number.isFinite(value)) {
                throw new Error('Invalid number parameter');
            }
            return String(value);
        }

        if (Buffer.isBuffer(value)) {
            return `X'${value.toString('hex')}'`;
        }

        if (typeof value === 'object') {
            value = JSON.stringify(value);
        }

        const hex = Buffer.from(String(value), 'utf8').toString('hex');

        return `CAST(X'${hex}' AS TEXT)`;
    }

    // @p0 / @p1 … 内联替换（按编号整体匹配，@p1 不会误伤 @p10）
    _bind(sql, params = []) {
        return String(sql).replace(/@p(\d+)\b/g, (match, index) => {
            const i = Number(index);

            if (i >= params.length) {
                throw new Error(`Missing SQL parameter @p${i}`);
            }

            return this._formatParam(params[i]);
        });
    }

    // 一次 sqlite3.exe 进程执行一段脚本，返回 stdout
    _execute(script) {
        const task = this.queue.then(
            () => new Promise((resolve, reject) => {
                const child = spawn(this.sqlitePath, ['-batch', '-bail', this.dbPath], {
                    windowsHide: true,
                    stdio: ['pipe', 'pipe', 'pipe'],
                });

                let stdout = '';
                let stderr = '';

                child.stdout.setEncoding('utf8');
                child.stderr.setEncoding('utf8');

                child.stdout.on('data', (data) => {
                    stdout += data;
                });

                child.stderr.on('data', (data) => {
                    stderr += data;
                });

                child.on('error', reject);

                child.on('close', (code) => {
                    if (code !== 0) {
                        reject(new Error(stderr.trim() || `SQLite exited with code ${code}`));
                        return;
                    }

                    resolve(stdout.trim());
                });

                child.stdin.on('error', reject);

                // 注意：不要加 `.parameter init`，它会把帮助文本写进 stdout
                child.stdin.end(`.bail on
.timeout 5000
.mode json
${script}
`);
            }),
        );

        // 一次操作失败后队列仍然要继续
        this.queue = task.catch(() => {});

        return task;
    }

    // 从 `.mode json` 的输出里切出数组（可能跨多行）
    // eslint-disable-next-line class-methods-use-this
    _parseRows(stdout) {
        const text = String(stdout || '');
        const from = text.indexOf('[');
        const to = text.lastIndexOf(']');

        if (from < 0 || to < from) return [];

        try {
            const rows = JSON.parse(text.slice(from, to + 1));
            return Array.isArray(rows) ? rows : [];
        } catch (e) {
            throw new Error(`SQLite 输出不是合法 JSON: ${text.slice(0, 200)}`);
        }
    }

    async all(sql) {
        const out = await this.exec(`${sql.trim().replace(/;+\s*$/, '')};`);
        const text = String(out || '');
        const from = text.indexOf('[');
        const to = text.lastIndexOf(']');

        if (from < 0 || to < from) return [];

        try {
            return JSON.parse(text.slice(from, to + 1));
        } catch (e) {
            return [];
        }
    }

    // 查询，返回对象数组
    async query(sql, params = []) {
        this._assertInitialized();

        const script = `${this._bind(sql, params)
            .trim()
            .replace(/;+\s*$/, '')};`;
        const result = await this._execute(script);

        return this._parseRows(result);
    }

    // 执行 INSERT / UPDATE / DELETE，返回 { changes, lastInsertRowid }
    async run(sql, params = []) {
        this._assertInitialized();

        const statement = this._bind(sql, params)
            .trim()
            .replace(/;+\s*$/, '');

        // changes() / last_insert_rowid() 是连接级的，必须和写语句同一次执行
        const result = await this._execute(`${statement};

SELECT changes() AS changes,
       last_insert_rowid() AS lastInsertRowid;`);

        const rows = this._parseRows(result);

        return (
            rows[0] || {
                changes: 0,
                lastInsertRowid: 0,
            }
        );
    }

    // 执行建表、索引等 SQL（不支持 @p 参数，需要参数请用 query/run）
    async exec(sql) {
        this._assertInitialized();

        return this._execute(sql);
    }

    // 执行多条 SQL 事务
    async transaction(statements) {
        this._assertInitialized();

        if (!Array.isArray(statements) || !statements.length) {
            throw new Error('Transaction requires statements');
        }

        let script = 'BEGIN IMMEDIATE;\n';

        for (const item of statements) {
            if (!item || typeof item.sql !== 'string') {
                throw new Error('Invalid transaction statement');
            }

            script += this._bind(item.sql, item.params || [])
                .trim()
                .replace(/;+\s*$/, '');
            script += ';\n';
        }

        script += 'COMMIT;';

        return this._execute(script);
    }

    // 检查初始化状态
    _assertInitialized() {
        if (!this.initialized) {
            throw new Error('SQLite has not been initialized');
        }
    }

    // 关闭接口：每次操作都是独立进程，无需保持连接
    async close() {
        await this.queue;
        this.initialized = false;
    }
}
