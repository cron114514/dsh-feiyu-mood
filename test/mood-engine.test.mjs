import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  EVENT_NAMES,
  applyEvent,
  coerceState,
  createInitialState,
  decay,
  describe,
  labelFor,
  normalizeConfig,
  setMood,
} from '../lib/mood-engine.mjs';

const config = normalizeConfig({});
const MINUTE = 60_000;
const T0 = 1_700_000_000_000;

test('初始状态落在基线上', () => {
  const state = createInitialState(T0);
  assert.equal(state.valence, DEFAULT_CONFIG.baselineValence);
  assert.equal(state.arousal, DEFAULT_CONFIG.baselineArousal);
  assert.equal(state.lastShiftAt, 0);
});

test('半分之一的半衰期后，偏离量正好减半', () => {
  const happy = applyEvent(createInitialState(T0), 'praise', T0, config);
  const later = decay(happy, T0 + config.halfLifeMinutes * MINUTE, config);
  const base = config.baselineValence;
  const expected = base + (happy.valence - base) / 2;
  assert.ok(Math.abs(later.valence - expected) < 0.002, `${later.valence} vs ${expected}`);
});

test('时间只会把心情拉回基线，不会推出去', () => {
  const happy = applyEvent(createInitialState(T0), 'praise', T0, config);
  const muchLater = decay(happy, T0 + 24 * 60 * MINUTE, config);
  assert.ok(Math.abs(muchLater.valence - config.baselineValence) < 0.01);
  assert.ok(Math.abs(muchLater.arousal - config.baselineArousal) < 0.01);
});

test('夸与被怼方向相反，且都夹在 -1..1', () => {
  const praised = applyEvent(createInitialState(T0), 'praise', T0, config);
  const rebuked = applyEvent(createInitialState(T0), 'rebuke', T0, config);
  assert.ok(praised.valence > rebuked.valence);
  const stacked = EVENT_NAMES.reduce(
    (state, event) => applyEvent(state, event, T0, config, { valence: 1 }),
    createInitialState(T0),
  );
  assert.ok(stacked.valence <= 1 && stacked.valence >= -1);
  assert.ok(stacked.arousal <= 1 && stacked.arousal >= -1);
});

test('历史被限制在 historyLimit 条', () => {
  const limit = normalizeConfig({ historyLimit: 3 });
  let state = createInitialState(T0);
  for (let index = 0; index < 10; index += 1) {
    state = applyEvent(state, 'praise', T0 + index * MINUTE, limit);
  }
  assert.equal(state.history.length, 3);
  assert.equal(state.history.at(-1).event, 'praise');
});

test('set 只改给出的那一维', () => {
  const state = setMood(createInitialState(T0), T0, config, { valence: -0.8 });
  assert.equal(state.valence, -0.8);
  assert.equal(state.arousal, config.baselineArousal);
  assert.equal(state.lastEvent, 'set');
});

test('脏数据不会抛，退回基线', () => {
  const state = coerceState({ valence: 'NaN', arousal: 42, history: 'nope' }, T0);
  assert.equal(state.valence, DEFAULT_CONFIG.baselineValence);
  assert.equal(state.arousal, 1);
  assert.deepEqual(state.history, []);
  assert.equal(coerceState(null, T0).valence, DEFAULT_CONFIG.baselineValence);
});

test('心情标签覆盖四个象限', () => {
  assert.equal(labelFor(0.6, 0.8).en, 'excited');
  assert.equal(labelFor(0.6, 0.2).en, 'content');
  assert.equal(labelFor(-0.6, 0.8).en, 'irritated');
  assert.equal(labelFor(-0.6, 0.2).en, 'low');
  assert.equal(labelFor(0, 0.1).en, 'drowsy');
  assert.equal(labelFor(0, 0.4).en, 'calm');
});

test('提示词文本包含状态、指引，并且不会超长', () => {
  const state = applyEvent(createInitialState(T0), 'praise', T0, config, { note: '{{{ 别炸' });
  const text = describe(state, T0 + 5 * MINUTE, config);
  assert.match(text, /feiyu-mood/);
  assert.match(text, /轻快|兴奋/);
  assert.match(text, /Tone/);
  assert.ok(text.length <= config.promptMaxChars);

  const tiny = normalizeConfig({ promptMaxChars: 120 });
  assert.ok(describe(state, T0, tiny).length <= 120);
});

test('配置写坏时归一成可用值', () => {
  const weird = normalizeConfig({ halfLifeMinutes: -3, promptOrder: 'x', historyLimit: -1, enabled: 'no' });
  assert.equal(weird.halfLifeMinutes, 1);
  assert.equal(weird.promptOrder, DEFAULT_CONFIG.promptOrder);
  assert.equal(weird.historyLimit, 0);
  assert.equal(weird.enabled, true);
  assert.equal(normalizeConfig({ enabled: false }).enabled, false);
});
