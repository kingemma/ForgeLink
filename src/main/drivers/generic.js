const { DeviceDriver, factsToText } = require('./base');
const { request } = require('../protocols/http');
const { WebSocketClient } = require('../protocols/websocket');

/**
 * 通用驱动 —— 兜底层。
 *
 * 「连接万物」必然遇到既不是机械臂也不是打印机的东西。对这类设备不下结论，
 * 而是给出它能确定的最小能力：HTTP 可达 + 可发任意请求 + （若有 WS）可订阅推送。
 * 这样未知设备依然能进入工作流，只是能力少一些。
 */
class GenericDriver extends DeviceDriver {
  static driverId = 'generic';
  static label = '通用网络服务';
  static kind = 'generic';
  static protocols = ['http', 'https', 'websocket', 'raw-text', 'unknown', 'snmp'];
  static actions = [
    { id: 'request', name: '发送 HTTP 请求', params: [{ name: 'method', label: '方法', type: 'string', default: 'GET' }, { name: 'path', label: '路径', type: 'string', default: '/' }, { name: 'body', label: '请求体', type: 'text', default: '' }] },
    { id: 'send', name: '发送原始数据', params: [{ name: 'data', label: '内容', type: 'text', default: 'ping' }] },
  ];
  static stateFields = ['reachable', 'latency', 'statusCode', 'server'];

  constructor(device, context) {
    super(device, context);
    const candidates = ['http', 'https', 'websocket', 'raw-text'];
    this.interface = this.pickInterface(candidates) || (device.interfaces || [])[0] || null;
    this.protocol = this.interface?.protocol || 'unknown';
  }

  static fitness() {
    return 0.15; // 兜底：永远可用，但优先级最低
  }

  async readState() {
    const started = Date.now();
    if (this.protocol === 'http' || this.protocol === 'https') {
      const response = await request({ host: this.device.ip, port: this.interface.port, path: '/', method: 'GET', timeout: 2000 });
      let data = null;
      try {
        data = JSON.parse(response.text);
      } catch {
        data = null;
      }
      return {
        status: response.status < 500 ? 'online' : 'error',
        metrics: {
          reachable: true,
          latency: Date.now() - started,
          statusCode: response.status,
          server: response.headers.server || null,
          contentType: response.headers['content-type'] || null,
        },
        raw: { data, text: response.text.slice(0, 500) },
      };
    }
    if (this.protocol === 'websocket') {
      const client = await WebSocketClient.connect(`ws://${this.device.ip}:${this.interface.port}/`, { timeout: 2000 });
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 900);
        client.on('message', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      client.close();
      return { status: 'online', metrics: { reachable: true, latency: Date.now() - started }, raw: {} };
    }
    const text = factsToText({ interfaces: this.interface ? [this.interface] : [] });
    return {
      status: 'online',
      metrics: { reachable: true, latency: Date.now() - started, protocol: this.protocol, hint: text.slice(0, 120) },
      raw: {},
    };
  }

  async invoke(action, params = {}) {
    if (action === 'request') {
      const response = await request({
        host: this.device.ip,
        port: this.interface.port,
        path: params.path || '/',
        method: (params.method || 'GET').toUpperCase(),
        body: params.body || null,
        timeout: 3000,
      });
      return { ok: response.status < 400, status: response.status, text: response.text.slice(0, 1000) };
    }
    if (action === 'send') {
      const { TcpSession } = require('../protocols/tcp');
      const session = await TcpSession.connect(this.device.ip, this.interface.port, 2000);
      try {
        session.send(String(params.data ?? ''));
        const response = (await session.readAvailable({ quiet: 250, timeout: 1500 })).toString('utf8');
        return { ok: true, response: response.slice(0, 1000) };
      } finally {
        session.close();
      }
    }
    throw new Error(`通用设备不支持动作：${action}`);
  }
}

module.exports = { GenericDriver };
