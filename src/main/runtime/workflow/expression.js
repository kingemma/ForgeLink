/**
 * 数据流表达式 —— 工作流里「上一个设备的输出如何变成下一个设备的输入」。
 *
 * 语法（刻意做得极小，不做任意 JS 求值，避免把设备网络变成 RCE 面）：
 *   {{ nodes.<节点ID>.<路径> }}   引用上游节点输出，如 {{ nodes.pick.result.jobId }}
 *   {{ input.<路径> }}            引用本节点的合并输入
 *   {{ device.<路径> }}           引用设备档案
 *   {{ now }}                     当前时间戳
 *   {{ round(x, 2) }} {{ join(a) }} {{ len(a) }} {{ json(x) }}  内置函数
 * 若整个模板只是一个占位符，则返回原始类型（数字/数组/对象），否则做字符串插值。
 */
const PLACEHOLDER = /\{\{([^}]+)\}\}/g;

const FUNCTIONS = {
  round: (value, digits = 0) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Number(numeric.toFixed(Number(digits) || 0)) : value;
  },
  join: (list, separator = ',') => (Array.isArray(list) ? list.join(separator) : String(list ?? '')),
  len: (value) => (Array.isArray(value) ? value.length : String(value ?? '').length),
  upper: (value) => String(value ?? '').toUpperCase(),
  lower: (value) => String(value ?? '').toLowerCase(),
  json: (value) => JSON.stringify(value),
  num: (value) => (Number.isFinite(Number(value)) ? Number(value) : 0),
  default: (value, fallback) => (value === undefined || value === null || value === '' ? fallback : value),
  sum: (...values) => values.reduce((acc, value) => acc + (Number(value) || 0), 0),
};

function resolvePath(context, path) {
  const parts = String(path)
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  let value = context;
  for (const part of parts) {
    if (value === null || value === undefined) return undefined;
    value = value[part];
  }
  return value;
}

function parseLiteral(token) {
  const trimmed = token.trim();
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true';
  if (/^(null|undefined)$/i.test(trimmed)) return null;
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1);
  }
  return undefined;
}

/** 安全的函数调用解析：函数名必须在白名单内，参数只能是路径或字面量 */
function evaluateExpression(expression, context) {
  const trimmed = String(expression).trim();
  const literal = parseLiteral(trimmed);
  if (literal !== undefined) return literal;

  const call = trimmed.match(/^([A-Za-z_]\w*)\s*\((.*)\)$/);
  if (call) {
    const name = call[1];
    const args = splitArgs(call[2]).map((arg) => {
      const argLiteral = parseLiteral(arg);
      return argLiteral !== undefined ? argLiteral : resolvePath(context, arg);
    });
    const fn = FUNCTIONS[name];
    if (!fn) throw new Error(`未知函数：${name}`);
    return fn(...args);
  }
  return resolvePath(context, trimmed);
}

function splitArgs(text) {
  const args = [];
  let depth = 0;
  let current = '';
  let quote = null;
  for (const char of text) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      args.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) args.push(current);
  return args.map((arg) => arg.trim()).filter((arg) => arg.length);
}

function stringify(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** 递归解析参数中的占位符：字符串插值，对象/数组逐项解析 */
function resolveTemplate(template, context) {
  if (template === null || template === undefined) return template;
  if (Array.isArray(template)) return template.map((item) => resolveTemplate(item, context));
  if (typeof template !== 'string') {
    if (typeof template === 'object') {
      const out = {};
      for (const [key, value] of Object.entries(template)) out[key] = resolveTemplate(value, context);
      return out;
    }
    return template;
  }
  if (!/\{\{/.test(template)) return template;
  const single = template.match(/^\s*\{\{([^}]+)\}\}\s*$/);
  if (single) return evaluateExpression(single[1], context);
  return template.replace(PLACEHOLDER, (_, expression) => stringify(evaluateExpression(expression, context)));
}

module.exports = { resolveTemplate, evaluateExpression, resolvePath, FUNCTIONS };
