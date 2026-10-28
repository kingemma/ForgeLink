import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

/**
 * 界面层测试配置。
 * 渲染层只通过 window.omni 与内核通信，因此测试里用桩替换它（见 test/ui.setup.js），
 * 这样组件/状态逻辑可以脱离 Electron 单独验证。
 */
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src/renderer', import.meta.url)) },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/renderer/**/*.test.js'],
    setupFiles: ['./test/ui.setup.js'],
  },
});
