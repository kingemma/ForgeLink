const { TcpSession } = require('./tcp');

/**
 * 行式文本协议。
 *
 * 大量自研控制器、机械臂示教盒、串口服务器都采用「发一行命令、回一行结果」的私有协议。
 * 这是无法归类到标准协议时的通用底座：先抓 banner，再发探针命令看回什么。
 */

/** 常见提示符，用于判断对端是否处于交互式命令行 */
const PROMPT_PATTERN = /(ok|ready|idle|>|\$|\]|#)\s*$/i;

/** 常见自述命令，用于让设备自我介绍 */
const INTROSPECTION_COMMANDS = ['?\n', 'INFO\n', '*IDN?\n'];

async function banner(host, port, options = {}) {
  const { timeout = 1200, quiet = 250 } = options;
  return TcpSession.connect(host, port, timeout).then(async (session) => {
    try {
      const data = await session.readAvailable({ quiet, timeout });
      return { text: data.toString('utf8').trim(), length: data.length, banner: true };
    } finally {
      session.close();
    }
  });
}

/**
 * 主动问询：连接后依次尝试自述命令，返回第一条有意义的响应。
 * 这是「自动发现通信接口」的关键一步——协议未知时，先用通用问句试探。
 */
async function introspect(host, port, options = {}) {
  const { timeout = 1200, commands = INTROSPECTION_COMMANDS, prompt = /\r|\n|>|\]|:|#/ } = options;
  const session = await TcpSession.connect(host, port, timeout);
  try {
    const greeting = (await session.readAvailable({ quiet: 200, timeout: 400 })).toString('utf8').trim();
    for (const command of commands) {
      session.send(command);
      const response = (await session.readAvailable({ quiet: 200, timeout: 450 })).toString('utf8').trim();
      if (response && response !== greeting && prompt.test(response)) {
        return { greeting, command: command.trim(), response, promptLike: PROMPT_PATTERN.test(response) };
      }
    }
    return greeting ? { greeting, command: null, response: null, promptLike: PROMPT_PATTERN.test(greeting) } : null;
  } finally {
    session.close();
  }
}

class LineClient {
  constructor(session) {
    this.session = session;
  }

  static connect(host, port, options = {}) {
    return TcpSession.connect(host, port, options.timeout ?? 2000).then((session) => new LineClient(session));
  }

  /**
   * 发送命令并等待响应。
   * @param {string} command 不含换行的命令
   * @param {{terminator?: string, timeout?: number, quiet?: number}} options
   */
  async command(command, options = {}) {
    const { terminator = '\n', timeout = 2500, quiet = 200 } = options;
    this.session.send(command.endsWith(terminator) ? command : command + terminator);
    const response = (await this.session.readAvailable({ quiet, timeout })).toString('utf8').trim();
    return response;
  }

  close() {
    this.session.close();
  }
}

module.exports = { banner, introspect, LineClient, INTROSPECTION_COMMANDS };
