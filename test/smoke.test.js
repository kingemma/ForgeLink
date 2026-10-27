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

const PORTS = [5021, 8631, 9001, 9101];
// 定向扫描本机：避免测试去枚举整个局域网，保证结果确定且快速
const SCAN_OPTIONS = { ports: PORTS, hosts: ['127.0.0.1'] };

let cluster;

test.before(() => {
  cluster = new SimulatorCluster();
  cluster.start();
});

test.after(() => {
  cluster?.stop();
});

test('协议层：Modbus-TCP 能读到机械臂寄存器', async () => {
  const client = await ModbusClient.connect('127.0.0.1', 5021, { timeout: 2000 });
  try {
    const registers = await client.readHoldingRegisters(0, 14);
    assert.strictEqual(registers[0], 0x5242, '设备标识寄存器应为 0x5242');
    assert.strictEqual(registers.length, 14);
  } finally {
    client.close();
  }
});

test('协议层：IPP 能查询打印机属性', async () => {
  const client = new IppClient({ host: '127.0.0.1', port: 8631, path: '/ipp/print' });
  const info = await client.getPrinterAttributes();
  assert.ok(info.makeAndModel, '应返回 make-and-model');
  assert.strictEqual(info.state, 'idle');
});

test('协议层：SNMP 能读取 Printer MIB', async () => {
  const client = new SnmpClient({ host: '127.0.0.1', port: 8161 });
  const results = await client.get(['1.3.6.1.2.1.1.1.0', '1.3.6.1.2.1.43.11.1.1.9.1.1']);
  assert.ok(results['1.3.6.1.2.1.1.1.0'].value.includes('ForgeLink'));
  assert.ok(results['1.3.6.1.2.1.43.11.1.1.9.1.1'].value > 0);
});

test('协议层：行式文本协议能查询机械臂状态', async () => {
  const client = await LineClient.connect('127.0.0.1', 9001, { timeout: 2000 });
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
