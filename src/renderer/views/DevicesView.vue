<script setup>
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useOmniStore } from '../stores';
import DeviceCard from '../components/DeviceCard.vue';
import DeviceDetail from '../components/DeviceDetail.vue';

const store = useOmniStore();
const { t } = useI18n();
const keyword = ref('');
const kindFilter = ref('all');
const statusFilter = ref('all');

/** 离线 = 非 online（含 offline / error / unknown），保证「全部 = 在线 + 离线」 */
const statusGroups = computed(() => [
  { key: 'all', label: t('devices.groupAll'), count: store.devices.length },
  { key: 'online', label: t('devices.groupOnline'), count: store.onlineCount },
  { key: 'offline', label: t('devices.groupOffline'), count: store.devices.length - store.onlineCount },
]);

const filtered = computed(() =>
  store.devices.filter((device) => {
    if (statusFilter.value === 'online' && device.status !== 'online') return false;
    if (statusFilter.value === 'offline' && device.status === 'online') return false;
    if (kindFilter.value !== 'all' && (device.kind || 'unknown') !== kindFilter.value) return false;
    if (!keyword.value) return true;
    const text = `${device.ip} ${device.name || ''} ${device.driverLabel || ''} ${(device.interfaces || [])
      .map((item) => item.protocol)
      .join(' ')}`.toLowerCase();
    return text.includes(keyword.value.toLowerCase());
  }),
);

const kinds = computed(() => ['all', ...Object.keys(store.kindCounts)]);

const emptyMessage = computed(() => {
  if (!store.devices.length) return t('devices.emptyNoDevice', { action: t('topbar.quickScan') });
  if (statusFilter.value !== 'all') return t('devices.emptyGroup');
  return t('devices.emptyFiltered');
});

watch(
  () => store.selectedDeviceId,
  (id) => {
    if (id) store.refreshHistory();
  },
);

async function handleRefresh(id) {
  await store.refreshDevice(id);
  store.devices = await window.omni.devices.list();
}
</script>

<template>
  <div class="view">
    <div class="toolbar">
      <div class="row" style="gap: 6px">
        <button
          v-for="group in statusGroups"
          :key="group.key"
          class="chip"
          :class="{ accent: statusFilter === group.key }"
          @click="statusFilter = group.key"
        >
          {{ group.label }} ({{ group.count }})
        </button>
      </div>
      <input v-model="keyword" :placeholder="t('devices.searchPlaceholder')" style="width: 260px" />
      <select v-model="kindFilter" style="width: 150px">
        <option v-for="kind in kinds" :key="kind" :value="kind">
          {{ kind === 'all' ? t('devices.allTypes') : kind }}<span v-if="kind !== 'all'"> ({{ store.kindCounts[kind] }})</span>
        </option>
      </select>
      <span class="chip">{{ t('devices.count', { n: filtered.length }) }}</span>
      <div class="topbar-spacer" />
      <button v-if="store.discovery.running" class="chip warn" disabled>{{ store.discovery.message }}</button>
      <button class="ghost" @click="store.scan({ deep: false })">{{ t('devices.rediscover') }}</button>
    </div>

    <div class="grid-devices flex-1">
      <DeviceCard
        v-for="device in filtered"
        :key="device.id"
        :device="device"
        :selected="device.id === store.selectedDeviceId"
        @select="store.selectDevice"
        @rename="store.renameDevice"
      />
      <div v-if="!filtered.length" class="empty">{{ emptyMessage }}</div>
    </div>

    <DeviceDetail
      v-if="store.selectedDevice"
      :device="store.selectedDevice"
      :history="store.history"
      @close="store.selectDevice(null)"
      @refresh="handleRefresh"
      @remove="store.removeDevice"
    />
  </div>
</template>
