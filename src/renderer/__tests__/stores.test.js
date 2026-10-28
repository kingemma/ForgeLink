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

describe('编排 store', () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it('liveStates 由内核事件累积出每个节点的实时状态', () => {
    const store = useWorkflowStore();
    store.pushEvent({ runId: 'r1', event: 'run:start' });
    expect(store.currentRunId).toBe('r1');

    store.pushEvent({ runId: 'r1', event: 'node:start', nodeId: 'a' });
    expect(store.liveStates.a).toBe('running');

    store.pushEvent({ runId: 'r1', event: 'node:done', nodeId: 'a', result: { ok: true } });
    expect(store.liveStates.a).toBe('ok');

    store.pushEvent({ runId: 'r1', event: 'node:skip', nodeId: 'b' });
    expect(store.liveStates.b).toBe('skipped');

    store.pushEvent({ runId: 'r1', event: 'node:done', nodeId: 'c', result: { ok: false, error: 'boom' } });
    expect(store.liveStates.c).toBe('error');
  });

  it('只统计当前这一次运行的事件', () => {
    const store = useWorkflowStore();
    store.pushEvent({ runId: 'old', event: 'node:done', nodeId: 'x', result: { ok: true } });
    store.pushEvent({ runId: 'new', event: 'run:start' });
    store.pushEvent({ runId: 'old', event: 'node:done', nodeId: 'y', result: { ok: true } });
    expect(store.liveStates.x).toBeUndefined();
    expect(store.liveStates.y).toBeUndefined();
  });

  it('校验不通过时不发起运行', async () => {
    const store = useWorkflowStore();
    store.create();
    window.omni.workflow.validate = async () => ({ ok: false, errors: [{ code: 'empty', message: '没有节点' }], warnings: [] });
    let ran = false;
    window.omni.workflow.run = async () => {
      ran = true;
      return {};
    };
    const result = await store.run();
    expect(result).toBeNull();
    expect(ran).toBe(false, '校验失败不应发起运行');
    expect(store.validation.ok).toBe(false);
  });

  it('校验通过时正常发起运行', async () => {
    const store = useWorkflowStore();
    store.create();
    window.omni.workflow.validate = async () => ({ ok: true, errors: [], warnings: [] });
    let ran = false;
    window.omni.workflow.run = async () => {
      ran = true;
      return { runId: 'r9', status: 'success', results: {} };
    };
    await store.run();
    expect(ran).toBe(true);
    expect(store.runResult.status).toBe('success');
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
