import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { spawn, execFile } from 'child_process';
import { promisify } from 'util';

import { SERVER_VPN_IP, MAX_BODY } from '../constants';
import mkdirp from '../modules/mkdirp';

const execFileAsync = promisify(execFile);

/**
 * 获取 Windows MachineGuid
 * @returns {Promise<string>}
 */
export async function getMachineGuid() {
    try {
        const { stdout } = await execFileAsync(
            'powershell.exe',
            [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                "(Get-ItemPropertyValue -Path 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography' -Name MachineGuid)",
            ],
            {
                windowsHide: true,
                timeout: 5000,
                encoding: 'utf8',
            },
        );

        return stdout.trim();
    } catch (error) {
        return '';
    }
}

// —— SQL 字面量转义（单引号成对）——
export function sqlStr(v) {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    return `'${String(v).replace(/'/g, "''")}'`;
}

export function sqlNum(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? String(Math.trunc(n)) : String(fallback);
}

// —— WireGuard 密钥（X25519）：导出的 32 字节裸密钥再按 wg 规则 clamp ——
export function generateKeyPair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');

    const priv = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'der' }).slice(-32));
    const pub = Buffer.from(publicKey.export({ type: 'spki', format: 'der' }).slice(-32));

    priv[0] &= 248;
    priv[31] &= 127;
    priv[31] |= 64;

    return {
        privateKey: priv.toString('base64'),
        publicKey: pub.toString('base64'),
    };
}

export function isPublicKey(k) {
    return typeof k === 'string' && k.length === 44 && k.endsWith('=');
}

export function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];

        req.on('data', (c) => {
            size += c.length;
            if (size > MAX_BODY) {
                reject(new Error('request body too large'));
                req.destroy();
                return;
            }
            chunks.push(c);
        });

        req.on('end', () => {
            if (!chunks.length) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch (e) {
                reject(Object.assign(new Error('invalid json body'), { status: 400 }));
            }
        });

        req.on('error', reject);
    });
}

export function send(res, code, payload) {
    const body = JSON.stringify(payload === undefined ? {} : payload);
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end(body);
}
export function enableForwarding() {
    return new Promise((resolve, reject) => {
        const script = `
            $interface = Get-NetIPAddress -IPAddress '${SERVER_VPN_IP}' -AddressFamily IPv4 -ErrorAction Stop
            Set-NetIPInterface -InterfaceIndex $interface.InterfaceIndex -AddressFamily IPv4 -Forwarding Enabled -ErrorAction Stop
            $result = Get-NetIPInterface -InterfaceIndex $interface.InterfaceIndex -AddressFamily IPv4
            if ($result.Forwarding -ne 'Enabled') { throw 'IPv4 forwarding verification failed.' }
            Write-Output 'IPv4 forwarding enabled.'
        `;

        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
            windowsHide: true,
        });

        let output = '';
        let errorOutput = '';

        child.stdout.on('data', (data) => {
            output += data.toString();
        });

        child.stderr.on('data', (data) => {
            errorOutput += data.toString();
        });

        child.once('error', reject);

        child.once('close', (code) => {
            if (code === 0) {
                resolve(true);
            } else {
                reject(new Error(errorOutput || output || `PowerShell exit code: ${code}`));
            }
        });
    });
}

export function formatDate(date, fmt) {
    const dateObj = typeof date === 'string' ? new Date(date) : date;
    const o = {
        'M+': dateObj.getMonth() + 1,
        'd+': dateObj.getDate(),
        'H+': dateObj.getHours(),
        'm+': dateObj.getMinutes(),
        's+': dateObj.getSeconds(),
        'q+': Math.floor((dateObj.getMonth() + 3) / 3),
        S: dateObj.getMilliseconds(),
    };
    if (/(y+)/.test(fmt)) {
        fmt = fmt.replace(/(y+)/, (str, p1) => `${dateObj.getFullYear()}`.substr(4 - p1.length));
    }
    for (const k in o) {
        if (new RegExp(`(${k})`).test(fmt)) {
            fmt = fmt.replace(new RegExp(`(${k})`), (str, p1) => (p1.length === 1 ? o[k] : `00${o[k]}`.substr(`${o[k]}`.length)));
        }
    }
    return fmt;
}
export function getCurDate(fmt, timeStamp) {
    const date = typeof timeStamp === 'number' ? new Date(timeStamp) : new Date();
    return this.formatDate(date, fmt || 'yyyy-MM-dd');
}
export function getCurDateTime(timeStamp) {
    const date = typeof timeStamp === 'number' ? new Date(timeStamp) : new Date();
    return this.formatDate(date, 'yyyy-MM-dd HH:mm:ss');
}
export function getCurTimeSeconds(timeStamp) {
    const date = typeof timeStamp === 'number' ? new Date(timeStamp) : new Date();
    return (date.getTime() / 1000) | 0;
}
export function getCurTime(timeStamp) {
    const date = typeof timeStamp === 'number' ? new Date(timeStamp) : new Date();
    return this.formatDate(date, 'ddHHmm');
}
export function formatTimeStamp(timeStamp) {
    let date;
    try {
        date = new Date(timeStamp);
    } catch (error) {
        date = new Date();
    }
    return (date.getTime() / 1000) | 0;
}

export function getQuery(name) {
    const g = window || global;
    if (!g) return '';
    const [, query] = (g.location.hash || '').split('?');
    if (!query) return '';
    const items = query.split('&');
    for (const item of items) {
        const [key, val] = item.split('=');
        if (key === name) return val;
    }
    return '';
}

// 获取根目录文件夹路径
export function getRootFolder(...arg) {
    // 获取根目录
    // eslint-disable-next-line no-undef
    const LocalPath = process.env.NODE_ENV === 'development' ? path.resolve(__static, '..') : path.dirname(process.resourcesPath);

    // 创建文件路径
    const filePath = [];
    // 判断是否使用Web链接
    const lastArg = arg[Math.max(arg.length - 1, 0)];
    const isWebURL = process.env.NODE_ENV === 'development' && lastArg === true;

    // 格式化路径
    arg.forEach((val) => typeof val === 'string' && filePath.push(isWebURL ? encodeURIComponent(val) : val));
    // 获取完整资源文件夹文件路径
    const location = isWebURL ? path.join(...filePath) : path.join(LocalPath, ...filePath);
    // 目录不存在时创建目录
    if (!/\.\w+$/.test(location) && !fs.existsSync(location)) {
        mkdirp.sync(location);
    }
    return location;
}
