# Feishu Avatar API Reference

## Upload Image (`im.images.create`)

```
POST /open-apis/im/v1/images
Identity: bot (tenant_access_token)
```

**Request:** multipart form-data
- `image_type`: "avatar" | "message"
- `image`: binary file (PNG, ≤10MB, ≤4096×4096 for avatar)

**Response:** `{"code": 0, "data": {"image_key": "v3_..."}}`

**lark-cli:**
```bash
lark-cli im images create --as bot \
  --data '{"image_type":"avatar"}' \
  --file "image=./avatar.png"  # MUST be relative path from cwd
```

**Key pitfalls:**
- `--file` requires relative path from current working directory
- Must use `--as bot` (tenant_access_token)
- `im:resource:upload` scope required (tenant-level only)
- strict-mode must be `off` to allow bot identity

## Update Chat (`im.chats.update`)

```
PUT /open-apis/im/v1/chats/{chat_id}
Identity: user or bot
```

**Request body (avatar field):**
```json
{"avatar": "<image_key>"}
```

**lark-cli:**
```bash
lark-cli im chats update --as user --yes \
  --params '{"chat_id":"oc_xxx"}' \
  --data '{"avatar":"v3_xxx"}'
```

**Key pitfalls:**
- Requires `--yes` (high-risk-write)
- `avatar` expects image_key from the upload API, not a file path
- User identity is fine for this call (user has `im:chat:update` scope)
