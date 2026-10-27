const { DeviceDriver, factsToText, hasProtocol } = require('./base');
const { IppClient } = require('../protocols/ipp');
const { SnmpClient } = require('../protocols/snmp');
const { TcpSession } = require('../protocols/tcp');

/**
 * 打印机驱动。
 *
 * 打印机是「同一台物理设备暴露多种协议」的典型：
 *   IPP(631)     —— 控制面：状态、队列、作业提交/取消
 *   JetDirect(9100) —— 数据面：直接投递打印数据
 *   SNMP(161)    —— 耗材/计数器（Printer MIB）
 * 驱动把它们合成一份状态视图，并按优先级选择传输通道。
 */

/** Printer MIB 常用 OID */
const OID = {
  sysDescr: '1.3.6.1.2.1.1.1.0',
  sysName: '1.3.6.1.2.1.1.5.0',
  deviceStatus: '1.3.6.1.2.1.25.3.2.1.5.1', // HOST-RESOURCES-MIB
  pageCount: '1.3.6.1.2.1.43.10.2.1.4.1.1', // prtMarkerLifeCount
  supplyLevel: '1.3.6.1.2.1.43.11.1.1.9.1.1', // prtMarkerSuppliesLevel
  supplyMax: '1.3.6.1.2.1.43.11.1.1.8.1.1', // prtMarkerSuppliesMaxCapacity
  supplyDescription: '1.3.6.1.2.1.43.11.1.1.6.1.1',
};

const HR_STATUS = ['unknown', 'running', 'warning', 'testing', 'down'];

class PrinterDriver extends DeviceDriver {
  static driverId = 'printer';
  static label = '打印机';
  static kind = 'printer';
  static protocols = ['ipp', 'jetdirect', 'snmp'];
  static actions = [
    { id: 'print', name: '打印文本', params: [{ name: 'text', label: '文本内容', type: 'text', default: 'Hello ForgeLink' }, { name: 'copies', label: '份数', type: 'number', default: 1 }] },
    { id: 'printLabel', name: '打印标签', params: [{ name: 'title', label: '标题', type: 'text', default: 'OMNI' }, { name: 'code', label: '编码', type: 'text', default: '0001' }] },
    { id: 'cancelJob', name: '取消作业', params: [{ name: 'jobId', label: '作业号', type: 'number', default: 1 }] },
    { id: 'getJobs', name: '查询作业', params: [] },
  ];
  static stateFields = ['state', 'queuedJobCount', 'pageCount', 'tonerLevel', 'acceptingJobs'];

  constructor(device, context) {
    super(device, context);
    this.ipp = this.pickInterface(['ipp']);
    this.jetdirect = this.pickInterface(['jetdirect']);
    this.snmp = this.pickInterface(['snmp']) || { port: 161 };
    this.path = context?.path || this.ipp?.details?.path || '/ipp/print';
  }

  static fitness(facts) {
    const text = factsToText(facts);
    let score = 0;
    if ((facts.beacons || []).some((beacon) => beacon.kind === 'printer')) score = Math.max(score, 0.98);
    if (hasProtocol(facts, 'ipp')) score = Math.max(score, 0.95);
    if (hasProtocol(facts, 'jetdirect')) score = Math.max(score, 0.82);
    if (/printer|打印|laserjet|officejet|deskjet|epson|canon|brother|kyocera|xerox|_ipp|pdl-datastream|cups/.test(text)) score = Math.max(score, 0.9);
    if (hasProtocol(facts, 'snmp') && /print|mark|toner|ink/.test(text)) score = Math.max(score, 0.75);
    return score;
  }

  async readState() {
    const state = {
      state: 'unknown',
      queuedJobCount: null,
      pageCount: null,
      tonerLevel: null,
      acceptingJobs: null,
      message: '',
      sources: [],
    };

    if (this.ipp) {
      try {
        const client = new IppClient({ host: this.device.ip, port: this.ipp.port, path: this.path, timeout: 2000 });
        const info = await client.getPrinterAttributes();
        state.state = info.state || 'unknown';
        state.queuedJobCount = info.queuedJobCount;
        state.acceptingJobs = info.isAcceptingJobs;
        state.message = info.stateMessage || '';
        state.makeAndModel = info.makeAndModel;
        if (Array.isArray(info.markerLevels) && info.markerLevels.length) state.tonerLevel = info.markerLevels[0];
        else if (typeof info.markerLevels === 'number') state.tonerLevel = info.markerLevels;
        state.sources.push('ipp');
      } catch (error) {
        state.message = `IPP 读取失败：${error.message}`;
      }
    }

    if (this.snmp) {
      try {
        const client = new SnmpClient({ host: this.device.ip, port: this.snmp.port || 161, timeout: 1500 });
        const results = await client.get([OID.deviceStatus, OID.pageCount, OID.supplyLevel, OID.supplyMax], 0);
        const status = results[OID.deviceStatus]?.value;
        const level = results[OID.supplyLevel]?.value;
        const max = results[OID.supplyMax]?.value;
        if (typeof status === 'number') {
          state.deviceStatus = HR_STATUS[status] || 'unknown';
          if (state.state === 'unknown') state.state = status === 5 ? 'stopped' : status === 2 ? 'idle' : HR_STATUS[status];
        }
        if (typeof level === 'number') state.tonerLevel = max > 0 ? Math.round((level / max) * 100) : level;
        if (results[OID.pageCount]?.value != null) state.pageCount = results[OID.pageCount].value;
        state.sources.push('snmp');
      } catch {
        /* SNMP 可选，失败不影响主状态 */
      }
    }

    if (!state.sources.length && this.jetdirect) {
      try {
        const session = await TcpSession.connect(this.device.ip, this.jetdirect.port, 1200);
        session.close();
        state.state = 'idle';
        state.sources.push('jetdirect');
      } catch {
        state.state = 'offline';
      }
    }

    if (!state.sources.length) throw new Error('打印机没有任何可用协议通道');
    return { status: state.state, metrics: state, raw: state };
  }

  async invoke(action, params = {}) {
    if (action === 'getJobs') {
      if (!this.ipp) throw new Error('该打印机未暴露 IPP，无法查询作业');
      const client = new IppClient({ host: this.device.ip, port: this.ipp.port, path: this.path, timeout: 2000 });
      return client.getJobs();
    }
    if (action === 'cancelJob') {
      if (!this.ipp) throw new Error('该打印机未暴露 IPP，无法取消作业');
      const client = new IppClient({ host: this.device.ip, port: this.ipp.port, path: this.path, timeout: 2000 });
      const result = await client.cancelJob(params.jobId ?? 1);
      return { ok: result.statusCode <= 0x00ff, ...result };
    }
    if (action === 'print') {
      const text = String(params.text ?? '');
      const copies = Math.max(1, Number(params.copies ?? 1));
      return this._print(text.repeat(1) + '\n', { copies, jobName: params.jobName || 'ForgeLink 文本打印' });
    }
    if (action === 'printLabel') {
      const label = renderLabel(params.title ?? 'OMNI', params.code ?? '0001');
      return this._print(label, { copies: Math.max(1, Number(params.copies ?? 1)), jobName: `标签 ${params.code}` });
    }
    throw new Error(`打印机不支持动作：${action}`);
  }

  async _print(payload, options) {
    const { copies = 1, jobName = 'ForgeLink' } = options;
    const results = [];
    for (let index = 0; index < copies; index += 1) {
      if (this.ipp) {
        try {
          const client = new IppClient({ host: this.device.ip, port: this.ipp.port, path: this.path, timeout: 3000 });
          const result = await client.printJob(payload, { jobName, documentFormat: 'text/plain' });
          results.push({ transport: 'ipp', ok: result.statusCode <= 0x00ff, jobId: result.jobId });
          continue;
        } catch (error) {
          results.push({ transport: 'ipp', ok: false, error: error.message });
          // IPP 失败时回落到 JetDirect 原始数据通道
        }
      }
      if (this.jetdirect) {
        const session = await TcpSession.connect(this.device.ip, this.jetdirect.port, 2000);
        try {
          session.send(payload);
          results.push({ transport: 'jetdirect', ok: true, bytes: Buffer.byteLength(payload) });
        } finally {
          session.close();
        }
        continue;
      }
      if (!results.length) throw new Error('无可用的打印通道');
    }
    return { ok: results.some((item) => item.ok), copies, results };
  }
}

/** 生成一份极简 ESC/POS 风格文本标签，保证任何文本打印机都能出内容 */
function renderLabel(title, code) {
  const line = '='.repeat(32);
  return [`\x1b@`, line, `  ${title}`, '', `  CODE: ${code}`, `  TIME: ${new Date().toISOString()}`, line, '\n'].join('\n');
}

module.exports = { PrinterDriver, OID, renderLabel };
