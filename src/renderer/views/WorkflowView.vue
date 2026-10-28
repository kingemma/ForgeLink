<script setup>
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useOmniStore, useWorkflowStore, NODE_TYPES } from '../stores';
import WorkflowCanvas from '../components/WorkflowCanvas.vue';
import NodeInspector from '../components/NodeInspector.vue';

const omni = useOmniStore();
const store = useWorkflowStore();
const { t } = useI18n();
const newType = ref('device');

const draftNodes = computed(() => store.draft?.nodes || []);
const draftEdges = computed(() => store.draft?.edges || []);

onMounted(async () => {
  await omni.init();
  await store.init();
  window.omni.on('omni:workflow-event', (event) => store.pushEvent(event));
});

function addNode() {
  const count = draftNodes.value.length;
  store.addNode(newType.value, { x: 60 + (count % 3) * 230, y: 40 + Math.floor(count / 3) * 96 });
}

function moveNode(id, pos) {
  const node = draftNodes.value.find((item) => item.id === id);
  if (node) node.pos = pos;
}

const selectedEdge = computed(() =>
  store.selectedEdgeIndex !== null ? store.draft?.edges?.[store.selectedEdgeIndex] || null : null,
);

/** 条件分支：给连线打上 when，引擎才会按 condition 的真假选择分支 */
const edgeWhen = computed({
  get: () => selectedEdge.value?.when ?? '',
  set: (value) => {
    const edge = selectedEdge.value;
    if (!edge) return;
    if (value) edge.when = value;
    else delete edge.when;
  },
});

const nodeLabel = (id) => (store.draft?.nodes || []).find((node) => node.id === id)?.label || id;

const runSummary = computed(() => {
  const results = store.runResult?.results || {};
  return Object.entries(results).map(([id, result]) => ({
    id,
    label: (store.draft?.nodes || []).find((node) => node.id === id)?.label || id,
    ...result,
  }));
});
</script>

<template>
  <div class="view" style="flex-direction: row; gap: 14px">
    <section class="panel" style="width: 220px; display: flex; flex-direction: column">
      <div class="panel-title">
        {{ t('workflow.title') }}
        <div class="topbar-spacer" />
        <button class="ghost" style="padding: 3px 8px" @click="store.create()">＋</button>
      </div>
      <div class="panel-body col" style="overflow: auto">
        <button
          v-for="workflow in store.workflows"
          :key="workflow.id"
          class="ghost"
          :style="{ textAlign: 'left', borderColor: workflow.id === store.currentId ? 'var(--accent)' : '' }"
          @click="store.open(workflow.id)"
        >
          {{ workflow.name }}
          <div class="text-11 muted">{{ t('workflow.nodes', { n: (workflow.nodes || []).length }) }}</div>
        </button>
        <div v-if="!store.workflows.length" class="text-11 muted">{{ t('workflow.emptyList') }}</div>
      </div>
    </section>

    <section class="flex-1 col" style="min-width: 0">
      <div class="toolbar">
        <input v-if="store.draft" v-model="store.draft.name" style="width: 240px" />
        <select v-model="newType" style="width: 130px">
          <option v-for="type in NODE_TYPES" :key="type.id" :value="type.id">{{ type.icon }} {{ t('nodeType.' + type.id) }}</option>
        </select>
        <button @click="addNode">{{ t('workflow.addNode') }}</button>
        <button @click="store.autoLayout()">{{ t('workflow.autoLayout') }}</button>
        <select
          v-if="store.selectedEdgeIndex !== null"
          v-model="edgeWhen"
          :title="t('workflow.branch')"
          style="width: 130px"
        >
          <option value="">{{ t('workflow.branchAlways') }}</option>
          <option value="true">{{ t('workflow.branchTrue') }}</option>
          <option value="false">{{ t('workflow.branchFalse') }}</option>
        </select>
        <button
          v-if="store.selectedEdgeIndex !== null"
          class="danger"
          @click="store.removeEdge(store.selectedEdgeIndex)"
        >
          {{ t('workflow.deleteEdge') }}
        </button>
        <div class="topbar-spacer" />
        <button class="danger" :disabled="!store.currentId" @click="store.remove(store.currentId)">
          {{ t('workflow.delete') }}
        </button>
        <button @click="store.save()">{{ t('workflow.save') }}</button>
        <button v-if="store.running" class="danger" @click="store.stop()">{{ t('workflow.stop') }}</button>
        <button class="primary" :disabled="store.running || !draftNodes.length" @click="store.run()">
          {{ store.running ? t('workflow.running') : t('workflow.run') }}
        </button>
      </div>

      <WorkflowCanvas
        v-if="store.draft"
        :nodes="draftNodes"
        :edges="draftEdges"
        :devices="omni.devices"
        :node-states="store.liveStates"
        :selected-node-id="store.selectedNodeId"
        :selected-edge-index="store.selectedEdgeIndex"
        @select-node="store.selectNode"
        @select-edge="(index) => (store.selectedEdgeIndex = index)"
        @move-node="moveNode"
        @connect="store.connect"
        @clear-selection="
          () => {
            store.selectedNodeId = null;
            store.selectedEdgeIndex = null;
          }
        "
      />
      <div v-else class="empty">{{ t('workflow.selectOrCreate') }}</div>

      <section
        v-if="store.validation && (store.validation.errors.length || store.validation.warnings.length)"
        class="panel"
      >
        <div class="panel-title">
          {{ t('workflow.validation') }}
          <span class="chip" :class="store.validation.ok ? 'warn' : 'err'">
            {{ store.validation.errors.length || store.validation.warnings.length }}
          </span>
        </div>
        <div class="panel-body col text-12">
          <div v-for="(item, index) in store.validation.errors" :key="`e${index}`" class="row" style="color: var(--err)">
            <span>✕</span>
            <span>{{ item.nodeId ? `${nodeLabel(item.nodeId)}：${item.message}` : item.message }}</span>
          </div>
          <div v-for="(item, index) in store.validation.warnings" :key="`w${index}`" class="row" style="color: var(--warn)">
            <span>!</span>
            <span>{{ item.nodeId ? `${nodeLabel(item.nodeId)}：${item.message}` : item.message }}</span>
          </div>
        </div>
      </section>

      <section v-if="store.runResult" class="panel" style="max-height: 190px; overflow: auto">
        <div class="panel-title">
          {{ t('workflow.result') }}
          <span class="chip" :class="store.runResult.status === 'success' ? 'ok' : 'err'">
            {{ store.runResult.status }}
          </span>
          <span class="chip">{{ store.runResult.duration }} ms</span>
        </div>
        <div class="panel-body col text-12">
          <div v-for="item in runSummary" :key="item.id" class="row">
            <span class="dot" :class="item.ok ? 'online' : item.skipped ? '' : 'offline'" />
            <span style="width: 150px">{{ item.label }}</span>
            <span class="chip" :class="item.ok ? 'ok' : item.skipped ? 'warn' : 'err'">
              {{ item.ok ? t('workflow.success') : item.skipped ? t('workflow.skipped') : t('workflow.failed') }}
            </span>
            <span class="text-11 muted">{{ item.duration ?? 0 }} ms</span>
            <span class="flex-1 mono text-11 muted" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
              {{ item.error || JSON.stringify(item.output) || item.reason || '' }}
            </span>
          </div>
        </div>
      </section>
    </section>

    <NodeInspector
      :node="store.selectedNode"
      :devices="omni.devices"
      :nodes="draftNodes"
      @remove="store.removeNode"
    />
  </div>
</template>
