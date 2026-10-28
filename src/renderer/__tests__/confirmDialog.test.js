import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import i18n from '../i18n';
import ConfirmDialog from '../components/ConfirmDialog.vue';

const mountDialog = (props = {}) =>
  mount(ConfirmDialog, {
    props: { open: true, title: '清空全部设备', message: '将移除 3 台设备', confirmText: '确认清空', cancelText: '取消', ...props },
    global: { plugins: [i18n, createPinia()] },
  });

describe('确认弹窗', () => {
  it('open=false 时不渲染遮罩', () => {
    const wrapper = mountDialog({ open: false });
    expect(wrapper.find('.confirm-mask').exists()).toBe(false);
  });

  it('展示标题、说明与自定义按钮文案', () => {
    const wrapper = mountDialog();
    const text = wrapper.text();
    expect(text).toContain('清空全部设备');
    expect(text).toContain('将移除 3 台设备');
    expect(text).toContain('确认清空');
    expect(text).toContain('取消');
  });

  it('确认按钮发出 confirm，取消按钮发出 cancel', async () => {
    const wrapper = mountDialog();
    const buttons = wrapper.findAll('button');
    await buttons.find((item) => item.text().trim() === '确认清空').trigger('click');
    await buttons.find((item) => item.text().trim() === '取消').trigger('click');
    expect(wrapper.emitted('confirm')).toHaveLength(1);
    expect(wrapper.emitted('cancel')).toHaveLength(1);
  });

  it('点遮罩空白处等同取消', async () => {
    const wrapper = mountDialog();
    await wrapper.find('.confirm-mask').trigger('click');
    expect(wrapper.emitted('cancel')).toHaveLength(1);
  });
});
