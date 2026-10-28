const fs = require('node:fs');
const path = require('node:path');

/**
 * 内核侧国际化：仅覆盖「面向用户、且会落到界面」的文案
 * （发现进度、示例工作流、模拟器/启动日志），诊断类日志保持原样。
 * 语言由渲染进程同步过来；设置目录由主进程注入（避免此处依赖 electron）。
 */
const MESSAGES = {
  zh: {
    'discovery.running': '发现任务正在运行',
    'discovery.broadcast': '正在通过 mDNS / SSDP / 信标广播探测设备…',
    'discovery.explicitHosts': '正在探测指定主机 {hosts}…',
    'discovery.arp': '正在读取 ARP 表并推导局域网网段…',
    'discovery.arpWarmup': '正在通过 ARP 确认局域网内真实主机…',
    'discovery.portscan': '正在扫描 {n} 台主机的开放端口…',
    'discovery.portscanProgress': '已扫描 {done}/{total} 台主机',
    'discovery.identify': '正在识别 {n} 个开放端口的协议…',
    'discovery.identifyProgress': '协议识别 {done}/{total}',
    'discovery.done': '发现完成：{n} 个设备',
    'discovery.broadcastDone': '广播探测完成：mDNS {mdns} / SSDP {ssdp} / 信标 {beacon}',
    'discovery.doneLog': '发现完成：{n} 个设备，耗时 {sec}s',

    'simulator.started': '设备模拟器已启动（机械臂 / 打印机）',
    'simulator.stopped': '设备模拟器已停止',
    'simulator.autoStarted': '已自动启动内置设备模拟器',
    'agent.restored': '已从本地档案恢复 {n} 个设备',
    'agent.autoDiscover': '启动后自动发现已触发',
    'discovery.autoFailed': '自动发现失败：{msg}',
    'workflow.saved': '已保存工作流：{name}',
    'workflow.created': '已生成示例工作流：机械臂取放 + 打印标签',
    'devices.cleared': '已清空 {n} 个设备档案',

    'demo.name': '示例：机械臂取放 + 打印标签',
    'demo.description': '机械臂回到安全位 → 移动到取件位 → 抓取 → 搬运到放件位 → 释放 → 打印机打印含循环计数的标签',
    'demo.node.readState': '读取机械臂状态',
    'demo.node.moveToPick': '移动到取件位',
    'demo.node.pick': '抓取工件',
    'demo.node.waitGrip': '等待夹持',
    'demo.node.moveToPlace': '移动到放件位',
    'demo.node.release': '释放工件',
    'demo.node.assembleCode': '组装标签编码',
    'demo.node.printLabel': '打印机打印标签',
    'demo.node.done': '完成通知',
    'demo.labelTitle': 'ForgeLink 工件',
    'demo.notifyMessage': '流水线完成：{{ nodes.n8.output.result.0.jobId }} 号作业已下发',
  },
  en: {
    'discovery.running': 'Discovery task is running',
    'discovery.broadcast': 'Probing devices via mDNS / SSDP / beacon broadcast…',
    'discovery.explicitHosts': 'Probing specified hosts {hosts}…',
    'discovery.arp': 'Reading ARP table and inferring LAN segment…',
    'discovery.arpWarmup': 'Confirming live hosts on the LAN via ARP…',
    'discovery.portscan': 'Scanning open ports on {n} hosts…',
    'discovery.portscanProgress': 'Scanned {done}/{total} hosts',
    'discovery.identify': 'Identifying protocols of {n} open ports…',
    'discovery.identifyProgress': 'Identified {done}/{total}',
    'discovery.done': 'Discovery complete: {n} devices',
    'discovery.broadcastDone': 'Broadcast probe done: mDNS {mdns} / SSDP {ssdp} / beacon {beacon}',
    'discovery.doneLog': 'Discovery complete: {n} devices in {sec}s',

    'simulator.started': 'Device simulator started (robot arm / printer)',
    'simulator.stopped': 'Device simulator stopped',
    'simulator.autoStarted': 'Auto-started built-in device simulator',
    'agent.restored': 'Restored {n} devices from local profile',
    'agent.autoDiscover': 'Auto-discovery triggered on startup',
    'discovery.autoFailed': 'Auto-discovery failed: {msg}',
    'workflow.saved': 'Saved workflow: {name}',
    'workflow.created': 'Generated sample workflow: robot-arm pick & place + print label',
    'devices.cleared': 'Cleared {n} device profiles',

    'demo.name': 'Sample: Robot-arm Pick & Place + Print Label',
    'demo.description': 'Robot returns to safe pose → moves to pick pose → grips → carries to place pose → releases → printer prints a label with the cycle count',
    'demo.node.readState': 'Read robot-arm state',
    'demo.node.moveToPick': 'Move to pick pose',
    'demo.node.pick': 'Grip workpiece',
    'demo.node.waitGrip': 'Wait for grip',
    'demo.node.moveToPlace': 'Move to place pose',
    'demo.node.release': 'Release workpiece',
    'demo.node.assembleCode': 'Assemble label code',
    'demo.node.printLabel': 'Printer prints label',
    'demo.node.done': 'Completion notice',
    'demo.labelTitle': 'ForgeLink Part',
    'demo.notifyMessage': 'Pipeline complete: job #{{ nodes.n8.output.result.0.jobId }} dispatched',
  },
};

let locale = 'zh';
let settingsDir = null;

function setSettingsDir(dir) {
  settingsDir = dir;
}

function settingsFile() {
  return settingsDir ? path.join(settingsDir, 'forgelink-settings.json') : null;
}

function loadLocale(dir) {
  if (dir) settingsDir = dir;
  const file = settingsFile();
  if (!file) return locale;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data && MESSAGES[data.locale]) locale = data.locale;
  } catch {}
  return locale;
}

function getLocale() {
  return locale;
}

function setLocale(next) {
  if (!MESSAGES[next]) return locale;
  locale = next;
  const file = settingsFile();
  if (file) {
    try {
      fs.writeFileSync(file, JSON.stringify({ locale }));
    } catch {}
  }
  return locale;
}

function t(key, params = {}) {
  const table = MESSAGES[locale] || MESSAGES.zh;
  let text = table[key] != null ? table[key] : MESSAGES.zh[key] != null ? MESSAGES.zh[key] : key;
  for (const name of Object.keys(params)) {
    const value = params[name];
    if (value == null) continue;
    text = text.split(`{${name}}`).join(String(value));
  }
  return text;
}

module.exports = { MESSAGES, setSettingsDir, loadLocale, getLocale, setLocale, t };
