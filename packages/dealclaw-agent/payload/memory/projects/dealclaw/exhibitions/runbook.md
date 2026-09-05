# 9/8 墨西哥展联调运行说明（runbook）

> 状态：2026-09-06 代码冻结，等 9/8 真实慧记/慧译数据。
> 目标：真实数据回来 → 留存原始响应 → 识别字段 → 重放调试 → 验证通过后正式写入。

## 命令位置

`work/mio-api/dc_meeting_capture.py`（联调命令），依赖 `dc_meeting_ingest.py` + `dc_opportunity_stage.py`。

## 流程（严格按顺序，别跳步）

### 1. 首次先 capture + dry_run（默认 dry_run，别加 --no-dry-run）

```bash
python3 work/mio-api/dc_meeting_capture.py --source note      --supplier-id <sid> --exhibition-id <exid> --page 1 --page-size 10
python3 work/mio-api/dc_meeting_capture.py --source translate --supplier-id <sid> --exhibition-id <exid> --page 1 --page-size 10
```

- raw 会完整保存（一字不丢），只脱敏进日志。
- 若 `records` 空，看 `empty_check` 区分三态：`no_data`（确实没数据）/ `api_error`（接口失败）/ `pagination_or_field_error`（total>0 但 records 空，多半分页或字段错）。

### 2. 人工看诊断报告

重点看这几项：
- `schema.unrecognized_fields`：真实接口返回的、adapter 没假设的字段（需补进 adapter）。
- `schema.missing_assumed_fields`：adapter 假设了但真实没返回的字段（需删/改假设）。
- `evidence_success_rate`：evidence 定位成功率，低说明原文和提取对不上。
- `unattributed_records`：无法归属 customer/opportunity 的记录。
- `standardized_count`：成功标准化的数量。

### 3. 校准 adapter 字段名

按诊断报告改 `dc_meeting_ingest.py` 的字段映射：
- 慧记：`NOTE_ID_FIELDS` / `NOTE_TEXT_FIELDS`
- 慧译：`TRANSLATE_ID_FIELDS` / `TRANSLATE_TEXT_FIELDS`

然后用 `--replay-file` 离线重跑（不调真实接口）：

```bash
python3 work/mio-api/dc_meeting_capture.py --replay-file /path/to/note_fixture.json      --supplier-id <sid> --exhibition-id <exid>
python3 work/mio-api/dc_meeting_capture.py --replay-file /path/to/translate_fixture.json --supplier-id <sid> --exhibition-id <exid>
```

同一 fixture 多次 replay 结果应一致。

### 4. 验证通过后才正式写入

确认 `proposed_stage` / `status` / `evidence` 都合理后，才加 `--no-dry-run` 正式写入 memory。否则保持 dry_run 不落库。

## 安全边界（不可绕）

- raw 文件保存完整原文，不脱敏；日志/诊断才脱敏（`log_safe_view`）。
- `evidence_verified` 只由本地 `verify_evidence` / `verify_evidence_from_raw` 计算，上游传入的一律清除。
- FileRawLoader 拒绝路径穿越 / 绝对路径 / 符号链接越界，校验 hash/编码/大小。
- 读取失败返回结构化错误，绝不静默降级为 confirmed。
