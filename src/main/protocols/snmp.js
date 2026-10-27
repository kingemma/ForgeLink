const dgram = require('node:dgram');

/**
 * SNMP v1/v2c 客户端（BER 编码，RFC 1157/1905）。
 *
 * 网络设备与网络打印机的状态（纸量、碳粉、计数器、故障码）几乎都通过 SNMP 暴露。
 * v2c 的 GetRequest 报文结构：
 *   SEQUENCE { INTEGER version, OCTET STRING community, [A0] GetRequest PDU }
 *   PDU { INTEGER request-id, INTEGER error-status, INTEGER error-index, SEQUENCE OF VarBind }
 *   VarBind { SEQUENCE { OID, NULL } }
 * 每个 TLV 的长度字段支持短形式（<128）与长形式（首字节高位置 1 + 后续字节数）。
 */
const PDU_GET_REQUEST = 0xa0;
const PDU_GET_RESPONSE = 0xa2;

function encodeLength(length) {
  if (length < 0x80) return Buffer.from([length]);
  const bytes = [];
  let value = length;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function encodeTLV(tag, value) {
  return Buffer.concat([Buffer.from([tag]), encodeLength(value.length), value]);
}

function encodeInteger(value) {
  const n = BigInt(value);
  if (n >= -128n && n < 128n) return encodeTLV(0x02, Buffer.from([Number(n) & 0xff]));
  const bytes = [];
  let rest = n < 0n ? -n - 1n : n;
  while (rest > 0n) {
    bytes.unshift(Number(rest & 0xffn));
    rest >>= 8n;
  }
  if (n < 0n) bytes[0] ^= 0xff;
  else if (bytes[0] & 0x80) bytes.unshift(0x00);
  return encodeTLV(0x02, Buffer.from(bytes.length ? bytes : [0]));
}

function encodeOid(oid) {
  const arcs = String(oid)
    .split('.')
    .filter(Boolean)
    .map((part) => BigInt(part));
  const bytes = [];
  const first = arcs[0] * 40n + arcs[1];
  bytes.push(...encodeBase128(first));
  for (const arc of arcs.slice(2)) bytes.push(...encodeBase128(arc));
  return encodeTLV(0x06, Buffer.from(bytes));
}

function encodeBase128(value) {
  if (value === 0n) return [0];
  const out = [];
  let rest = value;
  while (rest > 0n) {
    out.unshift(Number(rest & 0x7fn) | 0x80);
    rest >>= 7n;
  }
  out[out.length - 1] &= 0x7f;
  return out;
}

function parseTLV(buffer, offset = 0) {
  if (offset + 2 > buffer.length) throw new Error('SNMP 报文过短');
  const tag = buffer[offset];
  let position = offset + 1;
  let length = buffer[position];
  position += 1;
  if (length & 0x80) {
    const count = length & 0x7f;
    length = 0;
    for (let i = 0; i < count; i += 1) {
      length = (length << 8) | buffer[position];
      position += 1;
    }
  }
  const start = position;
  return { tag, length, value: buffer.subarray(start, start + length), start, end: start + length };
}

function decodeOid(buffer) {
  const arcs = [];
  let value = 0n;
  let first = true;
  for (const byte of buffer) {
    value = (value << 7n) | BigInt(byte & 0x7f);
    if (byte & 0x80) continue;
    if (first) {
      const numeric = Number(value);
      arcs.push(Math.floor(numeric / 40), numeric % 40);
      first = false;
    } else {
      arcs.push(Number(value));
    }
    value = 0n;
  }
  return arcs.join('.');
}

function decodeInteger(buffer) {
  if (!buffer.length) return 0;
  const negative = buffer[0] & 0x80;
  let value = 0n;
  for (const byte of buffer) value = (value << 8n) | BigInt(byte);
  if (negative) value = value - (1n << BigInt(buffer.length * 8));
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) ? numeric : value.toString();
}

function decodeValue(tag, buffer) {
  switch (tag) {
    case 0x02:
      return { type: 'integer', value: decodeInteger(buffer) };
    case 0x04:
      return { type: 'string', value: buffer.toString('utf8').replace(/\0+$/, '') };
    case 0x05:
      return { type: 'null', value: null };
    case 0x06:
      return { type: 'oid', value: decodeOid(buffer) };
    case 0x41: // Counter32
    case 0x42: // Gauge32
    case 0x43: // TimeTicks
      return { type: 'counter', value: buffer.length ? buffer.readUInt32BE(0) : 0 };
    case 0x46: // Counter64
      return { type: 'counter64', value: buffer.length >= 8 ? Number(buffer.readBigUInt64BE(0)) : 0 };
    case 0x80: // noSuchObject
    case 0x81: // noSuchInstance
    case 0x82: // endOfMibView
      return { type: 'none', value: null };
    default:
      return { type: `0x${tag.toString(16)}`, value: buffer.toString('hex') };
  }
}

function buildGetRequest(oids, community, requestId) {
  const varbinds = Buffer.concat(
    oids.map((oid) => encodeTLV(0x30, Buffer.concat([encodeOid(oid), encodeTLV(0x05, Buffer.alloc(0))]))),
  );
  const pdu = Buffer.concat([
    encodeInteger(requestId),
    encodeInteger(0), // error-status
    encodeInteger(0), // error-index
    encodeTLV(0x30, varbinds),
  ]);
  const message = Buffer.concat([
    encodeInteger(1), // version: v2c
    encodeTLV(0x04, Buffer.from(community, 'utf8')),
    encodeTLV(PDU_GET_REQUEST, pdu),
  ]);
  return encodeTLV(0x30, message);
}

function parseResponse(buffer) {
  const outer = parseTLV(buffer, 0);
  let position = outer.start;
  parseTLV(buffer, position); // version
  position = parseTLV(buffer, position).end;
  const community = parseTLV(buffer, position);
  position = community.end;
  const pdu = parseTLV(buffer, position);
  if ((pdu.tag & 0xdf) !== (PDU_GET_RESPONSE & 0xdf)) throw new Error('不是 GetResponse PDU');

  let cursor = pdu.start;
  const requestId = parseTLV(buffer, cursor);
  cursor = requestId.end;
  const errorStatus = parseTLV(buffer, cursor);
  cursor = errorStatus.end;
  const errorIndex = parseTLV(buffer, cursor);
  cursor = errorIndex.end;
  const varbindList = parseTLV(buffer, cursor);

  const results = {};
  let vbCursor = varbindList.start;
  while (vbCursor + 2 <= varbindList.end) {
    const varbind = parseTLV(buffer, vbCursor);
    vbCursor = varbind.end;
    const oid = parseTLV(buffer, varbind.start);
    const value = parseTLV(buffer, oid.end);
    results[decodeOid(oid.value)] = decodeValue(value.tag, value.value);
  }
  return { requestId: decodeInteger(requestId.value), errorStatus: decodeInteger(errorStatus.value), results };
}

class SnmpClient {
  constructor(options = {}) {
    this.host = options.host;
    this.port = options.port ?? 161;
    this.community = options.community ?? 'public';
    this.timeout = options.timeout ?? 2000;
    this._requestId = Math.floor(Math.random() * 65535);
  }

  /** @param {string[]} oids @returns {Promise<Record<string, {type:string, value:any}>>} */
  async get(oids, retries = 1) {
    const requestId = (this._requestId = (this._requestId + 1) & 0x7fffffff);
    const packet = buildGetRequest(oids, this.community, requestId);
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const response = await this._roundTrip(packet, requestId);
      if (response) return response.results;
    }
    throw new Error('SNMP 无响应');
  }

  _roundTrip(packet, requestId) {
    return new Promise((resolve) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        try {
          socket.close();
        } catch {
          /* 已关闭 */
        }
        resolve(value);
      };
      socket.on('message', (message) => {
        try {
          const parsed = parseResponse(message);
          if (parsed.requestId === requestId) done(parsed);
        } catch {
          /* 非本请求的报文，忽略 */
        }
      });
      socket.on('error', () => done(null));
      socket.bind(0, () => {
        socket.send(packet, 0, packet.length, this.port, this.host, (error) => {
          if (error) done(null);
        });
      });
      setTimeout(() => done(null), this.timeout);
    });
  }

  async sysDescr() {
    const results = await this.get(['1.3.6.1.2.1.1.1.0', '1.3.6.1.2.1.1.5.0', '1.3.6.1.2.1.1.2.0']);
    return {
      description: results['1.3.6.1.2.1.1.1.0']?.value ?? null,
      name: results['1.3.6.1.2.1.1.5.0']?.value ?? null,
      objectId: results['1.3.6.1.2.1.1.2.0']?.value ?? null,
    };
  }
}

module.exports = {
  SnmpClient,
  buildGetRequest,
  parseResponse,
  encodeOid,
  decodeOid,
  parseTLV,
  encodeTLV,
  encodeInteger,
  decodeInteger,
  decodeValue,
  PDU_GET_REQUEST,
  PDU_GET_RESPONSE,
};
