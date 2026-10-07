# HTML 海报 / 商机卡：Playwright 出图踩坑与版式规则

来源：2026-08-06 越南工业行买家拜访海报 ×3（memory/2026-08-06.md）、2026-08-13 Gulfood 商机卡 QC（memory/2026-08-13.md）。

## 渲染
- Playwright headless Chrome 和 html2canvas 都没有 emoji 字体，emoji 会变空白方块：一律用纯文本或 CSS 图形替代。
- chromium_headless_shell 缺失时手动 `npx playwright install chromium`。
- `body { overflow:hidden }` 会截掉超出部分，底部卡片频繁被裁；出图前核对总高度。
- 飞书转发的照片可能被压缩或丢原图，需要原图时请用户重发。

## 版式
- 卡片等距：固定高度 + 绝对定位，每张卡设精确 height/top，间距统一（约 28–35px）。
- 验证过的版式结构可以跨客户复用，只换配色和内容（例：TRUMPF 蓝版结构复用到红金版）。
- 多品类用一个标签加全品类字符串（如"豆类·大米·油·糖"），不要每个 tag 都贴一次"采购品类"。
- 多联系人时，联系人块只放 姓名/职位/电话/邮箱 并保持对称；公司级字段（国家/展会/行业/官网）只在底部出现一次。
- 文案视角：看海报的是客户（中国展商），突出"买家需要什么"，不是"我们拜访了谁"。

## 交付
- 可编辑交付用自包含 HTML（base64 图片 + html2canvas），比起本地服务器更容易交付。

## HTML → PDF（A4 手册 / 文档式报告）
- 固定 A4 页数和页高时，WeasyPrint 比 Chrome/Puppeteer 稳：每页设成固定 A4 高度，内容区用 flex/grid 撑满，能明显减少半页空白。HTML 转 PDF 要写专门的 print CSS，直接搬网页 CSS 到 WeasyPrint 基本没用；`CSS Grid + break-inside: avoid` 会把内容挤在页面上方或留下大块空白。（2026-06-09 PDF 手册排版，reflections/2026-06-09.jsonl#3）
- 验收不能只看 `pdfinfo` 页数：每页转图（如 `pdftoppm -png -r 100`）拼成 contact sheet 逐页看，核页数、空白比例、字号可读性、有无空白页，最后确认附件真的发出去了。（同上；2026-09-21 奥创小报告 WeasyPrint 链路沿用同一套逐页截图核验，memory/2026-09-21.md）
- 系统 Python 装不上包（PEP 668）就建 venv 装 `weasyprint`；要复现样例版式时用和样例 Producer 相同的 WeasyPrint 版本。（2026-09-21）
