/**
 * DingTalk Onboarding — Guide Page
 *
 * DingTalk internal enterprise apps do NOT require marketplace registration.
 * The flow is: scan QR → this guide page → copy info → go to DingTalk backend → add app.
 */

export const DINGTALK_ONBOARD_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>DealClaw — 钉钉入驻指南</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: linear-gradient(135deg, #0066cc 0%, #004d99 100%);
    min-height: 100vh; display: flex; justify-content: center; align-items: center;
    padding: 16px; color: #fff;
  }
  .card {
    background: rgba(0,0,0,0.3); backdrop-filter: blur(12px);
    border: 1px solid rgba(255,255,255,0.15); border-radius: 16px;
    padding: 28px 24px; max-width: 420px; width: 100%;
  }
  .logo { text-align: center; margin-bottom: 20px; }
  .logo h1 { font-size: 24px; color: #fff; }
  .logo p { font-size: 13px; color: rgba(255,255,255,0.7); margin-top: 4px; }
  .step { margin-bottom: 20px; padding: 14px; background: rgba(255,255,255,0.1); border-radius: 12px; }
  .step-num {
    display: inline-block; width: 24px; height: 24px; line-height: 24px;
    text-align: center; background: #fff; color: #0066cc;
    border-radius: 50%; font-size: 13px; font-weight: 700; margin-bottom: 6px;
  }
  .step h3 { font-size: 15px; margin-bottom: 6px; color: #fff; }
  .step p { font-size: 13px; color: rgba(255,255,255,0.8); line-height: 1.5; }
  .copy-box {
    background: rgba(0,0,0,0.3); border: 1px dashed rgba(255,255,255,0.3);
    border-radius: 8px; padding: 10px 12px; margin: 8px 0;
    font-family: monospace; font-size: 12px; word-break: break-all;
    position: relative;
  }
  .copy-btn {
    position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
    padding: 4px 12px; background: rgba(255,255,255,0.15);
    border: none; border-radius: 6px; color: #fff; font-size: 12px; cursor: pointer;
  }
  .copy-btn:hover { background: rgba(255,255,255,0.25); }
  .link-btn {
    display: block; width: 100%; padding: 12px; border-radius: 10px;
    background: #fff; color: #0066cc; text-align: center;
    font-size: 15px; font-weight: 600; text-decoration: none;
    margin: 12px 0; transition: opacity 0.2s;
  }
  .link-btn:hover { opacity: 0.9; }
  .note {
    font-size: 12px; color: rgba(255,255,255,0.6); margin-top: 16px; text-align: center;
  }
  .done-section {
    margin-top: 20px; padding: 14px; background: rgba(52,199,89,0.2);
    border: 1px solid rgba(52,199,89,0.3); border-radius: 12px; text-align: center;
  }
  .done-section p { font-size: 14px; }
  .hidden { display: none !important; }
</style>
</head>
<body>
<div class="card">
  <div class="logo">
    <h1>DealClaw × 钉钉</h1>
    <p>AI 外贸销售助手 · 企业内部应用</p>
  </div>

  <div class="step">
    <span class="step-num">1</span>
    <h3>打开钉钉开放平台</h3>
    <p>使用企业管理员账号登录钉钉开放平台后台</p>
    <a class="link-btn" href="https://open-dev.dingtalk.com/fe/app#/corp/app" target="_blank">
      🔧 打开钉钉开发者后台
    </a>
  </div>

  <div class="step">
    <span class="step-num">2</span>
    <h3>创建企业内部应用</h3>
    <p>在后台点击「创建应用」→ 选择「企业内部应用」→ 填写以下信息：</p>
    <div class="copy-box">
      应用名称：DealClaw AI 助手
      <button class="copy-btn" onclick="copyText('DealClaw AI 助手')">复制</button>
    </div>
    <p style="font-size:12px;color:rgba(255,255,255,0.5);">应用描述：AI 外贸销售助手，提供客户分析、线索挖掘、邮件撰写等服务</p>
  </div>

  <div class="step">
    <span class="step-num">3</span>
    <h3>添加机器人能力</h3>
    <p>在应用详情页 → 添加应用能力 → 选择「机器人」→ 配置消息接收模式为「HTTP 模式」→ 填入回调地址：</p>
    <div class="copy-box" id="callbackBox">
      正在生成回调地址...
      <button class="copy-btn hidden" onclick="copyText(document.getElementById('callbackUrl').textContent)">复制</button>
    </div>
  </div>

  <div class="step">
    <span class="step-num">4</span>
    <h3>获取应用凭证</h3>
    <p>在应用详情页 → 「凭证与基础信息」中获取以下信息：</p>
    <p style="font-size:12px;color:rgba(255,255,255,0.5);">Client ID (AppKey) + Client Secret (AppSecret)</p>
    <p style="font-size:12px;color:rgba(255,255,255,0.5);margin-top:4px;">将这些凭证发送给 DealClaw 技术团队以完成配置。</p>
  </div>

  <div class="step">
    <span class="step-num">5</span>
    <h3>发布应用</h3>
    <p>点击「版本管理与发布」→ 创建新版本 → 设置可见范围（建议全企业）→ 发布。</p>
    <p style="font-size:12px;color:rgba(255,255,255,0.5);margin-top:4px;">发布后员工在钉钉中搜索「DealClaw」即可找到并使用。</p>
  </div>

  <div class="done-section hidden" id="doneSection">
    <p>✅ 配置完成后，请在钉钉中搜索 <b>DealClaw AI 助手</b> 开始使用</p>
    <p style="font-size:12px;color:rgba(255,255,255,0.6);margin-top:8px;">如有问题，请联系 DealClaw 技术支持</p>
  </div>

  <button class="link-btn hidden" id="doneBtn" onclick="document.getElementById('doneSection').classList.remove('hidden'); this.classList.add('hidden')">
    ✅ 我已完成以上配置
  </button>
</div>

<script>
// Generate tenant-specific callback URL
const host = window.location.origin || 'https://api.dealclaw.cn';
const callbackUrl = host + '/v1/agent/dingtalk/callback';

document.getElementById('callbackBox').innerHTML =
  callbackUrl +
  '<button class="copy-btn" onclick="copyText(\'' + callbackUrl + '\')">复制</button>';

document.getElementById('doneBtn').classList.remove('hidden');

function copyText(text) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).catch(() => {});
  }
  // Fallback
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
  alert('已复制：' + text);
}
</script>
</body>
</html>`;

/**
 * WeCom Onboarding — Guide Page
 * Requires app marketplace listing (not yet available).
 */
export const WECOM_ONBOARD_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>DealClaw — 企业微信入驻</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: linear-gradient(135deg, #07c160 0%, #06ad56 100%);
    min-height: 100vh; display: flex; justify-content: center; align-items: center;
    padding: 16px; color: #fff;
  }
  .card {
    background: rgba(0,0,0,0.3); backdrop-filter: blur(12px);
    border: 1px solid rgba(255,255,255,0.15); border-radius: 16px;
    padding: 32px 24px; max-width: 420px; width: 100%; text-align: center;
  }
  .logo h1 { font-size: 24px; color: #fff; }
  .logo p { font-size: 13px; color: rgba(255,255,255,0.7); margin-top: 4px; }
  .icon { font-size: 64px; margin: 24px 0; }
  .msg { font-size: 15px; color: rgba(255,255,255,0.9); line-height: 1.6; margin-bottom: 20px; }
  .btn {
    display: block; width: 100%; padding: 12px; border-radius: 10px;
    background: #fff; color: #07c160; text-align: center;
    font-size: 15px; font-weight: 600; text-decoration: none; margin: 12px 0;
  }
  .btn:hover { opacity: 0.9; }
  .note { font-size: 12px; color: rgba(255,255,255,0.5); margin-top: 16px; }
</style>
</head>
<body>
<div class="card">
  <div class="logo">
    <h1>DealClaw × 企业微信</h1>
    <p>AI 外贸销售助手</p>
  </div>
  <div class="icon">🏗️</div>
  <p class="msg">
    企业微信渠道正在建设中。<br>
    DealClaw 将在企业微信应用市场上架后，<br>
    支持一键安装使用。
  </p>
  <p class="note">
    如需提前体验，请通过飞书或钉钉渠道入驻。<br>
    详情请联系 DealClaw 技术支持。
  </p>
</div>
</body>
</html>`;
