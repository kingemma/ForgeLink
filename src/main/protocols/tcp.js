const net = require('node:net');

/**
 * TCP 会话原语。
 *
 * 所有基于流的协议（Modbus-TCP、JetDirect、行式文本协议）都需要同一组能力：
 * 连接、发送、读到「对端安静下来为止」或读到定长。把这些抽出来，
 * 上层协议实现就只剩报文编解码。
 */
class TcpSession {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this._wake?.();
    });
    socket.on('close', () => {
      this.closed = true;
      this._wake?.();
    });
    socket.on('error', () => {
      this.closed = true;
      this._wake?.();
    });
  }

  static connect(host, port, timeout = 2000) {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      socket.setTimeout(timeout);
      socket.once('timeout', () => fail(new Error(`连接 ${host}:${port} 超时`)));
      socket.once('error', fail);
      socket.connect(port, host, () => {
        if (settled) return;
        settled = true;
        socket.setTimeout(0);
        socket.removeListener('error', fail);
        resolve(new TcpSession(socket));
      });
    });
  }

  send(data) {
    const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    this.socket.write(buffer);
    return this;
  }

  /** 等待新数据到达（或连接关闭），用于实现「读到安静为止」 */
  _wait(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._wake = null;
        resolve();
      }, ms);
      this._wake = () => {
        clearTimeout(timer);
        this._wake = null;
        resolve();
      };
    });
  }

  /**
   * 读取对端主动发送的数据：连续 quiet 毫秒没有新字节就结束。
   * @param {{quiet?: number, timeout?: number}} options
   */
  async readAvailable(options = {}) {
    const { quiet = 220, timeout = 1500 } = options;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline && !this.closed) {
      if (this.buffer.length === 0) {
        await this._wait(Math.min(quiet, Math.max(20, deadline - Date.now())));
        continue;
      }
      const before = this.buffer.length;
      await this._wait(quiet);
      if (this.buffer.length === before) break; // 已安静
    }
    return this.takeAll();
  }

  /** 读取恰好 n 字节 */
  async readExact(n, timeout = 1500) {
    const deadline = Date.now() + timeout;
    while (this.buffer.length < n && Date.now() < deadline && !this.closed) {
      await this._wait(Math.min(150, Math.max(20, deadline - Date.now())));
    }
    if (this.buffer.length < n) {
      const partial = this.takeAll();
      if (!partial.length) throw new Error(`预期 ${n} 字节，连接无响应`);
      return partial;
    }
    const out = this.buffer.subarray(0, n);
    this.buffer = this.buffer.subarray(n);
    return out;
  }

  takeAll() {
    const out = this.buffer;
    this.buffer = Buffer.alloc(0);
    return out;
  }

  close() {
    this.closed = true;
    try {
      this.socket.destroy();
    } catch {
      /* 已关闭 */
    }
  }
}

/** 一次性会话：连接 → 执行 → 关闭 */
async function withSession(host, port, handler, timeout = 2000) {
  const session = await TcpSession.connect(host, port, timeout);
  try {
    return await handler(session);
  } finally {
    session.close();
  }
}

module.exports = { TcpSession, withSession };
