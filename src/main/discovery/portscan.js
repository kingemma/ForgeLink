const net = require('node:net');

/**
 * TCP 端口探测。
 *
 * 用 connect() 握手而非完整 SYN 扫描：无需原生依赖与管理员权限，
 * 且在以太网上足以区分 open / closed / filtered。并发受信号量限制，
 * 避免一次性建上千个 socket 触发本地 FD 耗尽或对端 IDS 告警。
 */
async function scanPorts(host, ports, options = {}) {
  const { concurrency = 160, timeout = 350 } = options;
  const results = [];
  let cursor = 0;

  const worker = async () => {
    while (cursor < ports.length) {
      const port = ports[cursor++];
      const result = await probePort(host, port, timeout);
      if (result.open) results.push(result);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, ports.length) }, worker));
  return results.sort((a, b) => a.port - b.port);
}

function probePort(host, port, timeout) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = new net.Socket();
    let settled = false;
    const done = (open, error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ port, open, rtt: Date.now() - started, error });
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true, null));
    socket.once('timeout', () => done(false, 'timeout'));
    socket.once('error', (err) => done(false, err.code || err.message));
    try {
      socket.connect(port, host);
    } catch (error) {
      done(false, error.message);
    }
  });
}

module.exports = { scanPorts, probePort };
