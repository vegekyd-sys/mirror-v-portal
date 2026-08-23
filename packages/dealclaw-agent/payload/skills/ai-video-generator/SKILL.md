---
name: ai-video-generator
description: "AI 视频批量生成任务管理系统。提供提交视频生成任务、查看任务列表/进度/日志、监控任务实时状态、下载结果、删除/清理任务、查看服务器性能等全套能力。当用户需要生成 AI 视频、管理视频生成任务、查看任务进度、下载视频结果、或查询 Agent 任务系统状态时，使用此 skill。触发词：视频生成、AI视频、agent任务、提交视频任务、查看任务、任务进度、下载视频、模板混剪、配音生成、数字人视频、素材库、视频任务管理。"
agent_created: true
---

# AI 视频生成任务管理系统

## 概述

此 Skill 封装了 AI 视频批量生成系统的全部 HTTP API 操作能力。系统后端为 FastAPI 服务，前端为单页 Web 应用。通过此 Skill，WorkBuddy 可以完全替代 Web UI 和 CLI 工具，直接调用 REST API 完成所有任务管理操作。

## 配置

### 默认服务器地址

读取 `assets/config.yaml` 获取当前服务器配置：

- **python_server_url**: Python AI 模板服务（任务提交/进度/日志），默认 `https://template-api-test.ultronx.tech`
- **java_server_url**: Java 后端服务（素材库/语言列表），默认 `https://d12.ultronx.tech/api`
- **default_account**: 默认账号，默认 `admin`
- **default_language**: 默认语言，默认 `中文`
- **default_video_count**: 默认视频数量，默认 `2`

本地开发时，Python 服务地址改为 `http://localhost:8080`。

### 运行时修改配置

- 用户可在对话中指定账号、服务器地址等参数
- 优先使用用户指定的值，未指定时使用配置文件默认值
- 可通过编辑 `assets/config.yaml` 持久化修改

---

## 核心能力

### 1. 提交视频生成任务

调用 `POST {python_server_url}/api/agent/submit` 提交任务。

**必填参数：**
- `taskid` — 任务唯一 ID（如 `admin_756_708_中文_2_随机串`）
- `user_name` — 用户名（默认用 `assets/config.yaml` 中的 default_account）
- `dam_video_library_id` — 视频素材库 ID
- `dam_audio_library_id` — 音频素材库 ID
- `language` — 目标语言
- `video_count` — 目标视频数
- `user_requirement` — 用户需求描述文本

**可选参数：**
- `enabled_templates` — 启用的模板 ID 列表，null/空 = 全部 7 种模板

**工作流：**
1. 如果用户未提供素材库 ID 和语言，先调用 `GET /api/agent/libraries?account={user_name}` 和 `GET /api/agent/languages` 获取可用选项
2. 如果用户未提供 taskid，自动生成格式：`{user_name}_{video_lib_id}_{audio_lib_id}_{language}_{video_count}_{8位随机hex}`
3. 收集所有必填参数后提交
4. 返回 taskid 和提交状态（queued/duplicate）
5. 询问用户是否需要监控任务进度

**用户需求描述指南：**
- 描述视频主题、风格、目标受众
- 越具体效果越好（如"制作一个关于最新iPhone的评测视频，突出拍照功能，风格偏向科技感，面向年轻用户"）
- 可指定特殊要求（如字幕样式、BGM 风格、视频时长偏好）

---

### 2. 查看任务列表

调用 `GET {python_server_url}/api/agent/tasks` 获取所有任务。

返回每个任务的：taskid、status（pending/running/completed/failed）、percent、completed_count、total_count、submit_time、start_time、finish_time。

**向用户展示时：**
- 按状态排序：running > pending > completed > failed
- 用表格展示 taskid、状态、进度百分比、完成数/总数、提交时间
- 标注活跃任务数量

---

### 3. 监控任务实时进度

通过轮询 `GET {python_server_url}/api/agent/progress/{taskid}` 实现实时监控。

**参数：**
- `last_lines` — 返回最后 N 行日志（默认 50）
- `offset` — 日志偏移行数（增量轮询时使用）

**向用户展示：**
- 进度条（百分比 + 完成数/总数）
- 状态标签（pending/running/completed/failed）
- 最新日志行（增量更新）
- 已完成的视频列表（标题、模板、mp4_url）
- 当状态变为 completed/failed 时停止轮询并展示最终结果

**轮询频率：** 建议 3-5 秒间隔。

---

### 4. 查看任务详情

调用 `GET {python_server_url}/api/agent/progress/{taskid}?last_lines=100` 获取完整详情。

**向用户展示：**
- 基本信息：taskid、状态、进度、时间线
- 已完成视频列表（标题、模板、方向、播放链接）
- 日志内容
- 执行总结（Markdown 格式）
- 错误信息（如有）
- 结果下载链接（result_zip_url）

---

### 5. 下载任务结果

方式一：从任务详情的 `result_zip_url` 获取下载链接（任务完成后可用）。
方式二：调用 `GET {python_server_url}/api/agent/progress/{taskid}?return_zip=true` 立即打包进度快照。

**如果用户要求下载到本地：**
- 使用 `result_zip_url` 或 `progress_zip_url` 下载 ZIP 文件
- 默认保存为 `{taskid}.zip`

---

### 6. 删除任务

调用 `DELETE {python_server_url}/api/agent/tasks/{taskid}`。

**限制：** 仅 pending/completed/failed 状态可删除。running 状态需要等待任务结束。

**安全措施：** 删除前确认用户意图。

---

### 7. 清理任务文件

调用 `GET {python_server_url}/api/agent/progress/{taskid}?isclearfile=true`。

仅 completed/failed 状态的任务可清理。清理会删除服务器上的临时文件，释放磁盘空间。

**安全措施：** 清理前确认用户意图。

---

### 8. 服务器性能监控

调用 `GET {python_server_url}/api/system/stats` 获取服务器性能。

返回：CPU 使用率、内存使用率（已用/总量）、磁盘使用率（已用/总量）。

**展示格式：**
```
CPU:  45%  ████████░░░░░░░░░░░░
内存: 63%  ████████████░░░░░░░░  10.1 / 16.0 GB
磁盘: 55%  ███████████░░░░░░░░░  110.6 / 200.0 GB
```

---

## 模板参考

系统内置 7 种视频模板，详见 `references/templates.md`。

| ID | 名称 |
|----|------|
| `mix_template_v2` | 沉浸混剪v2 |
| `dubbing_generator` | AI配音生成 |
| `origin_sound_mix` | 原声混剪 |
| `dubbing_mix` | 配音混剪 |
| `dubbing_script_range_mix` | 脚本配音 |
| `opening_human_generator` | 数字人开场 |
| `mix_template` | 沉浸混剪v1 |

---

## 完整 API 参考

详细的 API 文档参见 `references/api_endpoints.md`，包含所有端点的请求/响应格式、参数说明、状态流转和典型轮询模式。

---

## CLI 工具

`scripts/agent_cli.py` 是一个独立的命令行工具，提供与 Web 前端相同的功能。使用方式：

```bash
python3 scripts/agent_cli.py submit          # 交互式提交任务
python3 scripts/agent_cli.py submit -r "需求" -m  # 命令行提交+自动监控
python3 scripts/agent_cli.py list             # 查看任务列表
python3 scripts/agent_cli.py monitor -t <id>  # 实时监控
python3 scripts/agent_cli.py detail -t <id>   # 查看详情
python3 scripts/agent_cli.py download -t <id> # 下载结果
python3 scripts/agent_cli.py delete -t <id>   # 删除任务
python3 scripts/agent_cli.py clear -t <id>    # 清理文件
python3 scripts/agent_cli.py stats            # 服务器状态
```

CLI 工具依赖：Python 3.8+（仅标准库，无需安装第三方包）。

配置文件：CLI 工具读取同目录下的 `config.yaml`（或通过 `--config` 指定路径），已将模板配置放在 `assets/config.yaml`。

当用户希望通过命令行操作时，可引导使用该脚本。如果用户只需要在对话中操作，直接使用 HTTP API 即可。

---

## 工作流决策树

当用户提出与视频生成/任务管理相关的请求时：

1. **"生成视频" / "制作视频" / "提交任务"** → 先获取素材库和语言列表 → 收集参数 → 提交任务 → 询问是否监控
2. **"查看任务" / "任务列表" / "有哪些任务"** → 调用任务列表接口 → 用表格展示
3. **"任务进度" / "监控"** → 启动轮询 → 实时展示进度/日志 → 完成时展示结果
4. **"查看详情" / "任务详情"** → 调用 progress 接口 → 完整展示
5. **"下载结果" / "下载视频"** → 确认 taskid → 下载 ZIP
6. **"删除任务"** → 确认 → 删除
7. **"清理文件" / "释放空间"** → 确认 → 清理
8. **"服务器状态" / "性能"** → 调用 stats 接口 → 可视化展示
