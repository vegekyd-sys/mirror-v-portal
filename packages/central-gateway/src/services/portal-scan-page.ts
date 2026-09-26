/** Phone landing page for the single, channel-neutral Portal QR. */
export const PORTAL_SCAN_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Mirror V Portal · 开通 Agent</title>
<style>
  *{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;min-height:100svh;background:#080e19;color:#f3f7fc;font-family:"Helvetica Neue","PingFang SC",sans-serif;display:grid;place-items:center;padding:24px}
  main{width:min(100%,420px);padding:36px 28px;border:1px solid #2e4158;border-radius:18px;background:linear-gradient(155deg,#18283d,#0d1726);box-shadow:0 20px 80px #0005}
  .brand{font-size:20px;font-weight:650;letter-spacing:-.05em}.brand small{display:block;margin-top:3px;font-size:9px;font-weight:550;letter-spacing:.28em;text-transform:uppercase}
  .eyebrow{margin:70px 0 12px;color:#9bb8d4;font-size:11px;letter-spacing:.12em}h1{margin:0;font-size:32px;letter-spacing:-.045em}p{margin:20px 0 0;color:#b3c4d6;font-size:14px;line-height:1.7}
  .choices{display:flex;gap:10px;margin-top:30px}button,a.action{min-height:46px;border:1px solid #54718f;border-radius:8px;background:#d8ebfa;color:#122139;font:inherit;font-size:14px;font-weight:600;cursor:pointer;text-align:center;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;padding:0 16px;flex:1}
  a.action{margin-top:20px;width:100%}button:focus-visible,a.action:focus-visible{outline:2px solid #fff;outline-offset:3px}
  .fine{margin-top:36px;color:#7f96ae;font-size:12px}
</style>
</head>
<body>
<main>
  <div class="brand">Mirror V<small>Portal</small></div>
  <div class="eyebrow">AGENT 入驻</div>
  <h1 id="title">正在连接…</h1>
  <p id="status" role="status" aria-live="polite">正在读取入口码</p>
  <div class="choices" id="choices" hidden><button type="button" id="feishu">在飞书开通</button></div>
  <a class="action" id="continue" hidden>在飞书继续授权</a>
  <div class="fine">微信用户请在电脑网页选择“微信”，扫描显示的原生授权码。</div>
</main>
<script>
(function(){
  var id=new URLSearchParams(location.search).get('entry');
  var title=document.getElementById('title'),status=document.getElementById('status');
  var choices=document.getElementById('choices'),continueLink=document.getElementById('continue');
  var ua=navigator.userAgent;
  var detected=/MicroMessenger|微信(?!企业)/i.test(ua)?'weixin':/Lark|Feishu|飞书/i.test(ua)?'feishu':/DingTalk|钉钉/i.test(ua)?'dingtalk':null;
  var busy=false;
  function say(text){status.textContent=text;}
  function showWeixinGuide(){title.textContent='请在电脑切换微信';say('回到电脑上的 Portal，选择“微信”，再用微信扫一扫扫描新授权码。');choices.hidden=true;continueLink.hidden=true;}
  async function getStatus(){
    var response=await fetch('/onboard/portal/'+encodeURIComponent(id)+'/status');
    var data=await response.json();
    if(!response.ok)throw new Error(data.message||'入口码已过期，请在电脑上重新生成');
    title.textContent=data.templateName;
    if(data.channel==='weixin'){showWeixinGuide();return data;}
    if(data.channel){
      choices.hidden=true;
      var active=data.status!=='completed'&&data.status!=='failed'&&data.status!=='expired';
      if(active&&data.actionUrl){continueLink.href=data.actionUrl;continueLink.hidden=false;}
      else continueLink.hidden=true;
      if(data.status==='completed')say('创建完成，回到飞书开始对话。');
      else if(data.status==='failed'||data.status==='expired')say(data.message||'授权未完成，请在电脑上重新生成入口码。');
      else say('授权已准备好，请点击下方按钮继续。');
    }
    return data;
  }
  async function start(templateId){
    if(busy)return;
    busy=true;choices.hidden=true;say('正在准备飞书授权…');
    var deviceCode=null;
    try{
      var response=await fetch('/onboard/feishu/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({templateId:templateId})});
      var data=await response.json();
      if(!response.ok||!data.ok||!data.deviceCode)throw new Error(data.message||'授权暂时不可用');
      deviceCode=data.deviceCode;
      response=await fetch('/onboard/portal/'+encodeURIComponent(id)+'/link',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({channel:'feishu',deviceCode:deviceCode})});
      data=await response.json();
      if(!response.ok||!data.redirectUrl)throw new Error('入口已在别处使用，请在电脑上重新生成');
      continueLink.href=data.redirectUrl;continueLink.hidden=false;
      say('授权已准备好，请点击下方按钮继续。');
    }catch(error){
      if(deviceCode)fetch('/onboard/cancel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({deviceCode:deviceCode})}).catch(function(){});
      say(error.message||'授权暂时不可用');choices.hidden=false;busy=false;
    }
  }
  async function init(){
    try{
      if(!id)throw new Error('入口码无效');
      var data=await getStatus();
      document.getElementById('feishu').onclick=function(){start(data.templateId);};
      setInterval(function(){if(document.visibilityState==='visible')getStatus().catch(function(){});},3000);
      if(data.channel)return;
      if(detected==='weixin'){showWeixinGuide();return;}
      if(detected==='dingtalk'){say('钉钉扫码开通尚未接入，请在电脑门户选择飞书或微信。');return;}
      if(detected==='feishu')start(data.templateId);
      else{say('请在飞书开通；微信用户请在电脑切换到微信授权码。');choices.hidden=false;}
    }catch(error){title.textContent='入口不可用';say(error.message||'请在电脑上重新生成入口码');}
  }
  init();
})();
</script>
</body></html>`;
