<script setup>
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useOmniStore } from './stores';
import { useUiStore } from './stores/ui';
import { availableLocales } from './i18n';
import GuideOverlay from './components/GuideOverlay.vue';
import DevicesView from './views/DevicesView.vue';
import WorkflowView from './views/WorkflowView.vue';
import MonitorView from './views/MonitorView.vue';
import LogsView from './views/LogsView.vue';

const { t } = useI18n();
const store = useOmniStore();
const ui = useUiStore();
const demoError = ref('');

const NAV = [
  { id: 'devices', icon: '🧩' },
  { id: 'workflow', icon: '🔗' },
  { id: 'monitor', icon: '📈' },
  { id: 'logs', icon: '📜' },
];

const VIEW_MAP = { devices: DevicesView, workflow: WorkflowView, monitor: MonitorView, logs: LogsView };
const currentView = computed(() => VIEW_MAP[store.view]);

const progressPercent = computed(() =>
  store.discovery.total ? Math.round((store.discovery.current / store.discovery.total) * 100) : 0,
);

/** 一键演示：设备发现与工作流重建都在 store 里完成，这里只负责失败提示 */
async function handleGenerateDemo() {
  demoError.value = '';
  try {
    const result = await store.generateDemo();
    if (!result?.ok) showDemoError(result?.reason);
  } catch (error) {
    showDemoError(error.message);
  }
}

/** 失败提示只在顶栏停留几秒，完整原因主进程已写入日志 */
function showDemoError(reason) {
  demoError.value = t('topbar.demoFailed', { reason: reason || '-' });
  setTimeout(() => {
    demoError.value = '';
  }, 6000);
}

onMounted(() => {
  ui.init();
  store.init();
});
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark" />
        <span>ForgeLink<span class="brand-sub"> · {{ t('brand.subtitle') }}</span></span>
      </div>

      <span class="chip accent">{{ t('topbar.devices') }} {{ store.devices.length }}</span>
      <span class="chip ok"> {{ t('topbar.online') }} {{ store.onlineCount }}</span>
      <span class="chip" :class="store.simulator.running ? 'ok' : ''">
        {{ t('topbar.simulator') }} {{ store.simulator.running ? t('topbar.running') : t('topbar.stopped') }}
      </span>

      <span v-if="demoError" class="chip err">{{ demoError }}</span>

      <div v-if="store.discovery.running" class="chip warn" style="min-width: 260px">
        {{ store.discovery.message }}
        <div class="progress" style="width: 90px">
          <span :style="{ width: progressPercent + '%' }" />
        </div>
      </div>

      <div class="topbar-spacer" />

      <label class="row text-12 muted" style="gap: 6px">
        {{ t('topbar.monitorInterval') }}
        <select
          style="width: 96px"
          :value="store.monitorIntervalMs"
          @change="store.setMonitorInterval(Number($event.target.value))"
        >
          <option :value="1000">1s</option>
          <option :value="2000">2s</option>
          <option :value="5000">5s</option>
          <option :value="10000">10s</option>
        </select>
      </label>

      <select class="locale-select" :value="ui.locale" @change="ui.setLocale($event.target.value)">
        <option v-for="item in availableLocales" :key="item.code" :value="item.code">{{ item.label }}</option>
      </select>
      <button class="ghost icon" :title="t('guide.open')" @click="ui.openGuide()">❓</button>
      <button class="ghost icon" :title="ui.theme === 'dark' ? 'Light' : 'Dark'" @click="ui.toggleTheme()">
        {{ ui.theme === 'dark' ? '🌙' : '☀️' }}
      </button>

      <button class="primary" :disabled="store.discovery.running" @click="store.scan({ deep: false })">
        {{ t('topbar.quickScan') }}
      </button>
      <button :disabled="store.discovery.running" @click="store.scan({ deep: true })">{{ t('topbar.deepScan') }}</button>
      <button
        class="ghost"
        :disabled="store.demoGenerating || store.discovery.running"
        @click="handleGenerateDemo"
      >
        {{ store.demoGenerating ? t('topbar.generatingDemo') : `🎬 ${t('topbar.generateDemo')}` }}
      </button>
      <button class="ghost" @click="store.toggleSimulator()">
        {{ store.simulator.running ? t('topbar.stopSimulator') : t('topbar.startSimulator') }}
      </button>
    </header>

    <nav class="sidebar">
      <button
        v-for="item in NAV"
        :key="item.id"
        class="nav-item"
        :class="{ active: store.view === item.id }"
        @click="store.view = item.id"
      >
        <span>{{ item.icon }}</span>
        <span>{{ t('nav.' + item.id) }}</span>
        <span v-if="item.id === 'devices'" class="nav-badge">{{ store.devices.length }}</span>
      </button>

      <div class="topbar-spacer" />

      <div v-if="store.appInfo" class="text-11 muted" style="padding: 10px">
        <div>{{ t('topbar.platform') }} {{ store.appInfo.platform }}</div>
        <div>{{ t('topbar.kernel') }}{{ store.appInfo.version }}</div>
      </div>
    </nav>

    <main class="main">
      <component :is="currentView" />
    </main>

    <GuideOverlay :open="ui.guideOpen" @close="ui.closeGuide()" />
  </div>
</template>
