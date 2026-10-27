const { SimulatorCluster } = require('./index');

/** 独立运行模拟器：`npm run sim`，便于不开桌面端也能联调协议层 */
const cluster = new SimulatorCluster();
cluster.start();

console.log('ForgeLink 设备模拟器已启动');
for (const device of cluster.manifest) {
  console.log(`  · ${device.name} [${device.kind}]`);
  for (const itf of device.interfaces) console.log(`      ${itf.protocol} → ${itf.port} (${itf.transport})`);
}
console.log('\n按 Ctrl+C 停止');

const shutdown = () => {
  cluster.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
