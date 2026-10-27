const net = require('node:net');
const http = require('node:http');
const dgram = require('node:dgram');
const {
  encodeRequest,
  OP_PRINT_JOB,
  OP_GET_PRINTER_ATTRIBUTES,
  OP_GET_JOBS,
  OP_CANCEL_JOB,
  TAG_OPERATION,
  TAG_END,
  VAL_INTEGER,
  VAL_ENUM,
  VAL_BOOLEAN,
  VAL_TEXT,
  VAL_NAME,
  VAL_KEYWORD,
  VAL_URI,
  VAL_MIME,
  VAL_CHARSET,
  VAL_LANGUAGE,
} = require('../protocols/ipp');
const { parseTLV, encodeTLV, encodeInteger, encodeOid, decodeOid, decodeInteger } = require('../protocols/snmp');

/**
 * 打印机模拟器：一台设备、三种协议，用来验证「多接口聚合」。
 *   IPP over HTTP(8631)   —— 控制面：状态查询、作业提交/取消
 *   JetDirect raw(9101)   —— 数据面：直接投递打印字节流
 *   SNMP over UDP(8161)   —— Printer MIB：页数、耗材余量
 */

const IPP_STATE = { idle: 3, processing: 4, stopped: 5 };
const JOB_STATE = { pending: 3, processing: 4, completed: 9, canceled: 8 };

const SNMP_VALUES = {
  '1.3.6.1.2.1.1.1.0': { type: 'string', get: (self) => `ForgeLink Simulated Printer ${self.model} (IPP/JetDirect/SNMP)` },
  '1.3.6.1.2.1.1.5.0': { type: 'string', get: (self) => self.name },
  '1.3.6.1.2.1.25.3.2.1.5.1': { type: 'integer', get: (self) => (self.state === IPP_STATE.stopped ? 5 : 2) },
  '1.3.6.1.2.1.43.10.2.1.4.1.1': { type: 'integer', get: (self) => self.pageCount },
  '1.3.6.1.2.1.43.11.1.1.9.1.1': { type: 'integer', get: (self) => self.tonerLevel },
  '1.3.6.1.2.1.43.11.1.1.8.1.1': { type: 'integer', get: () => 100 },
  '1.3.6.1.2.1.43.11.1.1.6.1.1': { type: 'string', get: () => '黑色碳粉' },
};

class PrinterSimulator {
  constructor(options = {}) {
    this.name = options.name || 'OmniPrint-2000';
    this.model = options.model || 'OmniPrint 2000 (模拟)';
    this.ippPort = options.ippPort ?? 8631;
    this.jetPort = options.jetPort ?? 9101;
    this.snmpPort = options.snmpPort ?? 8161;
    this.state = IPP_STATE.idle;
    this.jobs = [];
    this.jobSeq = 0;
    this.pageCount = 0;
    this.tonerLevel = 87;
    this.acceptingJobs = true;
    this.startedAt = Date.now();
    this.history = [];
    this.servers = [];
  }

  start() {
    this.servers.push(this._startIpp());
    this.servers.push(this._startJetDirect());
    this.servers.push(this._startSnmp());
    return this;
  }

  stop() {
    for (const server of this.servers) {
      try {
        if (server.close) server.close();
      } catch {
        /* 已关闭 */
      }
    }
    this.servers = [];
  }

  get manifest() {
    return {
      name: this.name,
      kind: 'printer',
      vendor: 'ForgeLink Simulator',
      model: this.model,
      interfaces: [
        { port: this.ippPort, protocol: 'ipp', transport: 'tcp', description: 'IPP 打印控制' },
        { port: this.jetPort, protocol: 'jetdirect', transport: 'tcp', description: 'JetDirect 原始数据' },
        { port: this.snmpPort, protocol: 'snmp', transport: 'udp', description: 'SNMP Printer MIB' },
      ],
    };
  }

  get queuedJobCount() {
    return this.jobs.filter((job) => job.state === JOB_STATE.pending || job.state === JOB_STATE.processing).length;
  }

  // ---------------- 作业生命周期 ----------------
  _submitJob(text, name) {
    const job = {
      id: ++this.jobSeq,
      name: name || `作业-${this.jobSeq}`,
      state: JOB_STATE.pending,
      bytes: Buffer.byteLength(text),
      createdAt: Date.now(),
      preview: String(text).replace(/\x1b[@A-Za-z]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80),
    };
    this.jobs.push(job);
    if (this.jobs.length > 50) this.jobs.shift();
    this._log(`收到作业 #${job.id}「${job.name}」(${job.bytes} 字节)`);

    setTimeout(() => {
      if (job.state === JOB_STATE.canceled) return;
      job.state = JOB_STATE.processing;
      this.state = IPP_STATE.processing;
      setTimeout(() => {
        if (job.state === JOB_STATE.canceled) return;
        job.state = JOB_STATE.completed;
        this.pageCount += 1;
        this.tonerLevel = Math.max(3, this.tonerLevel - 0.4);
        if (!this.queuedJobCount) this.state = IPP_STATE.idle;
        this._log(`作业 #${job.id} 完成，累计 ${this.pageCount} 页`);
      }, 1500);
    }, 600);
    return job;
  }

  _cancelJob(jobId) {
    const job = this.jobs.find((item) => item.id === Number(jobId));
    if (!job) return null;
    if (job.state === JOB_STATE.completed) return job;
    job.state = JOB_STATE.canceled;
    if (!this.queuedJobCount) this.state = IPP_STATE.idle;
    return job;
  }

  _log(message) {
    this.history.push({ ts: Date.now(), message });
    if (this.history.length > 100) this.history.shift();
  }

  // ---------------- IPP over HTTP ----------------
  _startIpp() {
    const server = http.createServer((request, response) => {
      if (request.method === 'POST') {
        const chunks = [];
        request.on('data', (chunk) => chunks.push(chunk));
        request.on('end', () => {
          const body = Buffer.concat(chunks);
          const result = this._handleIpp(body);
          response.writeHead(200, { 'Content-Type': 'application/ipp', 'Content-Length': Buffer.byteLength(result) });
          response.end(result);
        });
        return;
      }
      if (request.url === '/status') {
        const payload = JSON.stringify(this.snapshot());
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(payload);
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Server: 'ForgeLink-Printer/1.0' });
      response.end(`<html><head><title>${this.name}</title></head><body><h1>${this.model}</h1><p>IPP: ${this.ippPort} · JetDirect: ${this.jetPort} · SNMP: ${this.snmpPort}</p><p>已打印 ${this.pageCount} 页，碳粉 ${Math.round(this.tonerLevel)}%</p></body></html>`);
    });
    server.listen(this.ippPort);
    return server;
  }

  _handleIpp(buffer) {
    const parsed = parseIppRequest(buffer);
    const requestId = parsed.requestId;
    const attributes = parsed.attributes || {};

    if (parsed.operationId === OP_GET_PRINTER_ATTRIBUTES) {
      return this._ippResponse(0x0000, requestId, [{ tag: 0x04, attributes: this._printerAttributes() }]);
    }
    if (parsed.operationId === OP_PRINT_JOB) {
      const job = this._submitJob(parsed.data.toString('utf8'), attributes['job-name']);
      return this._ippResponse(0x0000, requestId, [
        {
          tag: 0x02,
          attributes: [
            { name: 'job-id', tag: VAL_INTEGER, value: job.id },
            { name: 'job-state', tag: VAL_ENUM, value: job.state },
            { name: 'job-state-message', tag: VAL_TEXT, value: '作业已接收' },
            { name: 'job-uri', tag: VAL_URI, value: `ipp://localhost/jobs/${job.id}` },
          ],
        },
      ]);
    }
    if (parsed.operationId === OP_GET_JOBS) {
      const group = { tag: 0x02, attributes: [] };
      for (const job of this.jobs.slice(-10)) {
        group.attributes.push({ name: 'job-id', tag: VAL_INTEGER, value: job.id });
        group.attributes.push({ name: 'job-state', tag: VAL_ENUM, value: job.state });
      }
      return this._ippResponse(0x0000, requestId, [group]);
    }
    if (parsed.operationId === OP_CANCEL_JOB) {
      const job = this._cancelJob(attributes['job-id']);
      return this._ippResponse(job ? 0x0000 : 0x0502, requestId, [
        { tag: 0x02, attributes: [{ name: 'job-id', tag: VAL_INTEGER, value: Number(attributes['job-id'] || 0) }] },
      ]);
    }
    return this._ippResponse(0x0501, requestId, []);
  }

  _printerAttributes() {
    return [
      { name: 'printer-uri-supported', tag: VAL_URI, value: `ipp://localhost:${this.ippPort}/ipp/print` },
      { name: 'printer-name', tag: VAL_NAME, value: this.name },
      { name: 'printer-info', tag: VAL_TEXT, value: 'ForgeLink 模拟打印机' },
      { name: 'printer-make-and-model', tag: VAL_TEXT, value: this.model },
      { name: 'printer-state', tag: VAL_ENUM, value: this.state },
      { name: 'printer-state-message', tag: VAL_TEXT, value: this.state === IPP_STATE.processing ? '正在打印' : '就绪' },
      { name: 'printer-state-reasons', tag: VAL_KEYWORD, value: this.state === IPP_STATE.processing ? 'processing' : 'none' },
      { name: 'printer-is-accepting-jobs', tag: VAL_BOOLEAN, value: this.acceptingJobs },
      { name: 'queued-job-count', tag: VAL_INTEGER, value: this.queuedJobCount },
      { name: 'marker-levels', tag: VAL_INTEGER, value: Math.round(this.tonerLevel) },
      { name: 'printer-up-time', tag: VAL_INTEGER, value: Math.floor((Date.now() - this.startedAt) / 1000) },
      { name: 'document-format-supported', tag: VAL_MIME, value: 'text/plain' },
    ];
  }

  /** 响应与请求共用 8 字节头布局，第 3~4 字节在响应中是 status-code */
  _ippResponse(statusCode, requestId, groups) {
    const operationGroup = {
      tag: TAG_OPERATION,
      attributes: [
        { name: 'attributes-charset', tag: VAL_CHARSET, value: 'utf-8' },
        { name: 'attributes-natural-language', tag: VAL_LANGUAGE, value: 'zh-cn' },
        { name: 'status-message', tag: VAL_TEXT, value: 'successful-ok' },
      ],
    };
    return encodeRequest(statusCode, [operationGroup, ...groups], null, requestId || 1);
  }

  // ---------------- JetDirect ----------------
  _startJetDirect() {
    const server = net.createServer((socket) => {
      const chunks = [];
      socket.on('error', () => socket.destroy());
      socket.on('data', (chunk) => chunks.push(chunk));
      socket.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (text.trim()) this._submitJob(text, 'JetDirect 作业');
      });
    });
    server.listen(this.jetPort);
    return server;
  }

  // ---------------- SNMP ----------------
  _startSnmp() {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('message', (message, rinfo) => {
      let request;
      try {
        request = parseSnmpRequest(message);
      } catch {
        return;
      }
      const varbinds = Buffer.concat(
        request.oids.map((oid) => {
          const definition = SNMP_VALUES[oid];
          const value = definition ? encodeSnmpValue(definition.type, definition.get(this)) : encodeTLV(0x81, Buffer.alloc(0));
          return encodeTLV(0x30, Buffer.concat([encodeOid(oid), value]));
        }),
      );
      const pdu = Buffer.concat([
        encodeInteger(request.requestId),
        encodeInteger(0),
        encodeInteger(0),
        encodeTLV(0x30, varbinds),
      ]);
      const packet = encodeTLV(0x30, Buffer.concat([encodeInteger(1), encodeTLV(0x04, Buffer.from('public', 'utf8')), encodeTLV(0xa2, pdu)]));
      socket.send(packet, 0, packet.length, rinfo.port, rinfo.address);
    });
    socket.bind(this.snmpPort);
    return socket;
  }

  snapshot() {
    return {
      name: this.name,
      model: this.model,
      state: this.state === IPP_STATE.processing ? 'printing' : this.state === IPP_STATE.stopped ? 'stopped' : 'idle',
      pageCount: this.pageCount,
      tonerLevel: Math.round(this.tonerLevel),
      queuedJobCount: this.queuedJobCount,
      jobs: this.jobs.slice(-10),
      history: this.history.slice(-20),
    };
  }
}

function parseIppRequest(buffer) {
  if (buffer.length < 8) throw new Error('IPP 报文过短');
  const operationId = buffer.readUInt16BE(2);
  const requestId = buffer.readUInt32BE(4);
  let offset = 8;
  const attributes = {};
  let lastName = null;
  while (offset < buffer.length) {
    const tag = buffer[offset];
    offset += 1;
    if (tag === TAG_END) break;
    if (tag <= 0x06) {
      lastName = null;
      continue;
    }
    if (offset + 2 > buffer.length) break;
    let nameLength = buffer.readUInt16BE(offset);
    offset += 2;
    let name = buffer.toString('utf8', offset, offset + nameLength);
    offset += nameLength;
    if (offset + 2 > buffer.length) break;
    const valueLength = buffer.readUInt16BE(offset);
    offset += 2;
    const raw = buffer.subarray(offset, offset + valueLength);
    offset += valueLength;
    if (nameLength === 0) name = lastName;
    if (!name) continue;
    lastName = name;
    const value = tag === VAL_INTEGER || tag === VAL_ENUM ? raw.readInt32BE(0) : tag === VAL_BOOLEAN ? raw[0] === 1 : raw.toString('utf8');
    if (attributes[name] === undefined) attributes[name] = value;
    else if (Array.isArray(attributes[name])) attributes[name].push(value);
    else attributes[name] = [attributes[name], value];
  }
  return { operationId, requestId, attributes, data: buffer.subarray(offset) };
}

function parseSnmpRequest(buffer) {
  const outer = parseTLV(buffer, 0);
  let position = outer.start;
  position = parseTLV(buffer, position).end; // version
  position = parseTLV(buffer, position).end; // community
  const pdu = parseTLV(buffer, position);
  let cursor = pdu.start;
  const requestId = parseTLV(buffer, cursor);
  cursor = requestId.end;
  cursor = parseTLV(buffer, cursor).end; // error-status
  cursor = parseTLV(buffer, cursor).end; // error-index
  const varbindList = parseTLV(buffer, cursor);
  const oids = [];
  let vbCursor = varbindList.start;
  while (vbCursor + 2 <= varbindList.end) {
    const varbind = parseTLV(buffer, vbCursor);
    vbCursor = varbind.end;
    const oid = parseTLV(buffer, varbind.start);
    oids.push(decodeOid(oid.value));
  }
  return { requestId: decodeInteger(requestId.value), oids };
}

function encodeSnmpValue(type, value) {
  if (type === 'string') return encodeTLV(0x04, Buffer.from(String(value), 'utf8'));
  return encodeInteger(Number(value));
}

module.exports = { PrinterSimulator, parseIppRequest };
