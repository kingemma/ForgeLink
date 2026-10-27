const dgram = require('node:dgram');

/**
 * mDNS / DNS-SD 客户端（手写，无第三方依赖）。
 *
 * 为什么自己实现：mDNS 是最有价值的零配置发现来源（打印机几乎都广播 `_ipp._tcp`），
 * 而成熟库要么需要原生编译（node-mdns），要么会常驻一个 Service 与 Electron 抢生命周期。
 * 这里只做「查询 + 解析」两件事，报文格式完全按 RFC 6762/6763 手写。
 *
 * 报文结构：12 字节定长头 + Question + [Answer/Authority/Additional] 资源记录，
 * 域名采用「长度前缀标签 + 0xC0 压缩指针」编码。
 */
const MDNS_MULTICAST = '224.0.0.251';
const MDNS_PORT = 5353;
const TYPE_A = 1;
const TYPE_PTR = 12;
const TYPE_TXT = 16;
const TYPE_AAAA = 28;
const TYPE_SRV = 33;

function encodeName(name) {
  const parts = String(name).split('.').filter(Boolean);
  const chunks = parts.map((part) => {
    const buf = Buffer.from(part, 'utf8');
    return Buffer.concat([Buffer.from([buf.length]), buf]);
  });
  return Buffer.concat([...chunks, Buffer.from([0])]);
}

function decodeName(buf, offset) {
  const labels = [];
  let pos = offset;
  let end = offset;
  let jumped = false;
  for (let hop = 0; hop < 32; hop += 1) {
    if (pos >= buf.length) break;
    const len = buf[pos];
    if (len === 0) {
      pos += 1;
      if (!jumped) end = pos;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) break;
      const pointer = ((len & 0x3f) << 8) | buf[pos + 1];
      if (!jumped) {
        end = pos + 2;
        jumped = true;
      }
      pos = pointer;
      continue;
    }
    pos += 1;
    labels.push(buf.toString('utf8', pos, pos + len));
    pos += len;
    if (!jumped) end = pos;
  }
  return { name: labels.join('.'), end };
}

function buildQuery(qname, qtype = TYPE_PTR, unicast = false) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x0000, 0);
  header.writeUInt16BE(0x0000, 2); // flags: 标准查询
  header.writeUInt16BE(1, 4); // qdcount
  header.writeUInt16BE(0, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);
  const question = Buffer.concat([encodeName(qname), Buffer.from([0, qtype, 0, unicast ? 0x80 : 0x00, 1])]);
  return Buffer.concat([header, question]);
}

function parseMessage(buf) {
  if (buf.length < 12) return [];
  const qdcount = buf.readUInt16BE(4);
  const ancount = buf.readUInt16BE(6);
  const nscount = buf.readUInt16BE(8);
  const arcount = buf.readUInt16BE(10);
  let offset = 12;

  for (let i = 0; i < qdcount; i += 1) {
    const name = decodeName(buf, offset);
    offset = name.end + 4;
  }

  const records = [];
  const total = ancount + nscount + arcount;
  for (let i = 0; i < total; i += 1) {
    if (offset >= buf.length) break;
    const name = decodeName(buf, offset);
    offset = name.end;
    if (offset + 10 > buf.length) break;
    const type = buf.readUInt16BE(offset);
    const rrClass = buf.readUInt16BE(offset + 2);
    const ttl = buf.readUInt32BE(offset + 4);
    const rdlength = buf.readUInt16BE(offset + 8);
    const rdataStart = offset + 10;
    const rdata = buf.subarray(rdataStart, Math.min(rdataStart + rdlength, buf.length));
    offset = rdataStart + rdlength;
    records.push({ name: name.name, type, class: rrClass & 0x7fff, ttl, data: decodeRdata(type, rdata, buf, rdataStart) });
  }
  return records;
}

function decodeRdata(type, rdata, buf, rdataStart) {
  switch (type) {
    case TYPE_A:
      return rdata.length >= 4 ? [...rdata.subarray(0, 4)].join('.') : null;
    case TYPE_AAAA:
      return rdata.length >= 16 ? formatIpv6(rdata) : null;
    case TYPE_PTR:
      return decodeName(buf, rdataStart).name;
    case TYPE_SRV:
      if (rdata.length < 6) return null;
      return {
        priority: rdata.readUInt16BE(0),
        weight: rdata.readUInt16BE(2),
        port: rdata.readUInt16BE(4),
        target: decodeName(buf, rdataStart + 6).name,
      };
    case TYPE_TXT:
      return decodeTxt(rdata);
    default:
      return rdata.toString('hex');
  }
}

function decodeTxt(rdata) {
  const entries = {};
  let pos = 0;
  while (pos < rdata.length) {
    const len = rdata[pos];
    pos += 1;
    if (!len) break;
    const raw = rdata.subarray(pos, pos + len).toString('utf8');
    pos += len;
    const eq = raw.indexOf('=');
    if (eq > 0) entries[raw.slice(0, eq)] = raw.slice(eq + 1);
    else entries[raw] = '';
  }
  return entries;
}

function formatIpv6(buf) {
  const parts = [];
  for (let i = 0; i < 8; i += 1) parts.push(buf.readUInt16BE(i * 2).toString(16));
  return parts.join(':');
}

/**
 * 浏览一组服务类型。
 * @param {string[]} serviceTypes 形如 `_ipp._tcp.local`
 * @param {{duration?: number, timeout?: number}} options
 * @returns {Promise<Array<{type:string,name:string,port:number,target:string,txt:object,ips:string[]}>>}
 */
function browse(serviceTypes, options = {}) {
  const { duration = 2500 } = options;
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const services = new Map();
    const nameToIps = new Map();
    let closed = false;

    const finish = () => {
      if (closed) return;
      closed = true;
      try {
        socket.close();
      } catch {
        /* 已关闭 */
      }
      for (const service of services.values()) {
        const key = (service.target || '').toLowerCase();
        service.ips = service.ips.length ? service.ips : nameToIps.get(key) || [];
      }
      resolve([...services.values()]);
    };

    socket.on('message', (msg, rinfo) => {
      let records;
      try {
        records = parseMessage(msg);
      } catch {
        return;
      }
      for (const record of records) {
        if (record.type === TYPE_A && record.data) {
          const key = record.name.toLowerCase();
          const list = nameToIps.get(key) || [];
          if (!list.includes(record.data)) list.push(record.data);
          nameToIps.set(key, list);
        }
      }
      for (const record of records) {
        if (record.type !== TYPE_SRV || !record.data) continue;
        const srv = record.data;
        const key = `${record.name}|${srv.port}|${srv.target}`;
        const existing = services.get(key) || {
          type: serviceTypeOf(record.name),
          name: record.name,
          port: srv.port,
          target: srv.target,
          txt: {},
          ips: [],
          sourceIp: rinfo.address,
        };
        services.set(key, existing);
      }
      for (const record of records) {
        if (record.type !== TYPE_TXT) continue;
        for (const service of services.values()) {
          if (record.name === service.name) service.txt = { ...service.txt, ...record.data };
        }
      }
      for (const record of records) {
        if (record.type !== TYPE_A || !record.data) continue;
        for (const service of services.values()) {
          if ((service.target || '').toLowerCase() === record.name.toLowerCase() && !service.ips.includes(record.data)) {
            service.ips.push(record.data);
          }
        }
      }
      // 有些设备只在 PTR 里宣告自身而不带 SRV
      for (const record of records) {
        if (record.type !== TYPE_PTR) continue;
        const key = `ptr|${record.data}`;
        if (!services.has(key)) {
          services.set(key, {
            type: serviceTypeOf(record.data),
            name: record.data,
            port: null,
            target: record.name,
            txt: {},
            ips: [rinfo.address],
            sourceIp: rinfo.address,
          });
        }
      }
    });

    socket.on('error', () => finish());

    const send = () => {
      if (closed) return;
      for (const type of serviceTypes) {
        const qname = type.endsWith('.local') ? type : `${type}.local`;
        const packet = buildQuery(qname, TYPE_PTR);
        try {
          socket.send(packet, 0, packet.length, MDNS_PORT, MDNS_MULTICAST);
        } catch {
          /* 网络不可用时忽略 */
        }
      }
    };

    const bindOptions = { port: MDNS_PORT, exclusive: false };
    try {
      socket.bind(bindOptions, () => {
        try {
          socket.addMembership(MDNS_MULTICAST);
        } catch {
          /* 某些环境不支持加组，仍能收到本机响应 */
        }
        socket.setMulticastTTL(255);
        send();
        setTimeout(send, 800);
      });
    } catch {
      // 5353 被占用（本机已有 Bonjour 服务）：改用随机端口，仍尽力发送查询
      try {
        socket.bind(0, () => send());
      } catch {
        finish();
      }
    }

    setTimeout(finish, duration);
  });
}

/**
 * 从实例名或服务名还原服务类型。
 * `OmniArm-6._robot._tcp.local` 与 `_robot._tcp.local` 都应得到 `_robot._tcp`：
 * 定位到 _tcp/_udp 标签，取其前一个标签。
 */
function serviceTypeOf(fullName) {
  const parts = String(fullName || '').split('.');
  const index = parts.findIndex((part) => /^_(tcp|udp)$/.test(part));
  if (index > 0) return `${parts[index - 1]}.${parts[index]}`;
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : String(fullName || '');
}

module.exports = { browse, buildQuery, parseMessage, encodeName, decodeName };
