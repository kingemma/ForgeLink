<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

/**
 * 节点配置面板。
 *
 * 这里最能体现「数据与操作在设备间流转」：参数输入框里可以直接写
 * {{ nodes.<上游节点>.output.<字段> }}，运行期由内核表达式引擎解析。
 */
const props = defineProps({
  node: { type: Object, default: null },
  devices: { type: Array, default: () => [] },
  nodes: { type: Array, default: () => [] },
});
const emit = defineEmits(['remove']);
const { t } = useI18n();

const selectedDevice = computed(() => props.devices.find((device) => device.id === props.node?.params?.deviceId) || null);
const deviceActions = computed(() => selectedDevice.value?.capabilities?.actions || []);
const actionDefinition = computed(() => deviceActions.value.find((action) => action.id === props.node?.params?.action) || null);

const upstream = computed(() => props.nodes.filter((node) => node.id !== props.node?.id));

/** 上游引用示例：模板里不能直接写 {{ }} 字面量，交给脚本拼接 */
const refOf = (node) => `{{ nodes.${node.id}.output }}`;

function onDeviceChange(event) {
  props.node.params.deviceId = event.target.value;
  props.node.params.action = '';
  props.node.params.params = {};
}

function onActionChange(event) {
  const action = deviceActions.value.find((item) => item.id === event.target.value);
  props.node.params.action = action?.id || '';
  props.node.params.params = Object.fromEntries((action?.params || []).map((param) => [param.name, param.default ?? '']));
}
</script>

<template>
  <aside v-if="node" class="panel" style="width: 320px; overflow: auto">
    <div class="panel-title">{{ t('node.config') }}</div>
    <div class="panel-body col">
      <label class="field">
        {{ t('node.name') }}
        <input v-model="node.label" />
      </label>

      <label v-if="node.type === 'device' || node.type === 'state'" class="field">
        {{ t('node.targetDevice') }}
        <select :value="node.params.deviceId" @change="onDeviceChange">
          <option value="">{{ t('node.selectDevice') }}</option>
          <option v-for="device in devices" :key="device.id" :value="device.id">
            {{ device.name || device.ip }} · {{ device.driverLabel || device.kind }}
          </option>
        </select>
      </label>

      <label v-if="node.type === 'device'" class="field">
        {{ t('node.action') }}
        <select :value="node.params.action" @change="onActionChange">
          <option value="">{{ t('node.selectAction') }}</option>
          <option v-for="action in deviceActions" :key="action.id" :value="action.id">{{ action.name }}</option>
        </select>
      </label>

      <template v-if="node.type === 'device' && actionDefinition">
        <label v-for="param in actionDefinition.params || []" :key="param.name" class="field">
          {{ param.label }}
          <input
            v-if="param.type !== 'text' && param.type !== 'number[]'"
            v-model="node.params.params[param.name]"
            :type="param.type === 'number' ? 'number' : 'text'"
          />
          <textarea v-else v-model="node.params.params[param.name]" rows="2" />
        </label>
      </template>

      <label v-if="node.type === 'transform' || node.type === 'condition'" class="field">
        {{ t('node.expression') }}
        <textarea v-model="node.params.expression" rows="3" />
      </label>

      <label v-if="node.type === 'delay'" class="field">
        {{ t('node.waitMs') }}
        <input v-model.number="node.params.ms" type="number" />
      </label>

      <label v-if="node.type === 'notify'" class="field">
        {{ t('node.messageTemplate') }}
        <textarea v-model="node.params.message" rows="2" />
      </label>

      <div v-if="node.type === 'device' || node.type === 'transform' || node.type === 'condition'" class="text-11 muted">
        {{ t('node.referenceHint') }}
        <div v-for="item in upstream.slice(0, 4)" :key="item.id" class="mono">{{ refOf(item) }}</div>
      </div>

      <button class="danger" @click="emit('remove', node.id)">{{ t('node.delete') }}</button>
    </div>
  </aside>
  <aside v-else class="panel" style="width: 320px">
    <div class="panel-title">{{ t('node.config') }}</div>
    <div class="panel-body text-12 muted">{{ t('node.selectHint') }}</div>
  </aside>
</template>
