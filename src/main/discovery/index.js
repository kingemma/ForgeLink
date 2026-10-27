const bus = require('../kernel/bus');
const { t } = require('../i18n');
const { Registry } = require('../kernel/registry');
const { enumerateHosts, localSubnets } = require('./arp');
const { scanPorts } = require('./portscan');
const mdns = require('./mdns');
const ssdp = require('./ssdp');
const beacon = require('./beacon');
const { QUICK_PORTS, SERVICE_TYPES, deepPorts, serviceHint, hintsFor } = require('./fingerprints');
const { detect, probeSnmp } = require('../protocols/detect');
const { selectDriver } = require('../drivers');

/**
 * 发现编排器（第一层）。
 *
 * 第一性原理：局域网里「有什么」没有单一答案来源，必须多通道交叉验证。
 * 四条通道各有覆盖盲区，组合起来才接近完备：
 *   ARP/网段  —— 谁在线（快，但只有最近通信过的）
 *   mDNS      —— 它宣告自己是什么服务（准，但设备必须支持）
 *   SSDP      —— 覆盖 UPnP 类设备（补充 mDNS 盲区）
 *   TCP 端口扫描 + 协议探测 —— 兜底，任何开着端口的设备都逃不掉
 * 结果不是「设备列表」而是「接口事实」，再由注册表聚合成设备。
 */
class DiscoveryService {
  constructor(registry) {
    this.registry = registry;
    this.running = false;
    this._stopBeacon = null;
  }

  _progress(phase, message, current = 0, total = 0) {
    bus.emit('discovery:progress', { phase, message, current, total, ts: Date.now() });
  }

  /** 被动监听信标：新设备上电自述时即时入库 */
  startPassive() {
    if (this._stopBeacon) return;
    this._stopBeacon = beacon.listen((announce) => {
      bus.info('discovery', `收到信标自述：${announce.name || announce.kind} @ ${announce.ip}`);
      const facts = { beacons: [announce] };
      this.registry.upsert({
        ip: announce.ip,
        name: announce.name || null,
        vendor: announce.vendor || null,
        model: announce.model || null,
        kind: announce.kind || 'unknown',
        tags: ['beacon', announce.kind].filter(Boolean),
        interfaces: (announce.interfaces || []).map((item) => ({
          port: item.port,
          protocol: item.protocol,
          transport: item.transport || 'tcp',
          confidence: 0.8,
          evidence: { source: 'beacon', description: item.description || null },
        })),
        facts,
      });
    });
  }

  stopPassive() {
    this._stopBeacon?.();
    this._stopBeacon = null;
  }

  /**
   * 执行一次完整发现。
   * @param {{deep?: boolean, includeSubnetScan?: boolean, ports?: number[]}} options
   */
  async scan(options = {}) {
    if (this.running) return { ok: false, reason: t('discovery.running') };
    this.running = true;
    const started = Date.now();
    const { deep = false, includeSubnetScan = false, hosts: explicitHosts = [] } = options;
    const localSubnetList = localSubnets();
    const candidates = new Map(); // ip -> {ip, mac, subnet, facts}
    const touch = (ip, patch = {}) => {
      if (!ip) return;
      const existing = candidates.get(ip) || { ip, facts: { beacons: [], mdns: [], ssdp: [] } };
      Object.assign(existing, patch);
      candidates.set(ip, existing);
    };

    try {
      // ---- 通道 1/2/3：并行跑广播类协议，它们互不干扰且耗时固定 ----
      this._progress('broadcast', t('discovery.broadcast'));
      const [mdnsServices, ssdpEntries, beacons] = await Promise.all([
        mdns.browse([...Object.keys(SERVICE_TYPES), '_services._dns-sd._udp'], { duration: 2200 }).catch(() => []),
        ssdp.discover({ duration: 2200 }).catch(() => []),
        beacon.probe({ duration: 1800 }).catch(() => []),
      ]);
      bus.info('discovery', t('discovery.broadcastDone', { mdns: mdnsServices.length, ssdp: ssdpEntries.length, beacon: beacons.length }));

      for (const service of mdnsServices) {
        const ip = service.ips?.[0] || service.sourceIp;
        if (!ip) continue;
        const entry = candidates.get(ip) || { ip, facts: { beacons: [], mdns: [], ssdp: [] } };
        entry.facts.mdns.push(service);
        candidates.set(ip, entry);
      }

      for (const entry of ssdpEntries.slice(0, 24)) {
        const description = await ssdp.fetchDescription(entry.location).catch(() => null);
        const enriched = { ...entry, ...(description || {}) };
        const target = candidates.get(entry.ip) || { ip: entry.ip, facts: { beacons: [], mdns: [], ssdp: [] } };
        target.facts.ssdp.push(enriched);
        if (!target.name && enriched.friendlyName) target.name = enriched.friendlyName;
        if (!target.vendor && enriched.manufacturer) target.vendor = enriched.manufacturer;
        if (!target.model && enriched.modelName) target.model = enriched.modelName;
        candidates.set(entry.ip, target);
      }

      // 同一台设备可能从多个网卡（含 VPN 虚拟网卡）各自应答，按设备名归并到主网段地址
      for (const announce of dedupeBeacons(beacons, localSubnetList)) {
        const target = candidates.get(announce.ip) || { ip: announce.ip, facts: { beacons: [], mdns: [], ssdp: [] } };
        target.facts.beacons.push(announce);
        target.name = target.name || announce.name;
        target.vendor = target.vendor || announce.vendor;
        target.model = target.model || announce.model;
        if (announce.kind) target.kind = announce.kind;
        candidates.set(announce.ip, target);
      }

      // ---- 通道 4：ARP / 网段候选（含本机，模拟器与本机服务同样算设备） ----
      let subnets = localSubnetList;
      if (explicitHosts.length) {
        // 指定主机模式：用于「手动添加设备」与定向排查，跳过全网枚举
        this._progress('arp', t('discovery.explicitHosts', { hosts: explicitHosts.join('、') }));
        for (const ip of explicitHosts) touch(ip, {});
      } else {
        this._progress('arp', t('discovery.arp'));
        const enumerated = await enumerateHosts({ includeSubnetScan });
        subnets = enumerated.subnets;
        for (const host of enumerated.hosts) touch(host.ip, { mac: host.mac, subnet: host.subnet });
        for (const own of localSubnetList) touch(own.address, { mac: own.mac, subnet: own.cidr, self: true });
      }
      bus.info('discovery', `候选主机 ${candidates.size} 台（网段：${subnets.map((s) => s.cidr).join(', ') || '未识别'}）`);

      const targets = [...candidates.values()];
      const results = [];

      // ---- 端口扫描 ----
      this._progress('portscan', t('discovery.portscan', { n: targets.length }));
      const portPlan = new Map();
      for (const target of targets) {
        const advertisedPorts = collectAdvertisedPorts(target.facts);
        const ports = options.ports || [...new Set([...(deep ? deepPorts(advertisedPorts) : QUICK_PORTS), ...advertisedPorts])];
        portPlan.set(target.ip, ports);
      }

      let scanned = 0;
      for (const target of targets) {
        const ports = portPlan.get(target.ip) || QUICK_PORTS;
        const open = await scanPorts(target.ip, ports, { concurrency: 160, timeout: deep ? 250 : 350 });
        // SNMP 走 UDP，TCP 扫描扫不到，对每台主机单独问一次
        const snmpMatch = await probeSnmp(target.ip, 161, 900).catch(() => null);
        target.openPorts = open.map((item) => item.port);
        target.snmp = snmpMatch;
        scanned += 1;
        this._progress('portscan', t('discovery.portscanProgress', { done: scanned, total: targets.length }), scanned, targets.length);
        if (open.length || snmpMatch) {
          bus.info('discovery', `${target.ip} 开放端口 ${open.map((p) => p.port).join(',') || '无'}${snmpMatch ? ' + SNMP' : ''}`);
        }
      }

      // ---- 协议识别 ----
      // 现实网络里存在「全端口伪开放」的防火墙/网关，逐个端口试协议会拖垮整轮扫描。
      // 因此设两道闸：单主机连续 3 个端口都识别不出协议就判定为伪开放并跳过剩余端口；
      // 全局另有时间预算，保证一次快速发现总能在数十秒内收敛。
      const timeBudgetMs = options.timeBudgetMs ?? 45000;
      const totalPorts = targets.reduce((sum, target) => sum + (target.openPorts?.length || 0), 0);
      let identified = 0;
      let budgetExceeded = false;
      this._progress('identify', t('discovery.identify', { n: totalPorts }));
      for (const target of targets) {
        if (budgetExceeded) break;
        const interfaces = [];
        let unknownStreak = 0;
        // 绝大多数端口都「开放」的主机通常是全通防火墙/透明代理：
        // 对它只按端口先验各探一次，不做兜底链，否则一轮扫描会被它吃掉几分钟
        const allPortsOpen = (target.openPorts || []).length > 10;
        const unknownLimit = allPortsOpen ? 2 : 3;
        for (const port of target.openPorts || []) {
          if (Date.now() - started > timeBudgetMs) {
            budgetExceeded = true;
            bus.warn('discovery', `协议识别超过时间预算 ${timeBudgetMs}ms，剩余端口本次跳过`);
            break;
          }
          const hints = mergeHints(port, target.facts);
          const match = await detect(target.ip, port, { hints, timeout: deep ? 1500 : 1000, allowFallback: !allPortsOpen });
          if (match) {
            interfaces.push({
              port,
              protocol: match.protocol,
              transport: match.transport || 'tcp',
              confidence: match.confidence,
              evidence: match.evidence,
              details: match.details,
            });
            if (match.protocol === 'unknown') unknownStreak += 1;
          }
          identified += 1;
          this._progress('identify', t('discovery.identifyProgress', { done: identified, total: totalPorts }), identified, totalPorts);
          if (unknownStreak >= unknownLimit && !interfaces.some((item) => item.protocol !== 'unknown')) {
            bus.warn('discovery', `${target.ip} 连续 ${unknownStreak} 个端口无协议响应，判定为伪开放主机并跳过`);
            break;
          }
        }
        if (target.snmp && !interfaces.some((item) => item.protocol === 'snmp')) {
          interfaces.push({
            port: target.snmp.port || 161,
            protocol: 'snmp',
            transport: 'udp',
            confidence: target.snmp.confidence,
            evidence: target.snmp.evidence,
            details: target.snmp.details,
          });
        }
        if (!interfaces.length) continue;

        // 一个 IP 不等于一台设备：同一主机上可能同时跑机械臂控制器与打印服务。
        // 先按「设备自述」（信标）切分，再按协议归属切分，最后才是主机级兜底。
        for (const partition of partitionDevices(target.ip, interfaces, target.facts)) {
          const device = this.registry.upsert({
            ...partition,
            mac: target.mac || null,
            name: partition.name || target.name || null,
            vendor: partition.vendor || target.vendor || null,
            model: partition.model || target.model || null,
            tags: ['discovered'],
            // 只有识别出协议才算真正「在线」；全是 unknown 的只是探测到主机存在
            status: interfaces.some((item) => item.protocol !== 'unknown') ? 'online' : 'unknown',
          });
          results.push(device);
        }
      }

      const duration = Date.now() - started;
      bus.info('discovery', t('discovery.doneLog', { n: results.length, sec: (duration / 1000).toFixed(1) }));
      this._progress('done', t('discovery.done', { n: results.length }), results.length, results.length);
      return { ok: true, devices: results, duration, candidates: targets.length };
    } finally {
      this.running = false;
    }
  }
}

/**
 * 信标应答去重：同一台设备从多张网卡（含 VPN 隧道）各自应答时，
 * 只保留主局域网网段内的那条，避免同一台机械臂在界面上出现三次。
 */
function dedupeBeacons(beacons, subnets) {
  const isPrivateLan = (ip) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  const byIdentity = new Map();
  for (const announce of beacons) {
    if (!announce.ip || announce.ip.startsWith('127.')) continue;
    const key = `${announce.name || announce.kind || ''}|${announce.model || ''}`;
    const previous = byIdentity.get(key);
    if (!previous) {
      byIdentity.set(key, announce);
      continue;
    }
    const better = isPrivateLan(announce.ip) && !isPrivateLan(previous.ip);
    if (better) byIdentity.set(key, announce);
  }
  return [...byIdentity.values()];
}

/**
 * 把一个 IP 上的接口集合切分为若干「逻辑设备」。
 *
 * 切分依据按可信度排序：
 *   1) 设备自述（UDP 信标给出名称、类型与接口清单）——最可靠
 *   2) 协议归属（按每个接口单独做驱动适配度判定并聚类）
 *   3) 剩下的无归属接口归为主机设备
 * 只有切分结果唯一时才使用「IP 即设备」的 id，避免同一台设备被反复建档。
 */
function partitionDevices(ip, interfaces, facts) {
  const groups = [];
  const claimed = new Set();

  for (const beacon of facts.beacons || []) {
    const ports = new Set((beacon.interfaces || []).map((item) => item.port));
    if (!ports.size) continue;
    const owned = interfaces.filter((item) => ports.has(item.port));
    if (!owned.length) continue;
    for (const item of owned) claimed.add(`${item.port}/${item.protocol}`);
    groups.push({
      key: slug(beacon.name || beacon.kind || 'device'),
      name: beacon.name || null,
      kind: beacon.kind || null,
      vendor: beacon.vendor || null,
      model: beacon.model || null,
      interfaces: owned,
      facts: { beacons: [beacon], mdns: facts.mdns || [], ssdp: facts.ssdp || [] },
    });
  }

  const rest = interfaces.filter((item) => !claimed.has(`${item.port}/${item.protocol}`));
  const byDriver = new Map();
  const leftovers = [];
  for (const item of rest) {
    // 逐个接口判定归属：不带信标自述，避免把同主机上另一台设备的自述算进来
    const selected = selectDriver({ ...facts, beacons: [], interfaces: [item] });
    const driverId = selected && selected.fitness >= 0.5 ? selected.DriverClass.driverId : null;
    if (!driverId) {
      leftovers.push(item);
      continue;
    }
    if (!byDriver.has(driverId)) byDriver.set(driverId, []);
    byDriver.get(driverId).push(item);
  }

  const entries = [...groups];
  for (const [driverId, list] of byDriver) {
    entries.push({ key: driverId, interfaces: list, facts: { ...facts, beacons: [] }, name: null, kind: null });
  }
  if (leftovers.length) entries.push({ key: 'host', interfaces: leftovers, facts, name: null, kind: null });

  const single = entries.length === 1;
  return entries.map((entry) => ({
    id: single ? Registry.keyOf(ip) : `${Registry.keyOf(ip)}__${entry.key}`,
    ip,
    name: entry.name || null,
    kind: entry.kind || null,
    vendor: entry.vendor || null,
    model: entry.model || null,
    interfaces: entry.interfaces,
    facts: entry.facts || facts,
  }));
}

function slug(text) {
  return String(text || 'device')
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, '-')
    .replace(/^-|-$/g, '');
}

function collectAdvertisedPorts(facts) {
  const ports = [];
  for (const service of facts.mdns || []) if (service.port) ports.push(service.port);
  for (const item of facts.beacons || []) for (const itf of item.interfaces || []) if (itf.port) ports.push(itf.port);
  return [...new Set(ports)];
}

/** 端口先验 ∪ 广播宣告，得到该端口的候选协议权重 */
function mergeHints(port, facts) {
  const hints = [...hintsFor(port)];
  for (const service of facts.mdns || []) {
    if (service.port !== port) continue;
    const hint = serviceHint(service.type);
    if (hint && !hints.some((item) => item.protocol === hint.protocol)) hints.push(hint);
    else if (hint) {
      const existing = hints.find((item) => item.protocol === hint.protocol);
      if (existing) existing.weight = Math.max(existing.weight, hint.weight);
    }
  }
  for (const item of facts.beacons || []) {
    for (const itf of item.interfaces || []) {
      if (itf.port === port && itf.protocol && !hints.some((h) => h.protocol === itf.protocol)) {
        hints.push({ protocol: itf.protocol, weight: 0.9 });
      }
    }
  }
  return hints;
}

module.exports = { DiscoveryService };
