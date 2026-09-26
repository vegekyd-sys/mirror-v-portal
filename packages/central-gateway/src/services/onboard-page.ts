/**
 * Mirror V Portal onboarding — the gate.
 *
 * Choose an Agent template, then scan a QR code to create its own instance.
 *
 * Feishu uses a Portal entry; WeChat displays its native iLink QR on desktop.
 */
export const ONBOARD_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="dark">
<title>Mirror V Portal · 选择你的 Agent</title>
<link rel="preload" as="image" href="/onboard/assets/nexus-world-v2.webp" media="(min-width: 601px)">
<link rel="preload" as="image" href="/onboard/assets/nexus-world-mobile-v2.webp" media="(max-width: 600px)">
<style>
  * { box-sizing:border-box; }
  [hidden] { display:none!important; }
  :root { color-scheme:dark; font-family:"Helvetica Neue","PingFang SC",sans-serif; color:#fff; background:#000; }
  body { margin:0; min-width:280px; -webkit-font-smoothing:antialiased; }
  .experience { min-height:700px; height:100svh; position:relative; overflow:hidden; isolation:isolate; background:#000; }
  .world { position:absolute; inset:0; z-index:-3; }
  .world img { width:100%; height:100%; object-fit:cover; object-position:50% 50%; animation:arrival 1.8s cubic-bezier(.2,.7,.2,1) both; }
  .world-video { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; z-index:-1; opacity:0; transition:opacity 1.6s; pointer-events:none; }
  .world-video.ready { opacity:1; }
  .motion-control { position:absolute; right:32px; bottom:18px; z-index:3; width:44px; height:44px; border:1px solid #ffffff44; border-radius:50%; background:#0005; color:#fff; cursor:pointer; font-size:13px; }
  .motion-control:focus-visible { outline:2px solid #fff; outline-offset:4px; }
  .motion-control[hidden] { display:none; }
  .world::after { content:""; position:absolute; inset:0; background:linear-gradient(#0007,transparent 22%,transparent 74%,#000b); }
  @keyframes arrival { from { opacity:0; } to { opacity:1; } }
  .masthead { position:absolute; top:0; left:0; right:0; padding:32px 40px; display:flex; justify-content:space-between; align-items:center; }
  .brand { display:inline-flex; flex-direction:column; gap:2px; color:#fff; text-decoration:none; text-shadow:0 1px 18px #0009; }
  .brand strong { font-size:23px; line-height:1; font-weight:650; letter-spacing:-.055em; }
  .brand small { font-size:10px; font-weight:550; letter-spacing:.28em; text-transform:uppercase; }
  .signature { font-size:12px; color:#c4c5cf; letter-spacing:.02em; }
  .gateway { position:absolute; top:54%; left:50%; transform:translate(-50%,-50%); width:250px; display:flex; flex-direction:column; align-items:center; }
  .template-picker { position:absolute; z-index:4; top:13%; left:50%; transform:translateX(-50%); width:min(540px,calc(100% - 40px)); text-align:center; }
  .template-picker h1 { margin:0 0 14px; font-size:15px; font-weight:500; letter-spacing:.12em; text-shadow:0 1px 12px #000; }
  .template-list { display:flex; justify-content:center; gap:10px; }
  .template-card { flex:1; max-width:250px; min-height:72px; padding:12px 14px; border:1px solid #ffffff77; border-radius:12px; background:#09121bc9; color:#fff; text-align:left; cursor:pointer; font:inherit; backdrop-filter:blur(14px); }
  .template-card[aria-pressed="true"] { border-color:#fff; background:#e9f2ffe8; color:#142032; }
  .template-card:focus-visible { outline:3px solid #fff; outline-offset:3px; }
  .template-name { display:block; font-size:14px; font-weight:600; }
  .template-description { display:block; margin-top:4px; font-size:11px; line-height:1.35; opacity:.8; }
  .gateway::before { content:""; position:absolute; z-index:-1; inset:-38px -40px; background:radial-gradient(ellipse, #f4f8fff5 30%, #f4f8ffe0 49%, #f4f8ff00 72%); filter:blur(14px); pointer-events:none; }
  .gate { width:216px; height:216px; display:grid; place-items:center; transition:transform 1s, filter 1s; }
  .portal { position:relative; width:100%; height:100%; display:grid; place-items:center; padding:6px; background:transparent; }
  #code { display:none; width:204px; height:204px; object-fit:contain; mix-blend-mode:multiply; opacity:.88; }
  .core { width:28px; height:28px; border:1.5px solid #14151b22; border-top-color:#14151b; border-radius:50%; animation:spin 1s linear infinite; }
  @keyframes spin { to { transform:rotate(360deg); } }
  .arrived { display:none; width:56px; height:56px; color:#151c2c; }
  .arrived svg { width:100%; height:100%; fill:none; stroke:currentColor; stroke-width:1.5; stroke-linecap:round; stroke-linejoin:round; }
  .gate.opening { transform:scale(.92); }
  .gate.through { transform:scale(.88); }
  .gate.through .arrived { display:block; }
  .gate.through #code,.gate.through .core { display:none!important; }
  .gate.lost #code { visibility:hidden; }
  .gate.lost .core { display:none!important; }
  .gate.lost .portal::after { content:"↻"; position:absolute; color:#545767; font-size:40px; }
  .beam-track { width:80px; height:1px; margin-top:9px; opacity:0; background:#27344c22; }
  .beam-track.on { opacity:1; }
  .beam-fill { width:0; height:100%; background:#27344c; transition:width .7s; }
  .readout { margin-top:13px; text-align:center; padding:0 8px; }
  .status { font-size:12px; line-height:1.6; letter-spacing:.08em; color:#26344b; }
  .status.warn { color:#773b21; }
  .meta { color:#55647b; font-size:10px; font-variant-numeric:tabular-nums; margin-top:4px; }
  .meta:empty { display:none; }
  .retry { visibility:hidden; position:absolute; top:calc(100% + 12px); border:1px solid #26344b88; background:#f4f8ffcc; color:#26344b; border-radius:4px; font:inherit; font-size:13px; padding:12px 20px; min-height:44px; cursor:pointer; }
  .retry.on { visibility:visible; }
  .retry:hover { background:#dbe4f2; color:#000; }
  .retry:focus-visible { outline:3px solid #fff; outline-offset:5px; }
  .channel-picker { display:flex; width:216px; margin-top:18px; padding:3px; border:1px solid #2c3c54; border-radius:999px; background:#eef4fc; }
  .channel-picker button { flex:1; min-height:36px; border:0; border-radius:999px; background:transparent; color:#172b45; font:inherit; font-size:13px; font-weight:600; cursor:pointer; }
  .channel-picker button[aria-pressed="true"] { background:#243a59; color:#fff; }
  .channel-picker button:focus-visible,.verify button:focus-visible,.verify input:focus-visible { outline:2px solid #243a59; outline-offset:2px; }
  .verify { width:216px; margin-top:12px; display:flex; gap:6px; }
  .verify input { min-width:0; flex:1; height:38px; padding:0 10px; border:1px solid #435774; border-radius:5px; background:#eef4fc; color:#172944; font:inherit; font-size:12px; }
  .verify button { height:38px; padding:0 12px; border:0; border-radius:5px; background:#243a59; color:#fff; font:inherit; font-size:12px; cursor:pointer; }
  .edge { position:absolute; bottom:30px; left:40px; right:40px; display:flex; justify-content:space-between; align-items:center; pointer-events:none; }
  .edge span { font-size:11px; color:#c4c5cf; }
  .edge-line { height:1px; width:44px; background:#ffffff55; }
  @media(min-aspect-ratio:19/10) { .world img { object-fit:contain; } }
  @media(max-width:600px) { .experience { min-height:620px; } .masthead { padding:24px; } .brand strong { font-size:19px; } .brand small { font-size:9px; } .signature { font-size:11px; } .world img { object-fit:cover; } .template-picker { top:15%; } .gateway { top:55%; } .gate { width:200px; height:200px; } #code { width:188px; height:188px; } .edge { left:24px; right:24px; bottom:24px; } }
  @media(prefers-reduced-motion:reduce) { *,*::before,*::after { animation:none!important; transition:none!important; } }
</style>
</head>
<body>
<main class="experience" aria-label="Mirror V Portal，选择 Agent">
  <picture class="world" aria-hidden="true"><source media="(max-width: 600px)" srcset="/onboard/assets/nexus-world-mobile-v2.webp"><img src="/onboard/assets/nexus-world-v2.webp" alt="" fetchpriority="high"></picture>
  <video class="world-video" id="worldVideo" muted playsinline preload="none" aria-hidden="true"></video>
  <video class="world-video" id="worldVideoNext" muted playsinline preload="none" aria-hidden="true"></video>
  <button class="motion-control" id="motionControl" type="button" aria-label="暂停背景动画" hidden>Ⅱ</button>
  <header class="masthead"><span class="brand"><strong>Mirror V</strong><small>Portal</small></span><span class="signature">your agent, your world</span></header>
  <section class="template-picker" aria-label="选择 Agent 模板"><h1>选择你的 Agent</h1><div class="template-list" id="templateList"></div></section>
  <section class="gateway" aria-label="扫码创建 Agent">
    <div class="gate" id="gate"><div class="portal">
      <div class="core" id="core" aria-hidden="true"></div>
      <img id="code" alt="扫码创建 Agent">
      <div class="arrived" aria-hidden="true"><svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="30"/><path d="M20 33l9 9 16-19"/></svg></div>
    </div></div>
    <div class="beam-track" id="beamTrack"><div class="beam-fill" id="beamFill"></div></div>
    <div class="readout"><div class="status" id="status" role="status" aria-live="polite">正在加载 Agent 模板…</div><div class="meta" id="meta"></div></div>
    <div class="channel-picker" role="group" aria-label="选择扫码 App"><button type="button" id="channelFeishu" aria-pressed="true">飞书</button><button type="button" id="channelWeixin" aria-pressed="false">微信</button></div>
    <form class="verify" id="verify" hidden><input id="verifyCode" inputmode="numeric" autocomplete="one-time-code" placeholder="微信验证码" aria-label="微信验证码"><button type="submit">确认</button></form>
    <button class="retry" id="retry" type="button">重新生成二维码</button>
  </section>
  <div class="edge" aria-hidden="true"><span class="edge-line"></span><span>另一种可能</span><span class="edge-line"></span></div>
</main>

<script>
(function () {
  var videos = [document.getElementById('worldVideo'), document.getElementById('worldVideoNext')];
  var button = document.getElementById('motionControl');
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  var pausedByUser = false, current = 0, switching = false, transitionTimer = null;
  var source = '/onboard/assets/nexus-world-v5.mp4?v=6';
  function canPlay() { return !reduced.matches && !document.hidden && !pausedByUser; }
  function label() {
    button.textContent = pausedByUser ? '▷' : 'Ⅱ';
    button.setAttribute('aria-label', pausedByUser ? '播放背景动画' : '暂停背景动画');
  }
  function syncMotion() {
    if (reduced.matches) {
      videos.forEach(function (v) { v.pause(); v.classList.remove('ready'); });
      button.hidden = true;
      return;
    }
    button.hidden = false;
    if (!canPlay()) { videos.forEach(function (v) { v.pause(); }); return; }
    var active = videos[current];
    if (!active.getAttribute('src')) active.src = source;
    active.muted = true;
    active.play().then(function () {
      if (!canPlay()) { active.pause(); return; }
      active.style.zIndex = '-1';
      active.classList.add('ready');
      var standby = videos[1-current];
      if (!standby.getAttribute('src')) { standby.preload = 'auto'; standby.src = source; standby.load(); }
      label();
    }).catch(function () { pausedByUser = true; label(); });
    if (switching) videos[1-current].play().catch(function () {});
  }
  function switchVideo() {
    if (switching || !canPlay()) return;
    switching = true;
    var outgoing = videos[current], nextIndex = 1-current, incoming = videos[nextIndex];
    incoming.classList.remove('ready');
    if (!incoming.getAttribute('src')) incoming.src = source;
    incoming.currentTime = 0;
    incoming.muted = true;
    incoming.play().then(function () {
      if (!canPlay()) { incoming.pause(); switching = false; return; }
      outgoing.style.zIndex = '-2';
      incoming.style.zIndex = '-1';
      incoming.classList.add('ready');
      current = nextIndex;
      transitionTimer = setTimeout(function () {
        outgoing.pause();
        outgoing.classList.remove('ready');
        outgoing.currentTime = 0;
        switching = false;
        transitionTimer = null;
      }, 1650);
    }).catch(function () { switching = false; });
  }
  videos.forEach(function (v, index) {
    v.addEventListener('timeupdate', function () {
      if (index === current && v.duration && v.duration-v.currentTime < 1.8) switchVideo();
    });
    v.addEventListener('ended', function () { if (index === current) switchVideo(); });
    v.addEventListener('error', function () {
      v.classList.remove('ready');
      if (index === current) button.hidden = true;
    });
  });
  button.addEventListener('click', function () { pausedByUser = !pausedByUser; label(); syncMotion(); });
  reduced.addEventListener('change', syncMotion);
  document.addEventListener('visibilitychange', syncMotion);
  syncMotion();
})();
(function () {
  var entryId = null, weixinCode = null, pollTimer = null, tickTimer = null, expireAt = null, active = false;
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
  var channelFeishu = document.getElementById('channelFeishu');
  var channelWeixin = document.getElementById('channelWeixin');
  var verify = document.getElementById('verify');
  var verifyCode = document.getElementById('verifyCode');

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
      var response = await fetch('/onboard/templates');
      if (!response.ok) throw new Error('模板暂时不可用，请稍后重试');
      var data = await response.json();
      if (!data.templates || !data.templates.length) throw new Error('暂无可用模板');
      var preferred = data.templates.some(function (template) { return template.id === requested; }) ? requested : 'mirror-v';
      var initialCard = null;
      templateList.replaceChildren();
      data.templates.forEach(function (template) {
        var card = document.createElement('button');
        card.type = 'button'; card.className = 'template-card'; card.setAttribute('aria-pressed', 'false');
        var name = document.createElement('span'); name.className = 'template-name'; name.textContent = template.name;
        var desc = document.createElement('span'); desc.className = 'template-description'; desc.textContent = template.description;
        card.append(name, desc);
        card.addEventListener('click', function () {
          if (selectedTemplate && selectedTemplate.id === template.id) return;
          selectedTemplate = template;
          templateList.querySelectorAll('button').forEach(function (button) { button.setAttribute('aria-pressed', String(button === card)); });
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
    var channel = selectedChannel;
    var previousEntry = entryId, previousWeixin = weixinCode;
    stopTimers(); active = false; entryId = null; weixinCode = null; expireAt = null;
    if (previousEntry) fetch('/onboard/portal/' + encodeURIComponent(previousEntry) + '/cancel', { method: 'POST', keepalive: true }).catch(function () {});
    if (previousWeixin) fetch('/onboard/weixin/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceCode: previousWeixin }), keepalive: true }).catch(function () {});
    retry.classList.remove('on'); setState(''); core.style.display = 'block'; code.style.display = 'none';
    verify.hidden = true; verifyCode.value = '';
    say('正在生成' + (channel === 'weixin' ? '微信授权码' : '飞书入口码') + '…'); metaEl.textContent = ''; progress(0);
    try {
      var response = await fetch(channel === 'weixin' ? '/onboard/weixin/start' : '/onboard/portal/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ templateId: template.id }),
      });
      var data = await response.json();
      if (currentGeneration !== generation) {
        if (channel === 'weixin' && data.deviceCode) fetch('/onboard/weixin/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceCode: data.deviceCode }), keepalive: true }).catch(function () {});
        if (channel === 'feishu' && data.entryId) fetch('/onboard/portal/' + encodeURIComponent(data.entryId) + '/cancel', { method: 'POST', keepalive: true }).catch(function () {});
        return;
      }
      if (!response.ok || !data.ok || !data.qrDataUri) throw new Error(data.message || '入口码生成失败');
      if (channel === 'weixin') weixinCode = data.deviceCode;
      else entryId = data.entryId;
      if (channel === 'weixin' ? !weixinCode : !entryId) throw new Error('授权会话不可用，请重新生成');
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
    var checked = channel === 'weixin' ? weixinCode : entryId;
    if (!checked) return;
    try {
      var response = await fetch(channel === 'weixin' ? '/onboard/weixin/status/' + encodeURIComponent(checked) : '/onboard/portal/' + encodeURIComponent(checked) + '/status');
      var data = await response.json();
      if (channel !== selectedChannel || checked !== (channel === 'weixin' ? weixinCode : entryId)) return;
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
      if (!data.channel) return;
      if (data.status === 'scanned' || data.status === 'need_verify_code') say('请在飞书完成确认');
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
  loadTemplates();
})();
</script>
</body>
</html>
`;
