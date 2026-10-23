// dsh-feiyu-mood 的装配层：注册一条动态提示词上下文 + 一个工具。
//
// 这里刻意只碰三个 DSH 面：
//   ctx.systemPrompt.context(...)  动态运行时事实，每次组装重读
//   ctx.tools.register(...)        原生工具（手写 ToolDefinition，不依赖 defineTool）
//   ctx.effect(...)                交给 Cordis 管生命周期，卸载时自动清理
// 不 import 任何 @deepseek-ai/*：插件就落在 ~/.dsh/plugins 下，少一层解析风险。

import path from 'node:path';
import { createStateStore, dshHome } from './state-store.mjs';
import {
  EVENT_NAMES,
  applyEvent,
  coerceState,
  createInitialState,
  decay,
  describe,
  normalizeConfig,
  resetMood,
  setMood,
  summary,
} from './mood-engine.mjs';

export const name = 'dsh-feiyu-mood';
export const inject = ['systemPrompt', 'tools'];

/** 注册的提示词上下文名（全局唯一，前缀避免和前两方撞名）。 */
export const CONTEXT_NAME = 'plugin:feiyu-mood';
/** 工具名。 */
export const TOOL_NAME = 'feiyu_mood';

/**
 * 状态文件默认路径。放 plugin-data 而不是 storages：storages 是 DSH 自己的
 * 领域存储，插件别去挤。
 * @param {ReturnType<typeof normalizeConfig>} config
 */
export function resolveStatePath(config) {
  return config.statePath ?? path.join(dshHome(), 'plugin-data', 'dsh-feiyu-mood', 'state.json');
}

/**
 * 创建心情服务：读写状态 + 补算衰减。
 * 每次读都先 decay，所以「上次写入到现在过了多久」自动生效，不依赖定时器。
 * @param {ReturnType<typeof normalizeConfig>} config
 */
export function createMoodService(config, now = () => Date.now()) {
  const store = createStateStore({
    file: resolveStatePath(config),
    coerce: coerceState,
    initial: () => createInitialState(now()),
  });

  /** 当前状态（已按真实时间衰减）。 */
  function current() {
    const at = now();
    return decay(store.load(at), at, config);
  }

  return {
    file: store.file,
    config,
    now,
    current,
    feel(event, options = {}) {
      const at = now();
      const next = applyEvent(store.load(at), event, at, config, options);
      store.save(next);
      return next;
    },
    set(values = {}) {
      const at = now();
      const next = setMood(store.load(at), at, config, values);
      store.save(next);
      return next;
    },
    reset() {
      const at = now();
      const next = resetMood(at);
      store.save(next);
      return next;
    },
    /** 提示词里那一段。抛异常会毁掉整个组装，所以这里自己兜住。 */
    text() {
      try {
        const at = now();
        return describe(decay(store.load(at), at, config), at, config);
      } catch {
        return '';
      }
    },
  };
}

/**
 * 手写 ToolDefinition。
 * 参数 schema 只用 DSH 支持的子集（type / properties / required / items），
 * 数值范围在 execute 里夹紧，免得 schema 用上不支持的 minimum / maximum。
 * @param {ReturnType<typeof createMoodService>} service
 */
export function createMoodTool(service) {
  return {
    name: TOOL_NAME,
    description:
      '查看或推动「自己」当前的心情状态（飞鱼心情）。心情会随时间自动回落到基线。action=get 读取，feel 用事件推动（praise/rebuke/success/failure/surprise/laugh/comfort/boredom），set 直接设定 valence/arousal，reset 回到基线。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'get（默认）/ feel / set / reset',
        },
        event: {
          type: 'string',
          description: `feel 用的事件名，可选 ${EVENT_NAMES.join('/')}`,
        },
        valence: { type: 'number', description: '愉快度 -1..1（set 或 feel 时覆盖）' },
        arousal: { type: 'number', description: '激动度 -1..1（set 或 feel 时覆盖）' },
        note: { type: 'string', description: '一句备注，会写进状态文件，便于事后回看' },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args = {}) {
      const action = typeof args.action === 'string' ? args.action.trim().toLowerCase() : 'get';
      const at = service.now();

      if (action === 'get') {
        const state = service.current();
        return `${summary(state, at)}\n${describe(state, at, service.config).split('\n')[1] ?? ''}`.trim();
      }

      if (action === 'feel') {
        const event = typeof args.event === 'string' ? args.event.trim() : '';
        if (!event) return `feel 需要一个 event，可选：${EVENT_NAMES.join(' / ')}`;
        const state = service.feel(event, { valence: args.valence, arousal: args.arousal, note: args.note });
        const known = EVENT_NAMES.includes(event) ? '' : `（未知事件，按 0 增量处理；已知事件：${EVENT_NAMES.join('/')}）`;
        return `${summary(state, at)}${known}`;
      }

      if (action === 'set') {
        const state = service.set({ valence: args.valence, arousal: args.arousal, note: args.note });
        return summary(state, at);
      }

      if (action === 'reset') {
        return summary(service.reset(), at);
      }

      return `不认识的 action：${action}（可用 get / feel / set / reset）`;
    },
  };
}

/**
 * Cordis 装配钩子。
 * @param {import('@deepseek-ai/cordis').Context} ctx - profile 根上下文
 * @param {unknown} rawConfig - cordis.patch.yml 里的 config
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  if (!config.enabled) return;

  const service = createMoodService(config);

  ctx.effect(
    () =>
      ctx.systemPrompt.context({
        name: CONTEXT_NAME,
        order: config.promptOrder,
        // 心情文本里可能带用户写的备注，关掉插值就不会被 {{...}} 打挂。
        interpolate: false,
        text: () => service.text(),
      }),
    'feiyu-mood.context()',
  );

  ctx.effect(() => ctx.tools.register(createMoodTool(service)), 'feiyu-mood.tool()');
}
