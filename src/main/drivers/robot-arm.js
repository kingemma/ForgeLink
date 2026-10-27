const { DeviceDriver, factsToText, hasProtocol } = require('./base');
const { ModbusClient } = require('../protocols/modbus');
const { LineClient } = require('../protocols/raw');

/**
 * 机械臂驱动 —— 统一能力契约 + 可配置寄存器映射。
 *
 * 第一性原理：市面上的协作/国产机械臂（UR、JAKA、AUBO、珞石、大族、艾利特、埃斯顿、配天…）
 * 在网络层绝大多数都提供 Modbus-TCP（或一路行式文本协议）。差别只在**寄存器含义**，
 * 而寄存器映射是各厂私有约定、没有公开标准。因此：
 *   1) 驱动**不内置任何厂商的寄存器表**——内置即等于猜测，接上真机必然读错；
 *   2) 默认映射只是「起步模板」，每台设备可在 `config.registerMap` 里填自己的映射；
 *   3) 能力集（回零 / 关节移动 / 直线移动 / 抓取 / 释放 / 速度 / IO / 复位 / 清报警 / 急停）
 *      与品牌无关：工作流里永远用统一动作，换品牌只改映射、不改流程。
 */

/** 默认寄存器映射（同时是内置模拟器的实现约定） */
const DEFAULT_REGISTER_MAP = {
  length: 14, // 状态区一次读取的寄存器数量（地址 0 起）
  status: 1,
  joints: [2, 3, 4, 5, 6, 7],
  gripper: 8,
  speed: 9,
  load: 10,
  temperature: 11,
  errorCode: 12,
  cycleCount: 13,
  pose: null, // 可选：笛卡尔位姿寄存器 [x,y,z,rx,ry,rz]
  digitalOut: null, // 可选：数字输出寄存器（交接握手信号）
  targets: [20, 21, 22, 23, 24, 25], // 目标关节角（命令区）
  targetGripper: 26,
  targetPose: null, // 可选：目标位姿寄存器
  command: 30,
  commands: {
    home: 1,
    moveJ: 2,
    grip: 3,
    release: 4,
    stop: 5,
    setSpeed: 6,
    moveL: 7,
    reset: 8,
    clearAlarm: 9,
    setDO: 10,
  },
  scale: { joint: 10, temperature: 10, pose: 100 }, // 寄存器值与物理量的换算倍数
};

const STATUS_TEXT = ['idle', 'moving', 'error', 'homing', 'stopped'];

/** 合并设备自定义映射到默认映射（数组整体覆盖，commands/scale 逐项合并） */
function resolveRegisterMap(device) {
  const custom = device?.config?.registerMap || {};
  return {
    ...DEFAULT_REGISTER_MAP,
    ...custom,
    commands: { ...DEFAULT_REGISTER_MAP.commands, ...(custom.commands || {}) },
    scale: { ...DEFAULT_REGISTER_MAP.scale, ...(custom.scale || {}) },
  };
}

/** 状态区需要读取的寄存器数量 = max(声明长度, 用到的最大地址+1) */
function readCount(map) {
  const addresses = [
    map.status,
    map.gripper,
    map.speed,
    map.load,
    map.temperature,
    map.errorCode,
    map.cycleCount,
    map.digitalOut,
    ...(map.joints || []),
    ...(map.pose || []),
  ].filter((value) => typeof value === 'number');
  return Math.max(map.length || 14, ...addresses.map((value) => value + 1));
}

class RobotArmDriver extends DeviceDriver {
  static driverId = 'robot-arm';
  static label = '机械臂';
  static kind = 'robot-arm';
  static protocols = ['modbus-tcp', 'raw-text'];
  static actions = [
    { id: 'home', name: '回零位', params: [] },
    { id: 'moveTo', name: '移动到关节角', params: [{ name: 'joints', label: '关节角(度)数组', type: 'number[]', default: [0, 0, 0, 0, 0, 0] }] },
    { id: 'moveL', name: '直线移动到位姿', params: [{ name: 'pose', label: '位姿[x,y,z,rx,ry,rz]', type: 'number[]', default: [0, 0, 0, 0, 0, 0] }] },
    { id: 'pick', name: '抓取', params: [{ name: 'force', label: '夹持力(%)', type: 'number', default: 60 }] },
    { id: 'release', name: '释放', params: [] },
    { id: 'setSpeed', name: '设置速度', params: [{ name: 'percent', label: '速度(%)', type: 'number', default: 50 }] },
    { id: 'setDO', name: '设置数字输出', params: [{ name: 'index', label: '输出点', type: 'number', default: 0 }, { name: 'value', label: '值(0/1)', type: 'number', default: 1 }] },
    { id: 'reset', name: '复位', params: [] },
    { id: 'clearAlarm', name: '清除报警', params: [] },
    { id: 'stop', name: '急停', params: [] },
  ];
  static stateFields = ['status', 'joints', 'pose', 'gripper', 'speed', 'load', 'temperature', 'cycleCount', 'errorCode', 'digitalOut'];

  constructor(device, context) {
    super(device, context);
    const modbus = this.pickInterface(['modbus-tcp']);
    const text = this.pickInterface(['raw-text']);
    this.channel = modbus ? 'modbus' : text ? 'text' : null;
    this.interface = modbus || text || null;
    this.unitId = context?.unitId ?? device?.config?.unitId ?? 1;
    this.map = resolveRegisterMap(device);
  }

  static fitness(facts) {
    const text = factsToText(facts);
    let score = 0;
    if ((facts.beacons || []).some((beacon) => beacon.kind === 'robot-arm')) score = Math.max(score, 0.98);
    if (hasProtocol(facts, 'modbus-tcp')) score = Math.max(score, 0.6);
    if (/robot|robotic|机械臂|arm|manipulator|dobot|ur\d|jaco|cobot|伺服|关节/.test(text)) score = Math.max(score, 0.9);
    if (/joint|j1|j2|servo|axis|gripper|夹爪|末端/.test(text)) score = Math.max(score, 0.8);
    // 常见协作/国产品牌关键字（只用于提高置信度，不代表已内置其寄存器映射）
    if (/universal robots|jaka|aubo|rokae|hans|elite|estun|peitian|节卡|遨博|珞石|大族|艾利特|埃斯顿|配天/.test(text)) {
      score = Math.max(score, 0.92);
    }
    for (const item of facts.interfaces || []) {
      const registers = item.evidence?.registers;
      if (item.protocol === 'modbus-tcp' && Array.isArray(registers) && registers[0] === 0x5242) score = Math.max(score, 0.95);
    }
    return score;
  }

  async readState() {
    if (!this.channel) throw new Error('机械臂没有可用通信接口');
    const raw = this.channel === 'modbus' ? await this._readModbus() : await this._readText();
    const status = typeof raw.status === 'number' ? STATUS_TEXT[raw.status] || 'unknown' : String(raw.status || 'unknown');
    return {
      status,
      metrics: {
        status, // 同时放进 metrics：交接条件常写 state.metrics.status === 'idle'
        joints: raw.joints,
        pose: raw.pose || null,
        gripper: raw.gripper,
        speed: raw.speed,
        load: raw.load,
        temperature: raw.temperature,
        cycleCount: raw.cycleCount,
        errorCode: raw.errorCode,
        digitalOut: raw.digitalOut ?? null,
        alarm: Number(raw.errorCode || 0) !== 0,
      },
      raw,
    };
  }

  async _readModbus() {
    const map = this.map;
    const client = await ModbusClient.connect(this.device.ip, this.interface.port, { unitId: this.unitId, timeout: 1500 });
    try {
      const regs = await client.readHoldingRegisters(0, readCount(map));
      const at = (address) => (typeof address === 'number' ? regs[address] ?? 0 : null);
      const signed = (address) => toSigned16(at(address) ?? 0);
      const scaleOf = (name, fallback) => Number(map.scale?.[name] || fallback);
      return {
        deviceId: at(0),
        status: at(map.status),
        joints: (map.joints || []).map((address) => Number((signed(address) / scaleOf('joint', 10)).toFixed(2))),
        pose: (map.pose || []).map((address) => Number((signed(address) / scaleOf('pose', 100)).toFixed(2))),
        gripper: at(map.gripper),
        speed: at(map.speed),
        load: at(map.load),
        temperature: Number(((at(map.temperature) ?? 0) / scaleOf('temperature', 10)).toFixed(1)),
        errorCode: at(map.errorCode),
        cycleCount: at(map.cycleCount),
        digitalOut: at(map.digitalOut),
      };
    } finally {
      client.close();
    }
  }

  async _readText() {
    const client = await LineClient.connect(this.device.ip, this.interface.port, { timeout: 2000 });
    try {
      const response = await client.command('STATE');
      const parsed = parseKeyValue(response);
      const joints = [1, 2, 3, 4, 5, 6].map((index) => Number(parsed[`J${index}`] ?? 0));
      const pose = [1, 2, 3, 4, 5, 6].map((index) => Number(parsed[`P${index}`] ?? NaN));
      return {
        status: String(parsed.STATUS || parsed.status || 'idle').toLowerCase(),
        joints,
        pose: pose.every((value) => Number.isFinite(value)) ? pose : null,
        gripper: parsed.GRIP !== undefined ? Number(parsed.GRIP) : 0,
        speed: Number(parsed.SPEED ?? 50),
        load: Number(parsed.LOAD ?? 0),
        temperature: Number(parsed.TEMP ?? 0),
        errorCode: Number(parsed.ERR ?? 0),
        cycleCount: Number(parsed.CYCLES ?? 0),
        digitalOut: parsed.DO !== undefined ? Number(parsed.DO) : null,
        raw: response,
      };
    } finally {
      client.close();
    }
  }

  async invoke(action, params = {}) {
    const commands = this.map.commands;
    if (action === 'home') return this._send(commands.home);
    if (action === 'stop') return this._send(commands.stop);
    if (action === 'reset') return this._send(commands.reset);
    if (action === 'clearAlarm') return this._send(commands.clearAlarm);
    if (action === 'release') return this._send(commands.release);
    if (action === 'grip' || action === 'pick') return this._send(commands.grip, { force: params.force ?? 60 });
    if (action === 'setSpeed') return this._send(commands.setSpeed, { percent: params.percent ?? 50 });
    if (action === 'setDO') return this._send(commands.setDO, { index: params.index ?? 0, value: params.value ?? 1 });
    if (action === 'moveTo') return this._send(commands.moveJ, { joints: normalizeArray(params.joints, 6) });
    if (action === 'moveL') return this._send(commands.moveL, { pose: normalizeArray(params.pose, 6) });
    throw new Error(`机械臂不支持动作：${action}`);
  }

  async _send(command, payload = {}) {
    if (!this.channel) throw new Error('机械臂没有可用通信接口');
    if (this.channel === 'modbus') return this._sendModbus(command, payload);
    return this._sendText(command, payload);
  }

  async _sendModbus(command, payload) {
    const map = this.map;
    const client = await ModbusClient.connect(this.device.ip, this.interface.port, { unitId: this.unitId, timeout: 2000 });
    try {
      if (command === map.commands.moveJ) {
        const values = payload.joints.map((angle) => toUnsigned16(Math.round(angle * Number(map.scale?.joint || 10))));
        await client.writeMultipleRegisters(map.targets[0], values);
      } else if (command === map.commands.moveL) {
        if (!Array.isArray(map.targetPose) || !map.targetPose.length) {
          throw new Error('未配置目标位姿寄存器（registerMap.targetPose），无法执行直线移动');
        }
        const values = payload.pose.map((value) => toUnsigned16(Math.round(value * Number(map.scale?.pose || 100))));
        await client.writeMultipleRegisters(map.targetPose[0], values);
      } else if (command === map.commands.setSpeed) {
        await client.writeSingleRegister(map.speed, clamp(payload.percent, 1, 100));
      } else if (command === map.commands.grip) {
        await client.writeSingleRegister(map.targetGripper, clamp(payload.force, 0, 100));
      } else if (command === map.commands.release) {
        await client.writeSingleRegister(map.targetGripper, 0);
      } else if (command === map.commands.setDO) {
        if (typeof map.digitalOut !== 'number') {
          throw new Error('未配置数字输出寄存器（registerMap.digitalOut），无法设置 IO');
        }
        await client.writeSingleRegister(map.digitalOut, payload.value ? 1 : 0);
      }
      await client.writeSingleRegister(map.command, command);
      return { ok: true, command, transport: 'modbus-tcp' };
    } finally {
      client.close();
    }
  }

  async _sendText(command, payload) {
    const map = this.map;
    const client = await LineClient.connect(this.device.ip, this.interface.port, { timeout: 2500 });
    try {
      let line = 'NOP';
      if (command === map.commands.home) line = 'HOME';
      else if (command === map.commands.stop) line = 'STOP';
      else if (command === map.commands.release) line = 'RELEASE';
      else if (command === map.commands.grip) line = `GRIP ${clamp(payload.force ?? 60, 0, 100)}`;
      else if (command === map.commands.setSpeed) line = `SPEED ${clamp(payload.percent ?? 50, 1, 100)}`;
      else if (command === map.commands.moveJ) line = `MOVE ${payload.joints.map((angle, index) => `J${index + 1}=${angle}`).join(' ')}`;
      else throw new Error(`行式文本协议不支持该动作（命令码 ${command}），请改用 Modbus-TCP 通道`);
      const response = await client.command(line, { timeout: 3500 });
      return { ok: /ok|done|complete/i.test(response) || response.length > 0, command: line, response, transport: 'raw-text' };
    } finally {
      client.close();
    }
  }
}

function normalizeArray(input, size) {
  const list = Array.isArray(input) ? input : String(input || '').split(/[,，\s]+/).filter(Boolean).map(Number);
  const out = new Array(size).fill(0);
  list.slice(0, size).forEach((value, index) => {
    out[index] = Number.isFinite(Number(value)) ? Number(value) : 0;
  });
  return out;
}

function toSigned16(value) {
  const unsigned = value & 0xffff;
  return unsigned >= 0x8000 ? unsigned - 0x10000 : unsigned;
}

function toUnsigned16(value) {
  return value < 0 ? 0x10000 + value : value & 0xffff;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function parseKeyValue(text) {
  const out = {};
  for (const token of String(text || '').split(/[\s,;]+/)) {
    const index = token.indexOf('=');
    if (index > 0) out[token.slice(0, index).toUpperCase()] = token.slice(index + 1);
  }
  return out;
}

module.exports = { RobotArmDriver, DEFAULT_REGISTER_MAP, resolveRegisterMap, REG: DEFAULT_REGISTER_MAP, CMD: DEFAULT_REGISTER_MAP.commands, STATUS_TEXT };
