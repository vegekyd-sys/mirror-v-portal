---
name: "landing-page-enterprise-onboarding"
description: "企业落地页全流程：接收资料→提取信息→生成落地页→部署→知识库登记→线索闭环。触发词：入驻/走全流程/发资料上线。"
---

# Landing Page 企业入驻全流程

## 触发条件
1. 宏洋或宋鹏宁在飞书群发送 PDF/文件/企业资料 → **自动执行全部 12 步流程**（不单独操作某节点）
2. 宏洋或宋鹏宁在飞书群 @V 明确要求「入驻」「走全流程」「发资料上线」

⚠️ 与前端生成 skill 区分：用户明确说「只生成前端/只出页面/单独生成页面代码」→ 走 `landing-page-frontend-generation`，不走本流程

## 执行规范
每步必须实时输出到群聊：`📥 [1/12] 步骤名...` + 接口调用结果 + ✅/❌。

## 全流程 12 步

### 📥 [1/12] 获取企业 partnerId
```
POST /auth/login { account:"admin", password:"..." }
POST /auth/getUserPageList { nickName:"从PDF提取的企业名称", status:0 }
  → partnerId = pageResult[0].id
```
🛑 **Gate 规则**：
1. 从 PDF 识别公司名称，用多个可能的名称搜索（全称、简称、品牌名、英文名）
2. 找不到 partnerId：**立即暂停并向群内确认**，告知搜索了哪些名称、均未找到，询问「请提供准确的企业名称，或回复'取消'终止本次入驻」
3. 🚫 在用户确认之前**不允许执行后续步骤**
4. 用户提供新名称 → 重新搜索；回复「取消」→ 终止全流程；仍找不到 → 再次确认或让用户先在系统注册合作方

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
