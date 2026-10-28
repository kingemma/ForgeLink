import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useUiStore } from '../stores/ui';
import { useOmniStore, useWorkflowStore } from '../stores';

describe('UI 偏好 store', () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it('主题切换并持久化到 localStorage', () => {
    const ui = useUiStore();
    ui.init();
    expect(document.documentElement.dataset.theme).toBe('dark');

    ui.toggleTheme();
    expect(ui.theme).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem('forgelink.theme')).toBe('light');

    ui.toggleTheme();
    expect(ui.theme).toBe('dark');
  });

  it('首次使用自动打开引导，关闭后记住，顶栏仍可再次打开', () => {
    const ui = useUiStore();
    ui.init();
    expect(ui.guideOpen).toBe(true, '首次应自动弹出');

    ui.closeGuide();
    expect(ui.guideOpen).toBe(false);
    expect(localStorage.getItem('forgelink.guideSeen')).toBe('1');

    setActivePinia(createPinia());
    const again = useUiStore();
    again.init();
    expect(again.guideOpen).toBe(false, '看过之后不应自动弹');

    again.openGuide();
    expect(again.guideOpen).toBe(true, '❓ 入口应能再次打开');
  });
});


describe('设备 store：清空与一键演示', () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    // 用例会覆写桩，这里复位到默认值，避免互相影响
    window.omni.workflow.list = async () => [];
  });

  it('clearDevices 同时清空设备、选中项与时序', async () => {
    const store = useOmniStore();
    store.devices = [{ id: 'd1' }, { id: 'd2' }];
    store.selectedDeviceId = 'd1';
    store.history = [{ ts: 1, values: {} }];
    window.omni.devices.clear = async () => ({ ok: true, removed: 2 });

    const result = await store.clearDevices();
    expect(result.ok).toBe(true);
    expect(store.devices).toEqual([]);
    expect(store.selectedDeviceId).toBeNull();
    expect(store.history).toEqual([]);
  });

  it('generateDemo 成功后刷新设备、模拟器并跳到示例工作流', async () => {
    const store = useOmniStore();
    const demoWorkflow = {
      id: 'demo-pick-and-label',
      name: '示例工作流',
      nodes: [{ id: 'n1', type: 'delay', label: '等待', params: { ms: 10 }, pos: { x: 1, y: 2 } }],
      edges: [],
    };
    window.omni.workflow.list = async () => [demoWorkflow];
    window.omni.demo.generate = async () => ({
      ok: true,
      workflow: demoWorkflow,
      devices: [{ id: 'sim-robot', kind: 'robot-arm' }],
      simulator: { running: true, devices: [] },
    });

    const result = await store.generateDemo();
    expect(result.ok).toBe(true);
    expect(store.devices).toHaveLength(1);
    expect(store.simulator.running).toBe(true);
    expect(store.view).toBe('workflow', '生成后应把用户带到编排页');
    expect(useWorkflowStore().currentId).toBe('demo-pick-and-label');
    expect(store.demoGenerating).toBe(false, '结束后必须复位');
  });

  it('generateDemo 失败时保留已有设备、不跳转并复位状态', async () => {
    const store = useOmniStore();
    store.devices = [{ id: 'keep' }];
    window.omni.demo.generate = async () => ({ ok: false, reason: '未发现机械臂或打印机' });

    const result = await store.generateDemo();
    expect(result.ok).toBe(false);
    expect(store.devices).toEqual([{ id: 'keep' }]);
    expect(store.view).toBe('devices', '失败不应切换页面');
    expect(store.demoGenerating).toBe(false);
  });

  it('生成中重复点击不会并发触发两轮发现', async () => {
    const store = useOmniStore();
    let calls = 0;
    window.omni.demo.generate = async () => {
      calls += 1;
      return { ok: true, devices: [], simulator: { running: true, devices: [] } };
    };

    const [first, second] = await Promise.all([store.generateDemo(), store.generateDemo()]);
    expect(calls).toBe(1);
    expect(first.ok).toBe(true);
    expect(second).toBeNull();
  });
});
