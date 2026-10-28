import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import i18n from '../i18n';
import NodeInspector from '../components/NodeInspector.vue';

const mountInspector = (node) =>
  mount(NodeInspector, {
    props: { node, devices: [], nodes: [] },
    global: { plugins: [i18n, createPinia()] },
  });

describe('节点配置面板', () => {
  it('未选择节点时显示提示', () => {
    const wrapper = mountInspector(null);
    expect(wrapper.text()).toContain('选择');
  });

  it('设备动作节点：显示设备与动作下拉', () => {
    const wrapper = mountInspector({
      id: 'n1',
      type: 'device',
      label: '移动',
      params: { deviceId: 'dev_1', action: 'moveTo', params: {} },
    });
    expect(wrapper.findAll('select').length).toBe(2);
  });

  it('waitUntil 交接节点：显示设备、条件表达式、超时与轮询间隔', () => {
    const wrapper = mountInspector({
      id: 'n2',
      type: 'waitUntil',
      label: '等待就位',
      params: {
        deviceId: 'dev_1',
        expression: '{{ eq(state.metrics.status, "idle") }}',
        timeoutMs: 8000,
        intervalMs: 400,
      },
    });
    expect(wrapper.findAll('select').length).toBe(1);
    expect(wrapper.find('textarea').exists()).toBe(true, '应显示条件表达式输入框');
    expect(wrapper.findAll('input[type="number"]').length).toBe(2, '应显示超时与轮询间隔');
    // 节点名称是输入框的 value，不是文本节点
    const nameInput = wrapper.find('input:not([type="number"])');
    expect(nameInput.element.value).toBe('等待就位');
    expect(wrapper.find('textarea').element.value).toContain('eq(state.metrics.status');
  });

  it('延迟节点：显示毫秒输入', () => {
    const wrapper = mountInspector({
      id: 'n3',
      type: 'delay',
      label: '等待',
      params: { ms: 1500 },
    });
    expect(wrapper.findAll('input[type="number"]').length).toBe(1);
  });

  it('点击删除发出 remove(nodeId)', async () => {
    const wrapper = mountInspector({
      id: 'n9',
      type: 'notify',
      label: '通知',
      params: { message: 'hi' },
    });
    await wrapper.find('button.danger').trigger('click');
    expect(wrapper.emitted('remove')[0]).toEqual(['n9']);
  });
});
