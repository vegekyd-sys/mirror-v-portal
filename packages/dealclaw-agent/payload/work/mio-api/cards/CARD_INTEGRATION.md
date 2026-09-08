# 展后报告实时卡片接入说明

复用 V Makaron 的卡片渲染机制（`card-runner-template.cjs` 的 renderCard/streamCard + `live-card-state-runner.cjs` 的「watch state.json → 原地更新同一张卡」），做到一张卡从「生成中」一路原地更新到「已完成/失败」。

## 三个文件

| 文件 | 作用 |
|------|------|
| `card-runner-template.cjs` | 卡片渲染库（renderCard / withChannel / streamCard / finalCard）。SDK 解析已加固，自动定位本机 Feishu Lark SDK，无需手动设 LARK_SDK_PATH |
| `live-card-state-runner.cjs` | 通用 runner：`node live-card-state-runner.cjs <oc_群或ou_用户> <state.json>`，watch state.json 原地更新同一张卡，`done`/`failed` 时退出 |
| `postexh_card.py` | Python 薄封装：状态机 + `write_card_state()` 原子写 state.json + `launch()` 起后台 runner |

## worker 里怎么接

```python
from postexh_card import write_card_state, launch

state_path = "/tmp/after_exh_state.json"

# 1) 起卡片（后台跑 runner，先显示「等待数据就绪」）
launch(target="oc_8d0de2b5bfc614de4dc39979b4b02046", state_path=state_path)

# 2) 每个阶段写一次状态，同一张卡原地更新
write_card_state(state_path, "cleaning")
write_card_state(state_path, "scoring")
write_card_state(state_path, "drafting")

# 3) 终态
write_card_state(state_path, "done", report_url="https://...docx/xxx", leads_url="https://...base/xxx")
# 或失败：write_card_state(state_path, "failed")
```

## 状态机

| stage | 进度 | 状态文案 |
|-------|------|----------|
| `awaiting_data` | 5% | 等待数据就绪 |
| `cleaning` | 20% | 线索清洗 |
| `scoring` | 50% | 线索优先级排序 |
| `drafting` | 70% | 生成报告正文 |
| `done` | 100% 绿 | 已交付，附「打开展后报告」「查看线索表」两个 URL 按钮 |
| `failed` | 100% 红 | 生成失败，附「重试」回调按钮 |

品牌名：卡片顶部灰字统一为「出海精灵小元 · 展后线索整理与报告」。

## 按钮回调

- `done` 的两个按钮是 `open_url`（打开链接），无需回调路由。
- `failed` 的「重试」按钮 callback 是 OpenClaw 结构化 quick 信封：`{"oc":"ocf1","k":"quick","a":"after_exhibition.retry","q":"<命令>"}`。用户点击后，OpenClaw 原生会把 `q` 作为合成命令分发给本群绑定的 agent（小元），小元据此重新触发报告生成。用 `--retry-q "重新生成展后报告 exhibition_id=xxx 企业=yyy"` 带上上下文即可回到同一份报告，无需额外 patch。

## 身份说明

卡片通过 V 的飞书 app（`channels.feishu`，appId `cli_a9365919fc3a1bd6`）发出。DealClaw 群目前只有这一个 bot，因此无需单独 account 参数化；卡片身份与 DealClaw 其它消息一致。
