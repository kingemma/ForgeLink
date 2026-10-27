import { defineStore } from 'pinia';
import { i18n, persistLocale } from '../i18n';

const THEME_KEY = 'forgelink.theme';

/**
 * 界面级别的偏好（语言 / 主题）。
 * 语言同时下发到内核：内核的进度文案、示例工作流等会按同一语言生成。
 */
export const useUiStore = defineStore('ui', {
  state: () => ({
    locale: i18n.global.locale.value,
    theme: localStorage.getItem(THEME_KEY) || 'dark',
  }),
  actions: {
    init() {
      this.applyLocale();
      this.applyTheme();
      // 让内核以同一语言生成发现进度、示例工作流等文案
      window.omni?.settings?.setLocale?.(this.locale);
    },
    setLocale(locale) {
      if (locale !== 'zh' && locale !== 'en') return;
      this.locale = locale;
      persistLocale(locale);
      this.applyLocale();
      window.omni?.settings?.setLocale?.(locale);
    },
    setTheme(theme) {
      this.theme = theme === 'light' ? 'light' : 'dark';
      localStorage.setItem(THEME_KEY, this.theme);
      this.applyTheme();
    },
    toggleTheme() {
      this.setTheme(this.theme === 'dark' ? 'light' : 'dark');
    },
    applyLocale() {
      i18n.global.locale.value = this.locale;
    },
    applyTheme() {
      document.documentElement.dataset.theme = this.theme;
    },
  },
});
