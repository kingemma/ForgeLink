import { describe, it, expect } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import i18n from '../i18n';
import DevicesView from '../views/DevicesView.vue';
import { useOmniStore } from '../stores';

const devices = [
  { id: 'd1', ip: '10.0.0.1', name: '在线臂', status: 'online', kind: 'robot-arm', driverLabel: '机械臂', interfaces: [], state: {} },
  { id: 'd2', ip: '10.0.0.2', name: '离线臂', status: 'offline', kind: 'robot-arm', driverLabel: '机械臂', interfaces: [], state: {} },
  { id: 'd3', ip: '10.0.0.3', name: '未知臂', status: 'unknown', kind: 'robot-arm', driverLabel: '机械臂', interfaces: [], state: {} },
];

async function mountView() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const wrapper = mount(DevicesView, { global: { plugins: [i18n, pinia] } });
  await flushPromises();
  const omni = useOmniStore();
  omni.devices = devices;
  await wrapper.vm.$nextTick();
  return wrapper;
}

const clickGroup = async (wrapper, label) => {
  const button = wrapper.findAll('button.chip').find((item) => item.text().includes(label));
  expect(button, `未找到分组按钮：${label}`).toBeTruthy();
  await button.trigger('click');
  await wrapper.vm.$nextTick();
};

describe('设备页：按状态分组', () => {
  it('默认「全部」展示所有设备', async () => {
    const wrapper = await mountView();
    expect(wrapper.findAll('.device-card').length).toBe(3);
  });

  it('点「在线」只显示在线设备', async () => {
    const wrapper = await mountView();
    await clickGroup(wrapper, '在线');
    expect(wrapper.findAll('.device-card').length).toBe(1);
    expect(wrapper.text()).toContain('在线臂');
    expect(wrapper.text()).not.toContain('离线臂');
  });

  it('点「离线」显示所有非在线设备（含 unknown，保证 全部=在线+离线）', async () => {
    const wrapper = await mountView();
    await clickGroup(wrapper, '离线');
    expect(wrapper.findAll('.device-card').length).toBe(2);
    const text = wrapper.text();
    expect(text).toContain('离线臂');
    expect(text).toContain('未知臂');
  });

  it('分组计数随数据变化', async () => {
    const wrapper = await mountView();
    const all = wrapper.findAll('button.chip').find((item) => item.text().includes('全部'));
    expect(all.text()).toContain('3');
    const online = wrapper.findAll('button.chip').find((item) => item.text().includes('在线'));
    expect(online.text()).toContain('1');
    const offline = wrapper.findAll('button.chip').find((item) => item.text().includes('离线'));
    expect(offline.text()).toContain('2');
  });

  it('分组后仍可与关键字搜索叠加', async () => {
    const wrapper = await mountView();
    await clickGroup(wrapper, '离线');
    await wrapper.find('input').setValue('未知');
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('.device-card').length).toBe(1);
    expect(wrapper.text()).toContain('未知臂');
  });
});

const clickText = async (wrapper, text) => {
  const button = wrapper.findAll('button').find((item) => item.text().trim() === text);
  expect(button, `未找到按钮：${text}`).toBeTruthy();
  await button.trigger('click');
  await flushPromises();
};

/** 用可观测的桩替换清空接口，用例结束后恢复，避免污染其它用例 */
async function withClearStub(run) {
  const original = window.omni.devices.clear;
  let calls = 0;
  window.omni.devices.clear = async () => {
    calls += 1;
    return { ok: true, removed: devices.length };
  };
  try {
    await run(() => calls);
  } finally {
    window.omni.devices.clear = original;
  }
}

describe('设备页：清空全部设备', () => {
  it('点「清空设备」先弹确认框，未确认前不动数据', async () => {
    const wrapper = await mountView();
    await withClearStub(async (calls) => {
      await clickText(wrapper, '清空设备');
      expect(wrapper.find('.confirm-panel').exists()).toBe(true);
      expect(wrapper.text()).toContain('清空全部设备');
      expect(calls()).toBe(0, '弹窗阶段不应调用内核');
      expect(wrapper.findAll('.device-card').length).toBe(3);
    });
  });

  it('点「取消」关闭弹窗且保留设备', async () => {
    const wrapper = await mountView();
    await withClearStub(async (calls) => {
      await clickText(wrapper, '清空设备');
      await clickText(wrapper, '取消');
      expect(wrapper.find('.confirm-panel').exists()).toBe(false);
      expect(calls()).toBe(0);
      expect(wrapper.findAll('.device-card').length).toBe(3);
    });
  });

  it('确认后调用内核并清空列表', async () => {
    const wrapper = await mountView();
    await withClearStub(async (calls) => {
      await clickText(wrapper, '清空设备');
      await clickText(wrapper, '确认清空');
      expect(calls()).toBe(1);
      expect(wrapper.find('.confirm-panel').exists()).toBe(false);
      expect(wrapper.findAll('.device-card').length).toBe(0);
      expect(wrapper.text()).toContain('尚未发现设备');
    });
  });

  it('没有设备时清空按钮禁用', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const wrapper = mount(DevicesView, { global: { plugins: [i18n, pinia] } });
    await flushPromises();
    const button = wrapper.findAll('button').find((item) => item.text().trim() === '清空设备');
    expect(button.attributes('disabled')).toBeDefined();
  });
});
