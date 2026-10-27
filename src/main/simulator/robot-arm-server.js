const net = require('node:net');

/**
 * 机械臂模拟器。
 *
 * 目的：让整个系统在没有任何真实硬件的情况下完成端到端验证。
 * 同一台「虚拟机械臂」同时暴露两条真实世界最常见的通道，用来检验
 * 「协议自动识别 + 驱动归一化」是否真的与底层无关：
 *   Modbus-TCP(5021) —— 工业型：寄存器读写
 *   行式文本(9001)   —— 桌面型：HOME / MOVE / GRIP / STATE
 * 两条通道共享同一份物理状态，因此无论走哪条都能看到一致的行为。
 */

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
const STATUS = { idle: 0, moving: 1, error: 2, homing: 3, stopped: 4 };

class RobotArmSimulator {
  constructor(options = {}) {
    this.name = options.name || 'OmniArm-6 六轴机械臂';
    this.modbusPort = options.modbusPort ?? 5021;
    this.textPort = options.textPort ?? 9001;
    this.registers = new Uint16Array(64);
    this.joints = [0, -20, 30, 0, 45, 0];
    this.targets = [...this.joints];
    this.gripper = 0;
    this.targetGripper = 0;
    this.speed = 50;
    this.load = 120;
    this.temperature = 36.5;
    this.cycleCount = 0;
    this.status = STATUS.idle;
    this.errorCode = 0;
    this.servers = [];
    this.timer = null;
    this.jobs = 0;

    this.registers[REG.deviceId] = 0x5242; // 'RB'
    this.registers[REG.speed] = this.speed;
    this.registers[REG.gripper] = 0;
    this.registers[REG.temperature] = 365;
    this._syncRegisters();
  }

  start() {
    this.servers.push(this._startModbus());
    this.servers.push(this._startText());
    this.timer = setInterval(() => this._tick(), 90);
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const server of this.servers) {
      try {
        server.close();
      } catch {
        /* 已关闭 */
      }
    }
    this.servers = [];
  }

  get manifest() {
    return {
      name: this.name,
      kind: 'robot-arm',
      vendor: 'ForgeLink Simulator',
      model: 'OmniArm-6',
      interfaces: [
        { port: this.modbusPort, protocol: 'modbus-tcp', transport: 'tcp', description: 'Modbus-TCP 寄存器接口' },
        { port: this.textPort, protocol: 'raw-text', transport: 'tcp', description: '行式文本命令接口' },
      ],
    };
  }

  snapshot() {
    return {
      status: ['idle', 'moving', 'error', 'homing', 'stopped'][this.status],
      joints: this.joints.map((value) => Number(value.toFixed(1))),
      gripper: this.gripper,
      speed: this.speed,
      load: this.load,
      temperature: Number(this.temperature.toFixed(1)),
      cycleCount: this.cycleCount,
      errorCode: this.errorCode,
    };
  }

  // ---------------- 状态演化 ----------------
  _tick() {
    const step = (this.speed / 100) * 2.2;
    let moving = false;
    for (let index = 0; index < 6; index += 1) {
      const delta = this.targets[index] - this.joints[index];
      if (Math.abs(delta) > 0.05) {
        this.joints[index] += Math.sign(delta) * Math.min(Math.abs(delta), step);
        moving = true;
      } else {
        this.joints[index] = this.targets[index];
      }
    }
    const gripperDelta = this.targetGripper - this.gripper;
    if (Math.abs(gripperDelta) > 0.5) {
      this.gripper += Math.sign(gripperDelta) * Math.min(Math.abs(gripperDelta), 8);
      moving = true;
    } else {
      this.gripper = this.targetGripper;
    }

    if (moving) {
      if (this.status === STATUS.idle || this.status === STATUS.homing) this.status = STATUS.moving;
      this.load = Math.min(800, 120 + Math.abs(this.joints[1]) * 3 + (this.gripper / 100) * 200 + Math.random() * 20);
      this.temperature += (this.speed / 100) * 0.05;
    } else {
      if (this.status === STATUS.moving) {
        this.cycleCount += 1;
        this.status = STATUS.idle;
      } else if (this.status === STATUS.homing) {
        this.status = STATUS.idle;
      }
      this.load = Math.max(80, this.load - 4);
      this.temperature = Math.max(30, this.temperature - 0.02);
    }
    this._syncRegisters();
  }

  _syncRegisters() {
    this.registers[REG.status] = this.status;
    REG.joints.forEach((index, joint) => {
      this.registers[index] = toUnsigned16(Math.round(this.joints[joint] * 10));
    });
    this.registers[REG.gripper] = Math.round(this.gripper);
    this.registers[REG.speed] = Math.round(this.speed);
    this.registers[REG.load] = Math.round(this.load);
    this.registers[REG.temperature] = Math.round(this.temperature * 10);
    this.registers[REG.errorCode] = this.errorCode;
    this.registers[REG.cycleCount] = this.cycleCount;
    // 目标寄存器（20~26）由客户端写入，属于「命令区」，
    // 不能用当前状态回写覆盖，否则先写目标再写命令时目标会被冲掉
  }

  _executeCommand(command) {
    switch (command) {
      case CMD.home:
        this.targets = [0, 0, 0, 0, 0, 0];
        this.status = STATUS.homing;
        break;
      case CMD.move:
        REG.targets.forEach((index, joint) => {
          this.targets[joint] = toSigned16(this.registers[index]) / 10;
        });
        this.status = STATUS.moving;
        break;
      case CMD.grip:
        this.targetGripper = Math.min(100, Math.max(1, this.registers[REG.targetGripper] || 60));
        this.status = STATUS.moving;
        break;
      case CMD.release:
        this.targetGripper = 0;
        this.status = STATUS.moving;
        break;
      case CMD.stop:
        this.status = STATUS.stopped;
        this.targets = [...this.joints];
        break;
      case CMD.setSpeed:
        this.speed = Math.min(100, Math.max(1, this.registers[REG.speed] || 50));
        break;
      default:
        break;
    }
    this.registers[REG.command] = 0;
    this._syncRegisters();
  }

  // ---------------- Modbus-TCP 服务端 ----------------
  _startModbus() {
    const server = net.createServer((socket) => {
      let buffer = Buffer.alloc(0);
      socket.on('error', () => socket.destroy());
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
          if (buffer.length < 8) break;
          const length = buffer.readUInt16BE(4);
          const frameLength = 6 + length;
          if (buffer.length < frameLength) break;
          const frame = buffer.subarray(0, frameLength);
          buffer = buffer.subarray(frameLength);
          const response = this._handleModbus(frame);
          if (response) socket.write(response);
        }
      });
    });
    server.listen(this.modbusPort);
    return server;
  }

  _handleModbus(frame) {
    const transactionId = frame.readUInt16BE(0);
    const unitId = frame[6];
    const fc = frame[7];
    const build = (pdu) => {
      const header = Buffer.alloc(7);
      header.writeUInt16BE(transactionId, 0);
      header.writeUInt16BE(0, 2);
      header.writeUInt16BE(pdu.length + 1, 4);
      header.writeUInt8(unitId, 6);
      return Buffer.concat([header, pdu]);
    };
    const exception = (code) => build(Buffer.from([fc | 0x80, code]));

    try {
      if (fc === 0x03) {
        const address = frame.readUInt16BE(8);
        const quantity = frame.readUInt16BE(10);
        if (address + quantity > this.registers.length) return exception(0x02);
        const data = Buffer.alloc(2 + quantity * 2);
        data[0] = fc;
        data[1] = quantity * 2;
        for (let i = 0; i < quantity; i += 1) data.writeUInt16BE(this.registers[address + i], 2 + i * 2);
        return build(data);
      }
      if (fc === 0x04) {
        const address = frame.readUInt16BE(8);
        const quantity = frame.readUInt16BE(10);
        const data = Buffer.alloc(2 + quantity * 2);
        data[0] = fc;
        data[1] = quantity * 2;
        for (let i = 0; i < quantity; i += 1) data.writeUInt16BE(this.registers[address + i] || 0, 2 + i * 2);
        return build(data);
      }
      if (fc === 0x06) {
        const address = frame.readUInt16BE(8);
        const value = frame.readUInt16BE(10);
        this._writeRegister(address, value);
        const data = Buffer.alloc(5); // [fc][地址 2B][值 2B]
        data[0] = fc;
        data.writeUInt16BE(address, 1);
        data.writeUInt16BE(value, 3);
        return build(data);
      }
      if (fc === 0x10) {
        const address = frame.readUInt16BE(8);
        const quantity = frame.readUInt16BE(10);
        for (let i = 0; i < quantity; i += 1) this._writeRegister(address + i, frame.readUInt16BE(13 + i * 2));
        const data = Buffer.alloc(5); // [fc][起始地址 2B][数量 2B]
        data[0] = fc;
        data.writeUInt16BE(address, 1);
        data.writeUInt16BE(quantity, 3);
        return build(data);
      }
      return exception(0x01);
    } catch {
      return exception(0x04);
    }
  }

  _writeRegister(address, value) {
    this.registers[address] = value;
    if (address === REG.command) this._executeCommand(value);
    if (address === REG.speed) this.speed = Math.min(100, Math.max(1, value || 50));
    if (address === REG.targetGripper) this.targetGripper = Math.min(100, Math.max(0, value));
    this._syncRegisters();
  }

  // ---------------- 行式文本服务端 ----------------
  _startText() {
    const server = net.createServer((socket) => {
      socket.write('ForgeLink OmniArm-6 仿真机械臂就绪 > ');
      let buffer = '';
      socket.on('error', () => socket.destroy());
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let index = buffer.indexOf('\n');
        while (index >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (line) socket.write(`${this._handleTextLine(line)}\n`);
          index = buffer.indexOf('\n');
        }
      });
    });
    server.listen(this.textPort);
    return server;
  }

  _handleTextLine(line) {
    const [command, ...rest] = line.trim().split(/\s+/);
    const upper = command.toUpperCase();
    const args = rest.join(' ');
    switch (upper) {
      case 'STATE':
      case 'STATUS': {
        const snapshot = this.snapshot();
        const joints = snapshot.joints.map((value, index) => `J${index + 1}=${value}`).join(' ');
        return `OK STATUS:${snapshot.status} ${joints} GRIP=${Math.round(snapshot.gripper)} SPEED=${snapshot.speed} LOAD=${Math.round(snapshot.load)} TEMP=${snapshot.temperature} CYCLES=${snapshot.cycleCount}`;
      }
      case 'HOME':
        this.registers[REG.command] = CMD.home;
        this._executeCommand(CMD.home);
        return 'OK HOME 回零中';
      case 'MOVE': {
        for (const token of args.split(/[\s,]+/)) {
          const match = token.match(/^J([1-6])=(-?[\d.]+)$/i);
          if (match) this.targets[Number(match[1]) - 1] = Number(match[2]);
        }
        this.status = STATUS.moving;
        this._syncRegisters();
        return 'OK MOVE 已下发目标关节角';
      }
      case 'GRIP':
        this.targetGripper = Math.min(100, Math.max(0, Number(rest[0] ?? 60)));
        this.status = STATUS.moving;
        return `OK GRIP ${this.targetGripper}`;
      case 'RELEASE':
        this.targetGripper = 0;
        this.status = STATUS.moving;
        return 'OK RELEASE';
      case 'SPEED':
        this.speed = Math.min(100, Math.max(1, Number(rest[0] ?? 50)));
        this._syncRegisters();
        return `OK SPEED ${this.speed}`;
      case 'STOP':
        this.registers[REG.command] = CMD.stop;
        this._executeCommand(CMD.stop);
        return 'OK STOP 已急停';
      case '?':
      case 'INFO':
      case 'VERSION':
      case '*IDN?':
      case 'IDN?':
        return 'OmniArm: MODEL=OmniArm-6; VENDOR=ForgeLink; JOINTS=6; PROTOCOL=OmniArmText/1; STATE:' + this.snapshot().status;
      default:
        return `ERR UNKNOWN_COMMAND ${upper}`;
    }
  }
}

function toSigned16(value) {
  return value >= 0x8000 ? value - 0x10000 : value;
}

function toUnsigned16(value) {
  return value < 0 ? 0x10000 + value : value & 0xffff;
}

module.exports = { RobotArmSimulator, REG, CMD };
