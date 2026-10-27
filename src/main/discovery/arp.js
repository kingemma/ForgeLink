const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const dgram = require('node:dgram');

const execFileAsync = promisify(execFile);

/**
 * 局域网候选主机枚举。
 *
 * 思路：先确定「我在哪个网段」，再从操作系统 ARP/邻居表拿到最近通信过的主机。
 * ARP 表比全网 ping 扫描快几个数量级（通常 1~2 秒覆盖几十台主机），
 * 且不需要管理员权限；ping/端口探测作为补充手段。
 */

/** 本机在局域网中的 IPv4 地址、掩码与推导出的网段 */
function localSubnets() {
  const interfaces = os.networkInterfaces();
  const subnets = [];
  for (const list of Object.values(interfaces)) {
    for (const ni of list || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      if (!ni.address || ni.address.startsWith('169.254') || ni.address.startsWith('127.')) continue;
      const cidr = toCidr(ni.address, ni.netmask);
      subnets.push({
        address: ni.address,
        netmask: ni.netmask,
        mac: ni.mac,
        cidr,
        size: cidrSize(ni.netmask),
      });
    }
  }
  return subnets;
}

function toCidr(address, netmask) {
  const bits = maskToBits(netmask);
  const base = (ipToInt(address) & ipToInt(netmask)) >>> 0;
  return `${intToIp(base)}/${bits}`;
}

function maskToBits(netmask) {
  if (!netmask) return 24;
  return netmask.split('.').reduce((acc, part) => acc + popcount(Number(part)), 0);
}

function popcount(n) {
  let c = 0;
  while (n) {
    c += n & 1;
    n >>= 1;
  }
  return c;
}

function ipToInt(ip) {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function intToIp(int) {
  return [(int >>> 24) & 255, (int >>> 16) & 255, (int >>> 8) & 255, int & 255].join('.');
}

function cidrSize(netmask) {
  const bits = maskToBits(netmask);
  return bits >= 30 ? 4 : 2 ** (32 - bits);
}

/** 展开网段为 IP 列表，限制上限避免 /8 之类的巨型网段 */
function expandCidr(cidr, limit = 512) {
  const [base, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  const start = ipToInt(base) & (bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0);
  const total = Math.min(2 ** (32 - bits), limit);
  const list = [];
  for (let i = 1; i < total; i++) list.push(intToIp((start + i) >>> 0));
  return list;
}

/**
 * 读取系统 ARP / 邻居表。
 * Windows: `arp -a`；Linux/macOS: `ip neigh` 或 `arp -a`。
 */
async function arpTable() {
  const commands = process.platform === 'win32' ? [['arp', ['-a']]] : [['ip', ['neigh', 'show']], ['arp', ['-a']]];
  for (const [cmd, args] of commands) {
    try {
      const { stdout } = await execFileAsync(cmd, args, { timeout: 6000, windowsHide: true });
      const parsed = parseArp(stdout);
      if (parsed.length) return parsed;
    } catch {
      // 命令不存在或超时，尝试下一个
    }
  }
  return [];
}

function parseArp(output) {
  const entries = [];
  const seen = new Set();
  // 兼容三种格式：
  //   Windows: "  192.168.1.10          aa-bb-cc-dd-ee-ff     动态"
  //   Linux ip: "192.168.1.10 dev eth0 lladdr aa:bb:cc:dd:ee:ff REACHABLE"
  //   Unix arp: "? (192.168.1.10) at aa:bb:cc:dd:ee:ff on en0 ifscope [ethernet]"
  const ipRe = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/;
  const macRe = /\b((?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2})\b/i;
  for (const line of output.split(/\r?\n/)) {
    if (/^\s*(接口|Interface)/i.test(line)) continue;
    const ip = line.match(ipRe);
    const mac = line.match(macRe);
    if (!ip) continue;
    const address = ip[1];
    if (address.endsWith('.255') || address.startsWith('224.') || address.startsWith('239.')) continue;
    if (seen.has(address)) continue;
    seen.add(address);
    entries.push({ ip: address, mac: mac ? mac[1].toLowerCase().replace(/-/g, ':') : null, source: 'arp' });
  }
  return entries;
}

/**
 * 用 UDP 触发 ARP 解析。
 *
 * 透明代理 / 防火墙会让任意 IP 的 TCP 都「开放」，但二层 ARP 必须由真实主机应答才能完成。
 * 所以先给每个地址发一个 UDP 包把邻居表填起来，之后「有没有 MAC」就是主机是否真实存在的判据。
 */
async function arpWarmup(ips, options = {}) {
  const { port = 9, settleMs = 400, guardMs = 2500 } = options;
  if (!ips.length) return;
  const socket = dgram.createSocket({ type: 'udp4' });
  await new Promise((resolve) => socket.bind(0, resolve));
  const payload = Buffer.from('forgelink-arp-probe');
  await new Promise((resolve) => {
    let pending = ips.length;
    const timer = setTimeout(resolve, guardMs); // 兜底：回调丢失时不要卡住整轮扫描
    const tick = () => {
      pending -= 1;
      if (pending <= 0) {
        clearTimeout(timer);
        resolve();
      }
    };
    for (const ip of ips) {
      try {
        socket.send(payload, 0, payload.length, port, ip, tick);
      } catch {
        tick();
      }
    }
  });
  await new Promise((resolve) => setTimeout(resolve, settleMs)); // 等 ARP 应答落进邻居表
  try {
    socket.close();
  } catch {
    /* 已关闭 */
  }
}

/**
 * 综合产出候选主机：ARP 表优先，其次本机网段内的完整扫描（可选）。
 * @param {{includeSubnetScan?: boolean, limit?: number}} options
 */
async function enumerateHosts(options = {}) {
  const { includeSubnetScan = false, limit = 256, totalLimit = 512 } = options;
  const subnets = localSubnets().filter((s) => s.size <= 65536);
  const candidates = new Map();
  const subnetOf = (ip) => subnets.find((s) => sameSubnet(ip, s));

  for (const entry of await arpTable()) {
    // 没有 MAC 的是「未解析」邻居（多为扫描产生的残缺项或代理 ARP），并不是真机
    if (!entry.mac) continue;
    const subnet = subnetOf(entry.ip);
    if (!subnet) continue;
    candidates.set(entry.ip, { ...entry, subnet: subnet.cidr, confidence: 0.9 });
  }

  if (includeSubnetScan) {
    // 小网段优先（真实局域网多为 /24，VPN/虚拟网卡常是 /16），并给总量封顶，
    // 避免多网卡机器把一轮扫描摊到上千个无意义地址上。
    const ordered = [...subnets].sort((a, b) => a.size - b.size);
    let added = 0;
    for (const subnet of ordered) {
      const room = totalLimit - added;
      if (room <= 0) break;
      for (const ip of expandCidr(subnet.cidr, Math.min(limit, room))) {
        if (candidates.has(ip)) continue;
        candidates.set(ip, { ip, mac: null, subnet: subnet.cidr, source: 'subnet', confidence: 0.4 });
        added += 1;
      }
    }
  }

  return { subnets, hosts: [...candidates.values()] };
}

function sameSubnet(ip, subnet) {
  const mask = ipToInt(subnet.netmask || '255.255.255.0');
  return ((ipToInt(ip) & mask) >>> 0) === ((ipToInt(subnet.address) & mask) >>> 0);
}

module.exports = { localSubnets, arpTable, arpWarmup, enumerateHosts, expandCidr, ipToInt, intToIp, sameSubnet };
