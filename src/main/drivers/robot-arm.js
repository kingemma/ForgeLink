const { DeviceDriver, factsToText, hasProtocol } = require('./base');
const { ModbusClient } = require('../protocols/modbus');
const { LineClient } = require('../protocols/raw');

/**
 * 机械臂驱动。
 *
 * 同时支持两条通道，因为现实中的机械臂分两类：
 *  1) 工业型：Modbus-TCP 寄存器映射（状态区只读、目标区可写、命令寄存器触发动作）
 *  2) 桌面/教育型：行式文本协议（HOME / MOVE / GRIP / STATE）
 * 两条通道归一化后对外暴露完全相同的动作集，工作流里不区分底层。
 */

/** 寄存器映射（同时是模拟器的实现约定） */
const REG = {
  deviceId: 0,
  status: 1,
  joints: [2, 3, 4, 5, 6, 7],
  gripper: 8,
  speed: 9,
  load: 10,
  temperature: 11,
  errorCode: 12,
  cycleCount: 13,
  targets: [20, 21, 22, 23, 24, 25],
  targetGripper: 26,
  command: 30,
};

const CMD = { none: 0, home: 1, move: 2, grip: 3, release: 4, stop: 5, setSpeed: 6 };
const STATUS_TEXT = ['idle', 'moving', 'error', 'homing', 'stopped'];

class RobotArmDriver extends DeviceDriver {
  static driverId = 'robot-arm';
  static label = '机械臂';
  static kind = 'robot-arm';
  static protocols = ['modbus-tcp', 'raw-text'];
  static actions = [
    { id: 'home', name: '回零位', params: [] },
    { id: 'moveTo', name: '移动到关节角', params: [{ name: 'joints', label: '关节角(度)数组', type: 'number[]', default: [0, 0, 0, 0, 0, 0] }] },
    { id: 'pick', name: '抓取', params: [{ name: 'force', label: '夹持力(%)', type: 'number', default: 60 }] },
    { id: 'release', name: '释放', params: [] },
    { id: 'setSpeed', name: '设置速度', params: [{ name: 'percent', label: '速度(%)', type: 'number', default: 50 }] },
    { id: 'stop', name: '急停', params: [] },
  ];
  static stateFields = ['status', 'joints', 'gripper', 'speed', 'load', 'temperature', 'cycleCount'];

  constructor(device, context) {
    super(device, context);
    const modbus = this.pickInterface(['modbus-tcp']);
    const text = this.pickInterface(['raw-text']);
    this.channel = modbus ? 'modbus' : text ? 'text' : null;
    this.interface = modbus || text || null;
    this.unitId = context?.unitId ?? 1;
  }

  static fitness(facts) {
    const text = factsToText(facts);
    let score = 0;
    if ((facts.beacons || []).some((beacon) => beacon.kind === 'robot-arm')) score = Math.max(score, 0.98);
    if (hasProtocol(facts, 'modbus-tcp')) score = Math.max(score, 0.6);
    if (/robot|robotic|机械臂|arm|manipulator|dobot|ur\d|jaco|cobot|伺服|关节/.test(text)) score = Math.max(score, 0.9);
    if (/joint|j1|j2|servo|axis|gripper|夹爪|末端/.test(text)) score = Math.max(score, 0.8);
    // 寄存器特征：机械臂控制器常用设备标识 0x5242('RB')
    for (const item of facts.interfaces || []) {
      const registers = item.evidence?.registers;
      if (item.protocol === 'modbus-tcp' && Array.isArray(registers) && registers[0] === 0x5242) score = Math.max(score, 0.95);
    }
    return score;
  }

  async readState() {
    if (!this.channel) throw new Error('机械臂没有可用通信接口');
    const raw = this.channel === 'modbus' ? await this._readModbus() : await this._readText();
    const status = STATUS_TEXT[raw.status] || 'unknown';
    return {
      status,
      metrics: {
        joints: raw.joints,
        gripper: raw.gripper,
        speed: raw.speed,
        load: raw.load,
        temperature: raw.temperature,
        cycleCount: raw.cycleCount,
        errorCode: raw.errorCode,
      },
      raw,
    };
  }

  async _readModbus() {
    const client = await ModbusClient.connect(this.device.ip, this.interface.port, { unitId: this.unitId, timeout: 1500 });
    try {
      const regs = await client.readHoldingRegisters(0, 14);
      const signed = (index) => toSigned16(regs[index] ?? 0);
      return {
        deviceId: regs[REG.deviceId],
        status: regs[REG.status] ?? 0,
        joints: REG.joints.map((index) => Number(((signed(index) / 10) || 0).toFixed(1))),
        gripper: regs[REG.gripper] ?? 0,
        speed: regs[REG.speed] ?? 0,
        load: regs[REG.load] ?? 0,
        temperature: Number(((regs[REG.temperature] ?? 0) / 10).toFixed(1)),
        errorCode: regs[REG.errorCode] ?? 0,
        cycleCount: regs[REG.cycleCount] ?? 0,
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
      const statusText = String(parsed.STATUS || parsed.status || 'idle').toLowerCase();
      return {
        status: statusText,
        joints,
        gripper: parsed.GRIP !== undefined ? Number(parsed.GRIP) : 0,
        speed: Number(parsed.SPEED ?? 50),
        load: Number(parsed.LOAD ?? 0),
        temperature: Number(parsed.TEMP ?? 0),
        errorCode: Number(parsed.ERR ?? 0),
        cycleCount: Number(parsed.CYCLES ?? 0),
        raw: response,
      };
    } finally {
      client.close();
    }
  }

  async invoke(action, params = {}) {
    if (action === 'home') return this._send(CMD.home);
    if (action === 'stop') return this._send(CMD.stop);
    if (action === 'release') return this._send(CMD.release);
    if (action === 'grip' || action === 'pick') return this._send(CMD.grip, { force: params.force ?? 60 });
    if (action === 'setSpeed') return this._send(CMD.setSpeed, { percent: params.percent ?? 50 });
    if (action === 'moveTo') {
      const joints = normalizeJoints(params.joints);
      return this._send(CMD.move, { joints });
    }
    throw new Error(`机械臂不支持动作：${action}`);
  }

  async _send(command, payload = {}) {
    if (!this.channel) throw new Error('机械臂没有可用通信接口');
    if (this.channel === 'modbus') return this._sendModbus(command, payload);
    return this._sendText(command, payload);
  }

  async _sendModbus(command, payload) {
    const client = await ModbusClient.connect(this.device.ip, this.interface.port, { unitId: this.unitId, timeout: 2000 });
    try {
      if (command === CMD.move) {
        const values = payload.joints.map((angle) => toUnsigned16(Math.round(angle * 10)));
        await client.writeMultipleRegisters(REG.targets[0], values);
      } else if (command === CMD.setSpeed) {
        await client.writeSingleRegister(REG.speed, clamp(payload.percent, 1, 100));
      } else if (command === CMD.grip) {
        await client.writeSingleRegister(REG.targetGripper, clamp(payload.force, 0, 100));
      } else if (command === CMD.release) {
        await client.writeSingleRegister(REG.targetGripper, 0);
      }
      await client.writeSingleRegister(REG.command, command);
      return { ok: true, command, transport: 'modbus-tcp' };
    } finally {
      client.close();
    }
  }

  async _sendText(command, payload) {
    const client = await LineClient.connect(this.device.ip, this.interface.port, { timeout: 2500 });
    try {
      let line = 'NOP';
      if (command === CMD.home) line = 'HOME';
      else if (command === CMD.stop) line = 'STOP';
      else if (command === CMD.release) line = 'RELEASE';
      else if (command === CMD.grip) line = `GRIP ${clamp(payload.force ?? 60, 0, 100)}`;
      else if (command === CMD.setSpeed) line = `SPEED ${clamp(payload.percent ?? 50, 1, 100)}`;
      else if (command === CMD.move) line = `MOVE ${payload.joints.map((angle, index) => `J${index + 1}=${angle}`).join(' ')}`;
      const response = await client.command(line, { timeout: 3500 });
      return { ok: /ok|done|complete/i.test(response) || response.length > 0, command: line, response, transport: 'raw-text' };
    } finally {
      client.close();
    }
  }
}

function normalizeJoints(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(/[,，\s]+/).filter(Boolean).map(Number);
  const joints = [0, 0, 0, 0, 0, 0];
  list.slice(0, 6).forEach((value, index) => {
    joints[index] = Number.isFinite(value) ? value : 0;
  });
  return joints;
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

module.exports = { RobotArmDriver, REG, CMD, STATUS_TEXT };
