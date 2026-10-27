import { createI18n } from 'vue-i18n';
import zh from './locales/zh';
import en from './locales/en';

const STORAGE_KEY = 'forgelink.locale';

function detectLocale() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === 'zh' || saved === 'en') return saved;
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export const i18n = createI18n({
  legacy: false,
  locale: detectLocale(),
  fallbackLocale: 'zh',
  messages: { zh, en },
});

export const availableLocales = [
  { code: 'zh', label: '中文' },
  { code: 'en', label: 'EN' },
];

export function persistLocale(locale) {
  localStorage.setItem(STORAGE_KEY, locale);
}

export default i18n;
