const { TcpSession } = require('./tcp');

/**
 * Modbus-TCP 客户端（RFC 793 / Modbus Messaging on TCP, GB/T 19582）。
 *
 * 工业设备（PLC、伺服驱动器、机械臂控制器）最普遍的开放协议。
 * 报文 = 7 字节 MBAP 头 + PDU：
 *   [事务标识 2B][协议标识 2B=0][长度 2B][单元标识 1B][功能码 1B][数据 nB]
 * 事务标识用于把并发请求与响应配对——这也是为什么必须自己管理自增 ID，
 * 而不能像行式协议那样「读到安静为止」。
 */
const FC_READ_COILS = 0x01;
const FC_READ_INPUT_REGISTERS = 0x04;
const FC_READ_HOLDING = 0x03;
const FC_WRITE_SINGLE = 0x06;
const FC_WRITE_MULTIPLE = 0x10;

class ModbusClient {
  constructor(session, options = {}) {
    this.session = session;
    this.unitId = options.unitId ?? 1;
    this.timeout = options.timeout ?? 1500;
    this._tx = 1;
  }

  static async connect(host, port = 502, options = {}) {
    const session = await TcpSession.connect(host, port, options.connectTimeout ?? 2000);
    return new ModbusClient(session, options);
  }

  close() {
    this.session.close();
  }

  async _transact(pdu) {
    const header = Buffer.alloc(7);
    header.writeUInt16BE(this._tx++ & 0xffff, 0);
    header.writeUInt16BE(0, 2); // 协议标识：Modbus 固定为 0
    header.writeUInt16BE(pdu.length + 1, 4); // 长度 = 单元标识 + PDU
    header.writeUInt8(this.unitId, 6);
    this.session.send(Buffer.concat([header, pdu]));

    const head = await this.session.readExact(8, this.timeout);
    if (head.length < 8) throw new Error('Modbus 响应过短');
    const remaining = head.readUInt16BE(4) - 2; // 减去已读的单元标识与功能码之外的部分
    const rest = remaining > 0 ? await this.session.readExact(remaining, this.timeout) : Buffer.alloc(0);
    const frame = Buffer.concat([head, rest]);
    const fc = frame[7];
    if (fc & 0x80) {
      const code = frame[8];
      throw new Error(`Modbus 异常码 0x${code.toString(16).padStart(2, '0')} (${MODBUS_ERRORS[code] || '未知'})`);
    }
    if (fc !== pdu[0]) throw new Error(`Modbus 功能码不匹配：期望 0x${pdu[0].toString(16)}，收到 0x${fc.toString(16)}`);
    // 返回 PDU（含功能码），便于各读写方法按 [fc][byteCount][data] 解析
    return frame.subarray(7);
  }

  /** 读保持寄存器（FC 0x03）——设备的可读可写状态区 */
  async readHoldingRegisters(address, quantity = 1) {
    const pdu = Buffer.from([FC_READ_HOLDING, (address >> 8) & 0xff, address & 0xff, (quantity >> 8) & 0xff, quantity & 0xff]);
    const data = await this._transact(pdu);
    const byteCount = data[1];
    const payload = data.subarray(2, 2 + byteCount);
    return toUint16Array(payload);
  }

  /** 读输入寄存器（FC 0x04）——只读遥测区 */
  async readInputRegisters(address, quantity = 1) {
    const pdu = Buffer.from([FC_READ_INPUT_REGISTERS, (address >> 8) & 0xff, address & 0xff, (quantity >> 8) & 0xff, quantity & 0xff]);
    const data = await this._transact(pdu);
    const byteCount = data[1];
    return toUint16Array(data.subarray(2, 2 + byteCount));
  }

  /** 读线圈（FC 0x01）——开关量输出 */
  async readCoils(address, quantity = 1) {
    const pdu = Buffer.from([FC_READ_COILS, (address >> 8) & 0xff, address & 0xff, (quantity >> 8) & 0xff, quantity & 0xff]);
    const data = await this._transact(pdu);
    const byteCount = data[1];
    const bits = [];
    for (let i = 0; i < byteCount; i += 1) {
      for (let bit = 0; bit < 8 && bits.length < quantity; bit += 1) bits.push(Boolean(data[2 + i] & (1 << bit)));
    }
    return bits;
  }

  async writeSingleRegister(address, value) {
    const pdu = Buffer.from([FC_WRITE_SINGLE, (address >> 8) & 0xff, address & 0xff, (value >> 8) & 0xff, value & 0xff]);
    const data = await this._transact(pdu);
    return { address: data.readUInt16BE(1), value: data.readUInt16BE(3) };
  }

  async writeMultipleRegisters(address, values) {
    const count = values.length;
    const pdu = Buffer.alloc(6 + count * 2);
    pdu[0] = FC_WRITE_MULTIPLE;
    pdu.writeUInt16BE(address, 1);
    pdu.writeUInt16BE(count, 3);
    pdu[5] = count * 2;
    values.forEach((value, index) => pdu.writeUInt16BE(value & 0xffff, 6 + index * 2));
    const data = await this._transact(pdu);
    return { address: data.readUInt16BE(1), count: data.readUInt16BE(3) };
  }
}

function toUint16Array(buffer) {
  const out = [];
  for (let i = 0; i + 1 < buffer.length; i += 2) out.push(buffer.readUInt16BE(i));
  return out;
}

const MODBUS_ERRORS = {
  0x01: '非法功能码',
  0x02: '非法数据地址',
  0x03: '非法数据值',
  0x04: '从站设备故障',
  0x05: '确认（需等待）',
  0x06: '从站设备忙',
};

module.exports = { ModbusClient, toUint16Array };
