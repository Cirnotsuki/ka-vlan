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
import Poller from './poller';
import TrayManager from './tray';

/**
 * Set `__static` path to static files in production
 * https://simulatedgreg.gitbooks.io/electron-vue/content/en/using-static-assets.html
 */
if (process.env.NODE_ENV !== 'development') {
    global.__static = require('path').join(__dirname, '/static').replace(/\\/g, '\\\\');
}

export const WindowTitle = 'KA-VLAN 组网';

// —— userData 目录初始化：稳定落在 %APPDATA%\vlan（次选 %LOCALAPPDATA%\vlan），实测可写才启用 ——
// 五段探针逐段记录失败点：mkdir → open/write → close → unlink；探针文件名带 pid + 随机串防并发冲突
async function probeWritableDir(dir) {
    const rand = Math.random().toString(36).slice(2, 8);
    const probe = path.join(dir, `write-probe-${process.pid}-${rand}.tmp`);
    const result = { ok: false, stage: '', err: null, probeFile: probe };

    let handle = null;
    try {
        result.stage = 'mkdir';
        await fs.promises.mkdir(dir, { recursive: true });

        result.stage = 'write';
        handle = await fs.promises.open(probe, 'w');
        await handle.writeFile('probe', 'utf8');

        result.stage = 'close';
        await handle.close();
        handle = null;

        result.stage = 'unlink';
        await fs.promises.unlink(probe);

        result.ok = true;
        return result;
    } catch (e) {
        result.err = e;
        if (handle) {
            try { await handle.close(); } catch (_) { /* 尽力关闭 */ }
        }
        if (result.stage !== 'unlink') {
            try { await fs.promises.unlink(probe); } catch (_) { /* 清理失败不掩盖原始错误 */ }
        }
        return result;
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

async function initUserData() {
    console.log('[VLAN] 进程身份:', processIdentity());
    const candidates = [path.join(process.env.APPDATA || '', 'vlan'), path.join(process.env.LOCALAPPDATA || '', 'vlan')].filter(
        (p) => p && p.length > 3,
    ); // 防止环境变量缺失导致根目录

    const errors = [];
    for (const dir of candidates) {
        const r = await probeWritableDir(dir);
        if (r.ok) {
            app.setPath('userData', dir);
            console.log('[VLAN] userData =', dir, '（探针全部通过：mkdir/open/write/close/unlink）');
            return dir;
        }
        errors.push(
            `目录 ${dir} 不可写 | 失败阶段=${r.stage} code=${r.err.code} syscall=${r.err.syscall} path=${r.probeFile} | ${r.err.message}`,
        );
    }
    console.error('[VLAN] userData 初始化失败，所有候选均不可写，退出（不回退 Temp）：');
    errors.forEach((s) => console.error(`  - ${s}`));
    shellLog(`userData 初始化失败: ${errors.join(' | ')}`);
    dialog.showErrorBox(WindowTitle, `应用数据目录初始化失败：\n${errors.join('\n')}\n\n详见 shell 日志`);
    app.exit(1);
    return null;
}

// —— 异步引导：userData 就绪后再注册单实例锁与窗口生命周期（顺序：先 userData，后单例锁） ——
(async () => {
    const vlanUserData = await initUserData();
    if (vlanUserData === null) {
        // initUserData 内部已弹窗并调用 app.exit(1)，这里不再继续
        return;
    }
    process.env.ElectronAppUserPath = app.getPath('userData');
    bootstrapApp();
})();

// —— VLAN 壳日志系统：优先落盘到「应用目录\logs\」，不可写时逐级回退；全失败留内存 ——
const shellLogLines = [];
let shellLogPath = null;

function shellLog(msg) {
    const line = `${new Date().toISOString()} ${msg}`;
    shellLogLines.push(line);
    if (process.env.NODE_ENV === 'development') {
        console.log(`[shellLog] ${msg}`);
    }
    try {
        if (shellLogPath) {
            fs.appendFileSync(shellLogPath, `${line}\n`);
            return;
        }
        // 首次落盘：确定一个可写目录后固定使用
        const appDir = app.isPackaged ? path.dirname(app.getPath('exe')) : app.getAppPath();
        const candidates = [
            path.join(appDir, 'logs'), // 应用目录（打包后主位置）
            path.join(process.env.LOCALAPPDATA || '', 'vlan', 'logs'),
            path.join(process.env.APPDATA || '', 'vlan', 'logs'),
            path.join(os.tmpdir(), 'vlan', 'logs'),
            path.join(process.env.PUBLIC || '', 'vlan', 'logs'),
        ].filter((p) => p && p.length > 3);

        for (const dir of candidates) {
            try {
                fs.mkdirSync(dir, { recursive: true });
                const p = path.join(dir, `shell-${new Date().toISOString().slice(0, 10)}.log`);
                fs.appendFileSync(p, `${shellLogLines.join('\n')}\n`);
                shellLogPath = p;
                console.log('[VLAN] shell 日志落盘:', p);
                return;
            } catch (_) {
                /* 试下一个候选目录 */
            }
        }
        // 全部不可写：日志留在内存（shellLogLines），退出时由弹窗兜底展示
    } catch (_) {
        /* 日志失败不致命 */
    }
}
shellLog('=== shell 启动 ===');

// GPU：无条件在 app ready 之前禁用硬件加速，走软件渲染。
// 本机实测 GPU 进程启动即失败（error_code=18 → FATAL GPU process isn't usable），
// 为保证 Windows 10 设备能正常启动窗口，一律软件渲染；如需恢复硬件加速再按机器差异开关。
// 注意：这是禁用硬件加速，不是关闭 GPU sandbox。
app.disableHardwareAcceleration();
// 兜底开关：GPU 子进程创建在本机持续失败（error_code=18，子进程被安全软件沙箱掐断），
// Chromium 会因此在子进程多次失败后 FATAL 退出。--in-process-gpu 让 GPU 跑在主进程内，
// 不再创建 GPU 子进程；这不是关闭 GPU sandbox，也不改系统显卡驱动。
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('in-process-gpu');
shellLog('GPU: 已禁用硬件加速（软件渲染）+ in-process-gpu，调用时机 = app ready 之前');

const CORE_PORT = 7400;

let mainWindow = null;
let trayManager = null;
let forceQuit = false; // 托盘「退出」置位后，close 不再隐藏而是真关
const winURL = process.env.NODE_ENV === 'development' ? 'http://localhost:9080/' : `file://${__dirname}/`;

function setWindowTitle(str) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        if (str) {
            mainWindow.setTitle(`${WindowTitle} - ${str}`);
        } else {
            mainWindow.setTitle(WindowTitle);
        }
    }
}
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
        const req = http.get(
            {
                host: '127.0.0.1',
                port: CORE_PORT,
                path: p,
                timeout: 1200,
            },
            (res) => {
                res.resume();
                resolve(res.statusCode === 200);
            },
        );
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
        setWindowTitle('已有实例');
        shellLog('startCore: 已有实例');
        return;
    }
    const exe = corePath();
    if (!fs.existsSync(exe)) {
        setWindowTitle(`核心缺失 ${exe}`);
        shellLog(`startCore: 核心缺失 ${exe}`);
        throw new Error(`找不到核心: ${exe}`);
    }
    setWindowTitle(`提权拉起 ${exe}`);
    shellLog(`startCore: 提权拉起 ${exe}`);
    const ps = `Start-Process -FilePath '${exe}' -WorkingDirectory '${path.dirname(exe)}' -WindowStyle Hidden -Verb RunAs`;
    spawn('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true });
    for (let i = 0; i < 30; i += 1) {
        await new Promise((r) => setTimeout(r, 500));
        if (await httpOK('/ping')) {
            setWindowTitle(`核心就绪 (等待 ${(i + 1) * 0.5}s)`);
            shellLog(`startCore: 核心就绪 (等待 ${(i + 1) * 0.5}s)`);
            return;
        }
    }
    setWindowTitle('15 秒内核心未就绪');
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
function showMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) {
        createWindow();
        return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
}

function requestQuit() {
    shellLog('托盘请求退出');
    forceQuit = true;
    if (trayManager) {
        trayManager.destroy();
        trayManager = null;
    }
    if (mainWindow) {
        mainWindow.close(); // 触发 window-all-closed → 停核心 → app.quit
    } else {
        app.quit();
    }
}

function handleTrayAction(action) {
    shellLog(`托盘动作 [${action}] → 转发渲染层`);
    if (!mainWindow || mainWindow.isDestroyed()) {
        shellLog(`托盘动作 ${action}: 无窗口可接收`);
        return;
    }
    // 业务全在 home.vue（sqlite 注册服务 + 隧道安装都在那边），主进程只转发
    mainWindow.webContents.send('tray:action', action);
}

function initTray() {
    trayManager = new TrayManager({
        getAppPath: () => app.getAppPath(),
        getWindow: () => mainWindow,
        onShow: () => showMainWindow(),
        onAction: (a) => handleTrayAction(a),
        onQuit: () => requestQuit(),
    });
    trayManager.create();
    shellLog('托盘已创建');
}

function createWindow() {
    shellLog('createWindow: 创建主窗口');
    mainWindow = new BrowserWindow({
        width: 1024,
        height: 768,
        minWidth: 1024,
        minHeight: 768,
        center: true,
        backgroundColor: '#f3f5f7',
        title: WindowTitle,
        icon: path.join(__static, 'icon.ico'),
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            devTools: process.env.NODE_ENV === 'development',
            webviewTag: true,
        },
        // frame: false,
    });

    mainWindow.loadURL(`${winURL}index.html`);

    // 点关闭按钮 = 隐藏到托盘常驻，不退出（真正的退出走托盘菜单）
    mainWindow.on('close', (e) => {
        if (!forceQuit) {
            e.preventDefault();
            mainWindow.hide();
            shellLog('窗口关闭→隐藏到托盘');
        }
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    // 系统首页是登录页，不显示菜单栏和开发调试工具
    mainWindow.removeMenu();
    mainWindow.webContents.closeDevTools();
}

// —— 启动自检：程序路径含中文/非 ASCII 时，WireGuard 的隧道服务（LocalSystem）加载不了 exe ——
// 只负责判断，弹窗交给渲染层（home.vue），用户点确定后由那边发 app:quit 退出
function isAsciiPath(p) {
    return /^[\x20-\x7E]*$/.test(String(p || ''));
}

function installPathIssue() {
    // 开发模式目录本来就在中文路径下（D:\DS 工作\...），不拦；发行版才提示
    if (!app.isPackaged) return null;

    const coreDir = path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'core');
    const bundled = path.join(coreDir, 'wg', 'wireguard.exe');

    // 只有"应用自带 WireGuard"时路径才要紧；用系统那份的话装在哪都行
    if (!fs.existsSync(bundled)) return null;
    if (isAsciiPath(bundled)) return null;

    shellLog(`路径自检：自带 WireGuard 位于非 ASCII 路径 ${bundled}`);
    return { path: bundled };
}

ipcMain.handle('path:check', () => {
    const issue = installPathIssue();
    return issue ? { ok: false, path: issue.path } : { ok: true };
});

ipcMain.on('app:quit', () => {
    shellLog('路径自检未通过，用户确认后退出');
    app.quit();
});

// —— 轮询在主进程：渲染层只负责起停和收结果 ——
// 都用 setTimeout 串行，上一轮有结果才排下一轮，不会像 setInterval 那样在慢网络下堆请求
const poller = new Poller(() => mainWindow);

ipcMain.on('poll:core:start', (e, opts) => poller.startCore(opts || {}));
ipcMain.on('poll:core:stop', () => poller.stopCore());

ipcMain.on('poll:state:start', (e, opts) => {
    shellLog(`poll:state 启动 ${(opts && opts.url) || '(空)'}`);
    poller.startState(opts || {});
});
ipcMain.on('poll:state:stop', () => {
    shellLog('poll:state 停止');
    poller.stopState();
});

// —— 托盘通道：home.vue 推状态、接动作；缺参数时把窗口唤起来 ——
ipcMain.on('tray:state', (e, s) => {
    if (trayManager) trayManager.update(s || {});
});
ipcMain.on('tray:need-window', () => {
    showMainWindow();
    try {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('tray:focus-join');
        }
    } catch (_) { /* 焦点失败不致命 */ }
});

// 限制单实例应用（必须在 userData 初始化之后：单例锁就存在 userData 目录里）
function bootstrapApp() {
    const curInstance = app.requestSingleInstanceLock();
    if (!curInstance) {
        console.error(
            '[VLAN] 获取单实例锁失败：已有实例在运行，或同一 userData 目录被其他进程占用（可用任务管理器清理残留的 electron.exe / VLAN 组网.exe）',
        );
        shellLog('单实例锁获取失败，退出');
        app.quit();
        return;
    }
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
        // 路径自检：中文/非 ASCII 路径下，WireGuard 的隧道服务（LocalSystem）加载不了 exe
        // 路径自检的弹窗由渲染层负责（home.vue 通过 path:check 询问）
        createWindow();
        initTray();
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
                    setWindowTitle('核心未就绪');
                } catch (_) {
                    /* 提示通道也不能反过来把主进程搞崩 */
                }
            });
    });
}

// —— 异步引导入口见上方 initUserData() 的调用处 ——

app.on('window-all-closed', async () => {
    shellLog('window-all-closed: 停核心');
    if (trayManager) {
        trayManager.destroy();
        trayManager = null;
    }
    if (poller) poller.dispose();
    await stopCore();
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', () => {
    forceQuit = true; // 任何退出路径都不再走"隐藏"
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
