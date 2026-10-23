import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// DSH_HOME 必须在 import 插件之前设好：模块顶层不读它，但 apply 时读。
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mood-test-'));
process.env.DSH_HOME = home;

const { apply, createMoodService, createMoodTool, CONTEXT_NAME, TOOL_NAME } = await import('../lib/index.js');
const { normalizeConfig } = await import('../lib/mood-engine.mjs');
const { assertRegistryReadyTool, fakeContext } = await import('./helpers.mjs');

test('apply 注册一条提示词上下文和一个工具', () => {
  const { ctx, registered } = fakeContext();
  apply(ctx, { halfLifeMinutes: 30 });

  assert.equal(registered.contexts.length, 1);
  assert.equal(registered.contexts[0].name, CONTEXT_NAME);
  assert.equal(typeof registered.contexts[0].text, 'function');
  assert.equal(registered.contexts[0].interpolate, false);
  assert.ok(Number.isFinite(registered.contexts[0].order));

  assert.equal(registered.tools.length, 1);
  assert.equal(registered.tools[0].name, TOOL_NAME);
  assertRegistryReadyTool(registered.tools[0], assert);

  assert.deepEqual(registered.effects, ['feiyu-mood.context()', 'feiyu-mood.tool()']);
});

test('config.enabled=false 时什么都不注册', () => {
  const { ctx, registered } = fakeContext();
  apply(ctx, { enabled: false });
  assert.equal(registered.contexts.length, 0);
  assert.equal(registered.tools.length, 0);
});

test('上下文文本可渲染，且带时间推移后的状态', async () => {
  const { ctx, registered } = fakeContext();
  apply(ctx, { halfLifeMinutes: 45 });

  const text = registered.contexts[0].text();
  assert.match(text, /feiyu-mood/);
  assert.match(text, /心情/);

  // 让工具真的推动一次心情，再读上下文：状态应该变，文本应该跟着变。
  const tool = registered.tools[0];
  await tool.execute({ action: 'feel', event: 'praise' });
  const after = registered.contexts[0].text();
  assert.notEqual(after, text);
  assert.match(after, /被夸/);
});

test('工具四个 action 都能跑通，且不会抛', async () => {
  const { ctx, registered } = fakeContext();
  apply(ctx, {});
  const tool = registered.tools[0];

  const got = await tool.execute({ action: 'get' });
  assert.match(got, /心情/);

  const felt = await tool.execute({ action: 'feel', event: 'rebuke', note: '被说写得慢' });
  assert.match(felt, /被怼|备注/);

  const set = await tool.execute({ action: 'set', valence: 0.9, arousal: 0.9 });
  assert.match(set, /兴奋/);

  const reset = await tool.execute({ action: 'reset' });
  assert.match(reset, /平静|懒散|警觉/);

  const unknownAction = await tool.execute({ action: 'dance' });
  assert.match(unknownAction, /不认识的 action/);

  const missingEvent = await tool.execute({ action: 'feel' });
  assert.match(missingEvent, /需要一个 event/);
});

test('状态真的落盘，且服务重开能读回来', async () => {
  const config = normalizeConfig({ statePath: path.join(home, 'state.json') });
  const service = createMoodService(config);
  service.feel('success');

  const raw = JSON.parse(fs.readFileSync(config.statePath, 'utf8'));
  assert.equal(raw.lastEvent, 'success');
  assert.ok(raw.valence > config.baselineValence);

  const reopened = createMoodService(config);
  assert.equal(reopened.current().lastEvent, 'success');
});

test('状态文件被写坏时退回基线，而不是抛异常', async () => {
  const statePath = path.join(home, 'broken.json');
  fs.writeFileSync(statePath, '{ not json', 'utf8');
  const service = createMoodService(normalizeConfig({ statePath }));
  assert.equal(service.current().valence, normalizeConfig({}).baselineValence);
  assert.equal(typeof service.text(), 'string');
});

test('手写工具定义能被 DSH 的注册期检查接受', () => {
  const service = createMoodService(normalizeConfig({ statePath: path.join(home, 'registry.json') }));
  assertRegistryReadyTool(createMoodTool(service), assert);
});
