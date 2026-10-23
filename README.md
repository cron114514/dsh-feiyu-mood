# dsh-feiyu-mood

给 DeepSeek Harness 里的 agent 一个**会衰减的情绪状态机**：心情会被事件推动，然后慢慢回到基线；当前心情以一条极短的运行时上下文进入系统提示词，所以它真的会改变说话的语气。

- 零运行时依赖（只用 Node 内置模块），不需要联网、不需要 pnpm 装包。
- host 插件（没有 browser 半），不会往 WebUI 里塞卡片。
- 状态落盘到 `<DSH_HOME>/plugin-data/dsh-feiyu-mood/state.json`，重启不丢。

## 它到底做了什么

| 机制 | 说明 |
| --- | --- |
| 状态 | `valence`（愉快度）与 `arousal`（激动度），都在 `-1..1` |
| 衰减 | 指数回归基线，半衰期默认 45 分钟；每次读取时按真实时间补算 |
| 触发 | `praise` / `rebuke` / `success` / `failure` / `surprise` / `laugh` / `comfort` / `boredom`，也可以直接 `set` |
| 提示词 | 注册一条 `systemPrompt.context`（动态、每次组装重读），内容是一行心情 + 一行语气指引 |
| 工具 | `feiyu_mood`，支持 `get` / `feel` / `set` / `reset` |

提示词里注入的是**状态**，不是剧本：模型拿到「现在偏轻快，10 分钟前被夸过，正在回落」这样的信息，自行决定语气。插件会在指引里明确写：不要把数值念出来、不要提这个插件。

## 安装

```powershell
# 1) 放到 DSH 的插件目录
git clone https://github.com/cron114514/dsh-feiyu-mood "$env:USERPROFILE\.dsh\plugins\dsh-feiyu-mood"

# 2) 让 profile 把本包当作 link 依赖（在 profile 目录执行）
cd "$env:USERPROFILE\.dsh\profiles\desktop"
# package.json 的 dependencies 里加："dsh-feiyu-mood": "link:../../plugins/dsh-feiyu-mood"
# package.json 的 dsh.profile.bundles 里加："dsh-feiyu-mood"
pnpm install

# 3) 重启 DeepSeek Harness
```

`cordis.patch.yml` 会插入一条 loader entry（`id: feiyu-mood`）。想临时关掉，把它改成 `disabled: true` 后重启，或直接 `config.enabled: false`。

## 配置

在 `cordis.patch.yml` 的 entry 里写 `config`：

```yaml
- insert:
    - id: feiyu-mood
      name: dsh-feiyu-mood
      config:
        halfLifeMinutes: 45
        baselineValence: 0.15
        baselineArousal: 0.4
        promptOrder: 9050
        promptMaxChars: 700
        enabled: true
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 关掉后不注册提示词上下文与工具，但状态文件保留 |
| `halfLifeMinutes` | `45` | 偏离基线的那部分多久衰减一半 |
| `baselineValence` | `0.15` | 心情的落点（0.15 = 略微偏正面） |
| `baselineArousal` | `0.4` | 激动度的落点 |
| `promptOrder` | `9050` | 提示词段落排序，越大越靠后 |
| `promptMaxChars` | `700` | 注入文本的上限，超了截断 |
| `statePath` | — | 覆盖状态文件路径（默认在 `DSH_HOME/plugin-data/...`） |

## 工具 `feiyu_mood`

| action | 参数 | 结果 |
| --- | --- | --- |
| `get` | — | 当前心情、数值、距上次变化的分钟数 |
| `feel` | `event`（必填）、`note`、`valence`、`arousal` | 按事件推动心情；给了 `valence`/`arousal` 时直接覆盖 |
| `set` | `valence`、`arousal` | 直接设定 |
| `reset` | — | 回到基线，清空历史 |

## 状态文件长什么样

```json
{
  "version": 1,
  "valence": 0.41,
  "arousal": 0.56,
  "updatedAt": 1761300000000,
  "lastShiftAt": 1761299700000,
  "lastEvent": "praise",
  "history": [{ "at": 1761299700000, "event": "praise", "valence": 0.41, "arousal": 0.56 }]
}
```

文件损坏时按「首次启动」处理，不会让提示词组装失败。

## 开发

```powershell
node --test
```

`lib/mood-engine.mjs` 是纯函数（无 I/O、无 DSH 依赖），`lib/state-store.mjs` 只管落盘，`lib/index.js` 只做装配。

## 卸载

从 profile 的 `dependencies` 与 `dsh.profile.bundles` 里删掉 `dsh-feiyu-mood`，删掉 `~/.dsh/plugins/dsh-feiyu-mood`，`pnpm install`，重启。

## License

MIT
