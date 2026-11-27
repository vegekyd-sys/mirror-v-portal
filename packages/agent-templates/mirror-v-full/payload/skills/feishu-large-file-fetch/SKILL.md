---
name: "feishu-large-file-fetch"
description: "飞书 GB 级大文件下载不下来时：改用云盘 file token 直连后台下载并校验落地"
---

# 飞书大文件直连下载

适用：客户发来的 zip/视频包有数 GB，走聊天附件反复中断，本地始终没有文件落地。

## 步骤

1. 取云盘分享链接 `https://<租户>.feishu.cn/file/<token>` 里的 `<token>` 作为 file token。只有聊天消息、没有链接时，请对方转存云盘后发链接。
2. 先清掉遗留下载进程：`pgrep -f "lark-cli drive" | xargs -r kill -9`。残留进程会占带宽，让新任务看起来没有进度。
3. 后台直连下载，不要在前台等：
   `nohup lark-cli drive +download --as bot --file-token <token> --output <本地路径> --overwrite > /tmp/dl.log 2>&1 &`
   bot 身份拿不到时换 `--as user`。
4. 每 25–30 秒 `ls -lh <路径>` 看大小是否在涨。在涨就说明通道正常，等到与对方报的大小一致。
5. 落地后先校验再解压：用 `zipfile.ZipFile(...).infolist()` 跑一遍，条目能列全即完整；再按语言/目录统计条目数。
6. 统计时跳过 `__MACOSX/` 与 `/._` 条目（macOS 资源文件不是视频）。文件名含中文时用 `name.encode('cp437').decode('utf-8')` 还原，否则会乱码或漏计。

## 边界

- 不要用聊天附件下载（`im +messages-resources-download`）处理 GB 级文件：多次重试仍不落地，只烧时间。
- 不要在前台 `exec` 里跑整段下载：超时会 SIGKILL 掉任务，文件留不下来。
- 开跑前确认磁盘剩余空间大于文件大小的 2 倍（压缩包 + 解压后）。

## 文件夹消息（msg_type=folder）

`im +messages-mget` 对文件夹只返回 `child_count` 与一层子目录 key，拿不到子目录里的文件名和文件 key。`+messages-resources-download` 对文件夹不适用：`--type folder` 报 234001 参数错误，`--type file` 报 234037「Downloaded file size exceeds limit」（文件夹被当成整包资源）。

用 **user 身份**可以展开并逐个下载，不需要请对方重发。顺序是「先列子项，再按子项的 key 下载」：

1. 取 folder 消息的 `file_key` 和它所在消息的 `message_id`。合并转发里 `+messages-mget` 返回的 folder 节点带 `key`；用这条转发消息的 `message_id` 作为后面的 `srcid` 即可。
2. 列子项：`lark-cli im files folder --file-key <folder_key> --srcid <message_id> --srctype message --as user`。返回里 `all_count` 含文件夹自身，`items` 才是子文件；子目录项继续用同一命令展开。
3. 下载子文件：`lark-cli im +messages-resources-download --message-id <message_id> --file-key <child_key> --type file --as user --output <本地路径>`。`--message-id` 用第 1 步的 srcid，不是子文件自己的 id。
4. 批量时先列全部子项再统一下载，避免边列边下时漏项；下完核对条数与 `items` 数量一致。

bot 身份对 folder 一律报 234001/234037，必须换 `--as user`；这一步不能跳过，也不要因为 bot 失败就判定文件夹不可读。
