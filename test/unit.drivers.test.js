const test = require('node:test');
const assert = require('node:assert');
const { resolveRegisterMap, DEFAULT_REGISTER_MAP, RobotArmDriver, STATUS_TEXT } = require('../src/main/drivers/robot-arm');
const { GenericDriver } = require('../src/main/drivers/generic');
const { factsToText, hasProtocol } = require('../src/main/drivers/base');

test('机械臂映射：自定义只覆盖填写项，其余保留默认', () => {
  const map = resolveRegisterMap({
    config: { registerMap: { status: 100, joints: [1, 2, 3, 4, 5, 6], commands: { home: 20 } } },
  });
  assert.strictEqual(map.status, 100);
  assert.deepStrictEqual(map.joints, [1, 2, 3, 4, 5, 6]);
  assert.strictEqual(map.commands.home, 20);
  assert.strictEqual(map.commands.stop, DEFAULT_REGISTER_MAP.commands.stop, '未覆盖的命令码应保留默认');
  assert.strictEqual(map.scale.joint, 10, '未覆盖的缩放系数应保留默认');
});

test('机械臂映射：无自定义时返回完整默认映射', () => {
  const plain = resolveRegisterMap({});
  assert.strictEqual(plain.status, DEFAULT_REGISTER_MAP.status);
  assert.deepStrictEqual(plain.targets, DEFAULT_REGISTER_MAP.targets);
  assert.strictEqual(plain.command, DEFAULT_REGISTER_MAP.command);
});

test('机械臂适配度：Modbus / 设备标识 / 品牌关键字分别提权', () => {
  const modbusOnly = { interfaces: [{ port: 502, protocol: 'modbus-tcp', evidence: {} }] };
  assert.ok(RobotArmDriver.fitness(modbusOnly) >= 0.6);

  const withId = { interfaces: [{ port: 502, protocol: 'modbus-tcp', evidence: { registers: [0x5242] } }] };
  assert.ok(RobotArmDriver.fitness(withId) >= 0.95, '设备标识 0x5242 应高置信');

  const brand = { vendor: 'Universal Robots', interfaces: [] };
  assert.ok(RobotArmDriver.fitness(brand) >= 0.9);

  const printer = { vendor: 'HP', model: 'LaserJet', interfaces: [{ port: 9100, protocol: 'jetdirect' }] };
  assert.ok(RobotArmDriver.fitness(printer) < 0.9, '打印机不应被判为机械臂');
});

test('机械臂驱动：无接口时明确报错而不是静默', async () => {
  const driver = new RobotArmDriver({ ip: '10.0.0.30', interfaces: [] }, {});
  await assert.rejects(() => driver.readState(), /没有可用通信接口/);
});

test('通用驱动：无接口时读取状态不抛错（L2 确认的主机）', async () => {
  const driver = new GenericDriver({ ip: '10.0.0.99', interfaces: [] }, {});
  const state = await driver.readState();
  assert.strictEqual(state.status, 'online');
  assert.strictEqual(state.metrics.reachable, true);
});

test('驱动基类：事实拼装与协议判定', () => {
  assert.ok(hasProtocol({ interfaces: [{ protocol: 'ipp' }] }, 'ipp'));
  assert.ok(!hasProtocol({ interfaces: [] }, 'ipp'));
  const text = factsToText({ vendor: 'ACME', model: 'X1', interfaces: [{ protocol: 'modbus-tcp' }] });
  assert.ok(text.includes('acme'));
  assert.ok(text.includes('modbus-tcp'));
  assert.strictEqual(factsToText({}), '');
});

test('机械臂状态枚举映射', () => {
  assert.strictEqual(STATUS_TEXT[0], 'idle');
  assert.strictEqual(STATUS_TEXT[1], 'moving');
  assert.strictEqual(STATUS_TEXT[2], 'error');
});
