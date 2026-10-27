const { RobotArmDriver } = require('./robot-arm');
const { PrinterDriver } = require('./printer');
const { GenericDriver } = require('./generic');

/**
 * 驱动注册表。
 *
 * 识别的最后一公里：把「协议事实」映射到「谁能驱动它」。
 * 判定方式是每个驱动自报适配度（fitness），取最高者；
 * GenericDriver 永远返回最低分，保证任何设备都能被接入而不是被丢弃。
 */
const DRIVERS = [RobotArmDriver, PrinterDriver, GenericDriver];

/** 设备档案 → 供驱动打分的完整事实集 */
function buildFacts(device) {
  return {
    ip: device.ip,
    name: device.name,
    vendor: device.vendor,
    model: device.model,
    hostnames: device.hostnames || [],
    tags: device.tags || [],
    interfaces: device.interfaces || [],
    beacons: device.facts?.beacons || [],
    mdns: device.facts?.mdns || [],
    ssdp: device.facts?.ssdp || [],
  };
}

function selectDriver(facts) {
  let best = null;
  for (const DriverClass of DRIVERS) {
    let score = 0;
    try {
      score = DriverClass.fitness(facts);
    } catch {
      score = 0;
    }
    if (!best || score > best.fitness) best = { DriverClass, fitness: score };
  }
  return best;
}

/** 为设备创建驱动实例；适配度低于阈值时仍返回 generic，保证可用 */
function createDriver(device, context = {}) {
  const facts = buildFacts(device);
  const selected = selectDriver(facts) || { DriverClass: GenericDriver, fitness: 0 };
  const DriverClass = selected.fitness > 0.05 ? selected.DriverClass : GenericDriver;
  const driver = new DriverClass(device, context);
  return {
    driver,
    fitness: selected.fitness,
    driverId: DriverClass.driverId,
    kind: DriverClass.kind,
    label: DriverClass.label,
  };
}

function listDrivers() {
  return DRIVERS.map((DriverClass) => ({
    driverId: DriverClass.driverId,
    label: DriverClass.label,
    kind: DriverClass.kind,
    protocols: DriverClass.protocols,
    actions: DriverClass.actions,
    stateFields: DriverClass.stateFields,
  }));
}

module.exports = { DRIVERS, buildFacts, selectDriver, createDriver, listDrivers };
