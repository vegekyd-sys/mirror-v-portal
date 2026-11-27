---
name: "pdf-deck-localization"
description: "PDF 提案书改配色、翻日语重排后输出 PDF。拆页取素材→HTML 重建→Chrome 出 PDF→回渲检查。"
---

# PDF 提案书重做 / 本地化

把一份别语言的 PDF（常见 Canva 导出的提案书）重做成目标语言、目标配色，并输出 PDF。核心做法不是改原 PDF，而是**拆页取素材 → 用 HTML 重建 → Chrome 出 PDF → 回渲检查**。

## 何时用
- 「把这个 PDF 改成适合 X 受众的配色/设计方案」「翻译成日语并输出 PDF」
- 品牌物料需要本地化换版，但原稿只有 PDF/PPT

## 步骤

### 1. 先量清楚原稿
```
pdfinfo src.pdf            # 页数、尺寸（常见 1440×810 pts = 16:9）
pdftotext -f N -l N -layout src.pdf -   # 逐页取文字，做翻译底稿
pdftoppm -png -r 96 src.pdf pages/p      # 低分辨率全页图，用来拼 montage 看图
```
把 20 页左右拼成一张 montage（4 列）通读一遍，先判断设计语言：底色、字体、图片位置、留白节奏。**先看完再动手，避免重建后返工。**

### 2. 取素材
- 高清渲染：`pdftoppm -png -r 150 src.pdf pages_hi/p`
- 图片块用坐标裁切：从 montage 估算坐标 ×(150/96) 后 `crop`。
- 客户 logo 墙这类「白底卡片阵列」用代码找，不要手点：
  白色掩膜（`max>0.88 & sat<0.18`）+ `binary_opening/closing` + `label` + `find_objects`，按面积和长宽比过滤，再按 y/x 排序拼 contact sheet 核对。
- 裁完一定拼一张 contact sheet 看一遍，错位的直接丢掉。

### 3. 重建 HTML（不要试图改原 PDF 配色）
- `@page { size: 1280px 720px; margin: 0 }`，每个 slide 固定 1280×720、`page-break-after: always`。
- 字体：日文用 `"Noto Serif CJK JP"`（标题）+ `"Noto Sans CJK JP"`（正文），系统已有，不要联网取字体。
- 版式用 CSS 变量统一管色板，改配色只改 `:root`。
- 页脚页码用统一 `<span class="pn">NN</span>`，**最后用正则按出现顺序重排**，插页后不用手改。

### 4. 出 PDF 并回渲检查
```
google-chrome --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
  --virtual-time-budget=20000 --no-pdf-header-footer \
  --print-to-pdf=out.pdf deck.html
pdftoppm -png -r 90 out.pdf chk/j   # 拼 montage 逐页看
```
必看三处：标题是否换行挤行、卡片/表格是否溢出页面下沿、图片网格最后一行是否被裁掉。溢出就缩图或改列数（例如 12 张头像用 6×2，不要 4×3）。

### 5. 保守型日本管理层配色（实测有效）
- 底：深藏青 `#1E3247`、墨 `#1B2430`、米白 `#FAF8F3`。
- 品牌高饱和色（霓虹洋红/粉）**只做「点」**：小节编号、标题里一个词、细罫线、左侧竖条渐变；不要大面积铺色。
- 客户品牌视觉图（如霓虹建筑）保留但改双色调/三色调（navy→暖砂），原色辉光全部压掉。
- 人像转灰度或降饱和，截图降饱和 0.5–0.6，整本视觉才统一。
- 字号宁大勿小：1280 宽下正文 17px、卡片正文 15px、表格 15px、H1 40px；页数多时用整幅带（band）和更大的卡片填掉下半页空白。

### 6. 客户方要 PPTX 时
不要用 PDF 转 PPT（整页变图，不可编辑）。用 python-pptx 按同一版面重建：13.333×7.5 in，标题 `Noto Serif CJK JP`、正文 `Noto Sans CJK JP`，色板沿用。
- 封面/扉页的楼体、底纹先用 PIL 合成为整张 2560×1440 背景 PNG，再 `add_picture` 满版铺——pptx 里做透明度很别扭，预合成最省事。
- 由 HTML 通用解析自动排版的，只对「标题+正文+卡片网格+表格」这类简单页可靠；封面、PART 扉页、logo 墙、人像页、双栏案例页必须手写排版函数，否则会丢整块内容或文字重叠。
- 校验：`soffice --headless --convert-to pdf` 后再 `pdftoppm` 拼 montage 逐页看。python-pptx 生成成功不等于版面对；LibreOffice 与 PowerPoint 渲染有差异，仍需人工过一遍。
- 插页后页码和顺序都会错：按 section 顺序重排页码，并确认新页插在该 PART 扉页**之前**（曾把客户 logo 页插到扉页之后）。

### 7. logo 墙与主视觉的两个坑
- 页面标题文字（如「携手共赴海洋新征程」九个字）会被白底卡片检测当成 logo。它们的特征是：集中在页顶一条带、尺寸几乎一致（≈100px 方块）、数量等于标题字数——按 y 带或尺寸一致性整批剔除。
- 客户 logo 必须**按行业分类**呈现（对齐原稿的分组），不要图省事排成一片网格；用各分类卡片的 x/y 范围把每个 logo 归组，再分组分行排。
- 主视觉（像素楼/城市夜景）容易「太黑」。提亮中间调（如 `g*1.55+0.10` 再压 gamma），双色调取 navy→暖砂的浅档，交付前单独出一张缩略图确认明度。

## 交付
- 文件名用**ASCII**（`Brand_JP_2026Q4.pdf`）。中文/日文文件名在飞书等渠道会出现「attachment unavailable」；已发生一次，改用 ASCII 名重发即恢复。
- 附件走 message send 的 `media`，同一条里给「改了什么 + 3 个待确认项」，不要只丢文件。

## 注意
- 原文里的数字（粉丝量、GMV、转化率）必须标明来源/时间点，或明确写「案件ごとに提示」，不要自己补数。
- 客户 logo 属于第三方商标：原样放置即可，不要重绘、不要改色。
- 先确认「保留多少原品牌色」再动手，这是最容易返工的一项。
