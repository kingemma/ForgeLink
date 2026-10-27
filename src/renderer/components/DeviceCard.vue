<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { iconOf, colorOf } from '../stores';

const props = defineProps({
  device: { type: Object, required: true },
  selected: { type: Boolean, default: false },
});
defineEmits(['select']);
const { t } = useI18n();

const title = computed(() => props.device.name || `${props.device.driverLabel || t('device.unrecognized')} @ ${props.device.ip}`);
const protocols = computed(() => (props.device.interfaces || []).map((item) => item.protocol));
const metrics = computed(() => {
  const state = props.device.state || {};
  return Object.entries(state)
    .filter(([, value]) => typeof value === 'number' || typeof value === 'string')
    .slice(0, 4);
});
</script>

<template>
  <div class="device-card" :class="{ selected }" @click="$emit('select', device.id)">
    <div class="device-card-head">
      <div class="device-icon">{{ iconOf(device.kind) }}</div>
      <div class="flex-1">
        <div class="device-name">{{ title }}</div>
        <div class="device-ip">{{ device.ip }}</div>
      </div>
      <span class="chip" :class="device.status === 'online' ? 'ok' : device.status === 'offline' ? 'err' : 'warn'">
        <span class="dot" :class="device.status" />{{ device.status || 'unknown' }}
      </span>
    </div>

    <div class="row" style="margin-top: 10px; gap: 6px; flex-wrap: wrap">
      <span v-if="device.driverLabel" class="chip accent">{{ device.driverLabel }}</span>
      <span
        v-for="protocol in protocols"
        :key="protocol"
        class="chip"
        :style="{ color: colorOf(protocol), borderColor: colorOf(protocol) + '55' }"
      >
        {{ protocol }}
      </span>
    </div>

    <div v-if="metrics.length" class="metrics">
      <div v-for="[key, value] in metrics" :key="key" class="metric">
        <div class="metric-label">{{ key }}</div>
        <div class="metric-value">{{ value }}</div>
      </div>
    </div>
    <div v-else class="text-11 muted" style="margin-top: 12px">{{ t('device.noStatus') }}</div>
  </div>
</template>
