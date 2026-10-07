---
name: "viral-impossible-test-video"
description: "\"Impossible Test\"爆款产品视频生成：极端场景+产品当英雄+黄金3秒钩子"
---

# 不可能测试 · 爆款产品视频生成 Skill

## Trigger
当用户给出飞书文档（策划案），并要求为某企业的具体产品生成 15-20s"不可能测试"风格短视频时触发。

典型触发：
- "V，帮 XX 企业的 XX 产品用不可能测试公式出条视频"
- "参考风扇/面料那个视频，给策划案里这个产品做"
- 用户发送飞书文档链接，说"出条 video demo"

## 工作流程

1. **读策划案** → 打开用户给的飞书文档，提取：
   - 企业全称（英文名）
   - 品牌愿景 / Slogan
   - 产品名称 + 核心卖点（3-5个）
   - 产品所属行业/品类
   
2. **想极端场景** → 根据产品真实卖点，设计一个"不可能"但逻辑合理的极端环境：
   - 面料保暖 → 暴风雪
   - 面料防水 → 暴雨
   - 面料阻燃 → 火堆旁
   - 电机风力强 → 台风
   - 千万别做反物理的（降落伞用摇粒绒 ❌）

3. **套公式生成 prompt** → 填入骨架（见下方），输出给视频模型

4. **出片** → 有实拍素材走 Seedance，没有走 xAI Grok

5. **QC** → 检查 7 项后发 1 条成片

## 核心公式：不可能测试

```
┌─────────────┬────────┬──────────────────────────┐
│   节拍      │  秒数  │  做什么                   │
├─────────────┼────────┼──────────────────────────┤
│ 🔥 钩子     │ 0-3s   │ 极端/荒谬场景，打破预期    │
│ 💪 制霸     │ 3-9s   │ 产品轻松控制/化解极端环境  │
│ 🌪 高潮     │ 9-13s  │ 最极端测试+平静收场       │
│ 🎯 收尾     │ 13-15s │ 产品亮相+品牌全称+愿景   │
└─────────────┴────────┴──────────────────────────┘
```

## 三条铁律

1. **卖点必须符合逻辑** — "不可能"的是环境，不是产品用法。场景可以荒谬，产品功能必须真实。

2. **不要多余道具** — 不喝茶、不接电话、不玩手机。只有产品、人物、测试环境。道具抢戏。

3. **前3秒必须有视觉冲击** — 不铺垫不介绍，第一帧就是极端场景里的冲突画面。

## Prompt 骨架

```text
15s viral [产品品类] test video, 9:16. Product: [产品名] by [公司英文全称].
Subtitle rule: SINGLE line only in lower third of frame, never duplicate text anywhere.
0-3s HOOK: [基于产品真实卖点的极端场景视觉冲突]. Sub: '[钩子文案].'
3-9s DEMO: [2-3个极端测试，每个都展示产品轻松应对]. Sub: '[制霸文案].' No further subtitles during tests.
9-13s CLIMAX: [最极端测试+平静收场]. Sub: '[高潮文案].'
13-15s HERO: [产品干净展示]. Center text: '[公司英文全称]'. Below: '[品牌愿景/标语]'.
No props. Raw handheld cinematic. Intense BGM.
```

## 策划案 → Prompt 转换示例

输入（策划案提取）：
- 企业：Shaoxing Sincere Needle Textile Co., Ltd.
- 愿景：Let sincere to be sincere
- 产品：Polar Fleece 摇粒绒面料
- 卖点：极寒保暖、防水、耐磨、阻燃

输出（prompt）：
```
0-3s: 暴风雪。人埋在雪里，破雪而出。面料完好。Sub: 'They said this won't work.'
3-9s: 暴雨淋身→水珠滚落→火烤烘干→拖地不破。Sub: 'Polar fleece disagrees.'
9-13s: 风雪转日出。人暖和干燥。Sub: 'Warm. Durable. Waterproof.'
13-15s: 人堆雪人。Hero text: 'Shaoxing Sincere Needle Textile Co., Ltd.' / 'Let sincere to be sincere.'
```

## 模型选择

| 场景 | 模型 | 说明 |
|------|------|------|
| 有实拍产品素材 | Seedance (`--video-model seedance-fast`) | 视频做身份锚，产品保真，需过确认环节 |
| 无实拍素材 | xAI Grok (`xai/grok-imagine-video`) | 文本直出 15s，快，字幕可能有重复 |
| 字幕精度要求高 | Seedance 优先 | xAI Grok 字幕有时中间+下方双行 |

## Seedance 专用流程

```
makaron chat --project auto --video-model seedance-fast --background --json "[完整prompt]"
→ 得到 runId
→ 等 30 秒，查 run status
→ 如果 text 里面有 "confirm" — 立即再发一条 makaron chat --project [projectId] "confirm. Render now."
→ 查 project media 拿 15s 视频 URL
→ 下载 → 发群
```

## QC 检查清单

生成后必须检查：
1. ✅ 卖点是否逻辑合理（不能出现反物理的产品用法）
2. ✅ 有无多余道具（茶杯、手机、多余人物）
3. ✅ 前3秒是否有视觉冲击
4. ✅ 字幕是否只在下方1/3处、单行、不重复
5. ✅ 结尾是否有品牌全称 + 愿景
6. ✅ 是否只发了 1 条（不是 2 条重复）
7. ✅ 时长是否 15-20s

## 已知失效模式

- xAI Grok 字幕容易重复（中间+下方双行）→ 从未完全解决，偏高可靠场景走 Seedance
- xAI Grok 文件可能超过 16MB 下载限制 → 缩短 prompt 减少视觉复杂场景
- Seedance 卡确认环节 → 主动 poll，看到 "confirm" 秒回推进
- 第一条面料 demo（降落伞版）卖点不逻辑 → 必须策划案验证产品真实功能
