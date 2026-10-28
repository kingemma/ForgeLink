import { defineStore } from 'pinia';
import { i18n } from '../i18n';

/**
 * 内核事件 → 界面状态。
 *
 * 界面不持有任何业务逻辑：所有状态都由主进程推送（omni:devices / omni:log / omni:*），
 * 所有操作都通过 window.omni.* 下发到内核。这样 UI 只是内核的一层投影。
 */

const KIND_ICON = {
  'robot-arm': '🦾',
  printer: '🖨',
  generic: '🔌',
  unknown: '❓',
  host: '🖥',
  scanner: '📠',
};

const PROTOCOL_COLOR = {
  'modbus-tcp': '#38bdf8',
  ipp: '#a78bfa',
  snmp: '#fbbf24',
  jetdirect: '#34d399',
  'raw-text': '#f472b6',
  http: '#60a5fa',
  https: '#60a5fa',
  websocket: '#22d3ee',
  unknown: '#94a3b8',
};

export const iconOf = (kind) => KIND_ICON[kind] || '🔌';
export const colorOf = (protocol) => PROTOCOL_COLOR[protocol] || '#94a3b8';

export const useOmniStore = defineStore('omni', {
  state: () => ({
    ready: false,
    view: 'devices',
    devices: [],
    selectedDeviceId: null,
    history: [],
    logs: [],
    discovery: { running: false, phase: '', message: '', current: 0, total: 0 },
    simulator: { running: false, devices: [] },
    /** 演示环境正在生成：按钮据此禁用，避免并发触发两轮发现 */
    demoGenerating: false,
    monitorIntervalMs: 2000,
    appInfo: null,
    lastEvent: null,
  }),
  getters: {
    selectedDevice: (state) => state.devices.find((device) => device.id === state.selectedDeviceId) || null,
    onlineCount: (state) => state.devices.filter((device) => device.status === 'online').length,
    kindCounts: (state) => {
      const counts = {};
      for (const device of state.devices) {
        const key = device.kind || 'unknown';
        counts[key] = (counts[key] || 0) + 1;
      }
      return counts;
    },
  },
  actions: {
    async init() {
      if (this.ready) return;
      this.ready = true;

      const api = window.omni;
      api.on('omni:log', (entry) => {
        this.logs.push(entry);
        if (this.logs.length > 600) this.logs.splice(0, this.logs.length - 600);
      });
      api.on('omni:devices', (devices) => {
        this.devices = devices;
        if (this.selectedDeviceId && !devices.some((device) => device.id === this.selectedDeviceId)) {
          this.selectedDeviceId = null;
        }
      });
      api.on('omni:device-state', (payload) => {
        this.lastEvent = payload;
        const device = this.devices.find((item) => item.id === payload.id);
        if (device) {
          device.state = payload.state;
          device.status = payload.status;
        }
      });
      api.on('omni:discovery-progress', (payload) => {
        this.discovery = { ...payload, running: payload.phase !== 'done' && payload.phase !== 'error' };
      });

      const [devices, logs, simulator, info] = await Promise.all([
        api.devices.list(),
        api.logs.recent(),
        api.simulator.status(),
        api.app.info(),
      ]);
      this.devices = devices;
      this.logs = logs;
      this.simulator = simulator;
      this.appInfo = info;
      this.monitorIntervalMs = info.monitorIntervalMs || 2000;
    },

    async scan(options = {}) {
      this.discovery = { ...this.discovery, running: true, phase: 'starting', message: i18n.global.t('store.startingDiscovery') };
      try {
        const result = await window.omni.discovery.start(options);
        return result;
      } finally {
        this.discovery = { ...this.discovery, running: false };
        this.simulator = await window.omni.simulator.status();
      }
    },

    async selectDevice(id) {
      this.selectedDeviceId = id;
      this.history = id ? await window.omni.devices.history(id) : [];
    },

    async refreshHistory() {
      if (this.selectedDeviceId) this.history = await window.omni.devices.history(this.selectedDeviceId);
    },

    async invoke(deviceId, action, params) {
      return window.omni.devices.invoke(deviceId, action, params);
    },

    async refreshDevice(id) {
      return window.omni.devices.refresh(id);
    },

    async renameDevice(id, name) {
      const result = await window.omni.devices.rename(id, name);
      this.devices = await window.omni.devices.list();
      return result;
    },

    async removeDevice(id) {
      await window.omni.devices.remove(id);
      this.selectedDeviceId = null;
    },

    /** 清空本机档案里的全部设备；时序缓冲随注册表一起丢弃 */
    async clearDevices() {
      const result = await window.omni.devices.clear();
      this.devices = [];
      this.selectedDeviceId = null;
      this.history = [];
      return result;
    },

    /**
     * 一键演示：内核拉起模拟器、发现设备并重建示例工作流，
     * 成功后直接把界面带到可以立刻点「运行」的编排页。
     */
    async generateDemo() {
      if (this.demoGenerating) return null;
      this.demoGenerating = true;
      try {
        const result = await window.omni.demo.generate();
        // 失败时保持现状：内核已经记录了原因，界面不该顺手把已有档案清掉
        if (!result?.ok || !result.workflow) return result;

        this.devices = result.devices || (await window.omni.devices.list());
        this.simulator = result.simulator || (await window.omni.simulator.status());

        const workflow = useWorkflowStore();
        await workflow.init();
        workflow.open(result.workflow.id);
        this.view = 'workflow';
        return result;
      } finally {
        this.demoGenerating = false;
      }
    },

    async toggleSimulator() {
      this.simulator = this.simulator.running ? await window.omni.simulator.stop() : await window.omni.simulator.start();
      return this.simulator;
    },

    async setMonitorInterval(ms) {
      const result = await window.omni.monitor.setInterval(ms);
      this.monitorIntervalMs = result.intervalMs;
    },
  },
});

export const useWorkflowStore = defineStore('workflow', {
  state: () => ({
    workflows: [],
    currentId: null,
    draft: null,
    selectedNodeId: null,
    selectedEdgeIndex: null,
    running: false,
    runResult: null,
    events: [],
    validation: null,
    currentRunId: null,
  }),
  getters: {
    current: (state) => state.workflows.find((item) => item.id === state.currentId) || null,
    selectedNode: (state) => state.draft?.nodes.find((node) => node.id === state.selectedNodeId) || null,
    /** 运行过程中每个节点的实时状态：由内核推送的事件累积而成 */
    liveStates: (state) => {
      const map = {};
      for (const event of state.events) {
        if (state.currentRunId && event.runId && event.runId !== state.currentRunId) continue;
        if (event.event === 'node:start') map[event.nodeId] = 'running';
        else if (event.event === 'node:done') {
          map[event.nodeId] = event.result?.ok ? 'ok' : event.result?.skipped ? 'skipped' : 'error';
        } else if (event.event === 'node:skip') map[event.nodeId] = 'skipped';
      }
      return map;
    },
  },
  actions: {
    async init() {
      this.workflows = await window.omni.workflow.list();
      if (this.workflows.length && !this.currentId) this.open(this.workflows[0].id);
    },
    /** 打开工作流：已有坐标就直接还原存档画面，缺失坐标（如内核生成的工作流）才自动布局 */
    open(id) {
      const workflow = this.workflows.find((item) => item.id === id);
      if (!workflow) return;
      this.currentId = id;
      this.draft = JSON.parse(JSON.stringify(workflow));
      if ((this.draft.nodes || []).some((node) => !isValidPosition(node.pos))) this.autoLayout();
      this.selectedNodeId = this.draft.nodes[0]?.id || null;
      this.selectedEdgeIndex = null;
      this.runResult = null;
      this.validation = null;
      this.currentRunId = null;
    },
    /**
     * 自动布局：按最长路径计算每个节点所处的拓扑层级，
     * 同层纵向排列，让「谁先谁后、哪些能并行」一眼可见。
     */
    autoLayout() {
      if (!this.draft) return;
      const nodes = this.draft.nodes || [];
      const edges = this.draft.edges || [];
      if (!nodes.length) return;

      const indegree = new Map(nodes.map((node) => [node.id, 0]));
      for (const edge of edges) indegree.set(edge.to, (indegree.get(edge.to) || 0) + 1);

      const level = new Map(nodes.map((node) => [node.id, 0]));
      const remaining = new Map(indegree);
      const queue = nodes.filter((node) => !remaining.get(node.id)).map((node) => node.id);
      // 防御环图：环上的节点入度永远不会归零，用 visited 防止死循环
      const visited = new Set();
      while (queue.length) {
        const id = queue.shift();
        for (const edge of edges.filter((item) => item.from === id)) {
          level.set(edge.to, Math.max(level.get(edge.to) || 0, (level.get(id) || 0) + 1));
          remaining.set(edge.to, (remaining.get(edge.to) || 1) - 1);
          if (remaining.get(edge.to) <= 0 && !visited.has(edge.to)) {
            visited.add(edge.to);
            queue.push(edge.to);
          }
        }
      }

      const perLevel = new Map();
      for (const node of nodes) {
        const index = level.get(node.id) || 0;
        const slot = perLevel.get(index) || 0;
        perLevel.set(index, slot + 1);
        node.pos = { x: 40 + index * 240, y: 30 + slot * 96 };
      }
    },
    create() {
      const id = `wf_${Date.now().toString(36)}`;
      const workflow = { id, name: i18n.global.t('store.newWorkflow'), description: '', nodes: [], edges: [], updatedAt: Date.now() };
      this.workflows.push(workflow);
      this.open(id);
      return workflow;
    },
    addNode(type, position = { x: 120, y: 120 }) {
      const id = `n${Date.now().toString(36)}`;
      const node = { id, type, label: labelOf(type), params: defaultParams(type), pos: { ...position } };
      this.draft.nodes.push(node);
      this.selectedNodeId = id;
      return node;
    },
    removeNode(id) {
      this.draft.nodes = this.draft.nodes.filter((node) => node.id !== id);
      this.draft.edges = this.draft.edges.filter((edge) => edge.from !== id && edge.to !== id);
      this.selectedNodeId = null;
    },
    connect(from, to) {
      if (from === to) return;
      if (this.draft.edges.some((edge) => edge.from === from && edge.to === to)) return;
      this.draft.edges.push({ from, to });
    },
    removeEdge(index) {
      this.draft.edges.splice(index, 1);
      this.selectedEdgeIndex = null;
    },
    selectNode(id) {
      this.selectedNodeId = id;
      this.selectedEdgeIndex = null;
    },
    async save() {
      const saved = await window.omni.workflow.save(this.draft);
      const index = this.workflows.findIndex((item) => item.id === saved.id);
      if (index >= 0) this.workflows[index] = saved;
      else this.workflows.push(saved);
      this.currentId = saved.id;
      return saved;
    },
    async remove(id) {
      await window.omni.workflow.remove(id);
      this.workflows = this.workflows.filter((item) => item.id !== id);
      if (this.currentId === id) {
        this.currentId = null;
        this.draft = null;
      }
    },
    /** 运行前静态校验：图有错就在按下运行时说清楚，而不是跑完得到一串 skipped */
    async validate() {
      if (!this.draft) return null;
      this.validation = await window.omni.workflow.validate(this.draft);
      return this.validation;
    },
    async stop() {
      if (!this.currentRunId) return null;
      return window.omni.workflow.stop(this.currentRunId);
    },
    async run() {
      if (!this.draft) return null;
      const check = await this.validate();
      if (check && !check.ok) return null;
      await this.save();
      this.running = true;
      this.events = [];
      this.currentRunId = null;
      this.runResult = null;
      try {
        const result = await window.omni.workflow.run(this.draft.id, {});
        this.runResult = result;
        return result;
      } finally {
        this.running = false;
      }
    },
    pushEvent(event) {
      this.events.push(event);
      if (this.events.length > 200) this.events.shift();
      if (event.event === 'run:start') this.currentRunId = event.runId;
      if (event.event === 'run:done' && event.runId === this.currentRunId) this.running = false;
    },
  },
});

/** 判断节点坐标是否是可用的存档数据（缺坐标的工作流无法还原画面） */
function isValidPosition(pos) {
  return Boolean(pos) && Number.isFinite(Number(pos.x)) && Number.isFinite(Number(pos.y));
}

const TYPE_KEY = {
  device: 'nodeType.device',
  state: 'nodeType.state',
  transform: 'nodeType.transform',
  condition: 'nodeType.condition',
  delay: 'nodeType.delay',
  waitUntil: 'nodeType.waitUntil',
  notify: 'nodeType.notify',
};

export function labelOf(type) {
  const key = TYPE_KEY[type];
  return key ? i18n.global.t(key) : type;
}

export function defaultParams(type) {
  switch (type) {
    case 'device':
      return { deviceId: '', action: '', params: {} };
    case 'state':
      return { deviceId: '' };
    case 'transform':
      return { expression: '{{ input }}' };
    case 'condition':
      return { expression: '{{ input.ok }}' };
    case 'delay':
      return { ms: 1000 };
    case 'notify':
      return { message: '{{ input }}' };
    default:
      return {};
  }
}

export const NODE_TYPES = [
  { id: 'device', icon: '⚙' },
  { id: 'state', icon: '📊' },
  { id: 'transform', icon: '🔀' },
  { id: 'condition', icon: '🔀' },
  { id: 'delay', icon: '⏱' },
  { id: 'waitUntil', icon: '⏳' },
  { id: 'notify', icon: '📣' },
];
