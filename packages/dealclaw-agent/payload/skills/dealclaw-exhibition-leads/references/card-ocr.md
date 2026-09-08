# 名片 OCR 契约（内部，勿对外暴露）

> 本文件是 DealClaw 内部实现契约，不对外、不对租户暴露。
> 视觉模型由平台管理员在「模型供应商」全局库配置一次，自动推所有租户，租户无需任何配置。

## 调用方式

名片照片 → 视觉模型（`view_image`，走系统 `imageModel`）→ 结构化 JSON。

- 首选路径：OpenClaw `view_image` 工具，由全局配置的系统视觉模型读图。
- 无需在 skill 内持有 API Key —— Key 由平台「模型供应商」页加密存储（AES-256-GCM，后台只回显掩码），**绝不写入本文件 / 仓库 / 对话 / 日志**。

## 部署前提（全局，一次配置，所有租户生效）

系统视觉模型（`imageModel`）由平台「模型供应商」全局库配置，任意带 `:vision` 标记的模型即可，无需专用 OCR 模型、无需额外 key。

- 当前系统视觉模型：`foldin-xiaoyuan/gpt-5.4`（`gpt-5.4` 在模型列表标 `(v)` = vision）
- API Key 由管理员在后台「模型供应商」页录入，加密存储，不回显明文。
- 未配置时 `view_image` 不可用 → 降级为「仅人工录入名片信息」，标 `⚠️ 数据不全`，不阻塞后续。

## 提取 Prompt（给视觉模型的指令模板）

```
这是一张名片。请提取以下字段，输出严格 JSON（键名固定英文）：
company_name, name, title, phone, email, website, address, country。
识别不清的字段值置空字符串；不确定的形近字记入 uncertain 字段。
只输出 JSON，不要任何解释文字。
```

## 字段契约（输出 JSON）

| 键 | 含义 | 规则 |
|---|---|---|
| `company_name` | 公司名 | 保留原文大小写 |
| `name` | 姓名 | 保留原文 |
| `title` | 职位 | 保留原文 |
| `phone` | 电话 | 多号码用 `; ` 分隔 |
| `email` | 邮箱 | — |
| `website` | 网址 | — |
| `address` | 地址 | 保留原文 |
| `country` | 国家 | 名片未直接标注 → 置空，标 `⚠️ 待补充`；可从区号/地址推断但**不落库**，等用户确认 |
| `uncertain` | 不确定项 | 形近字/拿不准的记这里 |

## 规则

- 反光 / 模糊 / 字段缺失 → 对应字段置空 + 标 `⚠️ 待补充`，不脑补。
- 形近字（擎/挚、舜/舸、染/梁等）拿不准 → 记入 `uncertain`，标 `⚠️` 请用户确认，不硬猜。
- 多语言名片 → 保留原文，必要时附中文转写。
- 结果先展示给用户确认，确认后才进入匹配 / 意图分析（沿用五步确认门）。
- GDPR 门不可跳过：含邮箱/电话等联系人信息，获得同意后才存储/落库。

## 实测样例（2026-09-08 验证 OCR 链路可用）

> 实测用火山方舟 `doubao-seed-evolving` 验证了「名片 → 结构化 JSON」链路；
> 生产环境走系统视觉模型（当前 `foldin-xiaoyuan/gpt-5.4`），流程一致。

输入：绿色名片一张（Toni Vo, THANH PHONG EXIM TRADING INVESTMENT CO., Ltd）。

输出：

```json
{
  "company_name": "THANH PHONG EXIM TRADING INVESTMENT CO., Ltd",
  "name": "TONI VO",
  "title": "Deputy Director",
  "phone": "0909 323 689; (+84) 28 2262 6969",
  "email": "toni@pltp.vn",
  "website": "phulieuthanhphong.vn",
  "address": "82, Dong Hung Thuan 5 Str, Tan Hung Thuan, Dis 12, HCMC",
  "country": "",
  "uncertain": ""
}
```

> `country` 置空（名片未直接标注国家）；区号 `+84` 与 `HCMC` 可推断越南，但按规则不落库，等用户确认。
