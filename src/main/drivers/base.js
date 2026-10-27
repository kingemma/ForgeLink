/**
 * 设备驱动抽象 —— 第三层的核心：能力归一化。
 *
 * 万物在进入编排层之前必须被压平成同一形状。无论底层是 Modbus 寄存器、
 * IPP 属性还是一行文本，对上层只暴露三个原语：
 *   readState()  观测：设备现在怎么样
 *   invoke()     控制：让设备做一个动作
 *   subscribe()  订阅：状态变化时主动告知（能推送就不轮询）
 *
 * 新增一种设备 = 新增一个 Driver，不需要改动发现层、编排层与 UI。
 */
class DeviceDriver {
  static driverId = 'base';
  static label = '未知设备';
  static kind = 'unknown';
  static protocols = [];
  static actions = [];
  static stateFields = [];

  constructor(device, context = {}) {
    this.device = device;
    this.context = context;
    this.ready = false;
    this.lastError = null;
  }

  /** 按协议优先级挑出本驱动要用的通信接口 */
  pickInterface(protocols) {
    const list = (this.device.interfaces || []).filter((item) => protocols.includes(item.protocol));
    if (!list.length) return null;
    return list.slice().sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0];
  }

  async open() {
    this.ready = true;
    return this;
  }

  async close() {
    this.ready = false;
  }

  async readState() {
    throw new Error(`${this.constructor.driverId} 未实现 readState`);
  }

  async invoke() {
    throw new Error(`${this.constructor.driverId} 未实现 invoke`);
  }

  /** 默认无推送能力，由运行时降级为轮询 */
  async subscribe() {
    return () => {};
  }

  describeCapabilities() {
    return {
      driverId: this.constructor.driverId,
      kind: this.constructor.kind,
      actions: this.constructor.actions,
      stateFields: this.constructor.stateFields,
    };
  }

  /**
   * 适配度：给定事实（接口、banner、厂商字符串），判断本驱动能否驱动它。
   * 0 表示完全不适用；1 表示确定无疑。
   */
  static fitness() {
    return 0;
  }
}

/** 把设备所有证据拼成一个用于关键字匹配的字符串 */
function factsToText(facts) {
  const parts = [];
  parts.push(facts.vendor || '', facts.model || '', facts.name || '');
  for (const item of facts.interfaces || []) {
    parts.push(item.protocol || '');
    if (item.evidence) {
      if (typeof item.evidence === 'string') parts.push(item.evidence);
      else parts.push(JSON.stringify(item.evidence));
    }
  }
  for (const beacon of facts.beacons || []) {
    parts.push(beacon.kind || '', beacon.name || '', beacon.model || '', beacon.vendor || '');
    for (const itf of beacon.interfaces || []) parts.push(itf.protocol || '', itf.description || '');
  }
  for (const service of facts.mdns || []) parts.push(service.type || '', service.name || '', JSON.stringify(service.txt || {}));
  for (const entry of facts.ssdp || []) parts.push(entry.server || '', entry.st || '', entry.friendlyName || '', entry.modelName || '');
  return parts.filter(Boolean).join(' \n ').toLowerCase();
}

function hasProtocol(facts, protocol) {
  return (facts.interfaces || []).some((item) => item.protocol === protocol);
}

module.exports = { DeviceDriver, factsToText, hasProtocol };
