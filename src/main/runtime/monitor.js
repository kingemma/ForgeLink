const bus = require('../kernel/bus');

/**
 * 运行状态监测（第五层的数据来源）。
 *
 * 监测的第一性问题：状态是「随时间变化的值」，所以采集必须是周期性的序列，
 * 而不是一次性的快照。这里做三件事：
 *   1) 按固定周期调用驱动的 readState()
 *   2) 写入设备级环形缓冲（registry 负责），供 UI 画趋势曲线
 *   3) 连续失败判定离线，避免把「网络抖动」误报成设备故障
 */
class Monitor {
  constructor({ registry, agent, intervalMs = 2000 }) {
    this.registry = registry;
    this.agent = agent;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.failureCount = new Map();
    this.running = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    bus.info('monitor', `状态监测已启动，周期 ${this.intervalMs}ms`);
    this._schedule();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    bus.info('monitor', '状态监测已停止');
  }

  _schedule() {
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      try {
        await this.tick();
      } catch (error) {
        bus.error('monitor', `监测周期异常：${error.message}`);
      }
      this._schedule();
    }, this.intervalMs);
  }

  async tick() {
    const devices = this.registry.list().filter((device) => device.driver && device.driver !== 'generic-none');
    if (!devices.length) return;

    // 有限并发：避免局域网内几十台设备同时被轮询造成自扰
    const concurrency = 6;
    let cursor = 0;
    const worker = async () => {
      while (cursor < devices.length) {
        const device = devices[cursor];
        cursor += 1;
        await this.poll(device);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, devices.length) }, worker));
  }

  async poll(device) {
    try {
      const state = await this.agent.readState(device.id);
      this.failureCount.set(device.id, 0);
      this.registry.patchState(device.id, state.metrics, state.status);
      return state;
    } catch (error) {
      const failures = (this.failureCount.get(device.id) || 0) + 1;
      this.failureCount.set(device.id, failures);
      if (failures >= 3) {
        this.registry.patchState(device.id, { lastError: error.message }, 'offline');
        bus.warn('monitor', `${device.name || device.ip} 连续 ${failures} 次读取失败：${error.message}`);
      }
      return null;
    }
  }
}

module.exports = { Monitor };
