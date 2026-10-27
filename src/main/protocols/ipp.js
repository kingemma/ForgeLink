const http = require('node:http');

/**
 * IPP（Internet Printing Protocol, RFC 8010/8011）客户端。
 *
 * 打印机的事实标准控制协议，over HTTP，操作码 0x000B = Get-Printer-Attributes。
 * 报文结构：
 *   [版本 2B][操作码 2B][请求号 4B][属性组…][结束标记 0x03][文档数据]
 * 每个属性 = [值标签 1B][名长 2B][名][值长 2B][值]。
 */

const OP_PRINT_JOB = 0x0002;
const OP_GET_JOBS = 0x000a;
const OP_GET_PRINTER_ATTRIBUTES = 0x000b;
const OP_CANCEL_JOB = 0x0008;

const TAG_OPERATION = 0x01;
const TAG_JOB = 0x02;
const TAG_END = 0x03;
const TAG_PRINTER = 0x04;

// 值标签（out-of-band 与常用语法）
const VAL_INTEGER = 0x21;
const VAL_BOOLEAN = 0x22;
const VAL_ENUM = 0x23;
const VAL_OCTET = 0x30;
const VAL_DATE = 0x31;
const VAL_RESOLUTION = 0x32;
const VAL_TEXT_LANG = 0x35;
const VAL_NAME_LANG = 0x36;
const VAL_TEXT = 0x41;
const VAL_NAME = 0x42;
const VAL_KEYWORD = 0x44;
const VAL_URI = 0x45;
const VAL_CHARSET = 0x47;
const VAL_LANGUAGE = 0x48;
const VAL_MIME = 0x49;

/** IPP printer-state 是枚举：3=idle、4=processing、5=stopped（RFC 8011 §5.4.11） */
const PRINTER_STATE_BY_ENUM = { 3: 'idle', 4: 'printing', 5: 'stopped' };
const PRINTER_STATE_TEXT = ['idle', 'printing', 'stopped'];

function encodeValue(tag, value) {
  if (tag === VAL_INTEGER || tag === VAL_ENUM) {
    const buffer = Buffer.alloc(4);
    buffer.writeInt32BE(Number(value) | 0, 0);
    return buffer;
  }
  if (tag === VAL_BOOLEAN) return Buffer.from([value ? 0x01 : 0x00]);
  if (Buffer.isBuffer(value)) return value;
  return Buffer.from(String(value), 'utf8');
}

/** @param {{tag:number, attributes:Array<{name:string, tag:number, value:any}>}[]} groups */
function encodeRequest(operationId, groups, document = null, requestId = 1) {
  const header = Buffer.alloc(8);
  header.writeUInt8(2, 0); // major
  header.writeUInt8(0, 1); // minor → IPP/2.0
  header.writeUInt16BE(operationId, 2);
  header.writeUInt32BE(requestId, 4);

  const parts = [];
  for (const group of groups) {
    parts.push(Buffer.from([group.tag]));
    for (const attribute of group.attributes) {
      const name = Buffer.from(attribute.name, 'utf8');
      const value = encodeValue(attribute.tag, attribute.value);
      const chunk = Buffer.alloc(3 + name.length + 2 + value.length);
      chunk.writeUInt8(attribute.tag, 0);
      chunk.writeUInt16BE(name.length, 1);
      name.copy(chunk, 3);
      chunk.writeUInt16BE(value.length, 3 + name.length);
      value.copy(chunk, 5 + name.length);
      parts.push(chunk);
    }
  }
  parts.push(Buffer.from([TAG_END]));
  if (document) parts.push(Buffer.isBuffer(document) ? document : Buffer.from(document, 'utf8'));
  return Buffer.concat([header, ...parts]);
}

/** 解析 IPP 响应，返回按属性名索引的扁平对象 */
function parseResponse(buffer) {
  if (buffer.length < 8 || buffer[0] !== 2) throw new Error('不是有效的 IPP 响应');
  const statusCode = buffer.readUInt16BE(2);
  const attributes = {};
  let offset = 8;
  let currentGroup = null;
  let lastName = null;

  while (offset < buffer.length) {
    const tag = buffer[offset];
    offset += 1;
    if (tag === TAG_END) break;
    if (tag <= 0x06) {
      currentGroup = tag;
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
    if (nameLength === 0) name = lastName; // 1setOf 的附加值
    if (!name) continue;
    lastName = name;
    const value = decodeValue(tag, raw);
    if (attributes[name] === undefined) attributes[name] = value;
    else if (Array.isArray(attributes[name])) attributes[name].push(value);
    else attributes[name] = [attributes[name], value];
    attributes[`__group_${name}`] = currentGroup;
  }
  return { statusCode, attributes };
}

function decodeValue(tag, raw) {
  switch (tag) {
    case VAL_INTEGER:
    case VAL_ENUM:
      return raw.length >= 4 ? raw.readInt32BE(0) : 0;
    case VAL_BOOLEAN:
      return raw.length ? raw[0] === 0x01 : false;
    case VAL_DATE:
      return raw.length >= 8 ? raw.readUInt16BE(0) : null;
    default:
      return raw.toString('utf8');
  }
}

class IppClient {
  constructor(options = {}) {
    this.host = options.host;
    this.port = options.port ?? 631;
    this.path = options.path ?? '/ipp/print';
    this.timeout = options.timeout ?? 2500;
    this.version = options.version ?? '2.0';
  }

  _post(body, operationId) {
    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          host: this.host,
          port: this.port,
          path: this.path,
          method: 'POST',
          headers: {
            'Content-Type': 'application/ipp',
            'Content-Length': Buffer.byteLength(body),
            'User-Agent': 'ForgeLink/1.0',
          },
          timeout: this.timeout,
        },
        (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => {
            const buffer = Buffer.concat(chunks);
            if (response.statusCode >= 400) {
              reject(new Error(`IPP HTTP ${response.statusCode}`));
              return;
            }
            try {
              resolve(parseResponse(buffer));
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      request.on('timeout', () => {
        request.destroy(new Error('IPP 请求超时'));
      });
      request.on('error', reject);
      request.end(body);
    });
  }

  _operationGroup(uri) {
    return {
      tag: TAG_OPERATION,
      attributes: [
        { name: 'attributes-charset', tag: VAL_CHARSET, value: 'utf-8' },
        { name: 'attributes-natural-language', tag: VAL_LANGUAGE, value: 'zh-cn' },
        { name: 'printer-uri', tag: VAL_URI, value: uri },
      ],
    };
  }

  get uri() {
    return `ipp://${this.host}:${this.port}${this.path}`;
  }

  async getPrinterAttributes(requested = []) {
    const groups = [this._operationGroup(this.uri)];
    if (requested.length) {
      groups.push({
        tag: TAG_OPERATION,
        attributes: requested.map((name) => ({ name: 'requested-attributes', tag: VAL_KEYWORD, value: name })),
      });
    }
    const body = encodeRequest(OP_GET_PRINTER_ATTRIBUTES, groups);
    const { statusCode, attributes } = await this._post(body, OP_GET_PRINTER_ATTRIBUTES);
    if (statusCode > 0x00ff) throw new Error(`IPP 状态码 0x${statusCode.toString(16)}`);
    return {
      statusCode,
      state: PRINTER_STATE_BY_ENUM[attributes['printer-state']] || 'unknown',
      stateCode: attributes['printer-state'] ?? null,
      stateMessage: attributes['printer-state-message'] || '',
      name: attributes['printer-name'] || null,
      info: attributes['printer-info'] || null,
      makeAndModel: attributes['printer-make-and-model'] || null,
      uriSupported: attributes['printer-uri-supported'] || null,
      uptime: attributes['printer-up-time'] ?? null,
      queuedJobCount: attributes['queued-job-count'] ?? null,
      isAcceptingJobs: attributes['printer-is-accepting-jobs'] ?? null,
      markerLevels: attributes['marker-levels'] ?? null,
      documentFormats: attributes['document-format-supported'] || null,
      raw: attributes,
    };
  }

  /** 提交打印作业：默认以 text/plain 直接投递 */
  async printJob(document, options = {}) {
    const { jobName = 'ForgeLink Job', documentFormat = 'text/plain' } = options;
    const groups = [
      this._operationGroup(this.uri),
      {
        tag: TAG_OPERATION,
        attributes: [
          { name: 'job-name', tag: VAL_NAME, value: jobName },
          { name: 'document-format', tag: VAL_MIME, value: documentFormat },
        ],
      },
    ];
    const body = encodeRequest(OP_PRINT_JOB, groups, document, 2);
    const { statusCode, attributes } = await this._post(body, OP_PRINT_JOB);
    return { statusCode, jobId: attributes['job-id'] ?? null, jobState: attributes['job-state'] ?? null, raw: attributes };
  }

  async getJobs() {
    const groups = [this._operationGroup(this.uri)];
    const body = encodeRequest(OP_GET_JOBS, groups, null, 3);
    try {
      const { attributes } = await this._post(body, OP_GET_JOBS);
      return { jobs: attributes['job-id'] ?? [], raw: attributes };
    } catch (error) {
      return { jobs: [], error: error.message };
    }
  }

  async cancelJob(jobId) {
    const groups = [
      this._operationGroup(this.uri),
      { tag: TAG_OPERATION, attributes: [{ name: 'job-id', tag: VAL_INTEGER, value: Number(jobId) }] },
    ];
    const body = encodeRequest(OP_CANCEL_JOB, groups, null, 4);
    const { statusCode } = await this._post(body, OP_CANCEL_JOB);
    return { statusCode };
  }
}

module.exports = {
  IppClient,
  encodeRequest,
  parseResponse,
  OP_GET_PRINTER_ATTRIBUTES,
  OP_PRINT_JOB,
  TAG_OPERATION,
  VAL_KEYWORD,
  VAL_URI,
  VAL_CHARSET,
  VAL_LANGUAGE,
  VAL_MIME,
  VAL_NAME,
  VAL_INTEGER,
  VAL_ENUM,
  VAL_BOOLEAN,
  VAL_TEXT,
  TAG_END,
  PRINTER_STATE_TEXT,
  PRINTER_STATE_BY_ENUM,
};
