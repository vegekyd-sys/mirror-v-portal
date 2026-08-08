---
name: "ppt-master-integration"
description: "触发关键词\"生成PPT\"\"做PPT\"制作PPT\"生成演示文稿\"：收集素材需求→委托Codex执行ppt-master工作流→返回.pptx文件"
---

# PPT Master Integration Skill

> 当用户在飞书私聊中说"生成PPT""做PPT""制作PPT""生成演示文稿""帮我做一个PPT"等关键词时激活。

## 定位

这是一个 **调度 skill**，不直接生成 PPT。它负责：
1. 收集用户素材和需求
2. 委托 Codex 子会话执行 `/home/openclaw/ppt-master` 中的 ppt-master 工作流
3. 将生成的 `.pptx` 文件返回给用户

## 工作流

### Phase 1: 收集需求

向用户确认以下信息（一次性问完，不要分多次）：

1. **素材/主题** — 提供什么？（任选其一或多个）
   - 纯文字主题描述
   - PDF / DOCX / Markdown 文件
   - 网页 URL
   - 已有的 PPTX 模板
2. **风格偏好** — 商务/科技/创意/简约/数据分析/杂志风？不指定则 AI 自行决定
3. **页数** — 预期多少页？不指定则 AI 根据内容判断
4. **语言** — 中文/英文/双语？
5. **特殊需求** — 是否需要图表、动画、语音旁白？

> ⛔ **BLOCKING GATE**：用户确认需求后才能进入 Phase 2。

### Phase 2: 准备素材

1. 如果用户提供了文件，确保文件在 `/home/openclaw/ppt-master/projects/` 下可访问
2. 如果用户提供了 URL，记下 URL 供 ppt-master 的 `source_to_md.py` 处理
3. 如果用户只给了主题（无文件），记下主题文本
4. 复述一遍将要生成的内容，让用户最后确认

> ⛔ **BLOCKING GATE**：用户确认"开始生成"后进入 Phase 3。

### Phase 3: 委托 Codex 生成

启动一个 Codex 子会话来执行 ppt-master 工作流：

**Codex 会话配置：**
- workspace: `/home/openclaw/ppt-master`
- 任务描述: 用中文告诉 Codex 用户的需求，包括素材路径、风格、页数、语言等
- 关键指令: 让 Codex 先读 `skills/ppt-master/SKILL.md`，然后严格遵循 ppt-master 工作流

**给 Codex 的 prompt 模板：**

```
你是 PPT Master 生成助手。请严格按照以下流程执行：

1. 先阅读 skills/ppt-master/SKILL.md 和 skills/ppt-master/workflows/routing.md
2. 根据用户需求选择 Generate PPTX 路由
3. 严格遵循 generate-pptx.md 中的 Step 1-7 流程
4. 使用 .venv/bin/python3 运行所有 Python 脚本
5. 生成完成后，告诉我导出的 .pptx 文件路径

用户需求：
- 素材：[素材路径或主题描述]
- 风格：[用户指定的风格]
- 页数：[用户指定的页数]
- 语言：[用户指定的语言]
- 特殊需求：[用户指定的特殊需求]
```

**监控策略：**
- 启动 Codex 后告知用户"PPT 正在生成中，预计需要几分钟，完成后通知你"
- 不要轮询 Codex 状态，等待完成事件
- 如果超过 10 分钟没有完成，主动查询一次状态

### Phase 4: 交付结果

1. 从 Codex 返回信息中提取 `.pptx` 文件路径
2. 文件路径在 `/home/openclaw/ppt-master/projects/<project>/exports/` 下
3. 通过飞书发送 `.pptx` 文件给用户
4. 附带简要说明：生成了多少页、用了什么风格

## 依赖

- `/home/openclaw/ppt-master/` — ppt-master 仓库（已安装）
- `/home/openclaw/ppt-master/.venv/` — Python 虚拟环境（已安装）
- Codex app-server 端点 — 用于执行 ppt-master 工作流
- 用户素材文件放入 `/home/openclaw/ppt-master/projects/` 目录

## 图片生成说明

ppt-master 默认使用 web 搜索获取图片（免 API key）。如果需要高质量 AI 生成图片，需配置以下环境变量之一：
- `OPENAI_API_KEY` — OpenAI DALL-E / GPT Image
- `ZHIPU_API_KEY` 或 `BIGMODEL_API_KEY` — 智谱 CogView
- `GEMINI_API_KEY` — Google Gemini

这些可在 Codex 会话环境中设置，或在 `/home/openclaw/ppt-master/.env` 中配置。

## 故障处理

| 问题 | 处理 |
|------|------|
| Codex 会话无响应 | 等待最多 10 分钟，然后 codex_session_read 检查进度 |
| 生成的 PPT 内容不对 | 让用户指出具体问题，重新委托 Codex 修正 |
| 图片获取失败 | 告诉用户 web search fallback 的结果，或建议配置 API key |
| source_to_md.py 转换失败 | 检查文件格式是否支持，尝试手动提供文本内容 |
