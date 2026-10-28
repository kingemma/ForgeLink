const test = require('node:test');
const assert = require('node:assert');
const { Registry } = require('../src/main/kernel/registry');
const { Agent } = require('../src/main/runtime/agent');
const { WorkflowEngine } = require('../src/main/runtime/workflow/engine');
const { validateWorkflow } = require('../src/main/runtime/workflow/validate');

function makeEngine() {
  const registry = new Registry();
  const agent = new Agent({ registry, store: null });
  return { engine: new WorkflowEngine({ agent, registry }), registry, agent };
}

test('引擎：无依赖节点并行执行（总耗时接近单个而非累加）', async () => {
  const { engine } = makeEngine();
  const run = await engine.run({
    id: 'p',
    name: 'parallel',
    nodes: [
      { id: 'a', type: 'delay', label: 'a', params: { ms: 300 } },
      { id: 'b', type: 'delay', label: 'b', params: { ms: 300 } },
    ],
    edges: [],
  });
  assert.strictEqual(run.status, 'success');
  assert.ok(run.duration < 550, `无依赖节点应并行，实际 ${run.duration}ms`);
});

test('引擎：数据沿边流转，下游能引用上游输出', async () => {
  const { engine } = makeEngine();
  const run = await engine.run({
    id: 'flow',
    name: 'flow',
    nodes: [
      { id: 'a', type: 'transform', label: 'a', params: { expression: 'C-42' } },
      { id: 'b', type: 'notify', label: 'b', params: { message: '编号 {{ nodes.a.output }}' } },
    ],
    edges: [{ from: 'a', to: 'b' }],
  });
  assert.strictEqual(run.status, 'success');
  assert.strictEqual(run.results.b.output.message, '编号 C-42');
});

test('引擎：失败默认阻断下游，continueOnError 可放行', async () => {
  const { engine } = makeEngine();
  const base = {
    id: 'f',
    name: 'fail',
    nodes: [
      { id: 'bad', type: 'device', label: 'bad', params: { deviceId: 'missing-device', action: 'moveTo' } },
      { id: 'next', type: 'notify', label: 'next', params: { message: 'ok' } },
    ],
    edges: [{ from: 'bad', to: 'next' }],
  };

  const run = await engine.run(base);
  assert.strictEqual(run.status, 'failed');
  assert.ok(run.results.next.skipped, '默认失败应阻断下游');

  const tolerant = JSON.parse(JSON.stringify(base));
  tolerant.nodes[0].params.continueOnError = true;
  const run2 = await engine.run(tolerant);
  assert.ok(run2.results.next.ok, 'continueOnError 时下游应继续执行');
});

test('引擎：环图不会挂死，未满足条件的节点标记跳过', async () => {
  const { engine } = makeEngine();
  const run = await engine.run({
    id: 'cyc',
    name: 'cycle',
    nodes: [
      { id: 'a', type: 'notify', label: 'a', params: { message: 'a' } },
      { id: 'b', type: 'notify', label: 'b', params: { message: 'b' } },
    ],
    edges: [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
    ],
  });
  assert.ok(run.endedAt, '必须正常结束而不是死循环');
  assert.ok(run.results.a.skipped || run.results.b.skipped, '环上至少有一个节点无法满足依赖');
});

test('引擎：stop 后剩余节点不再执行', async () => {
  const { engine } = makeEngine();
  const promise = engine.run({
    id: 's',
    name: 'stop',
    nodes: [
      { id: 'a', type: 'delay', label: 'a', params: { ms: 400 } },
      { id: 'b', type: 'delay', label: 'b', params: { ms: 400 } },
    ],
    edges: [{ from: 'a', to: 'b' }],
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  const runs = engine.listRuns();
  const runId = runs[runs.length - 1]?.runId;
  assert.ok(runId, '应能拿到 runId');
  assert.strictEqual(engine.stop(runId), true);

  const run = await promise;
  assert.strictEqual(run.status, 'stopped');
  assert.ok(run.results.b.skipped, '停止后下游不应执行');
});

test('引擎：运行过程按节点推送事件（供 UI 实时监控）', async () => {
  const { engine } = makeEngine();
  const events = [];
  const run = await engine.run(
    {
      id: 'ev',
      name: 'events',
      nodes: [
        { id: 'a', type: 'notify', label: 'a', params: { message: 'hi' } },
        { id: 'b', type: 'notify', label: 'b', params: { message: 'bye' } },
      ],
      edges: [{ from: 'a', to: 'b' }],
    },
    { onEvent: (event, payload) => events.push({ event, payload }) },
  );
  assert.strictEqual(run.status, 'success');
  assert.ok(events.some((item) => item.event === 'run:start'));
  assert.ok(events.some((item) => item.event === 'node:start' && item.payload.nodeId === 'a'));
  assert.ok(events.some((item) => item.event === 'node:done' && item.payload.nodeId === 'a'));
  assert.ok(events.some((item) => item.event === 'run:done'));
});

test('校验：合法工作流通过', () => {
  const { registry } = makeEngine();
  const result = validateWorkflow(
    {
      nodes: [{ id: 'a', type: 'notify', label: 'a', params: { message: 'ok' } }],
      edges: [],
    },
    registry,
  );
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.errors, []);
});

test('校验：设备不存在时报错（指向具体节点）', () => {
  const { registry } = makeEngine();
  const result = validateWorkflow(
    {
      nodes: [{ id: 'a', type: 'device', label: 'a', params: { deviceId: 'ghost', action: 'moveTo' } }],
      edges: [],
    },
    registry,
  );
  assert.strictEqual(result.ok, false);
  const error = result.errors.find((item) => item.code === 'deviceGone');
  assert.ok(error, '应报设备不存在');
  assert.strictEqual(error.nodeId, 'a');
});
