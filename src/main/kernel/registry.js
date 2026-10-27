const crypto = require('node:crypto');
const bus = require('./bus');

const MAX_HISTORY = 600;

/**
 * 设备注册表 —— 系统的「单一事实来源」。
 *
 * 一个设备（Device）是同一 IP 下若干通信接口（Interface）的聚合：
 * 机械臂可能同时暴露 Modbus-TCP(502) 与文本协议(9000)，打印机同时暴露 IPP(631)、
 * JetDirect(9100)、SNMP(161)。发现层只负责产出接口事实，注册表负责把它们归纳成设备，
 * 再由驱动层赋予能力。
 */
class Registry {
  constructor() {
    /** @type {Map<string, any>} */
    this.devices = new Map();
    /** @type {Map<string, {ts:number, values:Record<string,any>}[]>} */
    this.history = new Map();
    this.listeners = new Set();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit() {
    const snapshot = this.list();
    bus.emit('devices:changed', snapshot);
    for (const fn of this.listeners) fn(snapshot);
  }

  /** IP 是局域网内稳定的聚合键；MAC 作为辅助身份，避免 DHCP 换 IP 后重复建档 */
  static keyOf(ip) {
    return `dev_${ip.replace(/[.:]/g, '_')}`;
  }

  upsert(patch) {
    const id = patch.id || Registry.keyOf(patch.ip);
    const existing = this.devices.get(id) || {
      id,
      ip: patch.ip,
      firstSeen: Date.now(),
      interfaces: [],
      tags: [],
      hostnames: [],
    };

    const merged = {
      ...existing,
      ...patch,
      id,
      // 接口按 port+protocol 去重后合并，保留置信度更高的证据
      interfaces: mergeInterfaces(existing.interfaces, patch.interfaces || []),
      hostnames: unique([...(existing.hostnames || []), ...(patch.hostnames || [])]),
      tags: unique([...(existing.tags || []), ...(patch.tags || [])]),
      lastSeen: Date.now(),
    };

    // 用户改过名就锁住：发现层带来的自述名称（可能为 null）不应覆盖人工命名
    if (existing.nameLocked) merged.name = existing.name;

    this.devices.set(id, merged);
    this._emit();
    return merged;
  }

  /** 用户改名：改名即上锁；传空字符串表示恢复自动命名 */
  rename(id, name) {
    const device = this.devices.get(id);
    if (!device) return null;
    const value = String(name ?? '').trim() || null;
    device.name = value;
    device.nameLocked = Boolean(value);
    this._emit();
    return device;
  }

  get(id) {
    return this.devices.get(id);
  }

  list() {
    return [...this.devices.values()].sort((a, b) => (a.ip || '').localeCompare(b.ip || '', undefined, { numeric: true }));
  }

  remove(id) {
    this.devices.delete(id);
    this.history.delete(id);
    this._emit();
  }

  clear() {
    this.devices.clear();
    this.history.clear();
    this._emit();
  }

  patchState(id, state, status) {
    const device = this.devices.get(id);
    if (!device) return null;
    device.state = { ...(device.state || {}), ...state };
    if (status) device.status = status;
    device.lastSeen = Date.now();

    const series = this.history.get(id) || [];
    series.push({ ts: Date.now(), values: { ...device.state } });
    if (series.length > MAX_HISTORY) series.splice(0, series.length - MAX_HISTORY);
    this.history.set(id, series);

    bus.emit('device:state', { id, state: device.state, status: device.status, ts: Date.now() });
    return device;
  }

  getHistory(id) {
    return this.history.get(id) || [];
  }
}

function mergeInterfaces(current = [], incoming = []) {
  const byKey = new Map();
  for (const itf of [...current, ...incoming]) {
    const key = `${itf.port}/${itf.protocol}`;
    const prev = byKey.get(key);
    if (!prev || (itf.confidence || 0) > (prev.confidence || 0)) byKey.set(key, itf);
  }
  return [...byKey.values()].sort((a, b) => a.port - b.port);
}

function unique(list) {
  return [...new Set(list.filter(Boolean))];
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

module.exports = { Registry, randomId };
