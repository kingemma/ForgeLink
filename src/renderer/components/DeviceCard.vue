<script setup>
import { computed, nextTick, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { iconOf, colorOf } from '../stores';

const props = defineProps({
  device: { type: Object, required: true },
  selected: { type: Boolean, default: false },
});
const emit = defineEmits(['select', 'rename']);
const { t } = useI18n();

const editing = ref(false);
const draft = ref('');
const nameInput = ref(null);

function startEdit() {
  draft.value = props.device.name || '';
  editing.value = true;
  nextTick(() => nameInput.value?.focus());
}

function commit() {
  if (!editing.value) return;
  editing.value = false;
  const value = draft.value.trim();
  if (value === (props.device.name || '')) return;
  emit('rename', props.device.id, value);
}

function cancel() {
  editing.value = false;
}

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
        <div class="device-name row" style="gap: 6px">
          <input
            v-if="editing"
            ref="nameInput"
            v-model="draft"
            style="width: 100%"
            @click.stop
            @keydown.enter.prevent="commit"
            @keydown.esc.prevent="cancel"
            @blur="commit"
          />
          <template v-else>
            <span class="flex-1">{{ title }}</span>
            <button class="ghost icon" style="padding: 1px 5px" :title="t('device.rename')" @click.stop="startEdit">
              ✎
            </button>
          </template>
        </div>
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
