const test = require('node:test');
const assert = require('node:assert');
const { Registry } = require('../src/main/kernel/registry');

test('注册表：upsert 按 port+protocol 合并接口，保留置信度更高的证据', () => {
  const registry = new Registry();
  registry.upsert({ ip: '10.0.0.5', interfaces: [{ port: 502, protocol: 'modbus-tcp', confidence: 0.6 }] });
  registry.upsert({ ip: '10.0.0.5', interfaces: [{ port: 502, protocol: 'modbus-tcp', confidence: 0.95 }] });
  const device = registry.get('dev_10_0_0_5');
  assert.strictEqual(device.interfaces.length, 1, '同一接口不应重复建档');
  assert.strictEqual(device.interfaces[0].confidence, 0.95);

  registry.upsert({ ip: '10.0.0.5', interfaces: [{ port: 9000, protocol: 'raw-text', confidence: 0.7 }] });
  assert.strictEqual(registry.get('dev_10_0_0_5').interfaces.length, 2, '不同接口应并存');
});

test('注册表：改名后锁定发现不覆盖；清空即解锁', () => {
  const registry = new Registry();
  const id = Registry.keyOf('10.0.0.7');
  registry.upsert({ ip: '10.0.0.7', name: null });
  registry.rename(id, '装配臂A');
  assert.strictEqual(registry.get(id).nameLocked, true);

  registry.upsert({ ip: '10.0.0.7', name: 'Auto-Discovered' });
  assert.strictEqual(registry.get(id).name, '装配臂A', '人工命名不应被覆盖');

  registry.rename(id, '   ');
  assert.strictEqual(registry.get(id).name, null);
  assert.strictEqual(registry.get(id).nameLocked, false);

  registry.upsert({ ip: '10.0.0.7', name: 'Auto-Again' });
  assert.strictEqual(registry.get(id).name, 'Auto-Again', '解锁后应恢复自动命名');
});

test('注册表：patchState 写入状态并累积时序', () => {
  const registry = new Registry();
  const id = Registry.keyOf('10.0.0.9');
  registry.upsert({ ip: '10.0.0.9' });
  for (let i = 0; i < 5; i += 1) registry.patchState(id, { load: i }, 'online');
  assert.strictEqual(registry.getHistory(id).length, 5);
  assert.strictEqual(registry.get(id).status, 'online');
  assert.strictEqual(registry.get(id).state.load, 4, '后写入的字段应覆盖');
});

test('注册表：remove 与 clear', () => {
  const registry = new Registry();
  const id = Registry.keyOf('10.0.0.11');
  registry.upsert({ ip: '10.0.0.11' });
  assert.ok(registry.get(id));
  registry.remove(id);
  assert.strictEqual(registry.get(id), undefined);
  assert.strictEqual(registry.getHistory(id).length, 0, '历史也应一并清理');

  registry.upsert({ ip: '10.0.0.12' });
  registry.clear();
  assert.strictEqual(registry.list().length, 0);
});

test('注册表：keyOf 以 IP 为稳定键，list 按 IP 排序', () => {
  assert.strictEqual(Registry.keyOf('192.168.1.10'), 'dev_192_168_1_10');
  const registry = new Registry();
  registry.upsert({ ip: '10.0.0.20' });
  registry.upsert({ ip: '10.0.0.3' });
  registry.upsert({ ip: '10.0.0.4' });
  const ips = registry.list().map((device) => device.ip);
  assert.deepStrictEqual(ips, ['10.0.0.3', '10.0.0.4', '10.0.0.20']);
});
