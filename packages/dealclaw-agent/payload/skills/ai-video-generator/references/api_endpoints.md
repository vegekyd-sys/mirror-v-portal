# Agent AI 视频生成系统 — 完整 API 参考

## 服务器地址

| 服务 | URL | 用途 |
|------|-----|------|
| Python AI 模板服务 | `https://template-api-test.ultronx.tech` | 任务提交、进度查询、日志、系统监控 |
| Java 后端服务 | `https://d12.ultronx.tech/api` | 素材库列表、语言列表 |
| 本地开发服务 | `http://localhost:8080` | 本地开发时的 API 入口（等同 Python 服务） |

**默认配置:** Python 服务为 `https://template-api-test.ultronx.tech`，本地开发时改为 `http://localhost:8080`。

---

## 全部 API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/agent/submit` | 提交一个视频生成任务 |
| GET | `/api/agent/tasks` | 查询所有任务列表（轻量） |
| GET | `/api/agent/progress/{taskid}` | 查询任务进度、日志、结果 |
| GET | `/api/agent/libraries` | 获取视频/音频素材库列表 |
| GET | `/api/agent/languages` | 获取 TTS 支持的语言列表 |
| DELETE | `/api/agent/tasks/{taskid}` | 删除任务 |
| GET | `/api/system/stats` | 获取服务器性能信息 |

---

## 1. POST /api/agent/submit — 提交任务

### Request Body (JSON)

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `taskid` | string | 是 | 任务唯一标识，重复提交被拒绝 |
| `user_name` | string | 是 | 用户名（用于素材库权限） |
| `dam_video_library_id` | string | 是 | 视频素材库项目 ID |
| `dam_audio_library_id` | string | 是 | 音频素材库项目 ID |
| `language` | string | 是 | 目标语言，如 "中文"、"English" |
| `video_count` | int | 是 | 目标生成视频数量，>= 1 |
| `user_requirement` | string | 是 | 用户需求描述（越详细效果越好） |
| `enabled_templates` | list[string] | 否 | 启用的模板 ID 列表；null 或空=全部模板 |

### Response

```json
// 成功入队
{ "taskid": "xxx", "state": "queued", "queued_count": 3 }

// 重复提交
{ "taskid": "xxx", "state": "duplicate", "queued_count": 3 }
```

---

## 2. GET /api/agent/tasks — 任务列表

### Response

```json
{
  "tasks": [
    {
      "taskid": "admin_756_708_中文_2_a1b2c3d4",
      "status": "running",
      "percent": 60,
      "completed_count": 3,
      "total_count": 5,
      "submit_time": "2025-08-04 10:00:00",
      "start_time": "2025-08-04 10:00:05",
      "finish_time": null
    }
  ]
}
```

状态值: `pending`, `running`, `completed`, `failed`

---

## 3. GET /api/agent/progress/{taskid} — 任务进度

### Query Parameters

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `last_lines` | int | 50 | 返回日志的最后 N 行 |
| `offset` | int | 0 | 日志偏移行数（增量轮询用） |
| `isclearfile` | bool | false | true=结束后删除本地临时文件 |
| `return_zip` | bool | false | true=打包进度快照返回 OSS URL |

### Response

```json
{
  "taskid": "xxx",
  "status": "running|completed|failed|not_found|pending",
  "progress": "3/5",
  "percent": 60,
  "completed_count": 3,
  "total_count": 5,
  "log_lines": ["[时间] 日志内容...", "..."],
  "result_zip_url": "",
  "progress_zip_url": "",
  "completed_videos": [
    {
      "title": "视频标题",
      "template_id": "dubbing_mix",
      "direction": "产品评测方向",
      "mp4_url": "https://oss.xxx.com/video.mp4",
      "topic_id": "topic_001"
    }
  ],
  "summary": "## 执行总结\n对模板 X...",
  "error": "",
  "files_cleared": false
}
```

### 状态流转

```
pending → running → completed
                  → failed
```

| 状态 | 建议处理 |
|------|----------|
| `pending` | 继续轮询（3-5 秒间隔） |
| `running` | 继续轮询，展示进度和日志 |
| `completed` | 停止轮询，使用 result_zip_url 下载 |
| `failed` | 停止轮询，查看 error 字段 |
| `not_found` | 检查 taskid 是否正确 |

---

## 4. GET /api/agent/libraries — 素材库列表

### Query Parameters

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `account` | string | 是 | 用户名，如 "admin" |

### Response

```json
{
  "success": true,
  "video_libraries": [
    { "id": "756", "projectName": "科技产品素材库", "totalCount": 1500 }
  ],
  "audio_libraries": [
    { "id": "708", "projectName": "背景音乐库", "totalCount": 300 }
  ]
}
```

---

## 5. GET /api/agent/languages — 语言列表

### Response

```json
{
  "success": true,
  "languages": ["中文", "English", "日本語", "한국어"]
}
```

---

## 6. DELETE /api/agent/tasks/{taskid} — 删除任务

**限制:** 仅 pending/completed/failed 状态可删除，running 状态不可删除。

### Response

```json
{ "success": true }
// 或
{ "success": false, "error": "任务正在运行中，无法删除" }
```

---

## 7. GET /api/system/stats — 服务器性能

### Response

```json
{
  "cpu_percent": 45.2,
  "memory_percent": 62.8,
  "memory_used_gb": 10.1,
  "memory_total_gb": 16.0,
  "disk_percent": 55.3,
  "disk_used_gb": 110.6,
  "disk_total_gb": 200.0
}
```

---

## 典型轮询模式

```
1. POST /api/agent/submit → 获取 taskid
2. 每 3-5 秒 GET /api/agent/progress/{taskid}?last_lines=50
3.   - 展示 percent、completed_count/total_count
4.   - 增量展示 log_lines
5.   - 展示 completed_videos 中的视频
6. 状态变为 completed → 获取 result_zip_url 下载
7. 状态变为 failed → 展示 error
```
