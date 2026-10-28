const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');

const bus = require('./kernel/bus');
const { t, setSettingsDir, loadLocale, getLocale, setLocale } = require('./i18n');
const { Store } = require('./kernel/store');
const { Registry } = require('./kernel/registry');
const { DiscoveryService } = require('./discovery');
const { localSubnets } = require('./discovery/arp');
const { Agent } = require('./runtime/agent');
const { Monitor } = require('./runtime/monitor');
const { WorkflowEngine } = require('./runtime/workflow/engine');
const { validateWorkflow } = require('./runtime/workflow/validate');
const { listDrivers } = require('./drivers');
const { SimulatorCluster } = require('./simulator');

/**
 * 应用外壳（Electron 主进程）。
 *
 * 这里是「内核」与「界面」的唯一接缝：渲染进程只能通过预加载脚本暴露的 IPC 调用内核，
 * 内核的所有异步事件再通过 webContents 单向推送给界面。
 * 这样协议、驱动、工作流等全部逻辑都在 Node 侧，UI 可以纯粹地做展示与编排。
 */
const DEV_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
const RENDERER_FILE = path.join(__dirname, '..', '..', 'dist-renderer', 'index.html');
const MAX_LOGS = 500;
const DEMO_WORKFLOW_ID = 'demo-pick-and-label';

let mainWindow = null;
const logs = [];

const store = new Store(path.join(app.getPath('userData'), 'forgelink.json'), {
  devices: [],
  workflows: [],
  settings: { monitorIntervalMs: 2000, autoSimulator: true },
});
const registry = new Registry();
const discovery = new DiscoveryService(registry);
const agent = new Agent({ registry, store });
const monitor = new Monitor({ registry, agent, intervalMs: store.get('settings').monitorIntervalMs || 2000 });
const engine = new WorkflowEngine({ agent, registry });
let simulator = null;

// ---------------------------------------------------------------- 事件桥接
bus.on('log', (entry) => {
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
  send('omni:log', entry);
});
bus.on('devices:changed', (devices) => {
  persistDevices(devices);
  send('omni:devices', devices);
});
bus.on('device:state', (payload) => send('omni:device-state', payload));
bus.on('discovery:progress', (payload) => send('omni:discovery-progress', payload));
bus.on('workflow:event', (payload) => send('omni:workflow-event', payload));

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function persistDevices(devices) {
  store.update('devices', () => devices.map(stripVolatile));
}

/** 驱动实例与时序缓冲不落盘，只保留档案与接口事实 */
function stripVolatile(device) {
  return {
    id: device.id,
    ip: device.ip,
    mac: device.mac,
    name: device.name,
    nameLocked: device.nameLocked,
    vendor: device.vendor,
    model: device.model,
    kind: device.kind,
    driver: device.driver,
    driverLabel: device.driverLabel,
    fitness: device.fitness,
    capabilities: device.capabilities,
    interfaces: device.interfaces,
    facts: device.facts,
    tags: device.tags,
    status: device.status,
    state: device.state,
    firstSeen: device.firstSeen,
    lastSeen: device.lastSeen,
  };
}

// ---------------------------------------------------------------- 窗口
/**
 * 系统绘制的窗口按钮区不吃 CSS 变量，只能按主题传纯色；
 * 取顶栏渐变的基色，避免右上角出现一块与顶栏不搭的底色。
 */
const TITLEBAR_THEMES = {
  dark: { color: '#0d1526', symbolColor: '#e8effa' },
  light: { color: '#f1f5fb', symbolColor: '#1b2735' },
};

function titleBarOverlay(theme) {
  return { ...(TITLEBAR_THEMES[theme] || TITLEBAR_THEMES.dark), height: 38 };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0b1220',
    title: 'ForgeLink · 轻量级车间控制器',
    // 任务栏 / 窗口标题栏图标；安装包图标由 build/icon.png 生成
    icon: path.join(__dirname, 'icon.png'),
    // 页面内自定义标题栏承载 logo 与程序名，最小化/关闭交给系统 overlay
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlay('dark'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // 渲染进程的错误需要落到主进程日志里，否则桌面端出问题无从排查
  mainWindow.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) console.error('[renderer]', message);
  });
  mainWindow.webContents.on('did-fail-load', (_event, code, description) => {
    console.error('[renderer] 加载失败', code, description);
  });

  // --dev：强制连 Vite 开发服务器（热更新）；否则优先加载已构建的产物
  const forceDev = process.argv.includes('--dev');
  const load = !forceDev && fs.existsSync(RENDERER_FILE) ? mainWindow.loadFile(RENDERER_FILE) : mainWindow.loadURL(DEV_URL);
  load.catch(() => mainWindow.loadURL(DEV_URL));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------- 默认工作流
/**
 * 生成「机械臂 + 打印机」示例编排。
 *
 * 只在两类设备都已入档时才生成。force 为真时按最新设备 id 重建：
 * 模拟器重启或设备换了 IP 后，旧工作流里的 deviceId 会指向不存在的设备。
 */
function ensureDemoWorkflow({ force = false } = {}) {
  const existing = store.get('workflows', []);
  if (!force && existing.some((workflow) => workflow.id === DEMO_WORKFLOW_ID)) return null;
  const devices = registry.list();
  const robot = devices.find((device) => device.kind === 'robot-arm');
  const printer = devices.find((device) => device.kind === 'printer');
  if (!robot || !printer) return null;

  const workflow = {
    id: DEMO_WORKFLOW_ID,
    name: t('demo.name'),
    description: t('demo.description'),
    nodes: [
      { id: 'n1', type: 'state', label: t('demo.node.readState'), params: { deviceId: robot.id } },
      { id: 'n2', type: 'device', label: t('demo.node.moveToPick'), params: { deviceId: robot.id, action: 'moveTo', params: { joints: [45, -10, 20, 0, 30, 0] } } },
      { id: 'n3', type: 'device', label: t('demo.node.pick'), params: { deviceId: robot.id, action: 'pick', params: { force: 70 } } },
      { id: 'n4', type: 'delay', label: t('demo.node.waitGrip'), params: { ms: 1200 } },
      { id: 'n5', type: 'device', label: t('demo.node.moveToPlace'), params: { deviceId: robot.id, action: 'moveTo', params: { joints: [-30, 25, -15, 0, 45, 90] } } },
      { id: 'n6', type: 'device', label: t('demo.node.release'), params: { deviceId: robot.id, action: 'release', params: {} } },
      {
        id: 'n7',
        type: 'transform',
        label: t('demo.node.assembleCode'),
        params: { expression: 'CYCLE-{{ nodes.n1.output.metrics.cycleCount }}' },
      },
      {
        id: 'n8',
        type: 'device',
        label: t('demo.node.printLabel'),
        params: { deviceId: printer.id, action: 'printLabel', params: { title: t('demo.labelTitle'), code: '{{ nodes.n7.output }}' } },
      },
      { id: 'n9', type: 'notify', label: t('demo.node.done'), params: { message: t('demo.notifyMessage') } },
    ],
    edges: [
      { from: 'n1', to: 'n2' },
      { from: 'n2', to: 'n3' },
      { from: 'n3', to: 'n4' },
      { from: 'n4', to: 'n5' },
      { from: 'n5', to: 'n6' },
      { from: 'n6', to: 'n7' },
      { from: 'n7', to: 'n8' },
      { from: 'n8', to: 'n9' },
    ],
    updatedAt: Date.now(),
  };
  store.update('workflows', (list) => [...list.filter((item) => item.id !== DEMO_WORKFLOW_ID), workflow], []);
  bus.info('workflow', t('workflow.created'));
  return workflow;
}

/**
 * 兜底：模拟器已经在自己机器上监听端口，但广播通道可能被防火墙挡住。
 * 演示场景下直接把模拟器档案写进注册表，保证「一键演示」不依赖网络环境。
 */
function registerSimulatorDevices() {
  if (!simulator?.running) return [];
  const localIp = localSubnets()[0]?.address || '127.0.0.1';
  // 只补缺的那一类：局域网里已有真实机械臂时不该再塞一台虚拟的
  const knownKinds = new Set(registry.list().map((device) => device.kind));
  const created = [];
  for (const manifest of simulator.manifest) {
    if (knownKinds.has(manifest.kind)) continue;
    created.push(
      registry.upsert({
        // 同一 IP 上会挂多台模拟设备，必须用 kind 区分 id，否则会互相覆盖
        id: `${Registry.keyOf(localIp)}__sim-${manifest.kind}`,
        ip: localIp,
        name: manifest.name,
        kind: manifest.kind,
        vendor: manifest.vendor,
        model: manifest.model,
        tags: ['simulator', manifest.kind],
        interfaces: (manifest.interfaces || []).map((item) => ({
          port: item.port,
          protocol: item.protocol,
          transport: item.transport || 'tcp',
          confidence: 1,
          evidence: { source: 'simulator', description: item.description || null },
        })),
        status: 'online',
      }),
    );
  }
  return created;
}

/** 演示需要机械臂与打印机同时在场，缺任何一类就用模拟器补齐 */
function hasDemoDevices() {
  const devices = registry.list();
  return devices.some((device) => device.kind === 'robot-arm') && devices.some((device) => device.kind === 'printer');
}

// ---------------------------------------------------------------- IPC
function registerIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    userData: app.getPath('userData'),
    agent: agent.summary(),
    monitorIntervalMs: monitor.intervalMs,
  }));

  ipcMain.handle('logs:recent', () => logs.slice(-300));

  ipcMain.handle('drivers:list', () => listDrivers());

  ipcMain.handle('discovery:start', async (_event, options = {}) => {
    const result = await discovery.scan(options);
    agent.syncAll();
    ensureDemoWorkflow();
    return result;
  });

  ipcMain.handle('devices:list', () => registry.list());
  ipcMain.handle('devices:history', (_event, id) => registry.getHistory(id));
  ipcMain.handle('devices:remove', (_event, id) => {
    registry.remove(id);
    return { ok: true };
  });
  ipcMain.handle('devices:rename', (_event, { id, name } = {}) => {
    const device = registry.rename(id, name);
    if (device) bus.info('device', `设备已重命名为「${device.name || device.ip}」`);
    return { ok: Boolean(device), device };
  });

  ipcMain.handle('devices:clear', async () => {
    const removed = registry.list().length;
    registry.clear();
    // 先关掉每个驱动再清缓存：残留实例会握着旧连接与句柄
    await Promise.allSettled([...agent.drivers.values()].map((entry) => entry.driver?.close?.()));
    agent.drivers.clear();
    bus.info('device', t('devices.cleared', { n: removed }));
    return { ok: true, removed };
  });

  ipcMain.handle('demo:generate', async () => {
    if (!simulator?.running) {
      simulator = new SimulatorCluster();
      simulator.start();
      bus.info('simulator', t('simulator.started'));
    }

    // 只走 ARP 表 + 广播通道：演示按钮不该因为 /24 全网枚举转十几秒
    const scan = await discovery.scan({ deep: false, includeSubnetScan: false });
    agent.syncAll();

    // 广播被防火墙挡住时用模拟器档案兜底，保证演示不依赖网络环境
    if (!hasDemoDevices()) registerSimulatorDevices();
    agent.syncAll();

    const workflow = ensureDemoWorkflow({ force: true });
    if (!workflow) {
      bus.warn('demo', t('demo.noDevices'));
      return { ok: false, reason: t('demo.noDevices'), devices: registry.list(), simulator: simulator.status() };
    }

    bus.info('demo', t('demo.generated', { name: workflow.name }));
    return { ok: true, workflow, devices: registry.list(), simulator: simulator.status(), discovery: scan };
  });

  ipcMain.handle('device:refresh', async (_event, id) => {
    const entry = await agent.refresh(id);
    return { ok: true, driver: entry.driverId, label: entry.label };
  });

  ipcMain.handle('device:invoke', async (_event, { deviceId, action, params }) => {
    const result = await agent.invoke(deviceId, action, params || {});
    return result;
  });

  ipcMain.handle('device:state', async (_event, deviceId) => agent.readState(deviceId));

  ipcMain.handle('monitor:set', (_event, intervalMs) => {
    monitor.intervalMs = Math.max(500, Number(intervalMs) || 2000);
    store.update('settings', (settings) => ({ ...settings, monitorIntervalMs: monitor.intervalMs }), {});
    return { ok: true, intervalMs: monitor.intervalMs };
  });

  ipcMain.handle('workflow:list', () => store.get('workflows', []));
  ipcMain.handle('workflow:save', (_event, workflow) => {
    const saved = { ...workflow, updatedAt: Date.now() };
    store.update('workflows', (list) => {
      const index = list.findIndex((item) => item.id === saved.id);
      if (index >= 0) {
        const next = [...list];
        next[index] = saved;
        return next;
      }
      return [...list, saved];
    }, []);
    bus.info('workflow', t('workflow.saved', { name: saved.name }));
    return saved;
  });
  ipcMain.handle('workflow:validate', (_event, workflow) => validateWorkflow(workflow, registry));

  ipcMain.handle('workflow:remove', (_event, id) => {
    store.update('workflows', (list) => list.filter((item) => item.id !== id), []);
    return { ok: true };
  });
  ipcMain.handle('workflow:run', async (_event, { id, input }) => {
    const workflow = store.get('workflows', []).find((item) => item.id === id);
    if (!workflow) throw new Error(`工作流不存在：${id}`);
    return engine.run(workflow, { input });
  });
  ipcMain.handle('workflow:stop', (_event, runId) => ({ ok: engine.stop(runId) }));

  ipcMain.handle('simulator:status', () => (simulator ? simulator.status() : { running: false, devices: [] }));
  ipcMain.handle('simulator:start', () => {
    if (simulator?.running) return simulator.status();
    simulator = new SimulatorCluster();
    simulator.start();
    bus.info('simulator', t('simulator.started'));
    return simulator.status();
  });
  ipcMain.handle('simulator:stop', () => {
    simulator?.stop();
    simulator = null;
    bus.info('simulator', t('simulator.stopped'));
    return { running: false };
  });

  ipcMain.handle('settings:getLocale', () => getLocale());
  ipcMain.handle('settings:setLocale', (_event, next) => setLocale(next));

  // 主题切换时同步窗口按钮区配色；macOS 没有 overlay，返回 ok:false 让界面忽略
  ipcMain.handle('window:theme', (_event, theme) => {
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
    if (typeof mainWindow.setTitleBarOverlay !== 'function') return { ok: false };
    mainWindow.setTitleBarOverlay(titleBarOverlay(theme));
    return { ok: true };
  });
}

// ---------------------------------------------------------------- 生命周期
function bootstrap() {
  setSettingsDir(app.getPath('userData'));
  loadLocale();
  const saved = store.get('devices', []);
  for (const device of saved) {
    registry.devices.set(device.id, { ...device, status: 'unknown' });
  }
  if (saved.length) {
    registry._emit();
    agent.syncAll();
    bus.info('agent', t('agent.restored', { n: saved.length }));
  }

  // 菜单栏（文件/编辑/视图/帮助）与自定义标题栏重复，直接去掉
  Menu.setApplicationMenu(null);

  registerIpc();
  createWindow();
  discovery.startPassive();
  monitor.start();

  if (store.get('settings', {}).autoSimulator) {
    simulator = new SimulatorCluster();
    simulator.start();
    bus.info('simulator', t('simulator.autoStarted'));
  }

  // 启动后自动做一轮快速发现：打开就能看到局域网里有什么，而不是面对空白面板
  setTimeout(() => {
    if (discovery.running) return;
    bus.info('agent', t('agent.autoDiscover'));
    discovery
      .scan({ deep: false })
      .then(() => {
        agent.syncAll();
        ensureDemoWorkflow();
      })
      .catch((error) => bus.error('discovery', t('discovery.autoFailed', { msg: error.message })));
  }, 1500);
}

// Windows 任务栏/通知按 AppUserModelID 分组，缺省会归到 electron.exe 名下并显示它的图标
app.setAppUserModelId('com.forgelink.desktop');

app.whenReady().then(bootstrap);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  monitor.stop();
  discovery.stopPassive();
  simulator?.stop();
  store.flush();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
