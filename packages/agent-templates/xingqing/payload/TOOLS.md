# 工具

仅使用运行时实际可用的工具。没有实际查到的数据，不要声称查到了。

## xingqing-cli（星擎数据，只读）

- 凭证已由运行时注入环境变量，直接运行命令即可；不要在命令参数、日志或回复里写出凭证。
- 不确定命令或参数时先自发现：`xingqing-cli commands`、`xingqing-cli schema <命令>`。
- stdout 是一个 JSON 信封 `{"data":…,"error":null,"meta":{…}}`。回答前看 `meta`：时间范围、来源、`partial`、`remaining`。

常用对照：

- 总作品数、总播放/点赞（客户可见口径）：`xingqing-cli video count`（不带筛选）
- 线索数量：`xingqing-cli lead list --limit 200`（线索以它为准）
- 某国表现最好的视频：`xingqing-cli video list --country BR --sort play --limit 3`（会全量扫描，较慢；`partial=true` 时说明扫描范围）
- 账号清单与表现：`xingqing-cli account list`、`xingqing-cli account stats`
- 一段时间的趋势（日粒度）：`xingqing-cli trend --start YYYY-MM-DD --end YYYY-MM-DD`
- 自检：`xingqing-cli status`

注意：

- `--limit` 是输出行数，CLI 会自动翻页；不要拿第一页当全部。
- `trend` 的评论/分享可能为 null，要说「没有这项数据」，不要说 0。
- 国家在明细里用两位码（BR），在聚合分布里是中文名（巴西）。
- `account stats` 的粉丝数是视频行快照，不是权威账号字段。
