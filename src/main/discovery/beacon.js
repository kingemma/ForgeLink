const dgram = require('node:dgram');
const os = require('node:os');
const { localSubnets, ipToInt, intToIp } = require('./arp');

/**
 * ForgeLink 主动信标协议。
 *
 * mDNS/SSDP 覆盖的是「标准设备」，而机械臂、自研控制器这类设备通常只说自己的私有协议。
 * 为此定义一条极简 UDP 信标：广播一句 JSON 提问，支持该协议的设备回一句 JSON 自述
 * （名称、类型、厂商、开放接口清单）。这样即使设备不支持任何标准发现协议，
 * 也能被智能体识别——这是「万物可连接」的兜底通道。
 */
const BEACON_PORT = 47809;
const PROTOCOL = 'forgelink-beacon/1';

function broadcastAddresses() {
  const set = new Set(['255.255.255.255']);
  for (const subnet of localSubnets()) {
    const mask = ipToInt(subnet.netmask || '255.255.255.0');
    set.add(intToIp(((ipToInt(subnet.address) & mask) | (~mask >>> 0)) >>> 0));
  }
  return [...set];
}

function ownAddresses() {
  return localSubnets().map((s) => s.address);
}

/**
 * 广播提问并收集应答。
 * @param {{duration?: number}} options
 */
function probe(options = {}) {
  const { duration = 2000 } = options;
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const answers = new Map();
    let closed = false;

    const finish = () => {
      if (closed) return;
      closed = true;
      try {
        socket.close();
      } catch {
        /* 已关闭 */
      }
      resolve([...answers.values()]);
    };

    socket.on('message', (msg, rinfo) => {
      let payload;
      try {
        payload = JSON.parse(msg.toString('utf8'));
      } catch {
        return;
      }
      // 只接受 announce：自己发出的 discover 广播会被同一 socket 回环收到，靠类型过滤
      if (payload.protocol !== PROTOCOL || payload.type !== 'announce') return;
      // 同一主机可能同时宣告多个逻辑设备（机械臂 + 打印机），按名称区分
      const key = `${rinfo.address}:${payload.name || payload.kind || rinfo.port}`;
      answers.set(key, { ...payload, ip: rinfo.address, port: rinfo.port });
    });

    socket.on('error', () => finish());

    const question = Buffer.from(JSON.stringify({ protocol: PROTOCOL, type: 'discover', ts: Date.now() }), 'utf8');
    const send = () => {
      if (closed) return;
      for (const address of broadcastAddresses()) {
        try {
          socket.send(question, 0, question.length, BEACON_PORT, address);
        } catch {
          /* 忽略不可达的广播地址 */
        }
      }
    };

    // 主动探测用临时端口：设备上通常已占用 47809 常驻监听，
    // 若探询方也去抢同一个端口，应答可能投递到错误的 socket（Windows SO_REUSEADDR 行为）
    try {
      socket.bind(0, () => {
        socket.setBroadcast(true);
        send();
        setTimeout(send, 700);
      });
    } catch {
      finish();
    }
    setTimeout(finish, duration);
  });
}

/**
 * 被动监听：设备也可以周期性自述（无需等提问），这样新上电的设备会被自动捕获。
 * @param {(announce: object) => void} onAnnounce
 */
function listen(onAnnounce) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  socket.on('message', (msg, rinfo) => {
    let payload;
    try {
      payload = JSON.parse(msg.toString('utf8'));
    } catch {
      return;
    }
    if (payload.protocol !== PROTOCOL || payload.type !== 'announce') return;
    onAnnounce({ ...payload, ip: rinfo.address, port: rinfo.port });
  });
  socket.on('error', () => {});
  try {
    socket.bind({ port: BEACON_PORT, exclusive: false }, () => socket.setBroadcast(true));
  } catch {
    try {
      socket.bind(0);
    } catch {
      /* 放弃被动监听 */
    }
  }
  return () => {
    try {
      socket.close();
    } catch {
      /* 已关闭 */
    }
  };
}

module.exports = { probe, listen, BEACON_PORT, PROTOCOL };
