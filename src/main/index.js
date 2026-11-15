import {
    app, BrowserWindow, ipcMain, dialog, Menu, shell,
} from 'electron';
import os from 'os';
// 目前electron-screenshots不调用，可卸载
// import Screenshots from 'electron-screenshots';
// import path from 'path';

// —— VLAN 核心（vlancore）生命周期管理 ——
import { spawn, exec } from 'child_process';
import path from 'path';
import http from 'http';
import fs from 'fs'; //  clipboard, screen, desktopCapturer,
import IpcScreenshot from './ipcScreenshot';
import IpcManager from './ipcManager';

/**
 * Set `__static` path to static files in production
 * https://simulatedgreg.gitbooks.io/electron-vue/content/en/using-static-assets.html
 */
if (process.env.NODE_ENV !== 'development') {
    global.__static = require('path').join(__dirname, '/static').replace(/\\/g, '\\\\');
}

// —— userData 目录初始化：稳定落在 %APPDATA%\vlan（次选 %LOCALAPPDATA%\vlan），实测可写才启用 ——
// 五段探针逐段记录失败点：mkdir → open → write → close → unlink
function probeWritableDir(dir) {
    const stages = [];
    let probe = '';
    try {
        stages.push('mkdir');
        fs.mkdirSync(dir, { recursive: true });
        probe = path.join(dir, `write-probe-${process.pid}.txt`);
        stages.push('open');
        const fd = fs.openSync(probe, 'w');
        stages.push('write');
        fs.writeSync(fd, 'probe');
        stages.push('close');
        fs.closeSync(fd);
        stages.push('unlink');
        fs.unlinkSync(probe);
        return null; // null = 可写
    } catch (e) {
        e.failedStage = stages[stages.length - 1] || '(init)';
        return e;
    }
}

// 交叉诊断：用 cmd.exe 子进程往同一目录写探针（区分「目录被限制」还是「本 exe 被安全软件针对」）
function cmdWriteProbe(dir) {
    try {
        const file = path.join(dir, `.cmd-probe-${process.pid}.txt`);
        const r = require('child_process').execSync(`cmd /c echo probe > "${file}"`, { timeout: 5000, windowsHide: true });
        const ok = fs.existsSync(file);
        try {
            fs.unlinkSync(file);
        } catch (_) {}
        return ok ? 'cmd.exe 写入成功' : 'cmd.exe 执行后文件不存在';
    } catch (e) {
        return `cmd.exe 也写不进: code=${e.code || e.status} ${(e.message || '').slice(0, 120)}`;
    }
}

// 进程身份诊断：完整性级别 + 提权状态
function processIdentity() {
    try {
        const out = require('child_process').execSync('whoami /groups', { timeout: 5000, windowsHide: true }).toString();
        const m = out.split(/\r?\n/).find((l) => l.includes('Mandatory Level'));
        return m ? m.trim().replace(/\s{2,}/g, ' ') : '未找到完整性级别行';
    } catch (e) {
        return `whoami 失败: ${e.message}`;
    }
}

function initUserData() {
    console.log('[VLAN] 进程身份:', processIdentity());
    const candidates = [path.join(process.env.APPDATA || '', 'vlan'), path.join(process.env.LOCALAPPDATA || '', 'vlan')].filter(
        (p) => p && p.length > 3,
    ); // 防止环境变量缺失导致根目录

    const errors = [];
    for (const dir of candidates) {
        const err = probeWritableDir(dir);
        if (!err) {
            app.setPath('userData', dir);
            console.log('[VLAN] userData =', dir, '（五段探针全部通过）');
            return dir;
        }
        const cross = cmdWriteProbe(dir);
        errors.push(
            `目录 ${dir} 不可写 | 失败阶段=${err.failedStage} code=${err.code} syscall=${err.syscall} path=${err.path} | ${err.message} | [交叉] ${cross}`,
        );
    }
    console.error('[VLAN] userData 初始化失败，所有候选均不可写，退出：');
    errors.forEach((s) => console.error(`  - ${s}`));
    console.error('[VLAN] 判读：cmd.exe 能写而本进程不能 → 安全软件在针对本 exe；cmd.exe 也不能写 → 目录/策略层面限制');
    shellLog(`userData 初始化失败: ${errors.join(' | ')}`);
    dialog.showErrorBox('VLAN 组网', `应用数据目录初始化失败：\n${errors.join('\n')}\n\n详见 shell 日志`);
    app.exit(1);
    return null;
}

const vlanUserData = initUserData();
if (vlanUserData === null) {
    // initUserData 内部已弹窗并退出，这里兜底防继续执行
    throw new Error('userData 初始化失败');
}

process.env.ElectronAppUserPath = app.getPath('userData');

// —— VLAN 壳日志系统：%LOCALAPPDATA%\vlan\logs\shell-日期.log ——
let shellLogPath = path.join(
    process.env.LOCALAPPDATA || os.tmpdir(),
    'vlan',
    'logs',
    `shell-${new Date().toISOString().slice(0, 10)}.log`,
);
try {
    fs.mkdirSync(path.dirname(shellLogPath), { recursive: true });
} catch (_) {
    shellLogPath = null; // 日志目录同样可能不可写，退化成不写日志，不影响启动
}
function shellLog(msg) {
    if (!shellLogPath) return;
    try {
        fs.appendFileSync(shellLogPath, `${new Date().toISOString()} ${msg}\n`);
    } catch (_) {
        /* 日志失败不致命 */
    }
}
shellLog('=== shell 启动 ===');

// GPU：默认不禁用（Chromium 会自动回退软件渲染）。若确认环境不支持，设 VLAN_DISABLE_GPU=1 关闭
if (process.env.VLAN_DISABLE_GPU === '1') {
    app.disableHardwareAcceleration();
    console.log('[VLAN] 已按 VLAN_DISABLE_GPU=1 禁用硬件加速');
}

// 定义全局变量，所有窗口共享，通过ipcMain和ipcRenderer实现设置更改
global.ZLTB_DATA = {
    KEYNO: '', // 加密狗编号
};

// win7 禁用硬件加速（程序黑屏）
if (os.release().startsWith('6.1')) {
    app.disableHardwareAcceleration();
}

const CORE_PORT = 7400;

function corePath() {
    // 按优先级列出核心可能落地的位置，取第一个真实存在的；顺序覆盖打包版 / 开发版 / 仓库根的最新构建
    const appDir = app.getAppPath();
    const candidates = [
        path.join(process.resourcesPath || '', 'core', 'vlancore.exe'), // 打包后 resources/core
        path.join(appDir, 'core', 'vlancore.exe'), // electron-vue/core
        path.join(appDir, '..', 'vlancore.exe'), // 仓库根（go build 的默认输出）
        path.join(appDir, '..', 'core', 'vlancore.exe'), // 仓库根/core
        path.join(appDir, '..', 'dist', 'ui', 'vlancore.exe'), // 旧的 dist/ui
        path.join(appDir, 'dist', 'ui', 'vlancore.exe'),
    ].filter(Boolean);
    const hit = candidates.find((p) => fs.existsSync(p));
    if (hit) return hit;
    shellLog(`corePath: 全部候选都不存在 -> ${candidates.join(' | ')}`);
    return candidates[0];
}

function httpOK(p) {
    return new Promise((resolve) => {
        const req = http.get({
            host: '127.0.0.1', port: CORE_PORT, path: p, timeout: 1200,
        }, (res) => {
            res.resume();
            resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => {
            req.destroy();
            resolve(false);
        });
    });
}

async function startCore() {
    // 探活只能用 /ping：精简后的核心没有 /api/state，用旧路径会一直判成"没起来"，
    // 于是每次启动都再拉一个核心去抢 7400，老进程却一直占着端口
    if (await httpOK('/ping')) {
        shellLog('startCore: 已有实例');
        return;
    }
    const exe = corePath();
    if (!fs.existsSync(exe)) {
        shellLog(`startCore: 核心缺失 ${exe}`);
        throw new Error(`找不到核心: ${exe}`);
    }
    shellLog(`startCore: 提权拉起 ${exe}`);
    const ps = `Start-Process -FilePath '${exe}' -WorkingDirectory '${path.dirname(exe)}' -WindowStyle Hidden -Verb RunAs`;
    spawn('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true });
    for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 500));
        if (await httpOK('/ping')) {
            shellLog(`startCore: 核心就绪 (等待 ${(i + 1) * 0.5}s)`);
            return;
        }
    }
    shellLog('startCore: 15 秒内核心未就绪');
    throw new Error('核心进程启动失败（若 UAC 弹窗被取消请重试）');
}

async function stopCore() {
    await new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port: CORE_PORT, path: '/api/shutdown' }, (res) => {
            res.resume();
            resolve();
        });
        req.on('error', resolve);
        req.on('timeout', () => {
            req.destroy();
            resolve();
        });
    });
    exec('taskkill /F /IM vlancore.exe', { windowsHide: true }, () => {});
}

let mainWindow = null;
const winURL = process.env.NODE_ENV === 'development' ? 'http://localhost:9080/' : `file://${__dirname}/`;

function createWindow() {
    shellLog('createWindow: 创建主窗口');
    mainWindow = new BrowserWindow({
        width: 1100,
        height: 650,
        minWidth: 400,
        minHeight: 400,
        center: true,
        backgroundColor: '#f3f5f7',
        title: 'Vlan 组网',
        icon: './renderer/assets/logo.ico',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            devTools: process.env.NODE_ENV === 'development',
            webviewTag: true,
        },
        // frame: false,
    });

    mainWindow.loadURL(`${winURL}index.html`);

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    // 系统首页是登录页，不显示菜单栏和开发调试工具
    mainWindow.removeMenu();
    mainWindow.webContents.closeDevTools();
}

// 限制单实例应用（必须在 userData 初始化之后：单例锁就存在 userData 目录里）
const curInstance = app.requestSingleInstanceLock();
if (!curInstance) {
    console.error(
        '[VLAN] 获取单实例锁失败：已有实例在运行，或同一 userData 目录被其他进程占用（可用任务管理器清理残留的 electron.exe / VLAN组网.exe）',
    );
    shellLog('单实例锁获取失败，退出');
    app.quit();
} else {
    shellLog(`单实例锁获取成功，userData=${app.getPath('userData')}`);
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) {
                mainWindow.restore();
            }
            mainWindow.focus();
        }
    });

    app.whenReady().then(() => {
        // 界面优先：窗口先起来，核心放在后台拉，核心的任何失败都不许影响 GUI
        createWindow();
        shellLog('whenReady: 窗口已创建，后台拉起核心');
        startCore()
            .then(() => shellLog('startCore: 成功'))
            .catch((e) => {
                const msg = String((e && e.message) || e);
                shellLog(`startCore 失败（不中断界面）: ${msg}`);
                try {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('core-status', { ok: false, message: msg });
                    }
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.setTitle('VLAN 组网 - 核心未就绪');
                    }
                } catch (_) {
                    /* 提示通道也不能反过来把主进程搞崩 */
                }
            });
    });
}

app.on('window-all-closed', async () => {
    shellLog('window-all-closed: 停核心');
    await stopCore();
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (mainWindow === null) {
        createWindow();
    }
});

// 监听窗口崩溃
app.on('render-process-gone', (event, webcon, detial) => {
    shellLog(`render-process-gone: ${JSON.stringify(detial || {})}`);
    webcon.reload();
});

const ipcInstance = new IpcManager(app, ipcMain, BrowserWindow, dialog, Menu, winURL, shell);
ipcInstance.init();
// 注册 Vuex 事件
ipcInstance.registry(require('./registry/vuex').default);

process.on('uncaughtException', (err) => {
    shellLog(`uncaughtException: ${(err && err.stack) || err}`);
});

const ipcShortcutCapture = new IpcScreenshot(app, ipcMain, BrowserWindow, dialog, Menu, winURL);
ipcShortcutCapture.init();
