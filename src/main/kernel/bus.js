const { EventEmitter } = require('node:events');

/**
 * 全局事件总线。
 *
 * 内核各层之间只通过事件耦合：发现层产出 `discovery:*`，协议层产出 `probe:*`，
 * 运行时产出 `device:*` / `workflow:*`，主进程把其中一部分桥接给渲染进程。
 * 这样新增一种协议或驱动时，不需要改动已有的订阅方。
 */
class Bus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
    this._seq = 0;
  }

  /** 结构化日志：既发到总线，也写入内存环形缓冲供 UI 回看 */
  log(level, scope, message, detail) {
    const entry = {
      id: ++this._seq,
      ts: Date.now(),
      level,
      scope,
      message,
      detail,
    };
    this.emit('log', entry);
    return entry;
  }

  info(scope, message, detail) {
    return this.log('info', scope, message, detail);
  }

  warn(scope, message, detail) {
    return this.log('warn', scope, message, detail);
  }

  error(scope, message, detail) {
    return this.log('error', scope, message, detail);
  }

  debug(scope, message, detail) {
    return this.log('debug', scope, message, detail);
  }
}

module.exports = new Bus();
