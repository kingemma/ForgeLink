/**
 * 端口指纹知识库。
 *
 * 发现的第一性问题：给定一个开放端口，它「可能」说什么协议？
 * 先验来自 IANA 端口分配与行业惯例，最终结论必须由实际探测（probe）确认——
 * 这里只提供候选集与权重，不直接下结论。
 */
const PORT_HINTS = {
  23: [{ protocol: 'telnet', weight: 0.7 }],
  80: [{ protocol: 'http', weight: 0.8 }],
  161: [{ protocol: 'snmp', weight: 0.9 }],
  443: [{ protocol: 'https', weight: 0.7 }, { protocol: 'http', weight: 0.3 }],
  502: [{ protocol: 'modbus-tcp', weight: 0.95 }],
  631: [{ protocol: 'ipp', weight: 0.9 }, { protocol: 'http', weight: 0.4 }],
  1883: [{ protocol: 'mqtt', weight: 0.85 }],
  3000: [{ protocol: 'http', weight: 0.6 }],
  4485: [{ protocol: 'modbus-tcp', weight: 0.5 }],
  4840: [{ protocol: 'opcua', weight: 0.85 }],
  5000: [{ protocol: 'http', weight: 0.6 }],
  8080: [{ protocol: 'http', weight: 0.7 }],
  8081: [{ protocol: 'http', weight: 0.6 }],
  8883: [{ protocol: 'mqtt', weight: 0.7 }],
  9000: [{ protocol: 'raw-text', weight: 0.5 }, { protocol: 'http', weight: 0.4 }],
  9100: [{ protocol: 'jetdirect', weight: 0.9 }, { protocol: 'raw-text', weight: 0.5 }],
  10000: [{ protocol: 'raw-text', weight: 0.5 }, { protocol: 'http', weight: 0.3 }],
  20000: [{ protocol: 'raw-text', weight: 0.5 }],
  47809: [{ protocol: 'forgelink-beacon', weight: 0.6 }],
};

/** 快速扫描：只探最可能出现的端口，保证一次全网扫描在秒级完成 */
const QUICK_PORTS = [21, 22, 23, 80, 161, 443, 502, 631, 1883, 3000, 4485, 4840, 5000, 515, 8080, 8081, 8883, 9000, 9100, 9200, 10000, 20000, 47809];

/** 深度扫描：在快速扫描命中的主机上再做 1~10000 全端口（去重后） */
function deepPorts(extra = []) {
  const set = new Set([...QUICK_PORTS, ...extra, 102, 110, 137, 138, 139, 445, 548, 1900, 3306, 3389, 5432, 6379, 8000, 8008, 8443, 9001, 9101, 9102, 27017]);
  return [...set].sort((a, b) => a - b);
}

/** mDNS / DNS-SD 服务类型 → 语义标签，用于给设备打 kind 标签 */
const SERVICE_TYPES = {
  '_ipp._tcp': { protocol: 'ipp', kind: 'printer', weight: 0.95 },
  '_ipps._tcp': { protocol: 'ipp', kind: 'printer', weight: 0.95 },
  '_printer._tcp': { protocol: 'jetdirect', kind: 'printer', weight: 0.9 },
  '_pdl-datastream._tcp': { protocol: 'jetdirect', kind: 'printer', weight: 0.85 },
  '_scanner._tcp': { protocol: 'http', kind: 'scanner', weight: 0.7 },
  '_modbus._tcp': { protocol: 'modbus-tcp', kind: 'robot-arm', weight: 0.9 },
  '_robot._tcp': { protocol: 'raw-text', kind: 'robot-arm', weight: 0.85 },
  '_forgelink._tcp': { protocol: 'forgelink-beacon', kind: 'unknown', weight: 0.8 },
  '_http._tcp': { protocol: 'http', kind: 'generic', weight: 0.5 },
  '_workstation._tcp': { protocol: 'http', kind: 'host', weight: 0.4 },
  '_device-info._tcp': { protocol: 'http', kind: 'generic', weight: 0.5 },
};

function hintsFor(port) {
  return PORT_HINTS[port] || [{ protocol: 'raw-text', weight: 0.2 }, { protocol: 'http', weight: 0.2 }];
}

function serviceHint(serviceType) {
  const key = String(serviceType || '').toLowerCase();
  return SERVICE_TYPES[key] || null;
}

module.exports = { PORT_HINTS, QUICK_PORTS, SERVICE_TYPES, deepPorts, hintsFor, serviceHint };
