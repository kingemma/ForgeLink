<script setup>
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { iconOf, colorOf } from '../stores';
import StateChart from './StateChart.vue';

const props = defineProps({
  device: { type: Object, required: true },
  history: { type: Array, default: () => [] },
});
const emit = defineEmits(['close', 'refresh', 'remove']);
const { t, locale } = useI18n();

const actions = computed(() => props.device.capabilities?.actions || []);
const forms = reactive({});
const results = reactive({});
const busy = ref('');

watch(
  () => props.device.id,
  () => {
    for (const action of actions.value) {
      forms[action.id] = Object.fromEntries((action.params || []).map((param) => [param.name, param.default ?? '']));
    }
  },
  { immediate: true },
);

/** 从时序样本里挑出可绘制的数值字段（数组按元素展开为 joints[0] 这样的路径） */
const numericFields = computed(() => {
  const latest = props.history[props.history.length - 1]?.values || props.device.state || {};
  const fields = [];
  for (const [key, value] of Object.entries(latest)) {
    if (typeof value === 'number') fields.push(key);
    else if (Array.isArray(value)) value.forEach((_, index) => fields.push(`${key}[${index}]`));
  }
  return fields;
});

const selectedField = ref('');
watch(numericFields, (fields) => {
  if (!fields.includes(selectedField.value)) selectedField.value = fields[0] || '';
});

const points = computed(() => {
  const field = selectedField.value;
  if (!field) return [];
  const match = field.match(/^(.+)\[(\d+)\]$/);
  return props.history.map((sample) => {
    const values = sample.values || {};
    if (match) return Number(values[match[1]]?.[Number(match[2])]);
    return Number(values[field]);
  });
});

async function run(action) {
  busy.value = action.id;
  try {
    results[action.id] = await window.omni.devices.invoke(props.device.id, action.id, forms[action.id]);
  } catch (error) {
    results[action.id] = { ok: false, error: error.message };
  } finally {
    busy.value = '';
  }
}

const evidence = (item) => {
  if (!item.evidence) return '';
  const text = typeof item.evidence === 'string' ? item.evidence : JSON.stringify(item.evidence);
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
};

const formatTime = (ts) =>
  ts ? new Date(ts).toLocaleString(locale.value === 'zh' ? 'zh-CN' : 'en-GB', { hour12: false }) : '-';
</script>

<template>
  <aside class="drawer">
    <div class="row">
      <div class="device-icon">{{ iconOf(device.kind) }}</div>
      <div class="flex-1">
        <div style="font-weight: 600">{{ device.name || device.ip }}</div>
        <div class="device-ip">{{ device.ip }} · {{ device.driverLabel || t('detail.unknown') }}</div>
      </div>
      <button class="ghost" @click="emit('close')">{{ t('detail.close') }}</button>
    </div>

    <section class="panel">
      <div class="panel-title">{{ t('detail.profile') }}</div>
      <div class="panel-body">
        <dl class="kv">
          <dt>{{ t('detail.driver') }}</dt>
          <dd>{{ device.driver || '-' }}（{{ t('detail.fitness') }} {{ (device.fitness ?? 0).toFixed(2) }}）</dd>
          <dt>{{ t('detail.type') }}</dt>
          <dd>{{ device.kind || '-' }}</dd>
          <dt>{{ t('detail.vendor') }}</dt>
          <dd>{{ device.vendor || '-' }}</dd>
          <dt>{{ t('detail.model') }}</dt>
          <dd>{{ device.model || '-' }}</dd>
          <dt>{{ t('detail.mac') }}</dt>
          <dd>{{ device.mac || '-' }}</dd>
          <dt>{{ t('detail.firstSeen') }}</dt>
          <dd>{{ formatTime(device.firstSeen) }}</dd>
          <dt>{{ t('detail.lastOnline') }}</dt>
          <dd>{{ formatTime(device.lastSeen) }}</dd>
        </dl>
      </div>
    </section>

    <section class="panel">
      <div class="panel-title">{{ t('detail.interfaces') }}</div>
      <div class="panel-body">
        <div v-for="item in device.interfaces || []" :key="item.port + item.protocol" class="interface-row">
          <span class="chip" :style="{ color: colorOf(item.protocol), borderColor: colorOf(item.protocol) + '55' }">
            {{ item.protocol }}
          </span>
          <span class="mono">{{ item.port }}/{{ item.transport }}</span>
          <span class="progress flex-1"><span :style="{ width: Math.round((item.confidence || 0) * 100) + '%' }" /></span>
          <span class="text-11 muted">{{ ((item.confidence || 0) * 100).toFixed(0) }}%</span>
          <div class="text-11 muted" style="width: 100%; padding-top: 4px">{{ evidence(item) }}</div>
        </div>
        <div v-if="!(device.interfaces || []).length" class="text-11 muted">{{ t('detail.noInterface') }}</div>
      </div>
    </section>

    <section class="panel">
      <div class="panel-title">{{ t('detail.timeseries') }}</div>
      <div class="panel-body">
        <div class="row" style="margin-bottom: 8px">
          <select v-model="selectedField" style="width: 160px">
            <option v-for="field in numericFields" :key="field" :value="field">{{ field }}</option>
          </select>
          <span class="text-11 muted">{{ t('detail.samples', { n: history.length }) }}</span>
        </div>
        <StateChart :points="points" :height="78" />
      </div>
    </section>

    <section class="panel">
      <div class="panel-title">{{ t('detail.actions') }}</div>
      <div class="panel-body col">
        <div v-for="action in actions" :key="action.id" style="border-bottom: 1px solid var(--border-soft); padding-bottom: 10px">
          <div class="row">
            <strong style="font-size: 13px">{{ action.name }}</strong>
            <code class="text-11 muted">{{ action.id }}</code>
            <div class="topbar-spacer" />
            <button :disabled="busy === action.id" @click="run(action)">{{ busy === action.id ? t('detail.executing') : t('detail.execute') }}</button>
          </div>
          <div v-if="(action.params || []).length" class="col" style="margin-top: 8px; gap: 6px">
            <label v-for="param in action.params" :key="param.name" class="field">
              {{ param.label }}
              <input v-model="forms[action.id][param.name]" :type="param.type === 'number' ? 'number' : 'text'" />
            </label>
          </div>
          <pre
            v-if="results[action.id]"
            class="mono text-11"
            style="margin: 8px 0 0; padding: 8px; background: var(--code-bg); border-radius: 8px; overflow: auto"
            >{{ JSON.stringify(results[action.id], null, 2) }}</pre
          >
        </div>
        <div v-if="!actions.length" class="text-11 muted">{{ t('detail.noActions') }}</div>
      </div>
    </section>

    <div class="row">
      <button @click="emit('refresh', device.id)">{{ t('detail.redetect') }}</button>
      <button class="danger" @click="emit('remove', device.id)">{{ t('detail.remove') }}</button>
    </div>
  </aside>
</template>
