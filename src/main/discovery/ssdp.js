const dgram = require('node:dgram');
const http = require('node:http');

/**
 * SSDP / UPnP 发现。
 *
 * SSDP 是唯一能覆盖「非 mDNS 设备」（摄像头、NAS、智能插座、部分工业网关）的
 * 通用广播协议。流程：向 239.255.255.250:1900 发 M-SEARCH，收集 LOCATION，
 * 再回捞设备描述 XML 提取 friendlyName / manufacturer / modelName。
 */
const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;

function discover(options = {}) {
  const { duration = 2500, searchTargets = ['ssdp:all'] } = options;
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const found = new Map();
    let closed = false;

    const finish = () => {
      if (closed) return;
      closed = true;
      try {
        socket.close();
      } catch {
        /* 已关闭 */
      }
      resolve([...found.values()]);
    };

    socket.on('message', (msg, rinfo) => {
      const text = msg.toString('utf8');
      if (!/^HTTP\/1\.1\s+200/i.test(text) && !text.includes('NOTIFY * HTTP/1.1')) return;
      const headers = parseHeaders(text);
      const location = headers.location || headers.LOCATION || headers.Location;
      if (!location) return;
      const key = location;
      if (found.has(key)) return;
      found.set(key, {
        ip: rinfo.address,
        location,
        server: headers.server || headers.SERVER || null,
        st: headers.st || headers.ST || headers.nt || null,
        usn: headers.usn || headers.USN || null,
      });
    });

    socket.on('error', () => finish());

    const send = () => {
      if (closed) return;
      for (const st of searchTargets) {
        const packet = [
          'M-SEARCH * HTTP/1.1',
          `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
          'MAN: "ssdp:discover"',
          'MX: 2',
          `ST: ${st}`,
          'USER-AGENT: ForgeLink/1.0',
          '',
          '',
        ].join('\r\n');
        try {
          socket.send(Buffer.from(packet, 'utf8'), 0, Buffer.byteLength(packet), SSDP_PORT, SSDP_ADDRESS);
        } catch {
          /* 忽略 */
        }
      }
    };

    try {
      socket.bind(0, () => {
        send();
        setTimeout(send, 900);
      });
    } catch {
      finish();
    }
    setTimeout(finish, duration);
  });
}

function parseHeaders(text) {
  const headers = {};
  for (const line of text.split(/\r?\n/).slice(1)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return headers;
}

/** 抓取 UPnP 设备描述 XML，提取可读名称与厂商信息 */
function fetchDescription(location, timeout = 2500) {
  return new Promise((resolve) => {
    let request;
    const timer = setTimeout(() => {
      request?.destroy();
      resolve(null);
    }, timeout);
    try {
      request = http.get(location, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          clearTimeout(timer);
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({
            friendlyName: pick(body, 'friendlyName'),
            manufacturer: pick(body, 'manufacturer'),
            modelName: pick(body, 'modelName'),
            modelDescription: pick(body, 'modelDescription'),
            deviceType: pick(body, 'deviceType'),
          });
        });
      });
      request.on('error', () => {
        clearTimeout(timer);
        resolve(null);
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

function pick(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!match) return null;
  return decodeXmlEntities(match[1].trim());
}

function decodeXmlEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

module.exports = { discover, fetchDescription };
