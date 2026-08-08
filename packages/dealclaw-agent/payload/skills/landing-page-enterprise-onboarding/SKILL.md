---
name: "landing-page-enterprise-onboarding"
description: "企业落地页全流程：接收资料→提取信息→生成落地页→部署→知识库登记→线索闭环"
---

# Landing Page 企业入驻全流程

## 触发条件
宏洋或宋鹏宁在飞书群 @V 告知企业资料和名称。

## 执行规范
每步必须实时输出到群聊：`📥 [1/12] 步骤名...` + 接口调用结果 + ✅/❌。

## 全流程 12 步

### 📥 [1/12] 获取企业 partnerId
```
POST /auth/login { account:"admin", password:"..." }
POST /auth/getUserPageList { nickName:"企业名称", status:0 }
  → partnerId = pageResult[0].id
```

### 📁 [2/12] 下载企业资料文件
V 通过 lark-cli 下载飞书附件到本地。

### ☁️ [3/12] 上传文件到 OSS（海外加速，无大小限制）
```
POST /oss/preSign { dir:"knowledge/<slug>", filename:"xxx.pdf" }
  → uploadUrl + ossKey

PUT <uploadUrl> --upload-file <file>
  → 直传 OSS（oss-accelerate.aliyuncs.com，59MB≈10秒）

POST /knowledge/file/register { sourceCode, fileName, fileType, fileSize, ossKey }
  → 登记到 company_knowledge_file
```

### ⚙️ [4/12] 创建/更新 business_source_config
```
POST /business/source/create { sourceCode, partnerId, landingToken, remark }
  → 已存在则 POST /business/source/update { id, partnerId }
```

### 🎨 [5/12] 上传企业 Logo
从资料提取 logo（PNG 透明背景），调 /hotVideo/upload：
```
POST /hotVideo/upload { file: <logo.png> }
  → 返回 OSS URL
POST /business/source/update { id, logoUrl: "<OSS URL>" }
```
⚠️ 提取失败 → logoUrl 置空，流程结束告知"需手动补充 Logo"

### 🌐 [6/12] 保存多语言配置
```
POST /business/source/i18n/save
{
  "partnerId": <partnerId>,
  "names": {
    "zh": { "name":"戴诺维 Denovi", "description":"全屋整装定制配套·公寓酒店家具定制" },
    "en": { "name":"Denovi Furniture", "description":"Whole-House Custom Furniture Specialist" },
    "id": { "name":"Denovi Furniture", "description":"Furnitur Kustom Seluruh Rumah & Hotel" }
  }
}
```
description 20字以内，从附件提取，多样化有代表性

### 🏗️ [7/12] 提取信息 + 生成落地页
按 landingpage/RULES.md 生成 src/enterprises/<slug>/ 的 index.ts + 三语 locale + 资源文件。
tsc + vite build 通过后 git push。

### 🚀 [8/12] 部署测试环境
```bash
bash scripts/deploy.sh feat/multi-enterprise TEST
```
→ Jenkins → ACR → ArgoCD → ACK

### 🔗 [9/12] 回写落地页链接
```
POST /business/source/update { id, landingUrl: "https://landing-test.ultronx.tech/enterprise/<slug>" }
```

### 📋 [10/12] 验证线索闭环
```
POST /business/create { source:"<slug>", ... } → 入库成功
```

### 📊 [11/12] 文件列表确认
```
POST /knowledge/file/list { sourceCode } → 确认文件已入库
```

### ✅ [12/12] 完成报告
逐项检查：
- ✅/⚠️ Logo 状态
- ✅/⚠️ i18n 状态
- ✅ 落地页 URL
- ✅ 线索可提交
- ✅ 文件已入库

## 关键测试凭证
- 测试 API: `https://d12-test.ultronx.tech/api`
- 测试前端: `https://landing-test.ultronx.tech`
- 管理员: admin / v22+jGEEnHiW3SjIl5zwSQ==
- OSS 加速: oss-accelerate.aliyuncs.com
