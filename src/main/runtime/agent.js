const bus = require('../kernel/bus');
const { createDriver, listDrivers, buildFacts } = require('../drivers');
const { detect } = require('../protocols/detect');

/**
 * 智能体（Agent）——把前四层串起来的中枢。
 *
 * 职责边界很清晰：它不发明协议，也不画界面，只做三件事：
 *   1) 识别：给设备档案挑出最合适的驱动（attach）
 *   2) 执行：把「动作名 + 参数」翻译成具体协议的报文（invoke）
 *   3) 观测：周期读取状态并回写注册表（readState）
 * 因此任意设备一旦被 attach，就立刻拥有统一能力，可以直接拖进工作流。
 */
class Agent {
  constructor({ registry, store }) {
    this.registry = registry;
    this.store = store;
    /** @type {Map<string, {driver:any, driverId:string, kind:string, label:string, fitness:number, signature:string}>} */
    this.drivers = new Map();
    this.options = {};
  }

  /** 设备档案签名：接口集合变化时必须重新选型 */
  static signatureOf(device) {
    return (device.interfaces || [])
      .map((item) => `${item.port}:${item.protocol}`)
      .sort()
      .join('|');
  }

  /** 为设备绑定驱动；已绑定且接口未变时直接复用 */
  attach(device) {
    const signature = Agent.signatureOf(device);
    const cached = this.drivers.get(device.id);
    if (cached && cached.signature === signature) return cached;

    const { driver, fitness, driverId, kind, label } = createDriver(device, this.options);
    const entry = { driver, driverId, kind, label, fitness, signature };
    this.drivers.set(device.id, entry);

    this.registry.upsert({
      id: device.id,
      ip: device.ip,
      driver: driverId,
      driverLabel: label,
      kind,
      fitness,
      capabilities: driver.describeCapabilities(),
      status: device.status || 'online',
    });
    bus.info('agent', `${device.name || device.ip} → ${label}（适配度 ${fitness.toFixed(2)}，接口 ${signature || '无'}）`);
    return entry;
  }

  syncAll() {
    for (const device of this.registry.list()) {
      try {
        this.attach(device);
      } catch (error) {
        bus.error('agent', `为 ${device.ip} 绑定驱动失败：${error.message}`);
      }
    }
  }

  ensure(deviceId) {
    const device = this.registry.get(deviceId);
    if (!device) throw new Error(`设备不存在：${deviceId}`);
    return this.attach(device);
  }

  getDriverEntry(deviceId) {
    const device = this.registry.get(deviceId);
    if (!device) return null;
    return this.attach(device);
  }

  async readState(deviceId) {
    const entry = this.ensure(deviceId);
    const state = await entry.driver.readState();
    this.registry.patchState(deviceId, state.metrics, state.status);
    return { deviceId, ...state };
  }

  async invoke(deviceId, action, params = {}) {
    const entry = this.ensure(deviceId);
    const device = this.registry.get(deviceId);
    bus.info('agent', `调用 ${device?.name || deviceId} 的 ${action} 动作`, params);
    const result = await entry.driver.invoke(action, params);
    // 动作通常会改变设备状态，短延迟后回读一次，让 UI 立刻看到结果
    setTimeout(() => {
      this.readState(deviceId).catch(() => {});
    }, 400);
    return result;
  }

  /** 重新探测设备接口（协议可能变更或设备重启后端口变化） */
  async refresh(deviceId) {
    const device = this.registry.get(deviceId);
    if (!device) throw new Error(`设备不存在：${deviceId}`);
    const interfaces = [];
    for (const item of device.interfaces || []) {
      const match = await detect(device.ip, item.port, { hints: [{ protocol: item.protocol, weight: 1 }], timeout: 1200 }).catch(() => null);
      if (match && match.protocol !== 'unknown') {
        interfaces.push({
          port: item.port,
          protocol: match.protocol,
          transport: match.transport || item.transport,
          confidence: match.confidence,
          evidence: match.evidence,
          details: match.details,
        });
      }
    }
    if (interfaces.length) this.registry.upsert({ id: deviceId, ip: device.ip, interfaces });
    this.drivers.delete(deviceId);
    return this.attach(this.registry.get(deviceId));
  }

  capabilities(deviceId) {
    const entry = this.getDriverEntry(deviceId);
    return entry ? entry.driver.describeCapabilities() : null;
  }

  summary() {
    const devices = this.registry.list();
    const byKind = {};
    for (const device of devices) {
      const kind = device.kind || 'unknown';
      byKind[kind] = (byKind[kind] || 0) + 1;
    }
    return {
      total: devices.length,
      byKind,
      online: devices.filter((device) => device.status === 'online').length,
      drivers: listDrivers(),
      facts: devices.map((device) => buildFacts(device).interfaces.length),
    };
  }
}

module.exports = { Agent };
