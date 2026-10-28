const test = require('node:test');
const assert = require('node:assert');
const { expandCidr, ipToInt, intToIp, sameSubnet } = require('../src/main/discovery/arp');
const { QUICK_PORTS, SERVICE_TYPES, hintsFor, serviceHint, deepPorts } = require('../src/main/discovery/fingerprints');
const { identifyRobotBrand, brandById, ROBOT_PORTS } = require('../src/main/discovery/robots');

test('网段工具：IP 与整数互转、同网段判定', () => {
  assert.strictEqual(ipToInt('192.168.1.1'), 0xc0a80101);
  assert.strictEqual(intToIp(0xc0a80101), '192.168.1.1');
  assert.ok(sameSubnet('192.168.1.55', { address: '192.168.1.10', netmask: '255.255.255.0' }));
  assert.ok(!sameSubnet('192.168.2.55', { address: '192.168.1.10', netmask: '255.255.255.0' }));
});

test('网段工具：/24 展开跳过网络号与广播号', () => {
  const list = expandCidr('192.168.1.0/24', 256);
  assert.ok(!list.includes('192.168.1.0'), '不应包含网络号');
  assert.ok(!list.includes('192.168.1.255'), '不应包含广播号');
  assert.ok(list.includes('192.168.1.1'));
  assert.strictEqual(list.length, 254);
});

test('网段工具：展开数量受上限约束，避免巨型网段', () => {
  const list = expandCidr('10.0.0.0/8', 100);
  assert.ok(list.length <= 100);
});

test('端口指纹：机械臂端口已并入快速扫描，深度端口是超集', () => {
  for (const port of ROBOT_PORTS) assert.ok(QUICK_PORTS.includes(port), `快速扫描缺少机器人端口 ${port}`);
  const deep = deepPorts();
  for (const port of QUICK_PORTS) assert.ok(deep.includes(port), `深度扫描应包含 ${port}`);
  assert.ok(deep.length > QUICK_PORTS.length);
});

test('端口指纹：先验与 mDNS 服务类型映射', () => {
  assert.strictEqual(hintsFor(631)[0].protocol, 'ipp');
  assert.strictEqual(hintsFor(9100)[0].protocol, 'jetdirect');
  assert.strictEqual(hintsFor(502)[0].protocol, 'modbus-tcp');
  assert.strictEqual(serviceHint('_ipp._tcp').kind, 'printer');
  assert.strictEqual(serviceHint('_robot._tcp').kind, 'robot-arm');
  assert.strictEqual(serviceHint('_nope._tcp'), null);
  assert.ok(Object.keys(SERVICE_TYPES).length > 0);
});

test('品牌识别：关键字优先命中', () => {
  assert.strictEqual(identifyRobotBrand({ vendor: 'Universal Robots', model: 'UR5e' }).id, 'ur');
  assert.strictEqual(identifyRobotBrand({ vendor: 'JAKA' }).id, 'jaka');
  assert.strictEqual(identifyRobotBrand({ model: 'AUBO i5' }).id, 'aubo');
  assert.strictEqual(identifyRobotBrand({ vendor: 'Yaskawa Motoman' }).id, 'yaskawa');
});

test('品牌识别：端口兜底置信度更低，未知厂商不误判', () => {
  const byPort = identifyRobotBrand({ interfaces: [{ port: 30004, protocol: 'unknown' }] });
  assert.strictEqual(byPort.id, 'ur');
  assert.strictEqual(byPort.matched, 'port');
  assert.ok(byPort.confidence < 0.9, '端口兜底置信度应低于自述');
  assert.strictEqual(identifyRobotBrand({ vendor: 'Nobody Inc' }), null);
  assert.strictEqual(brandById('ur').name.includes('Universal'), true);
});
