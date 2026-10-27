const net = require('node:net');
const crypto = require('node:crypto');

/**
 * 最小 WebSocket 客户端（RFC 6455）。
 *
 * 只实现探测与状态订阅真正需要的部分：握手、文本帧收发、Ping/Pong、Close。
 * 目的不是做通用 WS 库，而是让「设备主动推送状态」这条通道可用——
 * 轮询是下策，推送才是实时监测应有的形态。
 */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

class WebSocketClient {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.open = true;
    this._handlers = { message: [], close: [], error: [] };
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => {
      this.open = false;
      this._emit('close', null);
    });
    socket.on('error', (error) => {
      this.open = false;
      this._emit('error', error);
    });
  }

  static connect(url, options = {}) {
    const { timeout = 2500, protocols = [] } = options;
    const parsed = new URL(url);
    const port = parsed.port || (parsed.protocol === 'wss:' ? 443 : 80);
    const key = crypto.randomBytes(16).toString('base64');
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
      socket.once('timeout', () => fail(new Error('WebSocket 握手超时')));
      socket.once('error', fail);
      socket.connect(Number(port), parsed.hostname, () => {
        const headers = [
          `GET ${parsed.pathname || '/'}${parsed.search || ''} HTTP/1.1`,
          `Host: ${parsed.host}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
        ];
        if (protocols.length) headers.push(`Sec-WebSocket-Protocol: ${protocols.join(', ')}`);
        socket.write(`${headers.join('\r\n')}\r\n\r\n`);

        const onHandshake = (chunk) => {
          const text = chunk.toString('binary');
          const separator = text.indexOf('\r\n\r\n');
          if (separator === -1) return;
          socket.removeListener('data', onHandshake);
          const head = text.slice(0, separator);
          const rest = Buffer.from(text.slice(separator + 4), 'binary');
          const lines = head.split('\r\n');
          if (!/101/.test(lines[0])) {
            fail(new Error(`WebSocket 握手被拒绝：${lines[0]}`));
            return;
          }
          const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
          const serverAccept = lines.find((line) => /^sec-websocket-accept:/i.test(line))?.split(':')[1]?.trim();
          if (serverAccept !== accept) {
            fail(new Error('WebSocket Sec-WebSocket-Accept 校验失败'));
            return;
          }
          socket.setTimeout(0);
          settled = true;
          const client = new WebSocketClient(socket);
          if (rest.length) client._onData(rest);
          resolve(client);
        };
        socket.on('data', onHandshake);
      });
    });
  }

  on(event, handler) {
    if (this._handlers[event]) this._handlers[event].push(handler);
    return this;
  }

  _emit(event, payload) {
    for (const handler of this._handlers[event] || []) handler(payload);
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const frame = this._readFrame();
      if (!frame) break;
      if (frame.opcode === OP_TEXT || frame.opcode === OP_BINARY || frame.opcode === OP_CONTINUATION) {
        this._emit('message', frame.opcode === OP_BINARY ? frame.payload : frame.payload.toString('utf8'));
      } else if (frame.opcode === OP_PING) {
        this._sendFrame(OP_PONG, frame.payload);
      } else if (frame.opcode === OP_CLOSE) {
        this.open = false;
        this._emit('close', null);
        this.close();
      }
    }
  }

  _readFrame() {
    const buffer = this.buffer;
    if (buffer.length < 2) return null;
    const b0 = buffer[0];
    const b1 = buffer[1];
    const opcode = b0 & 0x0f;
    const masked = Boolean(b1 & 0x80);
    let length = b1 & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < 4) return null;
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buffer.length < 10) return null;
      length = Number(buffer.readBigUInt64BE(2));
      offset = 10;
    }
    const maskKey = masked ? buffer.subarray(offset, offset + 4) : null;
    if (masked) offset += 4;
    if (buffer.length < offset + length) return null;
    const payload = Buffer.from(buffer.subarray(offset, offset + length));
    if (maskKey) for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4];
    this.buffer = buffer.subarray(offset + length);
    return { opcode, payload };
  }

  _sendFrame(opcode, payload) {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload ?? ''), 'utf8');
    const mask = crypto.randomBytes(4);
    let header;
    if (data.length < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | data.length;
    } else if (data.length < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(data.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(data.length), 2);
    }
    header[0] = 0x80 | opcode;
    const masked = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i += 1) masked[i] = data[i] ^ mask[i % 4];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  send(text) {
    if (!this.open) throw new Error('WebSocket 已关闭');
    this._sendFrame(OP_TEXT, text);
  }

  close() {
    try {
      this.socket.destroy();
    } catch {
      /* 已关闭 */
    }
  }
}

module.exports = { WebSocketClient };
