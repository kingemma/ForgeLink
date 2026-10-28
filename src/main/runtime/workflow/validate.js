const { t } = require('../../i18n');

/**
 * 工作流静态校验（与执行引擎分离：一个负责「能不能跑」，一个负责「怎么跑」）。
 *
 * 第一性原理：图要是错的，跑起来只会得到一串 skipped，而且原因含糊。
 * 所以必须在按下「运行」之前就把问题定位到具体节点说清楚。
 *
 * @param {object} workflow
 * @param {{get:(id:string)=>object|null}|null} registry 用于核对设备是否还在
 * @returns {{ok:boolean, errors:object[], warnings:object[]}}
 */
function validateWorkflow(workflow, registry = null) {
  const errors = [];
  const warnings = [];
  const nodes = workflow?.nodes || [];
  const edges = workflow?.edges || [];

  if (!nodes.length) {
    errors.push({ code: 'empty', message: t('workflow.err.empty') });
    return { ok: false, errors, warnings };
  }

  const nodeMap = new Map(nodes.map((node) => [node.id, node]));

  const checkDevice = (node, deviceId) => {
    if (!deviceId) {
      errors.push({ nodeId: node.id, code: 'missingDevice', message: t('workflow.err.missingDevice') });
      return;
    }
    if (registry && !registry.get(deviceId)) {
      errors.push({ nodeId: node.id, code: 'deviceGone', message: t('workflow.err.deviceGone', { id: deviceId }) });
    }
  };

  for (const node of nodes) {
    const params = node.params || {};
    switch (node.type) {
      case 'device':
        checkDevice(node, params.deviceId);
        if (!params.action) errors.push({ nodeId: node.id, code: 'missingAction', message: t('workflow.err.missingAction') });
        break;
      case 'state':
        checkDevice(node, params.deviceId);
        break;
      case 'waitUntil':
        checkDevice(node, params.deviceId);
        if (!params.expression) errors.push({ nodeId: node.id, code: 'missingExpression', message: t('workflow.err.missingExpression') });
        break;
      case 'transform':
      case 'condition':
        if (!params.expression) errors.push({ nodeId: node.id, code: 'missingExpression', message: t('workflow.err.missingExpression') });
        break;
      default:
        break;
    }
  }

  // 边指向不存在的节点：跑的时候会静默丢边
  for (const edge of edges) {
    if (!nodeMap.has(edge.from) || !nodeMap.has(edge.to)) {
      errors.push({ code: 'danglingEdge', message: t('workflow.err.danglingEdge') });
      break;
    }
  }

  // 环检测：DAG 的基本约束
  if (hasCycle(nodes, edges)) errors.push({ code: 'cycle', message: t('workflow.err.cycle') });

  // 条件节点分出多条边却没标分支：两条都会跑，等于没有分支
  for (const node of nodes) {
    if (node.type !== 'condition') continue;
    const outgoing = edges.filter((edge) => edge.from === node.id);
    if (outgoing.length > 1 && !outgoing.some((edge) => edge.when)) {
      warnings.push({ nodeId: node.id, code: 'branchAmbiguous', message: t('workflow.warn.branchAmbiguous') });
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** 有向图环检测（白/灰/黑三色 DFS） */
function hasCycle(nodes, edges) {
  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  const known = new Set(nodes.map((node) => node.id));
  for (const edge of edges) {
    if (!known.has(edge.from) || !known.has(edge.to)) continue;
    outgoing.get(edge.from).push(edge.to);
  }
  const color = new Map(); // 1 = 访问中, 2 = 已完成
  const visit = (id) => {
    if (color.get(id) === 1) return true;
    if (color.get(id) === 2) return false;
    color.set(id, 1);
    for (const next of outgoing.get(id) || []) {
      if (visit(next)) return true;
    }
    color.set(id, 2);
    return false;
  };
  for (const node of nodes) {
    if (visit(node.id)) return true;
  }
  return false;
}

module.exports = { validateWorkflow, hasCycle };
