// jsdom 的 navigator.language 多为 en-US，固定为中文，让界面断言稳定可复现
localStorage.setItem('forgelink.locale', 'zh');

/**
 * UI 测试环境。
 *
 * 渲染层只通过 window.omni 访问内核（preload 暴露的能力出口），
 * 这里给出可控的桩实现，使组件与状态逻辑可以脱离 Electron 单独验证。
 * 返回值都可以在单个用例里覆写，用来模拟内核的不同响应。
 */
const ok = { ok: true };

globalThis.window.omni = {
  on: () => () => {},
  app: {
    info: async () => ({ platform: 'test', version: '0.0.0-test', monitorIntervalMs: 2000 }),
  },
  logs: { recent: async () => [] },
  drivers: { list: async () => [] },
  discovery: { start: async () => ({ ok: true, devices: [], duration: 0, candidates: 0 }) },
  devices: {
    list: async () => [],
    history: async () => [],
    remove: async () => ok,
    clear: async () => ({ ok: true, removed: 0 }),
    rename: async () => ok,
    refresh: async () => ({}),
    state: async () => ({}),
    invoke: async () => ok,
  },
  monitor: { setInterval: async (ms) => ({ intervalMs: ms }) },
  workflow: {
    list: async () => [],
    save: async (workflow) => ({ ...workflow, updatedAt: Date.now() }),
    remove: async () => ok,
    run: async () => ({ ok: true, runId: 'r1', status: 'success' }),
    stop: async () => ok,
    validate: async () => ({ ok: true, errors: [], warnings: [] }),
  },
  simulator: {
    status: async () => ({ running: false, devices: [] }),
    start: async () => ({ running: true, devices: [] }),
    stop: async () => ({ running: false, devices: [] }),
  },
  demo: {
    generate: async () => ({
      ok: true,
      workflow: { id: 'demo-pick-and-label', name: '示例工作流', nodes: [], edges: [] },
      devices: [],
      simulator: { running: true, devices: [] },
    }),
  },
  settings: {
    getLocale: async () => 'zh',
    setLocale: async () => 'zh',
  },
};
