import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import i18n from '../i18n';
import GuideOverlay from '../components/GuideOverlay.vue';

const mountGuide = (open) =>
  mount(GuideOverlay, {
    props: { open },
    global: { plugins: [i18n, createPinia()] },
  });

describe('使用引导弹层', () => {
  it('open=false 时不渲染任何内容', () => {
    const wrapper = mountGuide(false);
    expect(wrapper.find('section').exists()).toBe(false);
  });

  it('open=true 时展示五个步骤', () => {
    const wrapper = mountGuide(true);
    expect(wrapper.findAll('.device-icon').length).toBe(5);
    const text = wrapper.text();
    expect(text).toContain('发现设备');
    expect(text).toContain('编排');
  });

  it('点右上角关闭按钮会发出 close', async () => {
    const wrapper = mountGuide(true);
    await wrapper.find('button.ghost').trigger('click');
    expect(wrapper.emitted('close')).toBeTruthy();
  });

  it('点「知道了」也会发出 close', async () => {
    const wrapper = mountGuide(true);
    await wrapper.find('button.primary').trigger('click');
    expect(wrapper.emitted('close')).toBeTruthy();
  });

  it('切换到英文后文案随之变化', async () => {
    const wrapper = mountGuide(true);
    i18n.global.locale.value = 'en';
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain('Discover devices');
    i18n.global.locale.value = 'zh';
  });
});
