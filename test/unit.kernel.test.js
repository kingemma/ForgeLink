const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/main/kernel/store');
const bus = require('../src/main/kernel/bus');
const i18nKernel = require('../src/main/i18n');

test('Store：默认值、更新与重新读回', () => {
  const file = path.join(os.tmpdir(), `forgelink-store-${Date.now()}.json`);
  const store = new Store(file, { devices: [], settings: { a: 1 } });
  assert.deepStrictEqual(store.get('devices', []), []);
  assert.strictEqual(store.get('missing', 'fallback'), 'fallback');

  store.update('devices', (list) => [...list, { id: 'd1' }], []);
  store.flush();
  assert.ok(fs.existsSync(file), '应落盘');

  const reopened = new Store(file, {});
  assert.strictEqual(reopened.get('devices', []).length, 1);
  fs.unlinkSync(file);
});

test('事件总线：日志带级别与自增序号', () => {
  const seen = [];
  const handler = (entry) => seen.push(entry);
  bus.on('log', handler);
  bus.info('unit-test', 'hello');
  bus.error('unit-test', 'boom');
  bus.off('log', handler);
  assert.strictEqual(seen.length, 2);
  assert.strictEqual(seen[0].level, 'info');
  assert.strictEqual(seen[1].level, 'error');
  assert.ok(seen[1].id > seen[0].id, '序号应递增');
});

test('内核 i18n：插值、缺失键回退、语言切换', () => {
  assert.strictEqual(i18nKernel.setLocale('zh'), 'zh');
  assert.ok(i18nKernel.t('discovery.arp').includes('ARP'));
  assert.strictEqual(i18nKernel.t('not.a.real.key'), 'not.a.real.key', '缺失键应回退为键名');

  assert.strictEqual(i18nKernel.setLocale('en'), 'en');
  assert.ok(i18nKernel.t('discovery.arp').toLowerCase().includes('arp'));

  assert.strictEqual(i18nKernel.setLocale('klingon'), 'en', '未知语言应保持当前语言');
  i18nKernel.setLocale('zh');
});

test('内核 i18n：参数插值', () => {
  i18nKernel.setLocale('zh');
  assert.strictEqual(i18nKernel.t('discovery.done', { n: 7 }), '发现完成：7 个设备');
  assert.strictEqual(i18nKernel.t('workflow.err.deviceGone', { id: 'dev_1' }), '设备不存在：dev_1');
  i18nKernel.setLocale('en');
  assert.strictEqual(i18nKernel.t('discovery.done', { n: 7 }), 'Discovery complete: 7 devices');
  i18nKernel.setLocale('zh');
});
