const dgram = require('node:dgram');
const { encodeName, decodeName } = require('../discovery/mdns');
const { localSubnets } = require('../discovery/arp');

/**
 * 极简 mDNS 应答器。
 *
 * 真实打印机/机械臂会自己广播 `_ipp._tcp` / `_robot._tcp`，模拟器也必须广播，
 * 否则无法验证「mDNS 通道 → 端口宣告 → 协议识别」这条链路。
 * 只实现应答：对 PTR/SRV/TXT/A 查询回对应记录。
 */
const MDNS_MULTICAST = '224.0.0.251';
const MDNS_PORT = 5353;
const CACHE_FLUSH = 0x8000;

class MdnsResponder {
  constructor(services = []) {
    this.services = services.map((service) => ({
      ...service,
      type: service.type.endsWith('.local') ? service.type.replace(/\.local$/, '') : service.type,
      target: service.target || `${(service.name || 'device').replace(/\s+/g, '-').toLowerCase()}.local`,
      txt: service.txt || {},
    }));
    this.socket = null;
    this.localIp = preferredLocalIp();
  }

  start() {
    if (this.socket) return this;
    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket.on('message', (message, rinfo) => this._handle(message, rinfo));
    this.socket.on('error', () => {});
    try {
      this.socket.bind({ port: MDNS_PORT, exclusive: false }, () => {
        try {
          this.socket.addMembership(MDNS_MULTICAST);
        } catch {
          /* 环境不支持加组时仍可应答单播查询 */
        }
      });
    } catch {
      try {
        this.socket.bind(0);
      } catch {
        this.socket = null;
      }
    }
    return this;
  }

  stop() {
    try {
      this.socket?.close();
    } catch {
      /* 已关闭 */
    }
    this.socket = null;
  }

  _handle(message, rinfo) {
    let questions = [];
    try {
      questions = parseQuestions(message);
    } catch {
      return;
    }
    if (!questions.length) return;
    const response = this._buildResponse(questions);
    if (!response) return;
    // 同时回单播（QU 位）与组播，确保查询方能收到
    try {
      this.socket.send(response, 0, response.length, rinfo.port, rinfo.address);
    } catch {
      /* 忽略 */
    }
    try {
      this.socket.send(response, 0, response.length, MDNS_PORT, MDNS_MULTICAST);
    } catch {
      /* 忽略 */
    }
  }

  _buildResponse(questions) {
    const answers = [];
    const additionals = [];
    let matched = false;

    for (const question of questions) {
      const name = question.name.toLowerCase();
      if (name === '_services._dns-sd._udp.local') {
        for (const service of this.services) {
          answers.push(encodeRecord(question.name, 12, 1, 120, encodeName(`${service.type}.local`)));
        }
        matched = true;
        continue;
      }
      const service = this.services.find(
        (item) => `${item.type}.local` === name || `${item.name}.${item.type}.local`.toLowerCase() === name,
      );
      if (service) {
        matched = true;
        const instance = `${service.name}.${service.type}.local`;
        // PTR 查询也必须顺带给出 SRV/TXT/A：RFC 6763 的响应聚合，
        // 否则查询方只知道「有这个服务」，拿不到端口与地址
        const includeDetails = question.type === 12 || question.type === 255;
        if (includeDetails || question.type === 12) {
          answers.push(encodeRecord(question.name, 12, 1, 120, encodeName(instance)));
        }
        if (includeDetails || question.type === 33) {
          additionals.push(encodeRecord(instance, 33, CACHE_FLUSH | 1, 120, encodeSrv(service)));
        }
        if (includeDetails || question.type === 16) {
          additionals.push(encodeRecord(instance, 16, CACHE_FLUSH | 1, 120, encodeTxt(service.txt)));
        }
        if (includeDetails || question.type === 1) {
          additionals.push(encodeRecord(service.target, 1, CACHE_FLUSH | 1, 120, encodeIpv4(this.localIp)));
          answers.push(encodeRecord(service.target, 1, CACHE_FLUSH | 1, 120, encodeIpv4(this.localIp)));
        }
        continue;
      }
      const byTarget = this.services.find((item) => item.target.toLowerCase() === name);
      if (byTarget && (question.type === 1 || question.type === 255)) {
        matched = true;
        answers.push(encodeRecord(question.name, 1, CACHE_FLUSH | 1, 120, encodeIpv4(this.localIp)));
      }
    }

    if (!matched) return null;

    const header = Buffer.alloc(12);
    header.writeUInt16BE(0, 0);
    header.writeUInt16BE(0x8400, 2); // 应答 + 权威
    header.writeUInt16BE(0, 4);
    header.writeUInt16BE(answers.length, 6);
    header.writeUInt16BE(0, 8);
    header.writeUInt16BE(additionals.length, 10);
    return Buffer.concat([header, ...answers, ...additionals]);
  }
}

function parseQuestions(buffer) {
  if (buffer.length < 12) return [];
  const qdcount = buffer.readUInt16BE(4);
  let offset = 12;
  const questions = [];
  for (let i = 0; i < qdcount; i += 1) {
    const parsed = decodeName(buffer, offset);
    if (parsed.end + 4 > buffer.length) break;
    const type = buffer.readUInt16BE(parsed.end);
    offset = parsed.end + 4;
    questions.push({ name: parsed.name, type });
  }
  return questions;
}

function encodeRecord(name, type, rrClass, ttl, rdata) {
  const nameBuffer = encodeName(name);
  const header = Buffer.alloc(10);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(rrClass, 2);
  header.writeUInt32BE(ttl, 4);
  header.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([nameBuffer, header, rdata]);
}

function encodeSrv(service) {
  const target = encodeName(service.target);
  const header = Buffer.alloc(6);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(0, 2);
  header.writeUInt16BE(service.port, 4);
  return Buffer.concat([header, target]);
}

function encodeTxt(txt) {
  const chunks = [];
  for (const [key, value] of Object.entries(txt)) {
    const raw = Buffer.from(`${key}=${value}`, 'utf8');
    chunks.push(Buffer.from([raw.length]), raw);
  }
  return chunks.length ? Buffer.concat(chunks) : Buffer.from([0]);
}

function encodeIpv4(ip) {
  return Buffer.from(ip.split('.').map((part) => Number(part)));
}

/** 多网卡（含 VPN 虚拟网卡）时，优先宣告私有局域网地址，避免把隧道地址当成设备地址 */
function preferredLocalIp() {
  const subnets = localSubnets();
  const isPrivateLan = (ip) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  return subnets.find((subnet) => isPrivateLan(subnet.address))?.address || subnets[0]?.address || '127.0.0.1';
}

module.exports = { MdnsResponder };
