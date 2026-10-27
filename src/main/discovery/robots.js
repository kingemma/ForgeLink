/**
 * 机械臂品牌线索表。
 *
 * 第一性原理：要「连上局域网里所有机械臂」，只需回答三件事——它是谁、它说什么、它能做什么。
 * 品牌识别只用**可公开核对**的线索：厂商名关键字、常用端口、设备自述（mDNS/SNMP/HTTP/SSDP）。
 *
 * 重要：各厂商的 Modbus 寄存器映射是**私有约定、没有公开标准**，
 * 因此这里不内置任何厂商的寄存器表（内置即等于猜测，接上真机必然读错）。
 * 统一做法是：给出一份默认映射，并允许每台设备在配置里填写自己的映射（见 drivers/robot-arm.js）。
 */

/** 机械臂常用的公开端口（IANA 标准端口或厂商公开文档端口），用于端口指纹 */
const ROBOT_PORTS = [29999, 30001, 30002, 30003, 30004, 44818, 4840, 54600, 10000];

const ROBOT_BRANDS = [
  {
    id: 'ur',
    name: 'Universal Robots（优傲）',
    keywords: ['universal robots', 'universal-robots', 'ur3', 'ur5', 'ur10', 'ur16', 'ur20', '优傲'],
    ports: [29999, 30001, 30002, 30003, 30004],
  },
  { id: 'jaka', name: 'JAKA（节卡）', keywords: ['jaka', '节卡'], ports: [10000] },
  { id: 'aubo', name: 'AUBO（遨博）', keywords: ['aubo', '遨博'], ports: [] },
  { id: 'rokae', name: 'Rokae（珞石）', keywords: ['rokae', '珞石'], ports: [] },
  { id: 'hans', name: "Han's Robot（大族）", keywords: ["han's", 'hans robot', 'hansrobot', '大族'], ports: [] },
  { id: 'elite', name: 'Elite Robots（艾利特）', keywords: ['elite robot', 'eliterobot', '艾利特'], ports: [] },
  { id: 'estun', name: 'ESTUN（埃斯顿）', keywords: ['estun', '埃斯顿'], ports: [] },
  { id: 'peitian', name: 'Peitian（配天）', keywords: ['peitian', '配天'], ports: [] },
  { id: 'dobot', name: 'DOBOT（越疆）', keywords: ['dobot', '越疆'], ports: [] },
  { id: 'kuka', name: 'KUKA', keywords: ['kuka'], ports: [54600] },
  { id: 'abb', name: 'ABB', keywords: ['abb robotics', 'robotware', 'irb '], ports: [] },
  { id: 'fanuc', name: 'FANUC', keywords: ['fanuc', '发那科', '法兰克'], ports: [] },
  { id: 'yaskawa', name: 'Yaskawa（安川）', keywords: ['yaskawa', 'motoman', '安川'], ports: [] },
  { id: 'mitsubishi', name: 'Mitsubishi MELFA（三菱）', keywords: ['melfa', 'mitsubishi'], ports: [10000] },
];

/**
 * 从设备事实里识别机械臂品牌。
 * @returns {{id:string, name:string, confidence:number, matched:'keyword'|'port'|null}|null}
 */
function identifyRobotBrand(facts) {
  const text = [
    facts.vendor || '',
    facts.model || '',
    facts.name || '',
    ...(facts.mdns || []).map((item) => `${item.type || ''} ${item.name || ''}`),
    ...(facts.ssdp || []).map((item) => `${item.server || ''} ${item.friendlyName || ''} ${item.modelName || ''}`),
    ...(facts.interfaces || []).map((item) => JSON.stringify(item.evidence || '')),
  ]
    .join(' \n ')
    .toLowerCase();

  for (const brand of ROBOT_BRANDS) {
    if (brand.keywords.some((keyword) => text.includes(keyword))) {
      return { id: brand.id, name: brand.name, confidence: 0.9, matched: 'keyword' };
    }
  }

  // 端口兜底：UR 的 30001/30004、KUKA 的 54600 等具有很强的品牌指向性，但弱于自述
  const ports = new Set((facts.interfaces || []).map((item) => item.port));
  const byPort = ROBOT_BRANDS.filter((brand) => brand.ports.length && brand.ports.some((port) => ports.has(port)));
  if (byPort.length === 1) return { id: byPort[0].id, name: byPort[0].name, confidence: 0.6, matched: 'port' };

  return null;
}

function brandById(id) {
  return ROBOT_BRANDS.find((brand) => brand.id === id) || null;
}

module.exports = { ROBOT_PORTS, ROBOT_BRANDS, identifyRobotBrand, brandById };
