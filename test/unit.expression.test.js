const test = require('node:test');
const assert = require('node:assert');
const { resolveTemplate, evaluateExpression, resolvePath } = require('../src/main/runtime/workflow/expression');

test('表达式：路径解析与字面量', () => {
  assert.strictEqual(resolvePath({ a: { b: 1 } }, 'a.b'), 1);
  assert.strictEqual(resolvePath({ list: [1, 2, 3] }, 'list[1]'), 2);
  assert.strictEqual(resolvePath({ a: 1 }, 'a.b.c'), undefined, '缺失路径应返回 undefined 而不是抛错');
  assert.strictEqual(evaluateExpression('true', {}), true);
  assert.strictEqual(evaluateExpression('123', {}), 123);
  assert.strictEqual(evaluateExpression("'abc'", {}), 'abc');
});

test('表达式：单个占位符返回原始类型，混合时做字符串插值', () => {
  const context = { nodes: { n1: { output: { ok: true, count: 3 } } } };
  assert.strictEqual(resolveTemplate('{{ nodes.n1.output.ok }}', context), true);
  assert.strictEqual(resolveTemplate('{{ nodes.n1.output.count }}', context), 3);
  assert.strictEqual(resolveTemplate('共 {{ nodes.n1.output.count }} 台', context), '共 3 台');
  assert.strictEqual(resolveTemplate('无占位符', context), '无占位符');
});

test('表达式：内置函数白名单', () => {
  assert.strictEqual(resolveTemplate('{{ round(3.14159, 2) }}', {}), 3.14);
  assert.strictEqual(resolveTemplate('{{ join(input) }}', { input: ['a', 'b'] }), 'a,b');
  assert.strictEqual(resolveTemplate('{{ len(input) }}', { input: [1, 2, 3] }), 3);
  assert.strictEqual(resolveTemplate('{{ upper(a) }}', { a: 'ab' }), 'AB');
  assert.strictEqual(resolveTemplate('{{ lower(a) }}', { a: 'AB' }), 'ab');
  assert.strictEqual(resolveTemplate('{{ sum(1, 2, 3) }}', {}), 6);
  assert.strictEqual(resolveTemplate('{{ num("12") }}', {}), 12);
  assert.strictEqual(resolveTemplate('{{ default(a, "fallback") }}', { a: '' }), 'fallback');
});

test('表达式：比较函数 eq/ne/gt/gte/lt/lte（交接条件依赖）', () => {
  const context = { state: { metrics: { status: 'idle', digitalOut: 1, load: 120 } } };
  assert.strictEqual(resolveTemplate("{{ eq(state.metrics.status, 'idle') }}", context), true);
  assert.strictEqual(resolveTemplate("{{ ne(state.metrics.status, 'idle') }}", context), false);
  assert.strictEqual(resolveTemplate('{{ eq(state.metrics.digitalOut, 1) }}', context), true);
  assert.strictEqual(resolveTemplate('{{ gt(state.metrics.load, 100) }}', context), true);
  assert.strictEqual(resolveTemplate('{{ gte(state.metrics.load, 120) }}', context), true);
  assert.strictEqual(resolveTemplate('{{ lt(state.metrics.load, 200) }}', context), true);
  assert.strictEqual(resolveTemplate('{{ lte(state.metrics.load, 100) }}', context), false);
});

test('表达式：未知函数必须报错（不允许任意 JS 求值）', () => {
  assert.throws(() => resolveTemplate('{{ evil(1) }}', {}), /未知函数/);
  assert.throws(() => resolveTemplate('{{ process() }}', {}), /未知函数/);
  // 属性访问走安全路径解析，取不到就是 undefined，不会执行任何代码
  assert.strictEqual(resolveTemplate('{{ process.exit }}', {}), undefined);
});
