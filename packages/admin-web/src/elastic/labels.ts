const states: Record<string, string> = {
  sleeping: '待命', running: '运行中', active: '运行中', ready: '就绪',
  provisioning: '创建中', failed: '失败', error: '异常', suspended: '暂停',
};

const channels: Record<string, string> = {
  feishu: '飞书', weixin: '微信', wechat: '微信', wecom: '企业微信',
  dingtalk: '钉钉', web: '网页',
};

export const agentStateLabel = (state: string) => states[state] || state;
export const agentChannelLabel = (channel: string) => channels[channel] || channel;
