// 极小的 JSON 状态存储：够用就好。
//
// 为什么不用 ctx.storage：那是 DSH 自己的领域存储，需要 domain / schema 注册，
// 跨版本容易漂移；插件自己的状态放自己的目录，坏了大不了重来一次。
// 写入走「临时文件 + rename」，避免半个 JSON 把提示词组装打挂。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** DSH 的主目录；没设 $DSH_HOME 时退回 ~/.dsh。 */
export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/**
 * 创建状态存储。
 * @param {object} options
 * @param {string} options.file 绝对路径
 * @param {(raw: unknown, now: number) => object} options.coerce 洗数据
 * @param {() => object} options.initial 首次启动的默认状态
 */
export function createStateStore({ file, coerce, initial }) {
  /** 读状态；文件不存在 / 坏掉都返回初始状态，绝不让调用方接住异常。 */
  function load(now = Date.now()) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      return coerce(JSON.parse(raw), now);
    } catch {
      return initial();
    }
  }

  /** 写状态；目录不存在就建，写失败静默（内存里的值仍然有效）。 */
  function save(state) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, file);
      return true;
    } catch {
      return false;
    }
  }

  return { file, load, save };
}
