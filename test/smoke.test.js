const test = require('node:test');
const assert = require('node:assert');

const { Registry } = require('../src/main/kernel/registry');
const { DiscoveryService } = require('../src/main/discovery');
const { Agent } = require('../src/main/runtime/agent');
const { WorkflowEngine } = require('../src/main/runtime/workflow/engine');
const { SimulatorCluster } = require('../src/main/simulator');
const { ModbusClient } = require('../src/main/protocols/modbus');
const { IppClient } = require('../src/main/protocols/ipp');
const { SnmpClient } = require('../src/main/protocols/snmp');
const { LineClient } = require('../src/main/protocols/raw');

// 端口随机化：避免与正在运行的桌面端抢占默认端口，保证测试任何时候都能跑
const BASE_PORT = 15000 + Math.floor(Math.random() * 3000);
const PORTS = {
  modbus: BASE_PORT,
  ipp: BASE_PORT + 1,
  text: BASE_PORT + 2,
  jet: BASE_PORT + 3,
  snmp: BASE_PORT + 4,
};
// 定向扫描本机：避免测试去枚举整个局域网，保证结果确定且快速
const SCAN_OPTIONS = { ports: [PORTS.modbus, PORTS.ipp, PORTS.text, PORTS.jet], hosts: ['127.0.0.1'] };

let cluster;

test.before(() => {
  cluster = new SimulatorCluster({
    robotModbusPort: PORTS.modbus,
    robotTextPort: PORTS.text,
    printerIppPort: PORTS.ipp,
    printerJetPort: PORTS.jet,
    printerSnmpPort: PORTS.snmp,
  });
  cluster.start();
});

test.after(() => {
  cluster?.stop();
});

test('协议层：Modbus-TCP 能读到机械臂寄存器', async () => {
  const client = await ModbusClient.connect('127.0.0.1', PORTS.modbus, { timeout: 2000 });
  try {
    const registers = await client.readHoldingRegisters(0, 14);
    assert.strictEqual(registers[0], 0x5242, '设备标识寄存器应为 0x5242');
    assert.strictEqual(registers.length, 14);
  } finally {
    client.close();
  }
});

test('协议层：IPP 能查询打印机属性', async () => {
  const client = new IppClient({ host: '127.0.0.1', port: PORTS.ipp, path: '/ipp/print' });
  const info = await client.getPrinterAttributes();
  assert.ok(info.makeAndModel, '应返回 make-and-model');
  assert.strictEqual(info.state, 'idle');
});

test('协议层：SNMP 能读取 Printer MIB', async () => {
  const client = new SnmpClient({ host: '127.0.0.1', port: PORTS.snmp });
  const results = await client.get(['1.3.6.1.2.1.1.1.0', '1.3.6.1.2.1.43.11.1.1.9.1.1']);
  assert.ok(results['1.3.6.1.2.1.1.1.0'].value.includes('ForgeLink'));
  assert.ok(results['1.3.6.1.2.1.43.11.1.1.9.1.1'].value > 0);
});

test('协议层：行式文本协议能查询机械臂状态', async () => {
  const client = await LineClient.connect('127.0.0.1', PORTS.text, { timeout: 2000 });
  try {
    const response = await client.command('STATE');
    assert.ok(response.includes('STATUS:'), `响应应包含状态字段，实际：${response}`);
  } finally {
    client.close();
  }
});

test('发现层：能自动发现机械臂与打印机并识别协议', async (t) => {
  const registry = new Registry();
  const discovery = new DiscoveryService(registry);
  const result = await discovery.scan(SCAN_OPTIONS);
  assert.ok(result.ok);

  const devices = registry.list();
  const protocols = devices.flatMap((device) => device.interfaces.map((item) => item.protocol));
  assert.ok(protocols.includes('modbus-tcp'), `应识别 modbus-tcp，实际：${protocols.join(',')}`);
  assert.ok(protocols.includes('ipp'), `应识别 ipp，实际：${protocols.join(',')}`);
  assert.ok(protocols.includes('raw-text') || protocols.includes('jetdirect'), `应识别文本/直打协议，实际：${protocols.join(',')}`);
  t.diagnostic(`发现设备：${devices.map((d) => `${d.ip}:${d.interfaces.map((i) => i.protocol).join('/')}`).join(' | ')}`);

  // 驱动层：归一化后必须给出机械臂与打印机两类能力
  const agent = new Agent({ registry, store: null });
  agent.syncAll();
  const kinds = registry.list().map((device) => device.kind);
  assert.ok(kinds.includes('robot-arm'), `应识别机械臂，实际：${kinds.join(',')}`);
  assert.ok(kinds.includes('printer'), `应识别打印机，实际：${kinds.join(',')}`);

  const robot = registry.list().find((device) => device.kind === 'robot-arm');
  const printer = registry.list().find((device) => device.kind === 'printer');

  const robotState = await agent.readState(robot.id);
  assert.ok(Array.isArray(robotState.metrics.joints) || Array.isArray(robotState.raw.joints));

  const printerState = await agent.readState(printer.id);
  assert.ok(printerState.metrics.tonerLevel >= 0);

  // 控制：下发动作后状态必须发生变化
  await agent.invoke(robot.id, 'moveTo', { joints: [30, 10, 0, 0, 20, 0] });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const moved = await agent.readState(robot.id);
  const joints = moved.metrics.joints || moved.raw.joints;
  assert.notStrictEqual(joints[0], 0, '机械臂第一关节应已移动');

  const printResult = await agent.invoke(printer.id, 'printLabel', { title: 'TEST', code: 'A-1' });
  assert.ok(printResult.ok, '打印动作应成功');
});

test('编排层：多设备工作流按 DAG 顺序执行并完成数据流转', async () => {
  const registry = new Registry();
  const discovery = new DiscoveryService(registry);
  await discovery.scan(SCAN_OPTIONS);
  const agent = new Agent({ registry, store: null });
  agent.syncAll();
  const engine = new WorkflowEngine({ agent, registry });

  const robot = registry.list().find((device) => device.kind === 'robot-arm');
  const printer = registry.list().find((device) => device.kind === 'printer');

  const workflow = {
    id: 'test-flow',
    name: '测试流水线',
    nodes: [
      { id: 'n1', type: 'state', label: '读机械臂', params: { deviceId: robot.id } },
      { id: 'n2', type: 'device', label: '抓取', params: { deviceId: robot.id, action: 'pick', params: { force: 70 } } },
      { id: 'n3', type: 'transform', label: '编码', params: { expression: 'C-{{ nodes.n1.output.metrics.cycleCount }}' } },
      { id: 'n4', type: 'device', label: '打印标签', params: { deviceId: printer.id, action: 'printLabel', params: { title: 'T', code: '{{ nodes.n3.output }}' } } },
      { id: 'n5', type: 'notify', label: '通知', params: { message: '完成 {{ nodes.n3.output }}' } },
    ],
    edges: [
      { from: 'n1', to: 'n2' },
      { from: 'n2', to: 'n3' },
      { from: 'n3', to: 'n4' },
      { from: 'n4', to: 'n5' },
    ],
  };

  const run = await engine.run(workflow);
  assert.strictEqual(run.status, 'success', `工作流应成功：${JSON.stringify(run.results)}`);
  assert.ok(String(run.results.n3.output).startsWith('C-'), '数据应从上游流转到下游');
  assert.ok(run.results.n5.output.message.includes('C-'));
});

test('机械臂：品牌识别与可配置寄存器映射', async () => {
  const { identifyRobotBrand } = require('../src/main/discovery/robots');
  const { resolveRegisterMap } = require('../src/main/drivers/robot-arm');

  assert.strictEqual(identifyRobotBrand({ vendor: 'Universal Robots', model: 'UR5e' })?.id, 'ur');
  assert.strictEqual(identifyRobotBrand({ vendor: 'JAKA', model: 'Zu 7' })?.id, 'jaka');
  const byPort = identifyRobotBrand({ interfaces: [{ port: 30004, protocol: 'unknown' }] });
  assert.strictEqual(byPort?.id, 'ur', 'UR 端口应能兜底识别品牌');
  assert.strictEqual(identifyRobotBrand({ vendor: 'Unknown Vendor' }), null, '未知厂商不应误判');

  // 自定义映射只覆盖填了的字段，其余保留默认（各厂映射私有，必须由用户填写而非内置猜测）
  const map = resolveRegisterMap({ config: { registerMap: { status: 100, commands: { home: 20 } } } });
  assert.strictEqual(map.status, 100);
  assert.strictEqual(map.commands.home, 20);
  assert.strictEqual(map.commands.stop, 5, '未覆盖的命令码应保留默认值');
  assert.deepStrictEqual(map.joints, [2, 3, 4, 5, 6, 7], '未覆盖的字段应保留默认值');
});

test('编排层：运行前校验能定位配置错误、环与缺失分支', async () => {
  const { validateWorkflow } = require('../src/main/runtime/workflow/validate');
  const registry = new Registry();

  const empty = validateWorkflow({ nodes: [], edges: [] }, registry);
  assert.strictEqual(empty.ok, false);
  assert.ok(empty.errors.some((item) => item.code === 'empty'));

  const bad = validateWorkflow(
    {
      nodes: [
        { id: 'a', type: 'device', params: { deviceId: '', action: '' } },
        { id: 'b', type: 'condition', params: {} },
      ],
      edges: [],
    },
    registry,
  );
  assert.strictEqual(bad.ok, false);
  assert.ok(bad.errors.some((item) => item.nodeId === 'a' && item.code === 'missingDevice'));
  assert.ok(bad.errors.some((item) => item.nodeId === 'a' && item.code === 'missingAction'));
  assert.ok(bad.errors.some((item) => item.nodeId === 'b' && item.code === 'missingExpression'));

  const cyclic = validateWorkflow(
    {
      nodes: [
        { id: 'x', type: 'notify', params: { message: 'a' } },
        { id: 'y', type: 'notify', params: { message: 'b' } },
      ],
      edges: [
        { from: 'x', to: 'y' },
        { from: 'y', to: 'x' },
      ],
    },
    registry,
  );
  assert.ok(cyclic.errors.some((item) => item.code === 'cycle'), '应检出环');

  const branch = validateWorkflow(
    {
      nodes: [
        { id: 'c', type: 'condition', params: { expression: '{{ input.ok }}' } },
        { id: 'd', type: 'notify', params: { message: 't' } },
        { id: 'e', type: 'notify', params: { message: 'f' } },
      ],
      edges: [
        { from: 'c', to: 'd' },
        { from: 'c', to: 'e' },
      ],
    },
    registry,
  );
  assert.strictEqual(branch.ok, true);
  assert.ok(branch.warnings.some((item) => item.code === 'branchAmbiguous'), '未标记分支应告警');
});

test('编排层：条件分支按 edge.when 选择下游，且工作流入参可用', async () => {
  const registry = new Registry();
  const agent = new Agent({ registry, store: null });
  const engine = new WorkflowEngine({ agent, registry });

  const run = await engine.run(
    {
      id: 'branch',
      name: '分支',
      nodes: [
        { id: 'c', type: 'condition', params: { expression: '{{ eq(input.value, 1) }}' } },
        { id: 'yes', type: 'notify', params: { message: '走了真分支' } },
        { id: 'no', type: 'notify', params: { message: '走了假分支' } },
      ],
      edges: [
        { from: 'c', to: 'yes', when: 'true' },
        { from: 'c', to: 'no', when: 'false' },
      ],
      input: { value: 1 },
    },
  );
  assert.strictEqual(run.status, 'success', JSON.stringify(run.results));
  assert.ok(run.results.yes.ok, '真分支应执行');
  assert.ok(run.results.no.skipped, '假分支应被跳过');
});

test('编排层：waitUntil 按设备真实状态完成交接（替代硬编码延时）', async () => {
  const registry = new Registry();
  const discovery = new DiscoveryService(registry);
  await discovery.scan(SCAN_OPTIONS);
  const agent = new Agent({ registry, store: null });
  agent.syncAll();
  const engine = new WorkflowEngine({ agent, registry });
  const robot = registry.list().find((device) => device.kind === 'robot-arm');
  assert.ok(robot, '应发现机械臂');

  // 移动 → 等它真正停下来 → 再抓取：交接点由设备状态决定，不靠猜时间
  const run = await engine.run({
    id: 'handoff',
    name: '机械臂交接',
    nodes: [
      { id: 'n1', type: 'device', label: '移动', params: { deviceId: robot.id, action: 'moveTo', params: { joints: [10, 10, 10, 0, 0, 0] } } },
      {
        id: 'n2',
        type: 'waitUntil',
        label: '等待就位',
        params: { deviceId: robot.id, expression: "{{ eq(state.metrics.status, 'idle') }}", timeoutMs: 10000, intervalMs: 300 },
      },
      { id: 'n3', type: 'device', label: '抓取', params: { deviceId: robot.id, action: 'pick', params: { force: 50 } } },
    ],
    edges: [{ from: 'n1', to: 'n2' }, { from: 'n2', to: 'n3' }],
  });
  assert.strictEqual(run.status, 'success', `交接工作流应成功：${JSON.stringify(run.results)}`);
  assert.ok(run.results.n2.output.waited >= 0, 'waitUntil 应返回等待时长');
  assert.ok(run.results.n3.output.result.ok, '交接完成后抓取应执行成功');

  // 条件永远不满足时应超时失败，而不是无限阻塞
  const timeoutRun = await engine.run({
    id: 'handoff-timeout',
    name: '交接超时',
    nodes: [
      {
        id: 'n1',
        type: 'waitUntil',
        label: '等待不可能满足的条件',
        params: { deviceId: robot.id, expression: "{{ eq(state.metrics.load, 999) }}", timeoutMs: 800, intervalMs: 200 },
      },
    ],
    edges: [],
  });
  assert.strictEqual(timeoutRun.status, 'failed', '条件不满足时应标记失败');
  assert.match(timeoutRun.results.n1.error, /等待超时/);
});
