<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useOmniStore } from '../stores';

const store = useOmniStore();
const { t, locale } = useI18n();
const level = ref('all');
const scope = ref('all');
const autoScroll = ref(true);
const listRef = ref(null);

const scopes = computed(() => ['all', ...new Set(store.logs.map((entry) => entry.scope))]);
const filtered = computed(() =>
  store.logs.filter(
    (entry) => (level.value === 'all' || entry.level === level.value) && (scope.value === 'all' || entry.scope === scope.value),
  ),
);

watch(
  () => filtered.value.length,
  async () => {
    if (!autoScroll.value) return;
    await nextTick();
    if (listRef.value) listRef.value.scrollTop = listRef.value.scrollHeight;
  },
);

const formatTime = (ts) => new Date(ts).toLocaleTimeString(locale.value === 'zh' ? 'zh-CN' : 'en-GB', { hour12: false });
</script>

<template>
  <div class="view">
    <div class="toolbar">
      <select v-model="level" style="width: 120px">
        <option value="all">{{ t('logs.allLevels') }}</option>
        <option value="info">info</option>
        <option value="warn">warn</option>
        <option value="error">error</option>
        <option value="debug">debug</option>
      </select>
      <select v-model="scope" style="width: 140px">
        <option v-for="item in scopes" :key="item" :value="item">{{ item === 'all' ? t('logs.allModules') : item }}</option>
      </select>
      <label class="row text-12 muted" style="gap: 6px">
        <input v-model="autoScroll" type="checkbox" style="width: auto" />{{ t('logs.autoScroll') }}
      </label>
      <div class="topbar-spacer" />
      <span class="chip">{{ t('logs.count', { n: filtered.length }) }}</span>
    </div>

    <div ref="listRef" class="log-list flex-1">
      <div v-for="entry in filtered" :key="entry.id" class="log-row">
        <span class="log-time">{{ formatTime(entry.ts) }}</span>
        <span class="log-scope">{{ entry.scope }}</span>
        <span :class="`log-level-${entry.level}`">
          {{ entry.message }}
          <span v-if="entry.detail" class="muted"> · {{ JSON.stringify(entry.detail) }}</span>
        </span>
      </div>
      <div v-if="!filtered.length" class="empty">{{ t('logs.empty') }}</div>
    </div>
  </div>
</template>
