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
  .choices{display:flex;gap:10px;margin-top:30px}.choices[hidden],form[hidden],a[hidden],.qr[hidden]{display:none}button,a.action{min-height:46px;border:1px solid #54718f;border-radius:8px;background:#d8ebfa;color:#122139;font:inherit;font-size:14px;font-weight:600;cursor:pointer;text-align:center;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;padding:0 16px;flex:1}.choices button+button{background:#1d3149;color:#e8f3ff}
  a.action{margin-top:20px;width:100%}form{display:flex;gap:8px;margin-top:24px}input{min-width:0;flex:1;padding:0 14px;border:1px solid #54718f;border-radius:8px;background:#122238;color:#fff;font:inherit}form button{flex:0 0 auto}
  .qr{margin-top:28px;text-align:center}.qr img{display:block;width:min(100%,260px);height:auto;margin:auto;padding:8px;background:#fff;border-radius:12px}.qr p{margin-top:16px;color:#d5e5f4}
  .fine{margin-top:36px;color:#7f96ae;font-size:12px}
</style>
</head>
<body>
<main>
  <div class="brand">Mirror V<small>Portal</small></div>
  <div class="eyebrow">AGENT 入驻</div>
  <h1 id="title">正在连接…</h1>
  <p id="status" role="status" aria-live="polite">正在读取入口码</p>
  <div class="choices" id="choices" hidden><button type="button" id="feishu">在飞书开通</button><button type="button" id="weixin">在微信开通</button></div>
  <a class="action" id="continue" hidden>继续授权</a>
  <div class="qr" id="wechat-qr" hidden><img id="wechat-qr-image" alt="微信 Agent 授权二维码"><p>如果点击后页面空白，请返回这里，长按授权码并选择“识别图中二维码”。</p></div>
  <form id="verify" hidden><input id="code" inputmode="numeric" autocomplete="one-time-code" placeholder="微信验证码" aria-label="微信验证码"><button type="submit">提交</button></form>
  <div class="fine">一个入口，按扫码 App 进入对应的授权流程。</div>
</main>
<script>
(function(){
  var id=new URLSearchParams(location.search).get('entry');
  var title=document.getElementById('title'),status=document.getElementById('status');
  var choices=document.getElementById('choices'),continueLink=document.getElementById('continue');
  var wechatQr=document.getElementById('wechat-qr'),wechatQrImage=document.getElementById('wechat-qr-image');
  var verify=document.getElementById('verify'),code=document.getElementById('code');
  var ua=navigator.userAgent;
  var detected=/MicroMessenger|微信(?!企业)/i.test(ua)?'weixin':/Lark|Feishu|飞书/i.test(ua)?'feishu':/DingTalk|钉钉/i.test(ua)?'dingtalk':null;
  var busy=false;
  function say(text){status.textContent=text;}
  async function getStatus(){
    var response=await fetch('/onboard/portal/'+encodeURIComponent(id)+'/status');
    var data=await response.json();
    if(!response.ok)throw new Error(data.message||'入口码已过期，请在电脑上重新生成');
    title.textContent=data.templateName;
    if(data.channel){
      choices.hidden=true;
      var active=data.status!=='completed'&&data.status!=='failed'&&data.status!=='expired';
      if(data.channel==='weixin'&&active&&data.qrImageUrl){
        wechatQrImage.src=data.qrImageUrl;wechatQr.hidden=false;
        if(data.actionUrl){continueLink.href=data.actionUrl;continueLink.textContent='在微信确认开通';continueLink.hidden=false;}
      }else if(data.channel==='feishu'&&active&&data.actionUrl){
        continueLink.href=data.actionUrl;continueLink.textContent='在飞书继续授权';continueLink.hidden=false;wechatQr.hidden=true;
      }else{continueLink.hidden=true;wechatQr.hidden=true;}
      if(data.status==='completed')say('创建完成，回到'+(data.channel==='weixin'?'微信':'飞书')+'开始对话。');
      else if(data.status==='need_verify_code'){verify.hidden=false;say('请填写微信提示的验证码。');}
      else if(data.status==='failed'||data.status==='expired')say(data.message||'授权未完成，请在电脑上重新生成入口码。');
      else if(data.channel==='weixin')say('授权已准备好，点击下方按钮在微信确认开通。');
      else say('授权已准备好，请点击下方按钮继续。');
    }
    return data;
  }
  async function start(channel,templateId){
    if(busy)return;
    busy=true;choices.hidden=true;say('正在准备'+(channel==='weixin'?'微信':'飞书')+'授权…');
    var deviceCode=null;
    try{
      var response=await fetch('/onboard/'+channel+'/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({templateId:templateId})});
      var data=await response.json();
      if(!response.ok||!data.ok||!data.deviceCode)throw new Error(data.message||'授权暂时不可用');
      deviceCode=data.deviceCode;
      response=await fetch('/onboard/portal/'+encodeURIComponent(id)+'/link',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({channel:channel,deviceCode:deviceCode})});
      data=await response.json();
      if(!response.ok)throw new Error('入口已在别处使用，请在电脑上重新生成');
      if(channel==='weixin'){
        wechatQrImage.src='/onboard/portal/'+encodeURIComponent(id)+'/weixin-qr.png';
        wechatQr.hidden=false;
        if(!data.redirectUrl)throw new Error('微信授权暂时不可用');
        continueLink.href=data.redirectUrl;continueLink.textContent='在微信确认开通';continueLink.hidden=false;
        say('授权已准备好，点击下方按钮在微信确认开通。');
      }else{
        if(!data.redirectUrl)throw new Error('飞书授权暂时不可用');
        continueLink.href=data.redirectUrl;continueLink.hidden=false;
        continueLink.textContent='在飞书继续授权';
        say('授权已准备好，请点击下方按钮继续。');
      }
    }catch(error){
      if(deviceCode)fetch('/onboard/'+(channel==='weixin'?'weixin/':'')+'cancel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({deviceCode:deviceCode})}).catch(function(){});
      say(error.message||'授权暂时不可用');choices.hidden=false;busy=false;
    }
  }
  async function init(){
    try{
      if(!id)throw new Error('入口码无效');
      var data=await getStatus();
      document.getElementById('feishu').onclick=function(){start('feishu',data.templateId);};
      document.getElementById('weixin').onclick=function(){start('weixin',data.templateId);};
      setInterval(function(){if(document.visibilityState==='visible')getStatus().catch(function(){});},3000);
      if(data.channel)return;
      if(detected==='dingtalk'){say('钉钉扫码开通尚未接入。请用飞书或微信扫描同一个入口码。');return;}
      if(detected)start(detected,data.templateId);
      else{say('请选择你要使用的 App，继续完成授权。');choices.hidden=false;}
    }catch(error){title.textContent='入口不可用';say(error.message||'请在电脑上重新生成入口码');}
  }
  verify.addEventListener('submit',async function(event){
    event.preventDefault();var value=code.value.trim();
    if(!/^\\d{4,8}$/.test(value)){say('请输入 4–8 位验证码');return;}
    try{
      var response=await fetch('/onboard/portal/'+encodeURIComponent(id)+'/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:value})});
      if(!response.ok)throw new Error('验证码提交失败');
      verify.hidden=true;say('验证码已提交，请在微信中确认。');
    }catch(error){say(error.message||'验证码提交失败');}
  });
  init();
})();
</script>
</body></html>`;
