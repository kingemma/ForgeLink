<script setup>
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { NODE_TYPES } from '../stores';

/**
 * 工作流画布（自绘 SVG）。
 *
 * 关键交互只有三个：拖节点、从输出端口拉线到下游节点、点选边后删除。
 * 其余（执行顺序、数据流转）全部交给内核的 DAG 引擎，画布只负责描述图。
 */
const props = defineProps({
  nodes: { type: Array, default: () => [] },
  edges: { type: Array, default: () => [] },
  selectedNodeId: { type: String, default: null },
  selectedEdgeIndex: { type: Number, default: null },
  devices: { type: Array, default: () => [] },
});
const emit = defineEmits(['select-node', 'select-edge', 'move-node', 'connect', 'clear-selection']);
const { t } = useI18n();

const NODE_WIDTH = 200;
const NODE_HEIGHT = 56;
const svgRef = ref(null);
const drag = ref(null);
const link = ref(null);

const iconOfType = (type) => NODE_TYPES.find((item) => item.id === type)?.icon || '⚙';

function toLocal(event) {
  const rect = svgRef.value.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function startDrag(node, event) {
  const point = toLocal(event);
  drag.value = { id: node.id, dx: point.x - (node.pos?.x || 0), dy: point.y - (node.pos?.y || 0) };
  emit('select-node', node.id);
}

function startLink(node, event) {
  const point = toLocal(event);
  link.value = { from: node.id, x: point.x, y: point.y };
}

function onMove(event) {
  const point = toLocal(event);
  if (drag.value) {
    const node = props.nodes.find((item) => item.id === drag.value.id);
    if (node) emit('move-node', node.id, { x: point.x - drag.value.dx, y: point.y - drag.value.dy });
  }
  if (link.value) {
    link.value = { ...link.value, x: point.x, y: point.y };
  }
}

function onUp() {
  if (link.value) {
    const target = hitTest(link.value.x, link.value.y);
    if (target && target.id !== link.value.from) emit('connect', link.value.from, target.id);
  }
  drag.value = null;
  link.value = null;
}

function hitTest(x, y) {
  return props.nodes.find((node) => {
    const px = node.pos?.x || 0;
    const py = node.pos?.y || 0;
    return x >= px && x <= px + NODE_WIDTH && y >= py && y <= py + NODE_HEIGHT;
  });
}

function nodeCenter(node) {
  return { x: (node.pos?.x || 0) + NODE_WIDTH, y: (node.pos?.y || 0) + NODE_HEIGHT / 2 };
}

function nodeEntry(node) {
  return { x: node.pos?.x || 0, y: (node.pos?.y || 0) + NODE_HEIGHT / 2 };
}

function edgePath(edge) {
  const from = props.nodes.find((node) => node.id === edge.from);
  const to = props.nodes.find((node) => node.id === edge.to);
  if (!from || !to) return '';
  const start = nodeCenter(from);
  const end = nodeEntry(to);
  const midX = (start.x + end.x) / 2;
  return `M${start.x},${start.y} C${midX},${start.y} ${midX},${end.y} ${end.x},${end.y}`;
}

/** 画布内容尺寸按节点边界撑开，超出可视区时容器滚动 */
const contentWidth = computed(() => {
  const right = props.nodes.reduce((max, node) => Math.max(max, (node.pos?.x || 0) + NODE_WIDTH), 0);
  return Math.max(right + 60, 900);
});
const contentHeight = computed(() => {
  const bottom = props.nodes.reduce((max, node) => Math.max(max, (node.pos?.y || 0) + NODE_HEIGHT), 0);
  return Math.max(bottom + 60, 460);
});

const linkPath = computed(() => {
  if (!link.value) return '';
  const from = props.nodes.find((node) => node.id === link.value.from);
  if (!from) return '';
  const start = nodeCenter(from);
  const midX = (start.x + link.value.x) / 2;
  return `M${start.x},${start.y} C${midX},${start.y} ${midX},${link.value.y} ${link.value.x},${link.value.y}`;
});

function subtitle(node) {
  const device = props.devices.find((item) => item.id === node.params?.deviceId);
  if (node.type === 'device') return `${device?.name || device?.ip || t('canvas.noDevice')} · ${node.params?.action || t('canvas.noAction')}`;
  if (node.type === 'state') return device?.name || device?.ip || t('canvas.noDevice');
  if (node.type === 'transform' || node.type === 'condition') return String(node.params?.expression || '');
  if (node.type === 'delay') return `${node.params?.ms ?? 1000} ms`;
  if (node.type === 'notify') return String(node.params?.message || '');
  return '';
}
</script>

<template>
  <div class="canvas-wrap">
    <div class="canvas-scroll">
      <svg
        ref="svgRef"
        class="canvas-svg"
        :width="contentWidth"
        :height="contentHeight"
      @mousemove="onMove"
      @mouseup="onUp"
      @mouseleave="onUp"
      @mousedown.self="emit('clear-selection')"
    >
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0,0 L10,5 L0,10 z" fill="rgba(56,189,248,0.75)" />
        </marker>
      </defs>

      <path
        v-for="(edge, index) in edges"
        :key="index"
        :d="edgePath(edge)"
        class="edge-path"
        :class="{ selected: index === selectedEdgeIndex }"
        marker-end="url(#arrow)"
        @mousedown.stop="emit('select-edge', index)"
      />
      <path v-if="link" :d="linkPath" class="edge-path" style="stroke-dasharray: 5 4" />

      <g
        v-for="node in nodes"
        :key="node.id"
        class="node-box"
        :class="{ dragging: drag?.id === node.id }"
        :transform="`translate(${node.pos?.x || 0},${node.pos?.y || 0})`"
        @mousedown="startDrag(node, $event)"
      >
        <rect
          :width="NODE_WIDTH"
          :height="NODE_HEIGHT"
          rx="10"
          :fill="node.id === selectedNodeId ? '#1c3355' : '#15243c'"
          :stroke="node.id === selectedNodeId ? '#38bdf8' : '#26395b'"
          stroke-width="1.4"
        />
        <text x="12" y="34" font-size="16">{{ iconOfType(node.type) }}</text>
        <text class="node-label" x="40" y="24">{{ node.label }}</text>
        <text class="node-sub" x="40" y="42">{{ subtitle(node).slice(0, 26) }}</text>
        <circle class="port-in" :cy="NODE_HEIGHT / 2" r="5" fill="#0d1526" stroke="#38bdf8" stroke-width="1.4" />
        <circle
          class="port-out"
          :cx="NODE_WIDTH"
          :cy="NODE_HEIGHT / 2"
          r="6"
          fill="#38bdf8"
          @mousedown.stop="startLink(node, $event)"
        />
      </g>
      </svg>
    </div>
  </div>
</template>
