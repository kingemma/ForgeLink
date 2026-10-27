const { IppClient } = require('./ipp');
const { ModbusClient } = require('./modbus');
const { SnmpClient } = require('./snmp');
const { get } = require('./http');
const { WebSocketClient } = require('./websocket');
const { banner, introspect } = require('./raw');
const { TcpSession } = require('./tcp');
const { hintsFor } = require('../discovery/fingerprints');

/**
 * 协议自动识别（第二层的核心）。
 *
 * 第一性原理：一个开放端口只是「有人应答」，要说得上话必须先确定语言。
 * 判定不能靠端口猜测——必须让对端真的回一句。
 * 因此每条探针都遵循同一契约：发一个该协议的最小合法请求，
 * 能解析出语义正确（而不只是「有字节」）的响应，才算识别成功，并给出置信度。
 *
 * 策略：端口先验决定探针顺序（省时间），实际响应决定结论（保证正确），
 * 多条证据叠加时取置信度最高者。
 */
const DEFAULT_TIMEOUT = 1000;

async function probeHttp(host, port, timeout = DEFAULT_TIMEOUT) {
  const response = await get(host, port, '/', { timeout });
  const server = response.headers.server || response.headers.Server || '';
  const contentType = response.headers['content-type'] || '';
  return {
    protocol: port === 443 ? 'https' : 'http',
    transport: 'tcp',
    confidence: 0.7,
    evidence: { status: response.status, server, contentType, title: extractTitle(response.text) },
    details: { server, contentType },
  };
}

async function probeIpp(host, port, timeout = DEFAULT_TIMEOUT) {
  const paths = port === 631 ? ['/ipp/print', '/', '/ipp/system'] : ['/ipp/print', '/'];
  let lastError = null;
  for (const path of paths) {
    try {
      const client = new IppClient({ host, port, path, timeout });
      const info = await client.getPrinterAttributes();
      if (!info.makeAndModel && !info.state && !info.name) continue;
      return {
        protocol: 'ipp',
        transport: 'tcp',
        confidence: 0.95,
        evidence: { path, state: info.state, makeAndModel: info.makeAndModel, statusCode: info.statusCode },
        details: info,
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('IPP 探测失败');
}

async function probeModbus(host, port, timeout = DEFAULT_TIMEOUT) {
  const client = await ModbusClient.connect(host, port, { timeout, connectTimeout: timeout });
  try {
    const registers = await client.readHoldingRegisters(0, 4);
    return {
      protocol: 'modbus-tcp',
      transport: 'tcp',
      confidence: 0.95,
      evidence: { registers },
      details: { registers },
    };
  } finally {
    client.close();
  }
}

async function probeSnmp(host, port = 161, timeout = DEFAULT_TIMEOUT) {
  const client = new SnmpClient({ host, port, timeout, community: 'public' });
  const info = await client.sysDescr();
  if (!info.description && !info.name) throw new Error('SNMP 无有效响应');
  return {
    protocol: 'snmp',
    transport: 'udp',
    confidence: 0.92,
    evidence: { description: info.description, name: info.name },
    details: info,
  };
}

async function probeWebSocket(host, port, timeout = DEFAULT_TIMEOUT) {
  const client = await WebSocketClient.connect(`ws://${host}:${port}/`, { timeout });
  client.close();
  return {
    protocol: 'websocket',
    transport: 'tcp',
    confidence: 0.8,
    evidence: { handshake: '101 Switching Protocols' },
    details: {},
  };
}

/** JetDirect / RAW 打印端口（9100）：只建立连接并抓 banner，绝不投递数据，避免误打印 */
async function probeJetDirect(host, port, timeout = DEFAULT_TIMEOUT) {
  const session = await TcpSession.connect(host, port, timeout);
  try {
    const data = (await session.readAvailable({ quiet: 220, timeout: 600 })).toString('utf8').trim();
    const looksLikePrinter = /pjl|printer|print|ready|idle|hp|epson|canon|brother/i.test(data);
    return {
      protocol: 'jetdirect',
      transport: 'tcp',
      confidence: looksLikePrinter ? 0.92 : 0.75,
      evidence: { banner: data.slice(0, 200), port },
      details: { banner: data },
    };
  } finally {
    session.close();
  }
}

async function probeRawText(host, port, timeout = DEFAULT_TIMEOUT) {
  const info = await introspect(host, port, { timeout });
  if (info?.response || info?.greeting) {
    return {
      protocol: 'raw-text',
      transport: 'tcp',
      confidence: info.response ? 0.7 : 0.55,
      evidence: { greeting: info.greeting, command: info.command, response: info.response },
      details: info,
    };
  }
  const data = await banner(host, port, { timeout });
  if (data.length) {
    return {
      protocol: 'raw-text',
      transport: 'tcp',
      confidence: 0.5,
      evidence: { banner: data.text.slice(0, 200) },
      details: data,
    };
  }
  return null;
}

const PROBE_BY_PROTOCOL = {
  http: probeHttp,
  https: probeHttp,
  ipp: probeIpp,
  'modbus-tcp': probeModbus,
  snmp: probeSnmp,
  websocket: probeWebSocket,
  jetdirect: probeJetDirect,
  'raw-text': probeRawText,
  mqtt: probeRawText,
};

function extractTitle(html) {
  const match = String(html || '').match(/<title[^>]*>([\s\S]{0,120}?)<\/title>/i);
  return match ? match[1].trim() : null;
}

/**
 * 对一个开放端口做协议识别。
 * @returns {Promise<{protocol:string, transport:string, confidence:number, evidence:object, matches:object[]}|null>}
 */
async function detect(host, port, options = {}) {
  const { hints, timeout = DEFAULT_TIMEOUT, enableWebSocket = true, allowFallback = true } = options;
  const priors = (hints && hints.length ? hints : hintsFor(port)).slice().sort((a, b) => b.weight - a.weight);
  const matches = [];
  const attempted = new Set();

  const run = async (name, fn) => {
    if (attempted.has(name)) return;
    attempted.add(name);
    try {
      const result = await fn();
      if (result) matches.push(result);
    } catch {
      /* 探针失败即代表不是该协议 */
    }
  };

  for (const prior of priors) {
    if (prior.weight < 0.5) continue;
    const probe = PROBE_BY_PROTOCOL[prior.protocol];
    if (probe) await run(prior.protocol, () => probe(host, port, timeout));
    if (matches.some((match) => match.confidence >= 0.9)) break;
  }

  // HTTP 通了还要确认是不是打印服务：IPP 是打印机的主控协议，价值远高于普通网页
  if (matches.some((match) => match.protocol === 'http' || match.protocol === 'https')) {
    await run('ipp', () => probeIpp(host, port, timeout));
    if (enableWebSocket) await run('websocket', () => probeWebSocket(host, port, timeout));
  }

  // 端口没有可用先验（或先验全部落空）时，按「代价低、结论明确」的顺序兜底试探
  const frontRunner = matches[0];
  if (allowFallback && (!matches.length || (frontRunner && frontRunner.confidence < 0.5))) {
    const chain = ['modbus-tcp', 'ipp', ...(port >= 9100 && port <= 9110 ? ['jetdirect'] : []), 'http', 'raw-text'];
    for (const name of chain) {
      if (matches.some((match) => match.confidence >= 0.6)) break;
      const probe = PROBE_BY_PROTOCOL[name];
      if (probe) await run(name, () => probe(host, port, timeout));
    }
  }

  if (!matches.length) {
    return {
      protocol: 'unknown',
      transport: 'tcp',
      confidence: 0.2,
      evidence: { note: '端口开放但无任何协议响应' },
      matches: [],
    };
  }

  matches.sort((a, b) => b.confidence - a.confidence);
  const best = matches[0];
  return { ...best, matches };
}

module.exports = {
  detect,
  probeHttp,
  probeIpp,
  probeModbus,
  probeSnmp,
  probeWebSocket,
  probeJetDirect,
  probeRawText,
};
