<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useOmniStore, iconOf } from '../stores';
import StateChart from '../components/StateChart.vue';

const store = useOmniStore();
const { t, locale } = useI18n();
const histories = ref({});
const fields = ref({});
let timer = null;

const devices = computed(() => store.devices.filter((device) => device.driver).slice(0, 12));

async function loadHistories() {
  const entries = await Promise.all(
    devices.value.map(async (device) => [device.id, await window.omni.devices.history(device.id)]),
  );
  histories.value = Object.fromEntries(entries);
}

function numericFields(device) {
  const latest = device.state || {};
  const list = [];
  for (const [key, value] of Object.entries(latest)) {
    if (typeof value === 'number') list.push(key);
    else if (Array.isArray(value)) value.forEach((_, index) => list.push(`${key}[${index}]`));
  }
  return list;
}

function pointsOf(device) {
  const field = fields.value[device.id];
  const series = histories.value[device.id] || [];
  if (!field) return [];
  const match = field.match(/^(.+)\[(\d+)\]$/);
  return series.map((sample) => {
    const values = sample.values || {};
    return match ? Number(values[match[1]]?.[Number(match[2])]) : Number(values[field]);
  });
}

function ensureField(device) {
  const list = numericFields(device);
  if (!list.length) return;
  if (!fields.value[device.id] || !list.includes(fields.value[device.id])) fields.value[device.id] = list[0];
}

devices.value.forEach(ensureField);

onMounted(async () => {
  await store.init();
  await loadHistories();
  timer = setInterval(loadHistories, 3000);
});
onUnmounted(() => timer && clearInterval(timer));

const formatTime = (ts) =>
  ts ? new Date(ts).toLocaleTimeString(locale.value === 'zh' ? 'zh-CN' : 'en-GB', { hour12: false }) : '-';
</script>

<template>
  <div class="view">
    <div class="toolbar">
      <span class="chip">{{ t('monitor.monitoring', { n: devices.length }) }}</span>
      <span class="chip">{{ t('monitor.sampling', { ms: store.monitorIntervalMs }) }}</span>
      <div class="topbar-spacer" />
      <span class="text-11 muted">{{ t('monitor.hint') }}</span>
    </div>

    <div class="monitor-grid flex-1">
      <section v-for="device in devices" :key="device.id" class="panel">
        <div class="panel-title">
          <span>{{ iconOf(device.kind) }}</span>
          <span class="flex-1" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
            {{ device.name || device.ip }}
          </span>
          <span class="chip" :class="device.status === 'online' ? 'ok' : device.status === 'offline' ? 'err' : 'warn'">
            <span class="dot" :class="device.status" />{{ device.status }}
          </span>
        </div>
        <div class="panel-body col">
          <div class="metrics">
            <div v-for="[key, value] in Object.entries(device.state || {}).slice(0, 4)" :key="key" class="metric">
              <div class="metric-label">{{ key }}</div>
              <div class="metric-value">{{ Array.isArray(value) ? value.join(', ') : value }}</div>
            </div>
          </div>

          <div class="row">
            <select v-model="fields[device.id]" style="width: 150px" @change="ensureField(device)">
              <option v-for="field in numericFields(device)" :key="field" :value="field">{{ field }}</option>
            </select>
            <span class="text-11 muted">{{ t('monitor.points', { n: (histories[device.id] || []).length }) }}</span>
          </div>

          <StateChart :points="pointsOf(device)" :height="70" />

          <div class="text-11 muted">
            {{ t('monitor.lastUpdated') }} {{ formatTime(device.lastSeen) }} · {{ device.driverLabel }}
          </div>
        </div>
      </section>

      <div v-if="!devices.length" class="empty">{{ t('monitor.empty') }}</div>
    </div>
  </div>
</template>
