---
name: "d12-video-tool-test"
description: "DAM + AutoFlow 测试服视频工具集。通过 d12-claw CLI 完成素材查询、视频生产、模板调用、智能体全流程。"
---

# d12-video-tool-test — DAM + AutoFlow 测试服

## 核心能力

通过 `d12-claw` CLI 完成视频生产全流程：素材管理 → 大纲生成 → 文案生成 → TTS 配音 → 模板调用 → 导出。

## 触发条件

**触发：** 用户要求用 d12 工具集做视频、查素材、调模板、管理 DAM 项目。

**不触发：** Makaron 图像/视频生成（走 Makaron skill）。

## 环境

- 测试服 Java 后端：`https://d12-test.ultronx.tech/api`
- Python 模板 API：`https://template-api-test.ultronx.tech/ai/template/insert_blocking`
- 代码仓库：`git.versa-ai.com/yongjian.zheng/ai-template`（V-1.0 分支）
- 本地路径：`/tmp/ai-template-new`
- 环境变量：`AI_TEMPLATE_PATH=/tmp/ai-template-new`

## CLI 命令树

### user — 用户相关
```bash
d12-claw user get-user-project <account>    # 查用户项目列表
d12-claw user login <account>               # 登录鉴权
```

### resource — 资源查询
```bash
d12-claw resource tts --language zh-CN      # 查 TTS 音色列表
d12-claw resource animations                # 查可用动效
d12-claw resource fonts                     # 查字体列表
```

### produce — 视频生产（分步）
```bash
d12-claw produce cached-data --task-id <id> --user-name <user> --project-id <pid>
d12-claw produce generate-outline --task-id <id> --project-id <pid> --requirements "..." --count N
d12-claw produce generate-text --task-id <id> --project-id <pid> --query "..." --count N
d12-claw produce generate-voice --task-id <id> --content "..." --speaker "Vivi 2.0" --language 中文
d12-claw produce export --task-id <id> --draft-json '{...}'
```

### template — 视频模板（7 个模板）
```bash
d12-claw template dubbing-mix       # 配音混剪（模板2）
d12-claw template dubbing-range     # 配音混剪（模板3）
d12-claw template dubbing-generator # AI 生成优先（模板7）
d12-claw template mix               # 沉浸式（模板4）
d12-claw template mix-v2            # 沉浸式 v2（模板6）
d12-claw template origin-sound      # 原声混剪（模板5）
d12-claw template human-opening     # 人物开场（模板8）
```

### agent — 智能体全流程
```bash
d12-claw agent plan --account <user> --requirements "..."     # 分析需求生成计划
d12-claw agent run --account <user> --requirements "..."      # 一键全流程执行
d12-claw agent review --task-id <id>                            # 审核结果
```

## 部署信息

- 部署路径：`/tmp/ai-template-new`
- CLI 入口：`/usr/local/bin/d12-claw`（软链 → `skill-test/d12-claw`）
- 素材目录：`/versa/deepin/ai-template/files-dev`

## 安全边界

- 不操作正式服环境
- production deploy 用 `DEPLOY-PROD.md`
- 不删除项目、不覆盖配置
