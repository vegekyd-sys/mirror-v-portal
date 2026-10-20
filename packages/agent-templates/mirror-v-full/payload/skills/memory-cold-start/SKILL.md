---
name: memory-cold-start
description: 记忆冷启动：主人的记忆是空的时候，把他已有的记忆来源（飞书文档库、官网与公开主页、别的 AI 助手里的记忆、粘贴的资料）接进来，落盘后交给夜间 Memory Librarian 编译成 wiki。适用于首次对话（BOOTSTRAP.md）、记忆为空、主人给了网址、主人说「把我的资料 / 我们公司的资料整理进来」「把我在 ChatGPT 里的记忆搬过来」「把飞书里的文档读进去」。不适用：普通派活、群聊、定时任务（那里看不到主人，也不该开口要资料）。
---

# 记忆冷启动

## 分工

| 谁 | 做什么 |
|---|---|
| **你（真人轮里）** | 找原料、让主人选、把原料**原样**落盘 |
| **采集器** `scripts/onboard-collect.py` | 原文进 `memory-archive/imports/`（不进检索索引）、脱敏、记 MANIFEST、体积闸门、git 提交 |
| **Librarian 队列** `scripts/librarian-daily-queue.py` | `kind=import` 把 MANIFEST 里 pending 的文档切成 ≤3500 字的片 |
| **夜间 Librarian**（21:00） | 每晚编译最多 20 片成 wiki 页，标完最后一片自动在 MANIFEST 结账，汇报进度 |

**冷启动期间不要自己把原料编译成 wiki。** 同一份东西被你和 Librarian 各写一遍，就会出现两套说法。唯一例外：主人在对话里**亲口**说的关于自己的事实，当场写进 `USER.md` 或项目页。

## 原则：先盘点，再让主人选，再深读

盘点很便宜，读正文很贵。实测一个企业飞书：13 个空间、117 个节点，**盘点 41 秒**；全部正文 199k 字，按每晚 20 片要 7 个晚上。所以：

1. 先列出有什么（空间 / 页面 / 来源），不读正文；
2. 让主人勾选要哪些，**默认排除**：飞书自带的示例知识库、标题含 凭证 / 密码 / 账号 / secret / token / key / 身份证 的页面、和主人无关的通用方法论库；
3. 只采勾选的。

## 四种原料

### 1. 飞书文档库（多数主人最大的来源）

办法：**装官方的 lark-cli，让主人自己授权，用主人的身份读他本来就能看到的文档。** 凭据只在 `agent-data/lark-cli` 里，不进记忆、不进 git、不出现在回复里。授权要主人在手机上点链接，会跨好几轮；进度写进 `onboarding/feishu-auth.json`，每轮先读它。

1. `python3 scripts/feishu-docs.py setup`：安装，`status.next` 告诉你下一步
2. 还没有应用：后台跑 `lark-cli config init --new --force-init`，把链接发给主人建一个只读文档的应用，**结束这一轮**
3. 授权：`lark-cli auth login --no-wait --json --domain wiki,docs,drive`，把链接（或 `auth qrcode` 生成的二维码）发给主人，**结束这一轮**；主人说好了再 `--device-code` 收尾
4. `python3 scripts/feishu-docs.py scopes`：缺权限时输出里有现成的 `fix`，补完要回到第 3 步重新授权
5. `python3 scripts/feishu-docs.py inventory`：只盘点目录（百来页约 40 秒），把空间清单给主人选。默认跳过示例库和像凭据库的空间
6. `python3 scripts/feishu-docs.py pull --spaces <id,...>`：每轮最多 40 份、240 秒，没拉完下一轮接着跑

每一步的命令细节、二维码、过期怎么办、缺权限怎么跟主人说：`references/feishu-lark-cli.md`。

**这个应用只用来读文档**，不要用 lark-cli 发消息、改文档、建群、加人。消息一律走 Mirror V 自己的通道。主人不想授权就退回粘正文 / 发截图，并把「不读飞书」记进 `USER.md` 的「已明确拒绝的采集源」。

### 2. 官网 / 公开主页（零授权）

- 多数官网是 SPA，`web_fetch` 首页只拿得到 `<title>`，正文在 `/js/app.*.js` 的多语言词条里。
- `web_search` 搜名字、法人、产品、创始人、App Store、论文、媒体报道。官网媒体墙常常只有标题没链接，**最多反查 8 条**，剩下的标「未反查」。
- 同名干扰项先排除，并记一条消歧义。返回登录页的私有端点不采集，只记「这里有东西，我没读」。
- 细节：`references/collection-sop.md`。

### 3. 别的 AI 助手里的记忆（个人用户最重要的来源）

主人在 ChatGPT / Claude / DeepSeek / 豆包里可能已经攒了一两年记忆，这通常是个人用户唯一现成的记忆来源。最通用的拿法：让主人把下面这段话**原样**发给他原来的那个助手，再把回复整段粘回来。

```
请把你记得的关于我的一切完整列出来，不要省略，不要加评价：
- 我是谁：身份、职业、所在城市、常用语言
- 我在做的事：公司、项目、产品，各自现在的状态
- 我常打交道的人：名字、和我的关系、我们一起在做什么
- 我的偏好和习惯：工作方式、写作风格、明确说过不喜欢的东西
- 我做过的重要决定，以及当时的理由
- 如果你有「记忆」功能，把保存的记忆条目原文逐条列出
每一条后面注明你是从哪里知道的；不确定的标「不确定」。
```

- 有「记忆」功能的助手（例如 ChatGPT），设置里一般能看到已保存的记忆条目，也可以直接复制过来（以当前版本的界面为准）。
- 没有跨对话记忆的助手，复述只能覆盖当前这次对话。这种情况更有用的做法是把几段重要的历史对话直接复制过来。
- 落盘用 `--source ai-memory`，`--title` 写清是哪个助手、哪天导出的。
- 这类原料里**别人的电话、住址、证件号**不进记忆。采集器只脱凭据，不脱个人信息，编译时要自己挡住。

### 4. 其它地方的文档和随手粘的文字

钉钉、Notion、本地文件这些没有接口的，让主人粘正文（无实际上限）或发截图（≤4 张，单张 ≤10MB），`--source paste` / `--source shot`。**现在别让主人直接发 pdf / word / 压缩包**，这条通道没开，发了收不到也不报错。几条路各自的上限：`references/no-api-playbook.md`。

## 落盘

```bash
python3 scripts/onboard-collect.py add --source <web|ai-memory|paste|shot|browser|feishu> \
    --url <来源> --title "<这是什么>" --stdin
```

- 退出码：0 成功；3 不是纯文本（二进制、非 UTF-8）；4 体积闸门拦下（`warn` 和 `stop` 都算）。非 0 就停下，把原因告诉主人。
- 同一内容重复投递会被标成 duplicate，不会重复落盘。
- **任何二进制都不进工作区**：备份连 `.git` 一起打包，进去一次就永久变大（历史事故：备份 294 MB，每轮排队 83 秒）。

## 交给 Librarian

```bash
python3 scripts/onboard-collect.py status            # 份数、字数、消化率
python3 scripts/librarian-daily-queue.py stats       # import_pending = 还剩几片
```

`import_pending ÷ 20` 就是还要几个晚上，跟主人说这个数，**不要拍脑袋估**。原料多到主人觉得太慢，可以减原料，或者主人同意的话把夜间上限调高。

## 验收：看结果，不看过程

冷启动做得好不好，只看它建出来的记忆：

```bash
python3 scripts/onboard-collect.py status                 # 消化率要到 100%（每份都有去向）
python3 scripts/memory-graph.py                           # 页数、链接、孤儿页
python3 scripts/librarian-reachability.py --metric-only   # 可达率要 1.0，同时看 pages 绝对值
python3 scripts/index-compact.py --check                  # index 0 死链 0 格式错
python3 scripts/memory-index-verify.py --probes onboarding/probes.json emit / record / report
```

**探针才是真正的验收。** 出 10 道「只有读过这批原料才答得出」的题（公开层 4、内部层 6），对每题跑 `memory_search` 再回填，看 recall@5。不要拿文件数、页数或者 `indexed` 字段当可检索的证据。

## 红线

- 凭据、密码、token 不进记忆。采集器会脱敏，编译时也不许把「这里原来有个密码」写进页面。
- 别人的私人信息（电话、住址、证件号）不进记忆。
- 原料之间互相矛盾时，两个说法都留着并注明出处，不替主人二选一。
- 主人拒绝过的来源记进 `USER.md`，以后不要再提。

## 参考

- `references/collection-sop.md`：官网、媒体、飞书知识库的采集细节和实测踩坑
- `references/no-api-playbook.md`：没有平台 API 时的几条路和各自上限
- `memory/SCHEMA.md` 的 Import Compile 和「检索友好的首段规范」
