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

const filtered = computed(() =>
  store.devices.filter((device) => {
    if (kindFilter.value !== 'all' && (device.kind || 'unknown') !== kindFilter.value) return false;
    if (!keyword.value) return true;
    const text = `${device.ip} ${device.name || ''} ${device.driverLabel || ''} ${(device.interfaces || [])
      .map((item) => item.protocol)
      .join(' ')}`.toLowerCase();
    return text.includes(keyword.value.toLowerCase());
  }),
);

const kinds = computed(() => ['all', ...Object.keys(store.kindCounts)]);

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
      />
      <div v-if="!filtered.length" class="empty">
        {{ store.devices.length ? t('devices.emptyFiltered') : t('devices.emptyNoDevice', { action: t('topbar.quickScan') }) }}
      </div>
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
