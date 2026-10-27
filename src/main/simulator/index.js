const dgram = require('node:dgram');
const { RobotArmSimulator } = require('./robot-arm-server');
const { PrinterSimulator } = require('./printer-server');
const { MdnsResponder } = require('./mdns-responder');
const { BEACON_PORT, PROTOCOL } = require('../discovery/beacon');

/**
 * 模拟器集群：一键拉起「机械臂 + 打印机」两套虚拟设备，
 * 并把它们接入三条发现通道（UDP 信标、mDNS、TCP 端口），
 * 使整个智能体在没有真实硬件时也能完整演示。
 */
class SimulatorCluster {
  constructor(options = {}) {
    this.robot = new RobotArmSimulator({
      modbusPort: options.robotModbusPort ?? 5021,
      textPort: options.robotTextPort ?? 9001,
      name: options.robotName,
    });
    this.printer = new PrinterSimulator({
      ippPort: options.printerIppPort ?? 8631,
      jetPort: options.printerJetPort ?? 9101,
      snmpPort: options.printerSnmpPort ?? 8161,
      name: options.printerName,
    });
    this.devices = [this.robot, this.printer];
    this.beaconSocket = null;
    this.mdns = null;
    this.running = false;
  }

  start() {
    if (this.running) return this;
    for (const device of this.devices) device.start();
    this._startBeacon();
    this._startMdns();
    this.running = true;
    return this;
  }

  stop() {
    for (const device of this.devices) device.stop();
    try {
      this.beaconSocket?.close();
    } catch {
      /* 已关闭 */
    }
    this.beaconSocket = null;
    this.mdns?.stop();
    this.mdns = null;
    this.running = false;
  }

  get manifest() {
    return this.devices.map((device) => device.manifest);
  }

  status() {
    return {
      running: this.running,
      devices: this.manifest,
      robot: this.robot.snapshot(),
      printer: this.printer.snapshot(),
    };
  }

  /** 应答 ForgeLink 信标：自述设备类型、厂商与接口清单 */
  _startBeacon() {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('message', (message, rinfo) => {
      let payload;
      try {
        payload = JSON.parse(message.toString('utf8'));
      } catch {
        return;
      }
      if (payload.protocol !== PROTOCOL || payload.type !== 'discover') return;
      for (const device of this.devices) {
        const announce = Buffer.from(JSON.stringify({ protocol: PROTOCOL, type: 'announce', ...device.manifest }), 'utf8');
        socket.send(announce, 0, announce.length, rinfo.port, rinfo.address);
      }
    });
    socket.on('error', () => {});
    try {
      socket.bind({ port: BEACON_PORT, exclusive: false }, () => socket.setBroadcast(true));
    } catch {
      try {
        socket.bind(0, () => socket.setBroadcast(true));
      } catch {
        /* 放弃信标应答 */
      }
    }
    this.beaconSocket = socket;
  }

  /** 宣告 mDNS 服务，模拟真实设备的零配置广播 */
  _startMdns() {
    this.mdns = new MdnsResponder([
      {
        name: 'OmniArm-6',
        type: '_robot._tcp',
        port: this.robot.textPort,
        txt: { vendor: 'ForgeLink', model: 'OmniArm-6', proto: 'text', modbus: String(this.robot.modbusPort) },
      },
      {
        name: 'OmniPrint-2000',
        type: '_ipp._tcp',
        port: this.printer.ippPort,
        txt: { vendor: 'ForgeLink', model: 'OmniPrint-2000', ipp: String(this.printer.ippPort), raw: String(this.printer.jetPort) },
      },
      {
        name: 'OmniPrint-2000',
        type: '_printer._tcp',
        port: this.printer.jetPort,
        txt: { vendor: 'ForgeLink', model: 'OmniPrint-2000' },
      },
    ]).start();
  }
}

module.exports = { SimulatorCluster };
