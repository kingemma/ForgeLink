const bus = require('../../kernel/bus');
const { resolveTemplate } = require('./expression');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 工作流执行引擎（第四层）。
 *
 * 第一性原理：多设备协同任务 = 一张有向无环图。
 *   节点 = 一次能力调用（设备动作 / 读状态 / 变换 / 分支 / 等待）
 *   边   = 数据流转方向，上游输出成为下游输入
 * 执行方式是按入度归零推进的拓扑调度：同一层没有依赖关系的节点自动并行，
 * 这正好匹配现实——两台设备不该因为没有依赖关系而互相等待。
 *
 * 数据流由表达式 `{{ nodes.x.output.y }}` 声明，运行前解析，
 * 因此「机械臂抓取完成 → 打印机打印标签」这类跨设备流转是纯配置，不是代码。
 */
class WorkflowEngine {
  constructor({ agent, registry }) {
    this.agent = agent;
    this.registry = registry;
    /** @type {Map<string, any>} */
    this.runs = new Map();
  }

  /**
   * @param {{id:string, name:string, nodes:any[], edges:any[], input?:object}} workflow
   * @param {{onEvent?: Function, runId?: string}} options
   */
  async run(workflow, options = {}) {
    const { onEvent } = options;
    const nodes = workflow.nodes || [];
    const edges = workflow.edges || [];
    const runId = options.runId || `run_${Date.now().toString(36)}`;

    const state = {
      runId,
      workflowId: workflow.id,
      name: workflow.name,
      startedAt: Date.now(),
      endedAt: null,
      results: {},
      status: 'running',
      stopRequested: false,
    };
    this.runs.set(runId, state);

    const emit = (event, payload = {}) => {
      const message = { runId, workflowId: workflow.id, event, ts: Date.now(), ...payload };
      bus.emit('workflow:event', message);
      onEvent?.(event, message);
    };
    emit('run:start', { name: workflow.name, nodes: nodes.length });

    const nodeMap = new Map(nodes.map((node) => [node.id, node]));
    const outgoing = new Map(nodes.map((node) => [node.id, []]));
    const incoming = new Map(nodes.map((node) => [node.id, []]));
    const remaining = new Map(nodes.map((node) => [node.id, 0]));
    for (const edge of edges) {
      if (!nodeMap.has(edge.from) || !nodeMap.has(edge.to)) continue;
      outgoing.get(edge.from).push(edge);
      incoming.get(edge.to).push(edge);
      remaining.set(edge.to, (remaining.get(edge.to) || 0) + 1);
    }

    const context = { nodes: {}, input: workflow.input || {}, now: Date.now() };
    const queue = nodes.filter((node) => remaining.get(node.id) === 0).map((node) => node.id);
    const executed = new Set();

    const skipFrom = (nodeId, reason) => {
      if (executed.has(nodeId) || state.results[nodeId]) return;
      state.results[nodeId] = { ok: false, skipped: true, reason, endedAt: Date.now() };
      emit('node:skip', { nodeId, reason });
      for (const edge of outgoing.get(nodeId) || []) {
        const left = (remaining.get(edge.to) || 0) - 1;
        remaining.set(edge.to, left);
        if (left <= 0) {
          const allSkipped = (incoming.get(edge.to) || []).every((item) => state.results[item.from]);
          if (allSkipped && (incoming.get(edge.to) || []).every((item) => state.results[item.from]?.skipped || state.results[item.from]?.ok === false)) {
            skipFrom(edge.to, '上游被跳过');
          } else if (!state.results[edge.to]) {
            queue.push(edge.to);
          }
        }
      }
    };

    const runNode = async (nodeId) => {
      if (state.stopRequested) {
        skipFrom(nodeId, '已停止');
        return;
      }
      const node = nodeMap.get(nodeId);
      const predecessors = incoming.get(nodeId) || [];
      const merged = {};
      for (const edge of predecessors) {
        const output = state.results[edge.from]?.output;
        if (output && typeof output === 'object' && !Array.isArray(output)) Object.assign(merged, output);
        else if (output !== undefined) merged.value = output;
      }
      const device = node.params?.deviceId ? this.registry.get(node.params.deviceId) : null;
      const nodeContext = { ...context, input: merged, device: device || null, now: Date.now() };

      emit('node:start', { nodeId, label: node.label, type: node.type });
      const startedAt = Date.now();
      try {
        const output = await this._executeNode(node, nodeContext, emit);
        state.results[nodeId] = { ok: true, output, startedAt, endedAt: Date.now(), duration: Date.now() - startedAt };
        context.nodes[nodeId] = { ok: true, output };
      } catch (error) {
        state.results[nodeId] = { ok: false, error: error.message, startedAt, endedAt: Date.now(), duration: Date.now() - startedAt };
        context.nodes[nodeId] = { ok: false, error: error.message };
      }
      executed.add(nodeId);
      const result = state.results[nodeId];
      emit('node:done', { nodeId, label: node.label, result });

      const branch = node.type === 'condition' ? String(Boolean(result.output)) : null;
      for (const edge of outgoing.get(nodeId) || []) {
        if (branch && edge.when && edge.when !== branch) {
          skipFrom(edge.to, `条件分支 ${branch} 未命中`);
          continue;
        }
        if (!result.ok && !node.params?.continueOnError) {
          skipFrom(edge.to, '上游失败');
          continue;
        }
        const left = (remaining.get(edge.to) || 0) - 1;
        remaining.set(edge.to, left);
        if (left <= 0 && !state.results[edge.to] && !queue.includes(edge.to)) queue.push(edge.to);
      }
    };

    while (queue.length && !state.stopRequested) {
      const batch = queue.splice(0, queue.length);
      await Promise.all(batch.map((nodeId) => runNode(nodeId).catch(() => {})));
    }

    for (const node of nodes) {
      if (!state.results[node.id]) state.results[node.id] = { ok: false, skipped: true, reason: '未满足执行条件（可能存在循环依赖）' };
    }

    state.status = state.stopRequested ? 'stopped' : Object.values(state.results).some((item) => item.ok === false && !item.skipped) ? 'failed' : 'success';
    state.endedAt = Date.now();
    state.duration = state.endedAt - state.startedAt;
    emit('run:done', { status: state.status, duration: state.duration, results: state.results });
    return state;
  }

  async _executeNode(node, context, emit) {
    const params = resolveTemplate(node.params || {}, context);
    switch (node.type) {
      case 'device': {
        const deviceId = params.deviceId;
        if (!deviceId) throw new Error('未指定设备');
        if (!params.action || params.action === 'readState') return this.agent.readState(deviceId);
        const result = await this.agent.invoke(deviceId, params.action, params.params || {});
        emit('device:invoke', { deviceId, action: params.action });
        return { deviceId, action: params.action, params: params.params || {}, result };
      }
      case 'state': {
        if (!params.deviceId) throw new Error('未指定设备');
        const state = await this.agent.readState(params.deviceId);
        return { deviceId: params.deviceId, ...state };
      }
      case 'transform':
        return resolveTemplate(params.expression ?? '{{ input }}', context);
      case 'condition':
        return Boolean(resolveTemplate(params.expression ?? '{{ input.ok }}', context));
      case 'delay': {
        const ms = Math.max(0, Number(params.ms ?? 1000));
        await sleep(Math.min(ms, 60000));
        return { waited: ms };
      }
      case 'notify': {
        const message = String(resolveTemplate(params.message ?? '{{ input }}', context));
        bus.info('workflow', message);
        return { message };
      }
      default:
        throw new Error(`未知节点类型：${node.type}`);
    }
  }

  stop(runId) {
    const state = this.runs.get(runId);
    if (state) state.stopRequested = true;
    return Boolean(state);
  }

  listRuns() {
    return [...this.runs.values()];
  }
}

module.exports = { WorkflowEngine };
