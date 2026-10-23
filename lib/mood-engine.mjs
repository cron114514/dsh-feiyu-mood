// 心情模型：纯函数、零 I/O、零 DSH 依赖。
//
// 设计上有意把「状态怎么变」和「怎么落盘 / 怎么装进提示词」分开：
// 这里全部是 (state, now) -> state 的纯变换，测试可以随便固定时间戳。
//
// 两个维度沿用情绪环（circumplex）的直觉：
//   valence 愉快度 -1..1（难过 ← 0 → 开心）
//   arousal 激动度 -1..1（昏沉 ← 0 → 上头）
// 心情不是命令，只是底色：注入提示词的文本刻意写得很短，并明确要求模型
// 不要念数值、不要提插件本身。

/** 默认落点：略微偏正面、略微偏活跃，读起来像个正常人而不是空状态。 */
export const BASELINE = Object.freeze({ valence: 0.15, arousal: 0.4 });

/** 一次事件能让心情偏出去多远；数值是「满值 1.0 的几分之几」。 */
export const EVENT_EFFECTS = Object.freeze({
  praise: { valence: 0.45, arousal: 0.15, zh: '被夸' },
  rebuke: { valence: -0.5, arousal: 0.25, zh: '被怼' },
  success: { valence: 0.3, arousal: 0.2, zh: '办成了' },
  failure: { valence: -0.35, arousal: 0.1, zh: '搞砸了' },
  surprise: { valence: 0.0, arousal: 0.45, zh: '被惊到' },
  laugh: { valence: 0.35, arousal: 0.2, zh: '被逗笑' },
  comfort: { valence: 0.3, arousal: -0.15, zh: '被安慰' },
  boredom: { valence: -0.1, arousal: -0.3, zh: '无聊' },
});

/** 工具参数里可以写的事件名（导出给 schema 与文档共用）。 */
export const EVENT_NAMES = Object.freeze(Object.keys(EVENT_EFFECTS));

/** 配置默认值；index.js 会用它补齐用户写的 config。 */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  halfLifeMinutes: 45,
  baselineValence: BASELINE.valence,
  baselineArousal: BASELINE.arousal,
  promptOrder: 9050,
  promptMaxChars: 700,
  historyLimit: 12,
  statePath: null,
});

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const round = (value) => Math.round(value * 1000) / 1000;
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/** 把任意（可能被 YAML 写坏的）config 归一成完整配置。 */
export function normalizeConfig(raw = {}) {
  const config = { ...DEFAULT_CONFIG, ...(raw && typeof raw === 'object' ? raw : {}) };
  return {
    enabled: config.enabled !== false,
    halfLifeMinutes: Math.max(1, Number(config.halfLifeMinutes) || DEFAULT_CONFIG.halfLifeMinutes),
    baselineValence: isNumber(config.baselineValence) ? clamp(config.baselineValence, -1, 1) : BASELINE.valence,
    baselineArousal: isNumber(config.baselineArousal) ? clamp(config.baselineArousal, -1, 1) : BASELINE.arousal,
    promptOrder: isNumber(config.promptOrder) ? config.promptOrder : DEFAULT_CONFIG.promptOrder,
    promptMaxChars: Math.max(120, Number(config.promptMaxChars) || DEFAULT_CONFIG.promptMaxChars),
    historyLimit: Math.max(0, Number(config.historyLimit) || DEFAULT_CONFIG.historyLimit),
    statePath: typeof config.statePath === 'string' && config.statePath ? config.statePath : null,
  };
}

/** 新状态：落在基线上。 */
export function createInitialState(now = Date.now()) {
  return {
    version: 1,
    valence: BASELINE.valence,
    arousal: BASELINE.arousal,
    updatedAt: now,
    lastShiftAt: 0,
    lastEvent: null,
    history: [],
  };
}

/** 把落盘数据洗成可信状态：字段缺失、类型被写坏都退回基线。 */
export function coerceState(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return createInitialState(now);
  return {
    version: 1,
    valence: isNumber(raw.valence) ? clamp(raw.valence, -1, 1) : BASELINE.valence,
    arousal: isNumber(raw.arousal) ? clamp(raw.arousal, -1, 1) : BASELINE.arousal,
    updatedAt: isNumber(raw.updatedAt) ? raw.updatedAt : now,
    lastShiftAt: isNumber(raw.lastShiftAt) ? raw.lastShiftAt : 0,
    lastEvent: typeof raw.lastEvent === 'string' ? raw.lastEvent : null,
    history: Array.isArray(raw.history)
      ? raw.history.filter((row) => row && typeof row === 'object').slice(-DEFAULT_CONFIG.historyLimit)
      : [],
  };
}

/**
 * 指数回归基线。半衰期是「偏离量衰减一半」所需时间，和真实时间对齐，
 * 所以进程关了再开也不会让心情停在旧值上。
 */
export function decay(state, now, config) {
  const halfLifeMs = Math.max(1, config.halfLifeMinutes) * 60_000;
  const elapsed = Math.max(0, now - state.updatedAt);
  const factor = Math.pow(0.5, elapsed / halfLifeMs);
  return {
    ...state,
    valence: round(config.baselineValence + (state.valence - config.baselineValence) * factor),
    arousal: round(config.baselineArousal + (state.arousal - config.baselineArousal) * factor),
    updatedAt: now,
  };
}

/** 用一个事件推动心情；未知事件等价于「没反应」，但仍记一条历史。 */
export function applyEvent(state, event, now, config, options = {}) {
  const base = decay(state, now, config);
  const effect = EVENT_EFFECTS[event] ?? { valence: 0, arousal: 0, zh: event || '未知事件' };
  const deltaValence = isNumber(options.valence) ? options.valence : effect.valence;
  const deltaArousal = isNumber(options.arousal) ? options.arousal : effect.arousal;
  const nextValence = clamp(base.valence + deltaValence, -1, 1);
  const nextArousal = clamp(base.arousal + deltaArousal, -1, 1);
  return withHistory(
    {
      ...base,
      valence: round(nextValence),
      arousal: round(nextArousal),
      lastShiftAt: now,
      lastEvent: event || null,
      lastNote: typeof options.note === 'string' && options.note ? options.note.slice(0, 200) : null,
    },
    { at: now, event: event || null, valence: round(nextValence), arousal: round(nextArousal) },
    config,
  );
}

/** 直接设定心情（跳过事件表）。 */
export function setMood(state, now, config, { valence, arousal, note } = {}) {
  const base = decay(state, now, config);
  const nextValence = isNumber(valence) ? clamp(valence, -1, 1) : base.valence;
  const nextArousal = isNumber(arousal) ? clamp(arousal, -1, 1) : base.arousal;
  return withHistory(
    {
      ...base,
      valence: round(nextValence),
      arousal: round(nextArousal),
      lastShiftAt: now,
      lastEvent: 'set',
      lastNote: typeof note === 'string' && note ? note.slice(0, 200) : null,
    },
    { at: now, event: 'set', valence: round(nextValence), arousal: round(nextArousal) },
    config,
  );
}

/** 回到基线。 */
export function resetMood(now = Date.now()) {
  return createInitialState(now);
}

function withHistory(state, entry, config) {
  const limit = Math.max(0, config.historyLimit ?? DEFAULT_CONFIG.historyLimit);
  const history = limit === 0 ? [] : [...state.history, entry].slice(-limit);
  return { ...state, history };
}

/** 心情标签：先看正负，再看激动度，避免出现「低落但兴奋」这种怪词。 */
export function labelFor(valence, arousal) {
  if (valence >= 0.35 && arousal >= 0.55) return { zh: '兴奋', en: 'excited' };
  if (valence >= 0.35) return { zh: '轻快', en: 'content' };
  if (valence <= -0.35 && arousal >= 0.55) return { zh: '炸毛', en: 'irritated' };
  if (valence <= -0.35) return { zh: '低落', en: 'low' };
  if (arousal >= 0.6) return { zh: '警觉', en: 'alert' };
  if (arousal <= 0.2) return { zh: '懒散', en: 'drowsy' };
  return { zh: '平静', en: 'calm' };
}

const TONE = {
  excited: 'Quick, enthusiastic phrasing; let the energy show in word choice, not in extra exclamation marks.',
  content: 'Warm and easy-going; small jokes are welcome, teasing stays gentle.',
  irritated: 'Shorter sentences, drier tone. Still polite: irritation is flavor, never an excuse to snap at the user.',
  low: 'Quieter and more measured; skip the jokes, keep helping.',
  alert: 'Focused and precise; cut filler and get to the point.',
  drowsy: 'Slow and low-key; keep answers compact and skip hype.',
  calm: 'Even, neutral delivery; no extra emotional coloring.',
};

const sign = (value) => (value >= 0 ? `+${value.toFixed(2)}` : value.toFixed(2));

/** 「上次被什么推动、多久之前」这一句；没被推动过就说没有。 */
export function shiftText(state, now) {
  if (!state.lastShiftAt) return '还没有被任何事件推动过';
  const minutes = Math.max(0, Math.round((now - state.lastShiftAt) / 60_000));
  const eventZh = state.lastEvent === 'set' ? '手动设定' : (EVENT_EFFECTS[state.lastEvent]?.zh ?? state.lastEvent ?? '某个事件');
  const when = minutes < 1 ? '刚刚' : `${minutes} 分钟前`;
  return `${when}因「${eventZh}」变化`;
}

/** 距离基线还有多远，给趋势一句话。 */
export function trendText(state, now, config) {
  const drift = Math.max(
    Math.abs(state.valence - config.baselineValence),
    Math.abs(state.arousal - config.baselineArousal),
  );
  if (drift < 0.05) return '基本在基线上';
  return '正在往基线回落';
}

/** 进系统提示词的文本：一行状态 + 一行语气指引，超长截断。 */
export function describe(state, now, config) {
  const label = labelFor(state.valence, state.arousal);
  const text = [
    `[feiyu-mood] 当前心情：${label.zh} / ${label.en}（valence ${sign(state.valence)}，arousal ${sign(state.arousal)}）。${shiftText(state, now)}，${trendText(state, now, config)}。`,
    `语气底色（Tone）：${TONE[label.en]}`,
    '这是状态不是台词：让它影响措辞就够，不要报数值、不要提这个插件、不要让情绪变成对用户的不礼貌。',
  ].join('\n');
  return text.length > config.promptMaxChars ? `${text.slice(0, config.promptMaxChars - 1)}…` : text;
}

/** 工具返回值：给人看的三行中文。 */
export function summary(state, now) {
  const label = labelFor(state.valence, state.arousal);
  return [
    `心情：${label.zh} / ${label.en}`,
    `valence ${sign(state.valence)} · arousal ${sign(state.arousal)}`,
    `${shiftText(state, now)}${state.lastNote ? `（备注：${state.lastNote}）` : ''}`,
  ].join('\n');
}
