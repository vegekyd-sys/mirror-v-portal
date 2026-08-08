# SKILL.md — 米奥兰特数据圈选

## 技能概述

`selection` CLI 工具，提供米奥兰特数据圈选的快速命令行访问能力。封装了展商搜索、买家搜索、公司画像、贸易洞察、参展历史等功能，Agent 调一条命令即得结果。

## 触发条件

- 用户提到"搜索展商"、"查买家"、"圈选"、"公司画像"、"贸易数据"、"参展历史"、"产品标签"
- 用户需要米奥兰特数据库的查询操作

## 前置条件

- `selection` 脚本已被安装到 PATH
- 环境变量 `SELECTION_API` 指向部署的 API 服务（默认 `http://121.199.25.223:8080`）

## 快速安装

```bash
# 下载脚本
curl -o /usr/local/bin/selection https://codeup.aliyun.com/.../selection
chmod +x /usr/local/bin/selection

# 设置 API 地址
export SELECTION_API=http://121.199.25.223:8080
```

## 命令参考

### 展商圈选

```bash
# 获取行业列表
selection industries

# 按行业搜索展商
selection search --industry "宠物" --pageSize 10
selection search --industry "工业机械" --country "德国"
selection search --keyword "海狮"

# 行业圈选（自动翻页）
selection cdp --industry "宠物" --max-results 100
selection cdp --industry "建材" --country "德国" --max-results 500

# 公司完整画像（传入统一社会信用代码）
selection company --id "91321181663286492K"

# 贸易洞察
selection trade --company-id "91321181663286492K"
selection trade --company-id "91321181663286492K" --start-date "202401" --end-date "202412"

# 参展历史
selection exhibitions --company-id "91321181663286492K"

# 产品标签
selection products --company-id "91321181663286492K"
```

### 买家搜索

```bash
# 按行业搜索买家
selection buyers --industry "宠物" --pageSize 10
selection buyers --industry "工业机械" --country "US"

# 买家统计
selection buyer-stats --dimension country
selection buyer-stats --industry "114" --dimension country
```

## 核心参数

| 参数 | 说明 | 示例 |
|------|------|------|
| `--industry` | 行业中文名称 | 宠物、工业机械、建材 |
| `--country` | 展会国（展商）/国家ISO码（买家） | 德国、印尼、US、MX |
| `--keyword` | 公司名/简介关键词 | 海狮、apple |
| `--pageSize` | 每页条数 | 20（默认） |
| `--id` / `--company-id` | 统一社会信用代码（税号） | 91321181663286492K |

## 典型工作流

### 1. 查找某行业展商
```bash
# 先查看行业列表
selection industries
# 搜索
selection search --industry "宠物" --pageSize 5
# 深入查看某个公司
selection company --id "91210203665842819N"
```

### 2. 展会国家筛选
```bash
selection search --industry "宠物" --country "德国"
```

### 3. 买家分析
```bash
selection buyers --industry "宠物" --country "US" --pageSize 5
selection buyer-stats --industry "114" --dimension country
```

## 返回格式

所有命令输出均为 JSON，包含 `total` 和具体数据字段。

## 架构

```
selection CLI → HTTP → 121.199.25.223:8080 (Spring Boot)
                          ├── supplier.datathink.com (展商API, token认证)
                          └── api.datathink.com (买家API, APPCODE认证)
```

## 维护者

V for Meorient (`v-for-meorient`)

## 最后更新

2026-07-15
