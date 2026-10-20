# 飞书文档库：用 lark-cli 读主人的文档


这台机器可以自己装 npm 包（全局前缀在 `agent-data/npm`，休眠和备份都保留），所以读飞书的办法是：**装官方的 lark-cli，让主人自己授权，用主人的身份读他本来就能看到的文档。** 凭据只在 lark-cli 自己的目录里（`agent-data/lark-cli`），不进记忆，不进 git，不出现在回复里。

授权要主人在手机上点链接，会跨好几轮对话。每一步做完都把进度写进 `onboarding/feishu-auth.json`（device code、做到第几步），下一轮先读它。

**① 装好并看状态**

```bash
python3 scripts/feishu-docs.py setup      # 装 @larksuite/cli，配置目录挪进 agent-data，打印 status
```

`status.next` 会直接告诉你下一步做什么。

**② 还没有绑定应用时：让主人建一个读文档用的应用（只做一次）**

```bash
nohup lark-cli config init --new --force-init > onboarding/lark-init.log 2>&1 &
sleep 5; grep -oE 'https://[^ "]+' onboarding/lark-init.log | head -3
```

把链接发给主人，告诉他：「在手机或电脑上打开，按提示建一个应用，这个应用只用来读你的文档。10 分钟内有效。」然后这一轮就结束，不要一直等。这台机器闲置约 10 分钟才休眠，后台进程在这段时间里会一直等着主人完成。主人说「好了」之后，跑 `feishu-docs.py status`，看到 `configured: true` 就继续；过期了就重来一次。
（`--force-init` 是必须的：在 agent 环境里 lark-cli 默认拒绝新建应用。Mirror V 自己那个机器人的应用凭据在沙箱外，这里用不到。）

**③ 主人授权：用他的身份读**

```bash
lark-cli auth login --no-wait --json --domain wiki,docs,drive
```

从输出里拿到授权链接和 device code（字段名以实际输出为准），把 device code 写进 `onboarding/feishu-auth.json`。把链接发给主人。也可以做成二维码图片一起发：

```bash
lark-cli auth qrcode "<授权链接>" -o feishu-auth.png
```

然后用 `MEDIA:` 行发出去。这一轮结束。主人说授权好了，再跑：

```bash
lark-cli auth login --device-code <device code>
python3 scripts/feishu-docs.py status       # 应该看到 identity: user 和主人的名字
```

**④ 对照权限，缺什么补什么**

```bash
python3 scripts/feishu-docs.py scopes
```

退出码 0 就是够了；2 表示缺权限，输出里的 `fix` 已经写好了要主人去哪开、开哪几项。主人开通并发布新版本后，重新跑 `scopes`，再回到第 ③ 步让主人重新授权一次（新权限要重新授权才进 token）。企业里发布新版本可能要管理员审核，这时如实告诉主人在等审核，不要反复催。

**⑤ 盘点，让主人选**

```bash
python3 scripts/feishu-docs.py inventory
```

只读目录不读正文，一个百来页的知识库大约 40 秒。把空间清单（名字、页数、建议读或跳过）发给主人，让他回要读哪几个。**默认跳过**：飞书自带的示例知识库、名字或描述像凭据库的空间、标题像凭据的页面。主人坚持要读被跳过的，可以，但先说清楚凭据会被脱敏、不会进记忆。

**⑥ 拉正文，交给 Librarian**

```bash
python3 scripts/feishu-docs.py pull --spaces <space_id,...>      # 或 --all
```

每一轮最多拉 40 份、240 秒，拉不完的下一轮接着跑同一条命令（`remaining` 会递减，不会重复拉）。每一份都经过 `onboard-collect.py`：脱敏、记账、体积闸门、提交。闸门拦下就停，把原因告诉主人。拉完之后看 `librarian-daily-queue.py stats` 的 `import_pending`，告诉主人大约要整理几晚。

**这个应用只用来读文档。** 不要用 lark-cli 发消息、改文档、建群、加人。消息一律走 Mirror V 自己的通道，用 lark-cli 发会绕开网关，主人那边会收到来路不明的消息。

主人不想授权，就退回到让他粘正文或发截图，并把「不读飞书」记进 `USER.md` 的「已明确拒绝的采集源」。

