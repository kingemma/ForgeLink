const fs = require('node:fs');
const path = require('node:path');

/**
 * 极简 JSON 持久化。
 *
 * 设备档案、工作流、偏好设置需要跨进程重启保留，但量级很小（KB 级），
 * 用单个 JSON 文件 + 防抖落盘即可，不引入数据库依赖。
 */
class Store {
  constructor(filePath, defaults = {}) {
    this.filePath = filePath;
    this.data = { ...defaults };
    this._dirty = false;
    this._timer = null;
    this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      Object.assign(this.data, JSON.parse(raw));
    } catch {
      // 首次启动或文件损坏：使用默认值并在下次写入时重建
    }
  }

  get(key, fallback) {
    const value = this.data[key];
    return value === undefined ? fallback : value;
  }

  set(key, value) {
    this.data[key] = value;
    this._schedule();
    return value;
  }

  update(key, updater, fallback) {
    const next = updater(this.get(key, fallback));
    return this.set(key, next);
  }

  flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
      this._dirty = false;
    } catch (error) {
      console.error('[store] 持久化失败', error.message);
    }
  }

  _schedule() {
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => this.flush(), 400);
  }
}

module.exports = { Store };
