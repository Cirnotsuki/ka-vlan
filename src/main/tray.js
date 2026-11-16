// 系统托盘：图标随 WireGuard 实际连接状态切换，菜单随 mode 动态变化。
// 业务动作全部通过 opts.onAction(action) 回调转交给 home.vue 执行，这里不重复实现业务。
import { Tray, Menu, nativeImage } from 'electron';
import path from 'path';
import fs from 'fs';

const STATE_LABEL = {
    idle: '未连接',
    joining: '加入中…',
    serve: '已连接（服务器）',
    join: '已连接',
};

export default class TrayManager {
    constructor(opts) {
        this.opts = opts; // { getAppPath, getWindow, onAction(action), onQuit() }
        this.tray = null;
        this.state = { mode: 'idle', connected: false, vpnIp: '' };
    }

    // static 目录随启动形态漂移：仓库根（dev）、dist（以 dist 为 app 根）、resources/app（打包）、resources
    staticDir() {
        const appPath = this.opts.getAppPath();
        console.log(appPath);
        const candidates = [
            path.join(appPath, 'static'),
            path.join(appPath, 'dist', 'static'),
            path.join(appPath, '..', 'static'),
            path.join(process.resourcesPath || '', 'app', 'static'),
            path.join(process.resourcesPath || '', 'static'),
        ];
        return candidates.find((p) => fs.existsSync(p)) || candidates[0];
    }

    iconPath(mode, connected, joinErr) {
        let name = 'icon';
        if (joinErr) {
            name = 'disconnect';
        } else if (mode === 'stoping') {
            name = 'connect';
        } else if (connected) {
            name = 'connected';
        } else if (['starting', 'joining'].includes(mode)) {
            name = 'connect';
        }

        const p = path.join(this.staticDir(), `tray-${name}.ico`);

        console.log(p);

        const ok = fs.existsSync(p);
        console.log('[VLAN] tray 图标解析:', p, '->', ok ? '存在' : '不存在');
        return ok ? p : null;
    }

    // 获取右键菜单图标
    menuIcon(name) {
        const p = path.join(this.staticDir(), `menu-${name}.png`);

        const ok = fs.existsSync(p);
        console.log('[VLAN] menu 图标解析:', p, '->', ok ? '存在' : '不存在');
        if (!ok) return null;
        const image = nativeImage.createFromPath(p);

        if (image.isEmpty()) {
            console.warn('[VLAN] 菜单图标解码失败:', p);
            return null;
        }

        return image;
    }

    create() {
        if (this.tray) return; // 防重复创建
        const icon = this.iconPath(false);
        const img = icon ? nativeImage.createFromPath(icon) : nativeImage.createEmpty();
        console.log('[VLAN] tray 图标解码:', img.isEmpty() ? '失败(空图)' : `成功 ${img.getSize().width}x${img.getSize().height}`);
        this.tray = new Tray(img);
        this.tray.setToolTip('KA-VLAN 组网 - 未连接');
        this.rebuild();
        // 左键 / 双击：唤起主窗口
        this.tray.on('click', () => this.opts.onShow());
        this.tray.on('double-click', () => this.opts.onShow());
    }

    destroy() {
        if (this.tray) {
            this.tray.destroy();
            this.tray = null;
        }
    }

    // state: { mode, connected, vpnIp } —— 由 home.vue 通过 tray:state IPC 推送
    update(state) {
        if (!this.tray || !state) return;
        this.state = { ...this.state, ...state };
        this.rebuild();
    }

    rebuild() {
        if (!this.tray) return;

        const {
            mode, connected, vpnIp, joinErr,
        } = this.state;

        const stateLine = STATE_LABEL[mode] || mode;

        const items = [
            {
                label: `状态: ${stateLine}`,
                icon: this.menuIcon(connected ? 'online' : 'offline'),
                enabled: false,
            },
            {
                label: `地址: ${vpnIp || '未获取'}`,
                enabled: false,
            },
            { type: 'separator' },
        ];

        if (mode === 'idle') {
            items.push({
                label: '启动服务器',
                icon: this.menuIcon('start'),
                click: () => this.opts.onAction('start-serve'),
            });
            items.push({
                label: '加入服务器',
                icon: this.menuIcon('join'),
                click: () => this.opts.onAction('join'),
            });
        } else if (mode === 'serve') {
            items.push({
                label: '关闭服务器',
                icon: this.menuIcon('shutdown'),
                click: () => this.opts.onAction('stop-serve'),
            });
        } else if (mode === 'join') {
            items.push({
                label: '离开服务器',
                icon: this.menuIcon('leave'),
                click: () => this.opts.onAction('leave'),
            });
        } else if (mode === 'joining') {
            items.push({
                label: '加入中…',
                enabled: false,
            });
        }

        items.push({ type: 'separator' });

        items.push({
            label: '退出',
            icon: this.menuIcon('exit'),
            click: () => this.opts.onQuit(),
        });

        this.tray.setContextMenu(Menu.buildFromTemplate(items));

        const icon = this.iconPath(mode, connected, joinErr);
        if (icon) this.tray.setImage(nativeImage.createFromPath(icon));

        this.tray.setToolTip(`KA-VLAN 组网 - ${connected ? '已连接' : '未连接'}${vpnIp ? ` (${vpnIp})` : ''}`);
    }
}
