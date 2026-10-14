/**
 * Mirror V Portal onboarding.
 * Choose a personal Agent, then connect it through a native channel QR.
 * The frontend preserves the existing registration, account and polling contracts.
 */
export const ONBOARD_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light">
<title>Mirror V Portal · 选择你的 Agent</title>
<style>
  * { box-sizing:border-box; }
  [hidden] { display:none!important; }
  :root { color-scheme:light; font-family:"Avenir Next","PingFang SC","Microsoft YaHei",sans-serif; color:#243244; background:#f7f9fb; --ink:#243244; --muted:#586879; --line:#dde4eb; --accent:#3b556f; }
  body { margin:0; min-width:280px; -webkit-font-smoothing:antialiased; }
  button,input,select { font:inherit; }
  button,a,input,select { -webkit-tap-highlight-color:transparent; }
  button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible { outline:2px solid #3b658b; outline-offset:4px; }
  button { cursor:pointer; }
  .experience { min-height:100svh; display:flex; flex-direction:column; padding:0 48px; }
  .masthead { width:100%; max-width:1120px; margin:0 auto; padding:34px 0; display:flex; justify-content:space-between; align-items:center; }
  .brand { display:flex; align-items:center; gap:12px; color:var(--ink); text-decoration:none; }
  .brand-mark { width:36px; height:36px; color:#7890a5; }
  .brand-mark svg { display:block; width:100%; height:100%; }
  .brand-wordmark { display:flex; align-items:baseline; gap:10px; }
  .brand strong { font-size:24px; line-height:1; font-weight:600; letter-spacing:-.065em; }
  .brand small { font-size:12px; color:var(--muted); }
  .manage-link { color:#617084; text-decoration:none; font-size:13px; padding:10px 0 10px 12px; }
  .manage-link:hover { color:var(--ink); }
  .portal-layout { flex:1; width:100%; max-width:1080px; margin:0 auto; padding:0 0 48px; display:grid; grid-template-columns:minmax(0,1fr) 390px; gap:80px; align-items:start; }
  .hero { width:100%; max-width:1080px; margin:0 auto; padding:24px 0 34px; display:grid; grid-template-columns:minmax(0,1fr) 470px; gap:80px; align-items:center; }
  .mirror-window { position:relative; margin:0; aspect-ratio:2.12; border-radius:100px 100px 28px 28px; overflow:hidden; background:#171a22; box-shadow:0 12px 32px #25344812; isolation:isolate; }
  .mirror-window video,.mirror-window picture,.mirror-window picture img { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; }
  .mirror-window video { opacity:0; transition:opacity 1.65s ease-in-out; }
  .mirror-window video.visible { opacity:1; }
  .motion-toggle { position:absolute; bottom:14px; right:16px; z-index:3; display:grid; place-items:center; width:34px; height:34px; border:1px solid #ffffff45; border-radius:50%; color:#fff; background:#15203180; backdrop-filter:blur(10px); }
  .motion-toggle svg { width:12px; height:12px; fill:currentColor; }
  .motion-toggle[data-paused="true"] .pause-icon,.motion-toggle[data-paused="false"] .play-icon { display:none; }
  .intro h1 { font-family:"Iowan Old Style","Songti SC","Noto Serif CJK SC",serif; font-size:56px; font-weight:500; line-height:1.18; letter-spacing:-.04em; margin:0; }
  .intro h1 span { display:block; }
  .intro p { margin:20px 0 0; font-size:14px; line-height:1.8; color:var(--muted); }
  .picker-label { margin:0 0 12px; font-size:13px; font-weight:500; color:var(--muted); }
  .template-list { display:flex; flex-direction:column; gap:4px; }
  .template-card { display:grid; grid-template-columns:52px minmax(0,1fr) 16px; grid-template-rows:auto auto; column-gap:16px; width:100%; padding:14px 16px; min-height:75px; border:1px solid transparent; border-radius:12px; text-align:left; color:var(--ink); background:transparent; transition:background .15s,border-color .15s; position:relative; }
  .template-card:hover { background:#edf1f5; }
  .template-card[aria-pressed="true"] { background:#fff; border-color:var(--line); }
  .template-card[aria-pressed="true"]::after { content:"✓"; grid-column:3; grid-row:1 / 3; align-self:center; color:var(--accent); font-size:15px; }
  .template-name { grid-column:2; grid-row:1; font-size:15px; font-weight:600; line-height:1.5; }
  .template-summary { grid-column:2; grid-row:2; font-size:13px; line-height:1.6; color:var(--muted); margin-top:2px; }
  .template-avatar,.template-symbol { grid-column:1; grid-row:1 / 3; align-self:center; width:52px; height:52px; border-radius:15px; }
  .template-avatar { display:block; object-fit:cover; }
  .template-symbol { display:grid; place-items:center; background:#e9eef3; color:#526b83; font-size:14px; font-weight:550; letter-spacing:-.05em; }
  .template-card[data-agent="mirror-v-full"] .template-symbol { background:#e5ebf2; color:#354e67; }
  .mobile-picker { display:none; }
  .gateway { background:#fff; border:1px solid var(--line); border-radius:20px; padding:30px; box-shadow:0 8px 32px #263b5005; min-width:0; }
  .gateway-heading { display:grid; grid-template-columns:54px minmax(0,1fr); column-gap:14px; align-items:start; margin-bottom:24px; }
  .selected-avatar,.selected-symbol { width:54px; height:54px; border-radius:15px; grid-column:1; grid-row:1 / 3; object-fit:cover; }
  .selected-symbol { display:grid; place-items:center; background:#edf1f5; color:#526b83; font-size:18px; font-weight:500; }
  .gateway-heading h2 { grid-column:2; margin:0; font-size:22px; font-weight:550; line-height:1.4; letter-spacing:-.035em; }
  .template-description { grid-column:2; margin:5px 0 0; font-size:13px; line-height:1.65; color:var(--muted); }
  .channel-picker { display:flex; padding:4px; gap:4px; border-radius:9px; background:#f0f3f6; margin-bottom:25px; }
  .channel-picker button { flex:1; min-height:40px; padding:8px 16px; border:0; border-radius:6px; background:transparent; color:var(--muted); font-size:13px; font-weight:500; }
  .channel-picker button[aria-pressed="true"] { color:var(--ink); background:#fff; box-shadow:0 1px 4px #1c334412; }
  .account-connect { width:100%; text-align:left; }
  .account-connect label { display:block; font-size:14px; font-weight:550; margin-bottom:9px; }
  .account-connect small { display:block; margin-bottom:20px; color:var(--muted); font-size:12px; line-height:1.8; }
  .account-connect input { width:100%; height:46px; padding:0 13px; border:1px solid #c9d3de; border-radius:8px; color:var(--ink); background:#fff; font-size:12px; }
  .account-connect input::placeholder { color:#8591a0; }
  .account-connect button { width:100%; min-height:46px; margin-top:12px; border:0; border-radius:8px; color:#fff; background:var(--accent); font-size:13px; }
  .account-connect button:hover { background:#2b455f; }
  .account-connect p { margin:16px 0 0; text-align:center; font-size:12px; }
  .account-connect a { color:#526b83; text-underline-offset:3px; }
  .gate { width:232px; height:232px; margin:0 auto; display:grid; place-items:center; }
  .portal { width:100%; height:100%; display:grid; place-items:center; background:#fff; position:relative; }
  #code { display:none; width:224px; height:224px; object-fit:contain; }
  .core { width:26px; height:26px; border:2px solid #e2e8ef; border-top-color:#526b83; border-radius:50%; animation:spin 1s linear infinite; }
  @keyframes spin { to { transform:rotate(360deg); } }
  .arrived { display:none; width:58px; height:58px; color:#547968; }
  .arrived svg { width:100%; height:100%; fill:none; stroke:currentColor; stroke-width:1.5; stroke-linecap:round; stroke-linejoin:round; }
  .gate.through .arrived { display:block; }
  .gate.through #code,.gate.through .core,.gate.lost .core { display:none!important; }
  .gate.lost #code { visibility:hidden; }
  .beam-track { width:100%; height:2px; margin-top:13px; background:#edf1f5; opacity:0; }
  .beam-track.on { opacity:1; }
  .beam-fill { width:0; height:100%; background:#68839c; transition:width .5s; }
  .readout { margin-top:17px; text-align:center; }
  .status { color:#526276; font-size:12px; line-height:1.7; }
  .status.warn { color:#984635; }
  .meta { margin-top:5px; color:#718092; font-size:11px; font-variant-numeric:tabular-nums; }
  .meta:empty { display:none; }
  .retry { display:none; width:100%; margin-top:16px; border:1px solid #c9d3de; background:#fff; color:var(--ink); border-radius:8px; min-height:44px; font-size:12px; }
  .retry.on { display:block; }
  .account-connect:not([hidden]) ~ .retry { display:none; }
  .retry:hover { background:#f3f6f9; }
  .verify { width:100%; margin-top:16px; display:flex; gap:8px; }
  .verify input { min-width:0; flex:1; min-height:44px; padding:0 12px; border:1px solid #c9d3de; border-radius:8px; color:var(--ink); background:#fff; font-size:12px; }
  .verify button { border:0; border-radius:8px; background:var(--accent); color:#fff; padding:0 16px; font-size:12px; }
  .connection-note { padding-top:23px; margin:23px 0 0; border-top:1px solid #edf0f4; color:#687789; text-align:center; font-size:12px; line-height:1.7; }
  .edge { width:100%; max-width:1120px; margin:0 auto; padding:22px 0 26px; border-top:1px solid #e4e9ef; display:flex; justify-content:space-between; gap:20px; color:#687789; font-size:12px; line-height:1.6; }
  @media(max-width:1000px) { .hero { gap:48px; grid-template-columns:minmax(0,1fr) 360px; } .portal-layout { gap:48px; grid-template-columns:minmax(0,1fr) 360px; } .intro h1 { font-size:49px; } .experience { padding:0 32px; } .template-card { column-gap:12px; padding:12px; } .gateway { padding:26px; } }
  @media(max-width:760px) { .hero { display:flex; flex-direction:column; align-items:stretch; gap:24px; max-width:450px; padding:16px 0 26px; } .mirror-window { aspect-ratio:2.05; border-radius:70px 70px 20px 20px; } .motion-toggle { bottom:10px; right:12px; } .experience { padding:0 24px; } .masthead { padding:24px 0; } .brand strong { font-size:22px; } .brand-mark { width:30px; height:30px; } .brand small { font-size:11px; } .manage-link { font-size:12px; } .portal-layout { display:block; max-width:450px; padding:0 0 38px; } .intro h1 { font-size:42px; line-height:1.18; } .intro p { margin:16px 0 0; font-size:12px; } .template-list { display:none; } .picker-label { margin-bottom:10px; } .mobile-picker { display:block; width:100%; min-height:48px; padding:0 14px; border:1px solid #c9d3de; border-radius:9px; background:#fff; color:var(--ink); font-size:16px; } .account-connect input,.verify input { font-size:16px; } .account-connect input::placeholder { font-size:12px; } .gateway { margin-top:24px; padding:25px; border-radius:16px; } .gateway-heading { margin-bottom:20px; } .channel-picker { margin-bottom:22px; } .connection-note { margin-top:20px; padding-top:20px; } .edge { padding:19px 0 22px; font-size:11px; flex-wrap:wrap; gap:6px; } }
  @media(max-width:350px) { .experience { padding:0 18px; } .intro h1 { font-size:37px; } .brand-wordmark { gap:7px; } .gateway { padding:20px; } }
  @media(prefers-reduced-motion:reduce) { *,*::before,*::after { animation:none!important; transition:none!important; } }

  body { background:#121b29; }
  .experience { position:relative; z-index:1; }
  .mirror-window { position:fixed; inset:0; z-index:0; width:100%; height:100%; margin:0; border-radius:0; aspect-ratio:auto; box-shadow:none; pointer-events:none; }
  .mirror-window::after { content:""; position:absolute; inset:0; z-index:2; background:linear-gradient(90deg,rgba(6,14,26,.52),rgba(6,14,26,.1) 55%,rgba(6,14,26,.22)),linear-gradient(180deg,rgba(10,18,30,.55),rgba(13,24,39,.18) 43%,rgba(10,18,30,.55)); }
  .mirror-window picture img,.mirror-window video { object-position:center; }
  .header-actions { display:flex; align-items:center; gap:22px; }
  .motion-toggle { position:static; width:34px; height:34px; background:#13213755; }
  .brand,.brand-mark,.manage-link,.manage-link:hover { color:#f6f9fc; }
  .brand small { color:#d3dbe5; }
  .hero { display:block; padding:22px 0 32px; }
  .intro { max-width:560px; }
  .intro h1 { color:#fff; text-shadow:0 2px 24px #09122240; }
  .intro p { color:#e6ebf1; text-shadow:0 1px 12px #09122255; }
  .template-picker { padding:22px; border:1px solid #ffffff75; border-radius:20px; background:rgba(248,250,253,.91); backdrop-filter:blur(22px); box-shadow:0 16px 48px #06101d18; }
  .template-card:hover { background:#ffffff90; }
  .template-card[aria-pressed="true"] { background:#fff; border-color:#d0dce7; }
  .gateway { background:rgba(255,255,255,.96); border-color:#ffffffb0; box-shadow:0 16px 48px #06101d18; }
  .edge { color:#dce5ef; border-color:#ffffff30; }
  @media(max-width:760px) {
    .hero { display:block; padding:14px 0 28px; }
    .template-picker { padding:18px; border-radius:16px; }
    .mirror-window { border-radius:0; aspect-ratio:auto; }
    .mirror-window::after { background:linear-gradient(180deg,#071221c4,#101d32b3 38%,#0b162a85); }
    .gateway { margin-top:18px; }
    .header-actions { gap:16px; }
    .motion-toggle { width:32px; height:32px; }
  }
</style>
</head>
<body>
      <figure class="mirror-window" id="mirrorWindow">
        <picture><source media="(max-width:760px)" srcset="/onboard/assets/nexus-world-mobile-v2.webp"><img src="/onboard/assets/nexus-world-v2.webp" alt="" decoding="async"></picture>
        <video id="worldA" muted playsinline preload="none" aria-hidden="true" data-src="/onboard/assets/nexus-world-v5.mp4?v=6"></video>
        <video id="worldB" muted playsinline preload="none" aria-hidden="true" data-src="/onboard/assets/nexus-world-v5.mp4?v=6"></video>

      </figure>
<main class="experience" aria-label="Mirror V Portal，选择 Agent">
  <header class="masthead">
    <a class="brand" href="/onboard" aria-label="Mirror V Portal">
      <span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 40 40" fill="none"><path d="M8 9l12 23L32 9" stroke="currentColor" stroke-width="1.5"/><path d="M4 9l12 23M36 9L24 32" stroke="currentColor" stroke-opacity=".35" stroke-width="1.5"/></svg></span>
      <span class="brand-wordmark"><strong>Mirror V</strong><small>Portal</small></span>
    </a>
    <div class="header-actions"><button class="motion-toggle" id="motionToggle" type="button" data-paused="false" aria-label="暂停背景视频"><svg class="pause-icon" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 1h3v10H2zM7 1h3v10H7z"/></svg><svg class="play-icon" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 1l8 5-8 5z"/></svg></button><a class="manage-link" id="manageLink" href="/admin/agents">管理 Agent</a></div>
  </header>
  <section class="hero" aria-labelledby="heroLine1">
      <div class="intro"><h1><span id="heroLine1">找到你的</span><span id="heroLine2">下一位伙伴。</span></h1><p id="heroDescription">思考、创作与行动，从一段对话开始。</p></div>

  </section>
  <div class="portal-layout">
    <section class="template-picker" aria-label="选择 Agent 模板">
      <h2 class="picker-label" id="pickerLabel">选择一位 Agent</h2>
      <select class="mobile-picker" id="templateSelect" aria-labelledby="pickerLabel"></select>
      <div class="template-list" id="templateList"></div>
    </section>
    <section class="gateway" aria-label="扫码创建 Agent">
      <div class="gateway-heading">
        <img class="selected-avatar" id="selectedAgentAvatar" alt="" hidden>
        <span class="selected-symbol" id="selectedAgentSymbol" aria-hidden="true">V</span>
        <h2 id="selectedAgentName">开始一段对话</h2><p class="template-description" id="templateDescription"></p>
      </div>
      <div class="channel-picker" role="group" aria-label="选择扫码 App"><button type="button" id="channelFeishu" aria-pressed="true">飞书</button><button type="button" id="channelWeixin" aria-pressed="false">微信</button></div>
      <form class="account-connect" id="makaronAccount" hidden>
        <label id="accountLabel" for="makaronApiKey"></label><small id="accountDescription"></small>
        <input id="makaronApiKey" type="password" autocomplete="off" spellcheck="false" maxlength="220" required>
        <button id="accountSubmit" type="submit"></button><p><a id="accountLogin" href="https://www.makaron.app" target="_blank" rel="noopener noreferrer"></a></p>
      </form>
      <div class="gate" id="gate"><div class="portal">
        <div class="core" id="core" aria-hidden="true"></div>
        <img id="code" alt="扫码创建 Agent">
        <div class="arrived" aria-hidden="true"><svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="30"/><path d="M20 33l9 9 16-19"/></svg></div>
      </div></div>
      <div class="beam-track" id="beamTrack"><div class="beam-fill" id="beamFill"></div></div>
      <div class="readout"><div class="status" id="status" role="status" aria-live="polite">正在加载 Agent 模板…</div><div class="meta" id="meta"></div></div>
      <form class="verify" id="verify" hidden><input id="verifyCode" inputmode="numeric" autocomplete="one-time-code" placeholder="微信验证码" aria-label="微信验证码"><button type="submit">确认</button></form>
      <button class="retry" id="retry" type="button">重新生成二维码</button>
      <p class="connection-note" id="connectionNote">扫码确认后，回到聊天 App 开始对话。</p>
    </section>
  </div>
  <footer class="edge"><span>© 2026 Mirror V</span><span id="footerNote">你的 Agent，你的对话与工作空间。</span></footer>
</main>
<script>
(function () {
  var copies = {
    zh: ['找到你的','下一位伙伴。','思考、创作与行动，从一段对话开始。','选择一位 Agent','管理 Agent','扫码确认后，回到聊天 App 开始对话。','你的 Agent，你的对话与工作空间。'],
    'zh-Hant': ['找到你的','下一位夥伴。','思考、創作與行動，從一段對話開始。','選擇一位 Agent','管理 Agent','掃碼確認後，回到聊天 App 開始對話。','你的 Agent，你的對話與工作空間。'],
    ja: ['あなたの次の','パートナーを。','考える、創る、行動する。会話から始めましょう。','Agent を選ぶ','Agent の管理','QR コードを確認した後、チャットアプリで会話を始めましょう。','あなたの Agent、あなたの会話とワークスペース。'],
    en: ['Meet your','next partner.','Think, create, and take action. Start with a conversation.','Choose an Agent','Manage Agents','After confirming the QR code, return to your chat app to start talking.','Your Agent, your conversations and workspace.']
  };
  var locale = new URLSearchParams(location.search).get('lang') || navigator.language || 'zh';
  var lang = copies[locale] ? locale : /^zh-(TW|HK|Hant)/i.test(locale) ? 'zh-Hant' : /^ja/i.test(locale) ? 'ja' : /^zh/i.test(locale) ? 'zh' : 'en';
  var text = copies[lang];
  ['heroLine1','heroLine2','heroDescription','pickerLabel','manageLink','connectionNote','footerNote'].forEach(function(id,index){document.getElementById(id).textContent=text[index];});
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang;
  document.title = {zh:'Mirror V Portal · 选择你的 Agent','zh-Hant':'Mirror V Portal · 選擇你的 Agent',ja:'Mirror V Portal · Agent を選ぶ',en:'Mirror V Portal · Choose your Agent'}[lang];
})();
(function () {
  var videos=[document.getElementById('worldA'),document.getElementById('worldB')], control=document.getElementById('motionToggle');
  var reduced=matchMedia('(prefers-reduced-motion: reduce)'), paused=reduced.matches, current=0, switching=false, frame=null;
  var words={zh:['暂停背景视频','播放背景视频'],'zh-Hant':['暫停背景影片','播放背景影片'],ja:['背景動画を一時停止','背景動画を再生'],en:['Pause background video','Play background video']};
  var labels=words[document.documentElement.lang==='zh-CN'?'zh':document.documentElement.lang]||words.en;
  function update(){control.dataset.paused=String(paused);control.setAttribute('aria-label',labels[paused?1:0]);}
  function stop(){videos.forEach(function(v){v.pause();});cancelAnimationFrame(frame);frame=null;}
  function watch(){
    if(paused||document.hidden)return;
    var a=videos[current], b=videos[1-current];
    if(!switching&&a.readyState>=2&&a.duration&&a.currentTime>=a.duration-1.8){
      switching=true;b.currentTime=0;
      b.play().then(function(){b.classList.add('visible');a.classList.remove('visible');current=1-current;setTimeout(function(){a.pause();switching=false;},1650);}).catch(function(){switching=false;});
    }
    frame=requestAnimationFrame(watch);
  }
  function start(){
    if(paused||document.hidden)return;
    videos.forEach(function(v){if(!v.getAttribute('src')){v.src=v.dataset.src;v.load();}});
    videos[current].play().then(function(){videos[current].classList.add('visible');cancelAnimationFrame(frame);watch();}).catch(function(){paused=true;stop();update();});
  }
  control.addEventListener('click',function(){paused=!paused;update();if(paused)stop();else start();});
  document.addEventListener('visibilitychange',function(){if(document.hidden)stop();else start();});
  reduced.addEventListener('change',function(event){if(event.matches){paused=true;stop();update();}});
  videos.forEach(function(v){v.addEventListener('error',function(){paused=true;stop();videos.forEach(function(item){item.classList.remove('visible');});update();});v.addEventListener('ended',function(){if(!paused&&!document.hidden){v.currentTime=0;start();}});});
  update();start();
})();
(function () {
  var feishuCode = null, weixinCode = null, pollTimer = null, tickTimer = null, expireAt = null, active = false;
  var selectedTemplate = null, selectedChannel = 'feishu', generation = 0;
  var POLL_MS = 3000;
  var gate = document.getElementById('gate');
  var core = document.getElementById('core');
  var code = document.getElementById('code');
  var statusEl = document.getElementById('status');
  var metaEl = document.getElementById('meta');
  var beamTrack = document.getElementById('beamTrack');
  var beamFill = document.getElementById('beamFill');
  var retry = document.getElementById('retry');
  var templateList = document.getElementById('templateList');
  var templateSelect = document.getElementById('templateSelect');
  var templateDescription = document.getElementById('templateDescription');
  var channelFeishu = document.getElementById('channelFeishu');
  var channelWeixin = document.getElementById('channelWeixin');
  var verify = document.getElementById('verify');
  var verifyCode = document.getElementById('verifyCode');
  var accountForm = document.getElementById('makaronAccount'), accountInput = document.getElementById('makaronApiKey'), accountKey = '';
  var accountCopy = {
    zh: ['连接你的 Makaron 账号','作品与额度属于你，账号只绑定到你的专属 Agent。','粘贴你的 Makaron API Key','连接账号并生成二维码','注册 / 登录 Makaron','登录后，从右上角菜单获取 API Key。','请先连接你的 Makaron 账号','无法连接该账号，请检查 API Key','账号暂时无法连接，请稍后重试'],
    'zh-Hant': ['連接你的 Makaron 帳號','作品與額度屬於你，帳號只綁定到你的專屬 Agent。','貼上你的 Makaron API Key','連接帳號並產生 QR 碼','註冊 / 登入 Makaron','登入後，從右上角選單取得 API Key。','請先連接你的 Makaron 帳號','無法連接此帳號，請檢查 API Key','帳號暫時無法連接，請稍後重試'],
    ja: ['Makaron アカウントを接続','作品とクレジットはあなたのものです。アカウントは専用 Agent にのみ接続されます。','Makaron API Key を貼り付け','接続して QR コードを生成','Makaron に登録 / ログイン','ログイン後、右上のメニューから API Key を取得してください。','先に Makaron アカウントを接続してください','接続できません。API Key を確認してください','現在接続できません。後でもう一度お試しください'],
    en: ['Connect your Makaron account','Your work and credits stay yours. This account is linked only to your personal Agent.','Paste your Makaron API Key','Connect and create QR code','Sign up / Log in to Makaron','After login, get your API Key from the top-right menu.','Connect your Makaron account first','Unable to connect. Check your API Key','Account connection is unavailable. Try again later']
  };
  var accountLang = new URLSearchParams(location.search).get('lang') || navigator.language || 'zh';
  var copy = accountCopy[accountLang] || accountCopy[/^zh-(TW|HK|Hant)/i.test(accountLang) ? 'zh-Hant' : /^ja/i.test(accountLang) ? 'ja' : /^zh/i.test(accountLang) ? 'zh' : 'en'];
  document.getElementById('accountLabel').textContent=copy[0]; document.getElementById('accountDescription').textContent=copy[1]+' '+copy[5];
  accountInput.placeholder=copy[2]; accountInput.setAttribute('aria-label',copy[2]);
  document.getElementById('accountSubmit').textContent=copy[3]; document.getElementById('accountLogin').textContent=copy[4]; document.getElementById('accountLogin').title=copy[5];
  accountForm.addEventListener('submit',function(event){ event.preventDefault(); accountKey=accountInput.value.trim(); open(); });

  function say(text, warn) {
    statusEl.textContent = text;
    statusEl.className = 'status' + (warn ? ' warn' : '');
  }
  function setState(cls) { gate.className = 'gate' + (cls ? ' ' + cls : ''); }
  function progress(pct) {
    beamTrack.classList.toggle('on', pct > 4 && pct < 100);
    beamFill.style.width = Math.max(0, Math.min(100, pct)) + '%';
  }
  function stopTimers() { clearInterval(pollTimer); clearInterval(tickTimer); pollTimer = tickTimer = null; }
  function closeGate(message) {
    stopTimers(); active = false; setState('lost'); say(message, true);
    metaEl.textContent = ''; beamTrack.classList.remove('on'); retry.classList.add('on'); verify.hidden = true;
  }
  function tick() {
    if (!expireAt) return;
    var left = Math.max(0, Math.ceil((expireAt - Date.now()) / 1000));
    metaEl.textContent = left <= 60 ? left + ' 秒后过期' : '';
    if (left <= 0) closeGate('入口码已过期，请重新生成');
  }
  async function loadTemplates() {
    try {
      var requested = new URLSearchParams(location.search).get('template');
      var response = await fetch('/onboard/templates' + (requested ? '?template=' + encodeURIComponent(requested) : ''));
      if (!response.ok) throw new Error('模板暂时不可用，请稍后重试');
      var data = await response.json();
      if (!data.templates || !data.templates.length) throw new Error('暂无可用模板');
      // An explicit agent link must never open another agent's authorization.
      if (requested !== null && !data.templates.some(function (template) { return template.id === requested; })) throw new Error('所选 Agent 暂未开放，请稍后重试');
      var preferred = requested !== null ? requested : 'mirror-v';
      var initialCard = null;
      templateList.replaceChildren(); templateSelect.replaceChildren();
      var portraits = {"dealclaw":"agent-dealclaw-portrait-57e4cb1ee845.png","mirror-v":"agent-mirror-v-portrait-1260c99c184d.png","xingqing":"agent-xingqing-portrait-a376b49895b1.png","makaron":"agent-makaron-portrait-154a2a9faba7.png","mirror-v-full":"agent-mirror-v-full-portrait-ed4e1c0cbd1d.png"};
      data.templates.forEach(function (template) {
        if (portraits[template.id]) template.avatarUrl = '/onboard/assets/' + portraits[template.id];
        var card = document.createElement('button');
        card.type = 'button'; card.className = 'template-card'; card.setAttribute('aria-pressed', 'false'); card.setAttribute('data-agent', template.id);
        var option = document.createElement('option'); option.value = template.id; option.textContent = template.name; templateSelect.appendChild(option);
        if (template.avatarUrl) {
          var avatar = document.createElement('img'); avatar.className = 'template-avatar'; avatar.alt = ''; avatar.width = 48; avatar.height = 48; avatar.decoding = 'async';
          avatar.src = template.avatarUrl; avatar.addEventListener('error', function (event) { event.currentTarget.remove(); });
          card.append(avatar);
        } else {
          var symbol = document.createElement('span'); symbol.className = 'template-symbol'; symbol.setAttribute('aria-hidden','true');
          symbol.textContent = template.id === 'dealclaw' ? 'DC' : template.id === 'xingqing' ? '星' : template.id === 'mirror-v-full' ? 'V+' : 'V'; card.append(symbol);
        }
        var name = document.createElement('span'); name.className = 'template-name'; name.textContent = template.name;
        card.setAttribute('aria-label', template.name + '，' + template.description);
        card.append(name);
        var summary = document.createElement('span'); summary.className = 'template-summary'; summary.textContent = template.description; card.append(summary);
        card.addEventListener('click', function () {
          if (selectedTemplate && selectedTemplate.id === template.id) return;
          selectedTemplate = template; templateSelect.value = template.id;
          templateList.querySelectorAll('button').forEach(function (button) { button.setAttribute('aria-pressed', String(button === card)); });
          templateDescription.textContent = template.description;
          var url = new URL(location.href); url.searchParams.set('template', template.id); history.replaceState(null, '', url);
          open();
        });
        templateList.appendChild(card);
        if (preferred === template.id || (!initialCard && template === data.templates[0])) initialCard = card;
      });
      initialCard.click();
    } catch (error) { closeGate(error.message || '模板加载失败'); }
  }
  async function open() {
    if (!selectedTemplate) { loadTemplates(); return; }
    var currentGeneration = ++generation;
    var template = selectedTemplate;
    document.getElementById('selectedAgentName').textContent = template.name;
    var selectedAvatar = document.getElementById('selectedAgentAvatar');
    var selectedSymbol = document.getElementById('selectedAgentSymbol');
    selectedAvatar.hidden = !template.avatarUrl; selectedSymbol.hidden = !!template.avatarUrl;
    if (template.avatarUrl) selectedAvatar.src = template.avatarUrl;
    selectedSymbol.textContent = template.id === 'dealclaw' ? 'DC' : template.id === 'xingqing' ? '星' : template.id === 'mirror-v-full' ? 'V+' : 'V';
    var channel = selectedChannel;
    var previousFeishu = feishuCode, previousWeixin = weixinCode;
    stopTimers(); active = false; feishuCode = null; weixinCode = null; expireAt = null;
    if (previousFeishu) fetch('/onboard/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceCode: previousFeishu }), keepalive: true }).catch(function () {});
    if (previousWeixin) fetch('/onboard/weixin/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceCode: previousWeixin }), keepalive: true }).catch(function () {});
    retry.classList.remove('on'); setState(''); core.style.display = 'block'; code.style.display = 'none';
    var needsAccount = template.id === 'makaron';
    accountForm.hidden = !needsAccount; gate.style.display = needsAccount && !accountKey ? 'none' : 'grid';
    if (needsAccount && !accountKey) { core.style.display='none'; say(copy[6]); return; }
    verify.hidden = true; verifyCode.value = '';
    say('正在生成' + (channel === 'weixin' ? '微信授权码' : '飞书授权码') + '…'); metaEl.textContent = ''; progress(0);
    try {
      var response = await fetch(channel === 'weixin' ? '/onboard/weixin/start' : '/onboard/feishu/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ templateId: template.id, ...(needsAccount ? { makaronApiKey: accountKey } : {}) }),
      });
      var data = await response.json();
      if (currentGeneration !== generation) {
        if (channel === 'weixin' && data.deviceCode) fetch('/onboard/weixin/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceCode: data.deviceCode }), keepalive: true }).catch(function () {});
        if (channel === 'feishu' && data.deviceCode) fetch('/onboard/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceCode: data.deviceCode }), keepalive: true }).catch(function () {});
        return;
      }
      if (!response.ok || !data.ok || !data.qrDataUri) {
        if (needsAccount && /^MAKARON_ACCOUNT_/.test(data.code || '')) { accountKey=''; gate.style.display='none'; accountForm.hidden=false; throw new Error(copy[data.code==='MAKARON_ACCOUNT_INVALID' ? 7 : data.code==='MAKARON_ACCOUNT_REQUIRED' ? 6 : 8]); }
        throw new Error(data.message || '入口码生成失败');
      }
      accountInput.value=''; accountForm.hidden=true;
      if (channel === 'weixin') weixinCode = data.deviceCode;
      else feishuCode = data.deviceCode;
      if (channel === 'weixin' ? !weixinCode : !feishuCode) throw new Error('授权会话不可用，请重新生成');
      active = true; core.style.display = 'none';
      code.src = data.qrDataUri; code.alt = '用' + (channel === 'weixin' ? '微信' : '飞书') + '扫码创建 ' + template.name;
      code.style.display = 'block'; setState('live');
      say(channel === 'weixin' ? '用微信扫一扫，创建 ' + template.name : '用飞书扫码，创建 ' + template.name);
      expireAt = Date.now() + (data.expireIn || 600) * 1000;
      tick(); pollTimer = setInterval(poll, POLL_MS); tickTimer = setInterval(tick, 1000);
    } catch (error) { if (currentGeneration === generation) closeGate(error.message || '入口码生成失败'); }
  }
  async function poll() {
    if (!active) return;
    var channel = selectedChannel;
    var checked = channel === 'weixin' ? weixinCode : feishuCode;
    if (!checked) return;
    try {
      var response = await fetch(channel === 'weixin' ? '/onboard/weixin/status/' + encodeURIComponent(checked) : '/onboard/feishu/status/' + encodeURIComponent(checked));
      var data = await response.json();
      if (channel !== selectedChannel || checked !== (channel === 'weixin' ? weixinCode : feishuCode)) return;
      if (!response.ok || data.status === 'expired') { closeGate(data.message || '入口码已过期'); return; }
      if (typeof data.progress === 'number') progress(data.progress);
      if (channel === 'weixin') {
        verify.hidden = data.status !== 'need_verify_code';
        if (data.status === 'scanned') { progress(35); say('已扫码，请在微信完成确认'); }
        else if (data.status === 'need_verify_code') { progress(50); say('请输入微信显示的验证码'); }
        else if (data.status === 'completed') {
          stopTimers(); active = false; progress(100); setState('through');
          code.style.display = 'none'; say(selectedTemplate.name + ' 已就绪');
          metaEl.textContent = '回到微信，开始对话';
        } else if (data.status === 'failed') closeGate('微信绑定失败，请重新生成授权码');
        else say('用微信扫一扫，创建 ' + selectedTemplate.name);
        return;
      }
      if (data.status === 'pending') say('用飞书扫一扫，创建 ' + selectedTemplate.name);
      else if (data.status === 'provisioning') { setState('opening'); say('正在为你开通 ' + selectedTemplate.name + '…'); }
      else if (data.status === 'completed') {
        stopTimers(); active = false; progress(100); setState('through');
        code.style.display = 'none'; say(selectedTemplate.name + ' 已就绪');
        metaEl.textContent = '回到飞书，开始对话';
        setTimeout(function () { beamTrack.classList.remove('on'); }, 900);
      } else if (data.status === 'failed' || data.status === 'cancelled') closeGate(data.message || '授权未完成，请重新生成');
      else say('请在飞书完成授权');
    } catch (error) { /* transient — keep polling */ }
  }
  function chooseChannel(channel) {
    if (channel === selectedChannel) return;
    selectedChannel = channel;
    channelFeishu.setAttribute('aria-pressed', String(channel === 'feishu'));
    channelWeixin.setAttribute('aria-pressed', String(channel === 'weixin'));
    open();
  }
  channelFeishu.addEventListener('click', function () { chooseChannel('feishu'); });
  channelWeixin.addEventListener('click', function () { chooseChannel('weixin'); });
  verify.addEventListener('submit', async function (event) {
    event.preventDefault();
    var value = verifyCode.value.trim(), checked = weixinCode;
    if (!checked || !/^\\d{4,8}$/.test(value)) { say('请输入 4–8 位微信验证码', true); return; }
    try {
      var response = await fetch('/onboard/weixin/verify/' + encodeURIComponent(checked), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: value }) });
      var data = await response.json();
      if (!response.ok || !data.ok) throw new Error('验证码未通过，请重新核对');
      verify.hidden = true; say('验证码已提交，请在微信完成确认');
    } catch (error) { say(error.message || '验证码提交失败', true); }
  });
  retry.addEventListener('click', function () { if (selectedTemplate) open(); else loadTemplates(); });
  document.addEventListener('visibilitychange', function () {
    if (!active) return;
    if (document.hidden) { clearInterval(pollTimer); pollTimer = null; }
    else if (!pollTimer) { poll(); pollTimer = setInterval(poll, POLL_MS); }
  });
  templateSelect.addEventListener('change', function () {
    templateList.querySelectorAll('button').forEach(function(card){ if(card.getAttribute('data-agent') === templateSelect.value) card.click(); });
  });
  loadTemplates();
})();
</script>
</body>
</html>
`;
