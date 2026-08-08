---
name: "expo-industrial-video-bg"
description: "工业品展会视频背景：Makaron底图+HTML/CSS文字叠加。触发词：展会背景/工业展视频底图/品牌联展背景"
---

# 工业品展会视频背景图 Skill

## 触发方式

在飞书群里 @V 说以下任一即可触发：

| 触发词 | 示例 |
|--------|------|
| 展会背景 | "帮我做一张展会视频背景" |
| 工业展底图 | "生成工业品展会背景图" |
| 品牌联展背景 | "做个出口品牌联展的背景" |
| 视频背景图 | "1080x1920 视频背景，工业风" |

V 会自动走完整流程：Makaron 生底图 → 叠加文字 → QC → 交付。

## 规格约束

| 参数 | 值 |
|------|-----|
| 尺寸 | 1080×1920 (9:16) |
| 顶部安全区 | ≥120px |
| 底部安全区 | ≥300px，留遮罩（0→8~20%），透底图纹理，不纯色块 |
| 底图风格 | 细线条 + 半透明几何点阵，抽象工业风 |
| 底图禁止 | 人物、机械特写、具象图案、任何文字 |

## 工作流

### Step 1: 底图生成

用 Makaron 生成 3-4 张纯抽象几何背景。

**默认 Prompt**（深色工业风）：
> Generate 4 dark abstract industrial backgrounds. 1080x1920. Fine grid lines + semi-transparent geometric dot matrix. Dark navy/charcoal base. No text, no figures, no complex mechanical objects. 4 variations with different geometric patterns.

**亮色调 Prompt**（用户要亮蓝/丰富色调时）：
> Generate 4 bright blue industrial abstract backgrounds. 1080x1920. Brighter blue/cerulean tones, not dark navy. Fine lines + dots. Lighter overall — modern tech expo feel. No text, no figures. 4 variations.

- 通过 `visible-parent-flow.cjs` 提交，`--expected image`
- Worker 会在 Feishu 卡片中展示 4 张变体

### Step 2: 底图选版

用户选 1-2 张喜欢的（"1-3都蛮好的" / "第一张不错"）。用 `makaron-cli project media <id> --json` 获取 URL，curl 下载。

### Step 3: 遮罩色值计算

对选定底图计算平均色值，遮罩用底图自身色调而非纯黑：

```python
from PIL import Image; import numpy as np
img = Image.open('bg.jpg'); arr = np.array(img).astype(float)
h, w = arr.shape[:2]
top_avg = arr[:h//4, :].mean(axis=(0,1))      # 顶部遮罩色
bot_avg = arr[3*h//4:, :].mean(axis=(0,1))     # 底部遮罩色
```

### Step 4: HTML/CSS 文字叠加

用 Playwright 渲染 HTML（base64 内嵌底图 + logo）到 1080×1920 PNG。

**核心规则**：

1. **遮罩颜色**——永远用底图平均色值，不用纯黑：
```css
.top-shield  { background: rgba(top_r, top_g, top_b, 0.3) → transparent; }
.bottom-overlay { background: rgba(bot_r, bot_g, bot_b, 0.08) → transparent; }
.bottom-safe { background: rgba(bot_r, bot_g, bot_b, 0.08) → transparent; }
```

2. **底部安全区也透底图**⸺不要用纯色块。安全区和遮罩区共用同一套渐变色值，确保 300px 线无缝过渡。

3. **中英文标题宽度对齐**⸺通过字号 + letter-spacing 微调到差值 <10px：
```css
.expo-title-en { font-size: 28px; font-weight: 600; letter-spacing: 3px; }
.expo-title-cn { font-size: 37px; font-weight: 700; letter-spacing: 12px; }
```
渲染后 `getBoundingClientRect().width` 实测，差 >30px 则调 letter-spacing。

4. **信息层级**——地点比时间更重要，地点字要大于日期：
```css
.date-text { font-size: 42px; }        /* 辅助信息 */
.location-text { font-size: 36px; font-weight: 700; }  /* 主要信息 */
```

5. **遮罩透明度**——底部 0→8% 起步（似透非透），用户要加可到 20%：
- 默认：`rgba(bot_avg, 0.08) → transparent`
- 用户要求"遮罩再重点"：调至 0→15-20%
- 底部点阵纹理始终可见

6. **Logo**——140px 等比缩放，白/透明底自动转正：
```css
.logo-wrapper img { height: 140px; filter: brightness(0) invert(1); }
```

7. **色彩增强**——底图偏暗时 CSS 提亮：
```css
.bg-image img { filter: brightness(1.2); }  /* 深色底图用 */
.blue-shift { mix-blend-mode: screen; }      /* 蓝色叠加 */
.vignette { /* 轻暗角 <0.35 */ }
```

### Step 5: 渲染

```js
const { chromium } = require('playwright');
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
await page.setContent(html, { waitUntil: 'load' });
await page.evaluate(async () => { await document.fonts.ready; });
await page.waitForTimeout(2000);
await page.screenshot({ path: 'output.png' });
```

### Step 6: QC 清单

- [ ] 底部 300px 完全无文字（像素扫描 y=1620-1920）
- [ ] 中英文标题宽度差 <10px
- [ ] 遮罩区和安全区 300px 线处无缝过渡（B 通道均值差 <5）
- [ ] 底部文字（日期+地点）白色清晰可读（bright pixels >200）
- [ ] 底图纹理在安全区可见（std >5）
- [ ] Logo 完整显示
- [ ] 整体有蓝色调，不是纯黑
- [ ] 地点字 > 日期字，信息层级正确
- [ ] 遮罩过渡无硬边

## 常见迭代

| 用户反馈 | 处理 |
|----------|------|
| 太暗 | CSS brightness↑ + blue-shift↑，或重跑亮色调 prompt |
| 遮罩太黑/不自然 | 用底图平均色值替换纯黑，降透明度 |
| 中文标题不够大 | 增字号 + 调 letter-spacing 到与英文等宽 |
| 地点不够突出 | 地点放大（36px+），日期缩小（42px），调信息层级 |
| 底部遮罩过渡硬 | 安全区也用透底图+渐变，和遮罩区同色同公式 |
| 换个底图 | Makaron project 里换 media_2/3/4 |
| 色调单一 | 换亮蓝 prompt 重跑，或 CSS 换色 |

## 字体

- 英文：Montserrat 400-900
- 中文：Noto Sans SC 400-900
- 兜底：PingFang SC, Microsoft YaHei

## 依赖

- `makaron-cli` + Makaron API key
- `playwright` (Chromium)
- Python PIL + numpy（色值计算、QC 像素扫描）
- Feishu 卡片工作流（`visible-parent-flow.cjs`）

## 参考案例

雪梨（谢蕾）x V，第十一届中国(墨西哥)出口品牌联展，2026-07-01。

五轮迭代关键决策：
1. 纯CSS背景 → Makaron底图+CSS文字叠加
2. 遮罩从纯黑改为底图平均色值
3. 中文标题放大+宽度对齐英文
4. 底部安全区从纯色块改为透底图+渐变（解决硬过渡）
5. 亮蓝底图 + 地点放大（地点>时间的信息层级）
