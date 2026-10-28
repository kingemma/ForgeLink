import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import i18n from '../i18n';
import DeviceCard from '../components/DeviceCard.vue';

const device = {
  id: 'dev_1',
  ip: '192.168.1.15',
  name: '装配臂A',
  kind: 'robot-arm',
  driverLabel: '机械臂',
  status: 'online',
  interfaces: [{ port: 502, protocol: 'modbus-tcp' }],
  state: { load: 120 },
};

const mountCard = () =>
  mount(DeviceCard, {
    props: { device, selected: false },
    global: { plugins: [i18n, createPinia()] },
  });

describe('设备卡片', () => {
  it('展示设备名与 IP', () => {
    const wrapper = mountCard();
    expect(wrapper.text()).toContain('装配臂A');
    expect(wrapper.text()).toContain('192.168.1.15');
  });

  it('未命名时回退为「驱动 @ IP」', () => {
    const wrapper = mount(DeviceCard, {
      props: { device: { ...device, name: null } },
      global: { plugins: [i18n, createPinia()] },
    });
    expect(wrapper.text()).toContain('机械臂 @ 192.168.1.15');
  });

  it('点 ✎ 进入编辑态并出现输入框', async () => {
    const wrapper = mountCard();
    await wrapper.find('button.ghost').trigger('click');
    expect(wrapper.find('input').exists()).toBe(true);
  });

  it('Enter 提交改名，发出 rename(id, name)', async () => {
    const wrapper = mountCard();
    await wrapper.find('button.ghost').trigger('click');
    const input = wrapper.find('input');
    await input.setValue('装配臂B');
    await input.trigger('keydown.enter');
    const emitted = wrapper.emitted('rename');
    expect(emitted).toBeTruthy();
    expect(emitted[0]).toEqual(['dev_1', '装配臂B']);
  });

  it('Esc 取消编辑且不发出 rename', async () => {
    const wrapper = mountCard();
    await wrapper.find('button.ghost').trigger('click');
    await wrapper.find('input').trigger('keydown.esc');
    expect(wrapper.emitted('rename')).toBeFalsy();
  });

  it('名字没改动时不发出 rename', async () => {
    const wrapper = mountCard();
    await wrapper.find('button.ghost').trigger('click');
    const input = wrapper.find('input');
    await input.setValue('装配臂A');
    await input.trigger('keydown.enter');
    expect(wrapper.emitted('rename')).toBeFalsy();
  });
});
