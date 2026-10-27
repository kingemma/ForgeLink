const { contextBridge, ipcRenderer } = require('electron');

/**
 * 预加载脚本：渲染进程的唯一能力出口。
 *
 * 只暴露与内核能力一一对应的方法，不暴露 ipcRenderer 本体，
 * 这样界面层无法绕过内核直接访问系统资源。
 */
const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

/** 订阅内核事件，返回取消订阅函数 */
function on(channel, handler) {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('omni', {
  on,
  app: {
    info: () => invoke('app:info'),
  },
  logs: {
    recent: () => invoke('logs:recent'),
  },
  drivers: {
    list: () => invoke('drivers:list'),
  },
  discovery: {
    start: (options) => invoke('discovery:start', options),
  },
  devices: {
    list: () => invoke('devices:list'),
    history: (id) => invoke('devices:history', id),
    remove: (id) => invoke('devices:remove', id),
    clear: () => invoke('devices:clear'),
    refresh: (id) => invoke('device:refresh', id),
    state: (id) => invoke('device:state', id),
    invoke: (deviceId, action, params) => invoke('device:invoke', { deviceId, action, params }),
  },
  monitor: {
    setInterval: (ms) => invoke('monitor:set', ms),
  },
  workflow: {
    list: () => invoke('workflow:list'),
    save: (workflow) => invoke('workflow:save', workflow),
    remove: (id) => invoke('workflow:remove', id),
    run: (id, input) => invoke('workflow:run', { id, input }),
    stop: (runId) => invoke('workflow:stop', runId),
  },
  simulator: {
    status: () => invoke('simulator:status'),
    start: () => invoke('simulator:start'),
    stop: () => invoke('simulator:stop'),
  },
  settings: {
    getLocale: () => invoke('settings:getLocale'),
    setLocale: (locale) => invoke('settings:setLocale', locale),
  },
});
