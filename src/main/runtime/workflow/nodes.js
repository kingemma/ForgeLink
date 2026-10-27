/**
 * 工作流节点类型定义（同时驱动执行引擎与 UI 表单）。
 *
 * 节点是「一次能力调用」的最小单元。刻意保持类型数量极少，
 * 因为真实的多设备协同任务 = 若干设备动作 + 少量数据变换 + 条件分支，
 * 更多的节点类型只会增加认知负担。
 */
const NODE_TYPES = {
  device: {
    id: 'device',
    label: '设备动作',
    icon: '⚙',
    description: '调用一台设备的能力（控制或读取）',
    fields: [
      { name: 'deviceId', label: '设备', type: 'device', required: true },
      { name: 'action', label: '动作', type: 'action', required: true },
      { name: 'params', label: '参数', type: 'params', default: {} },
    ],
  },
  state: {
    id: 'state',
    label: '读取状态',
    icon: '📊',
    description: '读取设备当前运行状态，作为后续节点输入',
    fields: [{ name: 'deviceId', label: '设备', type: 'device', required: true }],
  },
  transform: {
    id: 'transform',
    label: '数据变换',
    icon: '🔀',
    description: '把上游输出加工成下游需要的形状',
    fields: [{ name: 'expression', label: '表达式', type: 'expression', required: true, default: '{{ input }}' }],
  },
  condition: {
    id: 'condition',
    label: '条件分支',
    icon: '🔀',
    description: '按表达式真值选择下游分支',
    fields: [{ name: 'expression', label: '条件表达式', type: 'expression', required: true, default: '{{ input.ok }}' }],
  },
  delay: {
    id: 'delay',
    label: '等待',
    icon: '⏱',
    description: '等待一段时间，用于等待设备动作完成',
    fields: [{ name: 'ms', label: '毫秒', type: 'number', default: 1000 }],
  },
  notify: {
    id: 'notify',
    label: '通知/日志',
    icon: '📣',
    description: '把中间结果写入运行日志，便于观察数据流',
    fields: [{ name: 'message', label: '消息模板', type: 'expression', default: '{{ input }}' }],
  },
};

function nodeTypeList() {
  return Object.values(NODE_TYPES);
}

function defaultNode(type, id) {
  const definition = NODE_TYPES[type] || NODE_TYPES.notify;
  const node = { id, type, label: definition.label, params: {} };
  for (const field of definition.fields) {
    if (field.default !== undefined) node.params[field.name] = field.default;
  }
  return node;
}

module.exports = { NODE_TYPES, nodeTypeList, defaultNode };
