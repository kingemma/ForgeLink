const http = require('node:http');

/**
 * HTTP 探测与通用 REST 客户端。
 *
 * HTTP 是「最可能说人话」的协议：拿到响应头（Server / Content-Type）往往就能
 * 直接判定设备身份（例如 `Server: CUPS/2.4` ⇒ 打印服务）。因此探测链把 HTTP 放在首位。
 */
function request(options) {
  const { host, port = 80, path = '/', method = 'GET', headers = {}, body = null, timeout = 2500 } = options;
  return new Promise((resolve, reject) => {
    let client;
    const timer = setTimeout(() => {
      client?.destroy(new Error(`HTTP ${method} ${host}:${port} 超时`));
    }, timeout);
    try {
      client = http.request(
        {
          host,
          port,
          path,
          method,
          headers: { 'User-Agent': 'ForgeLink/1.0', Accept: '*/*', ...headers },
          timeout,
        },
        (response) => {
          const chunks = [];
          response.on('data', (chunk) => {
            if (chunks.length < 512) chunks.push(chunk); // 探测阶段限制内存占用
          });
          response.on('end', () => {
            clearTimeout(timer);
            const buffer = Buffer.concat(chunks);
            resolve({
              status: response.statusCode,
              statusMessage: response.statusMessage,
              headers: response.headers,
              body: buffer,
              text: buffer.toString('utf8'),
            });
          });
          response.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
          });
        },
      );
      client.on('timeout', () => client.destroy(new Error('HTTP 超时')));
      client.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      if (body) client.write(body);
      client.end();
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}

async function get(host, port, path = '/', options = {}) {
  return request({ host, port, path, method: 'GET', ...options });
}

async function post(host, port, path, payload, options = {}) {
  const isObject = payload && typeof payload === 'object' && !Buffer.isBuffer(payload);
  const body = isObject ? JSON.stringify(payload) : payload;
  return request({
    host,
    port,
    path,
    method: 'POST',
    body,
    headers: { 'Content-Type': isObject ? 'application/json' : 'text/plain', ...(options.headers || {}) },
    ...options,
  });
}

/** 尝试从常用路径抓取一份「设备自述」，用于能力发现 */
async function fetchDescriptor(host, port, paths = ['/forgelink/device', '/api/device', '/device/info', '/status', '/']) {
  for (const path of paths) {
    try {
      const response = await get(host, port, path, { timeout: 1500 });
      if (response.status >= 200 && response.status < 300 && response.text.trim()) {
        try {
          return { path, data: JSON.parse(response.text), headers: response.headers };
        } catch {
          return { path, data: null, headers: response.headers, text: response.text.slice(0, 2000) };
        }
      }
    } catch {
      /* 路径不存在，继续下一个 */
    }
  }
  return null;
}

module.exports = { request, get, post, fetchDescriptor };
