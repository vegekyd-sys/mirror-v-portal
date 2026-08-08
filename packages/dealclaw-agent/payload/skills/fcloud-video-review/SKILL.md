---
name: "fcloud-video-review"
description: "FCloud全量拉取优质视频→数据完整性验证→vision+ASR复盘→飞书表格输出。含分页、去重、API限流检测、导出兜底。"
---

# Revision: FCloud API 数据完整性修复

## Coach Preflight

### 1. Reusable Trigger ✅
触发条件不变：用户要求对FCloud分组做TikTok优质视频复盘。

### 2. Capability Amplified ✅
> 帮助模型检测并处理FCloud API数据不完整的问题，通过count验证 + fallback路径确保排名不遗漏高质量视频。

### 3. Judgment vs Machine Rules
- **模型判断**: 判断是否数据不完整 — 对比api账号列表的works数与api返回实际条数
- **用户确认**: 如果数据不完整，向用户请求后台导出xlsx文件
- **机器合约**: FCloud鉴权、lark-cli sheets写入不变

### 4. Background Routing ✅
已正确分类为background-worthy，不变。

### 5. Sibling Coverage
无直接兄弟技能。

### 6. Boundaries
新增: 数据不完整时必须告知用户、不得在缺失数据下继续排名。

### 7. Failure Modes
新增: API数据不完整 → 验证gate → 请求导出 → 兜底xlsx读取

---

## 具体改动

### 改动1: Step 2 — 新增数据完整性验证 Gate

在 `### 作品列表（按账号逐个拉）` 之后新增:

```markdown
### 数据完整性验证 Gate（必须执行）

⚠️ **FCloud API `query-works` 端点已知限制**：对于单账号视频数多的情况（>100条），即使使用分页参数 `nextCursor`，API 仍可能只返回约 100 条数据，导致遗漏非首页的高质量视频（如14-18%赞播率的高互动内容）。

验证步骤：
1. 对比账号列表中的 `works` 字段（总作品数）与实际拉取条数
2. 如果差值 > 5% 或实际条数 < 100 但 works 数 > 100，标记为 **数据不完整**
3. 数据不完整时：
   - **不得**在缺失数据下继续排名和分析
   - 告知用户检测到数据不完整，无法继续
   - 请求用户从 FCloud 后台导出完整数据（xlsx格式）发送给我
   - xlsx 通常包含完整字段：视频标题、播放量、点赞数、评论数、分享数、发布时间、发布账号、账号分组、分享链接
4. 如果用户提供了 xlsx，使用 `openpyxl` 读取并替代 API 数据进入 Step 3
```

### 改动2: 常见陷阱表 — 新增条目

在已有陷阱表末尾追加：

```markdown
| API数据不完整 | 排名漏掉高赞视频（比如14-18%赞播率的内容全在第二页之后） | 对比accounts的works计数与api实际返回条数，差值大则标记不完整并请求导出 |
```

### 改动3: Step 1 鉴权说明 — 新增 endpoint 注释

在 `### Step 1：FCloud 鉴权` 末尾追加:

```markdown
**Endpoint 说明**: 当前生产环境为 `https://prod-api.xxfcloud.com`。使用 `work/phone-remote-control/fcloud/common.py` 中的 `load_config()` + `login()` + `request()` 进行鉴权和API调用。
```

### 改动4: 前置依赖 — 新增 openpyxl

```markdown
- Python 库：`cryptography`, `pycryptodome`, `requests`, `openpyxl`（用于读取用户导出的 xlsx 兜底）
```

### 改动5: Step 10 — 错误处理（新增）

新增一节:

```markdown
## Step 10：API 数据不完整时的兜底处理

### 检测逻辑
```python
# Verify completeness
resp = request('/user-res/open-api/account/query-list', {'pageSize': 100, 'mediaApp': 2}, token, cfg)
accounts = resp.get('data', [])
for a in accounts:
    works_count = a.get('works', 0)
    pulled_count = count_videos_pulled(a['acctId'])
    if works_count > 0 and pulled_count < works_count * 0.95:
        incomplete = True
```

### 兜底：读取用户导出的 xlsx
```python
import openpyxl
wb = openpyxl.load_workbook('导出作品数据.xlsx')
ws = wb.active
# Headers: 视频标题, 播放量, 点赞数, 评论数, 分享数, 发布时间, 发布账号, 账号分组, 分享链接
videos = []
for r in range(2, ws.max_row+1):
    videos.append({
        'title': ws.cell(r,1).value,
        'views': ws.cell(r,2).value or 0,
        'likes': ws.cell(r,3).value or 0,
        'comments': ws.cell(r,4).value or 0,
        'shares': ws.cell(r,5).value or 0,
        'pub': str(ws.cell(r,6).value or ''),
        'acct': str(ws.cell(r,7).value or ''),
        'group': str(ws.cell(r,8).value or ''),
        'url': str(ws.cell(r,9).value or ''),
    })
```

**当从 xlsx 兜底时**，Step 5（视频下载）仍然需要调用 FCloud API 的 `query-works` 获取 `localUrl` 来下载视频帧，但排名和选取基于 xlsx 完整数据。

### Failure Mode 补充
- **API数据不完整**: 不要强行排名。标记为不完整并请求导出。宁可延迟交付也不要基于残缺数据出结论。
