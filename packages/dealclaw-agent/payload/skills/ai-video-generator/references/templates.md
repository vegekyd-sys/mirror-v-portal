# AI 视频生成模板列表

系统内置 7 种视频生成模板，每种模板有不同的生成策略和适用场景。

| ID | 名称 | 说明 | 有配音 | AI 生成素材 | 转场效果 |
|----|------|------|--------|------------|----------|
| `mix_template_v2` | 沉浸混剪v2 | 无配音，DAM 搜索匹配素材，无过渡处理 | ❌ | ❌ | ❌ |
| `dubbing_generator` | AI配音生成 | 配音混剪，AI 生成视频优先，DAM 兜底 | ✅ | ✅ | ✅ |
| `origin_sound_mix` | 原声混剪 | 无配音，保留素材原生音频 | ❌ | ❌ | ✅ |
| `dubbing_mix` | 配音混剪 | 标准配音混剪，LLM 动态分段，DAM 匹配素材 | ✅ | ❌ | ✅ |
| `dubbing_script_range_mix` | 脚本配音 | 配音混剪，按字幕时间点固定素材区间 | ✅ | ❌ | ✅ |
| `opening_human_generator` | 数字人开场 | 数字人形象口播开场 + 素材混剪 | ✅ | ✅ | ✅ |
| `mix_template` | 沉浸混剪v1 | 无配音沉浸式混剪，随机区间，含转场过渡效果 | ❌ | ❌ | ✅ |

## 模板选择建议

- **快速无配音视频**: 使用 `mix_template_v2` 或 `mix_template`
- **标准配音视频**: 使用 `dubbing_mix`
- **AI 生成优先**: 使用 `dubbing_generator`
- **保留原声**: 使用 `origin_sound_mix`
- **精确时间控制**: 使用 `dubbing_script_range_mix`
- **品牌/人物口播**: 使用 `opening_human_generator`

## enabled_templates 字段行为

- `null` 或不传 → 启用全部 7 种模板（Agent 自动选择最佳模板）
- `[]` 空列表 → 启用全部模板
- 指定列表如 `["dubbing_mix", "dubbing_generator"]` → 仅使用这 2 种模板
