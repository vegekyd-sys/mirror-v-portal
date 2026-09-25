/**
 * Nexus Onboarding — the gate.
 *
 * Choose an Agent template, then scan a QR code to create its own instance.
 *
 * Backend contract (unchanged):
 *   POST /onboard/feishu/start          -> { ok, deviceCode, qrDataUri|qrUrl, expireIn }
 *   GET  /onboard/feishu/status/:code   -> { status, progress, message }
 *   POST /onboard/cancel                -> { deviceCode }
 */
export const ONBOARD_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="dark">
<title>NEXUS · 选择你的 Agent</title>
<link rel="preload" as="image" href="/onboard/assets/nexus-world-v2.webp" media="(min-width: 601px)">
<link rel="preload" as="image" href="/onboard/assets/nexus-world-mobile-v2.webp" media="(max-width: 600px)">
<style>
  * { box-sizing:border-box; }
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
  .brand { width:170px; height:auto; display:block; mix-blend-mode:screen; }
  .signature { font-size:12px; color:#c4c5cf; letter-spacing:.02em; }
  .gateway { mix-blend-mode:multiply; position:absolute; top:47%; left:50%; transform:translate(-50%,-50%); width:250px; display:flex; flex-direction:column; align-items:center; }
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
  .sweep { display:none!important; }
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
  .edge { position:absolute; bottom:30px; left:40px; right:40px; display:flex; justify-content:space-between; align-items:center; pointer-events:none; }
  .edge span { font-size:11px; color:#c4c5cf; }
  .edge-line { height:1px; width:44px; background:#ffffff55; }
  @media(min-aspect-ratio:19/10) { .world img { object-fit:contain; } }
  @media(max-width:600px) { .experience { min-height:620px; } .masthead { padding:24px; } .brand { width:140px; } .signature { font-size:11px; } .world img { object-fit:cover; } .template-picker { top:15%; } .gateway { top:55%; } .gate { width:200px; height:200px; } #code { width:188px; height:188px; } .edge { left:24px; right:24px; bottom:24px; } }
  @media(prefers-reduced-motion:reduce) { *,*::before,*::after { animation:none!important; transition:none!important; } }
</style>
</head>
<body>
<main class="experience" aria-label="Nexus，选择 Agent">
  <picture class="world" aria-hidden="true"><source media="(max-width: 600px)" srcset="/onboard/assets/nexus-world-mobile-v2.webp"><img src="/onboard/assets/nexus-world-v2.webp" alt="" fetchpriority="high"></picture>
  <video class="world-video" id="worldVideo" muted playsinline preload="none" aria-hidden="true"></video>
  <video class="world-video" id="worldVideoNext" muted playsinline preload="none" aria-hidden="true"></video>
  <button class="motion-control" id="motionControl" type="button" aria-label="暂停背景动画" hidden>Ⅱ</button>
  <header class="masthead"><img class="brand" src="/onboard/assets/nexus-logo-v2.webp" alt="NEXUS"><span class="signature">your agent, your world</span></header>
  <section class="template-picker" aria-label="选择 Agent 模板"><h1>选择你的 Agent</h1><div class="template-list" id="templateList"></div></section>
  <section class="gateway" aria-label="飞书扫码创建 Agent">
    <div class="gate" id="gate"><div class="portal">
      <div class="core" id="core" aria-hidden="true"></div>
      <img id="code" alt="飞书扫码创建 Agent">
      <div class="sweep" id="sweep"></div>
      <div class="arrived" aria-hidden="true"><svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="30"/><path d="M20 33l9 9 16-19"/></svg></div>
    </div></div>
    <div class="beam-track" id="beamTrack"><div class="beam-fill" id="beamFill"></div></div>
    <div class="readout"><div class="status" id="status" role="status" aria-live="polite">正在加载 Agent 模板…</div><div class="meta" id="meta"></div></div>
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
  var deviceCode = null, pollTimer = null, tickTimer = null, expireAt = null, active = false;
  var selectedTemplate = null, generation = 0;
  // Edge providers treat sub-second-scale polling from many clients as an attack;
  // 3s is still responsive for a scan while roughly halving requests per session.
  var POLL_MS = 3000;
  var gate = document.getElementById('gate');
  var core = document.getElementById('core');
  var code = document.getElementById('code');
  var sweep = document.getElementById('sweep');
  var statusEl = document.getElementById('status');
  var metaEl = document.getElementById('meta');
  var beamTrack = document.getElementById('beamTrack');
  var beamFill = document.getElementById('beamFill');
  var retry = document.getElementById('retry');
  var templateList = document.getElementById('templateList');

  async function loadTemplates() {
    try {
      var response = await fetch('/onboard/templates');
      if (!response.ok) throw new Error('模板暂时不可用，请稍后重试');
      var data = await response.json();
      if (!data.templates || !data.templates.length) throw new Error('暂无可用模板');
      templateList.replaceChildren();
      data.templates.forEach(function (template) {
        var card = document.createElement('button');
        card.type = 'button'; card.className = 'template-card';
        card.setAttribute('aria-pressed', 'false');
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
      });
      say('请选择 Agent，生成专属二维码');
    } catch (error) { closeGate(error.message || '模板加载失败'); }
  }

  function setState(cls) { gate.className = 'gate' + (cls ? ' ' + cls : ''); }
  function say(text, warn) {
    statusEl.textContent = text;
    statusEl.className = 'status' + (warn ? ' warn' : '');
  }
  function progress(pct) {
    beamTrack.classList.toggle('on', pct > 4 && pct < 100);
    beamFill.style.width = Math.max(0, Math.min(100, pct)) + '%';
  }
  function stopTimers() { clearInterval(pollTimer); clearInterval(tickTimer); pollTimer = tickTimer = null; }

  function closeGate(message) {
    stopTimers();
    active = false;
    setState('lost');
    say(message, true);
    metaEl.textContent = '';
    beamTrack.classList.remove('on');
    retry.classList.add('on');
  }

  function tick() {
    if (!expireAt) return;
    var left = Math.max(0, Math.ceil((expireAt - Date.now()) / 1000));
    var m = Math.floor(left / 60), s = left % 60;
    metaEl.textContent = left <= 60 ? left + ' 秒后过期' : '';
    if (left <= 0) closeGate('二维码已过期，请重新生成');
  }

  async function open() {
    if (!selectedTemplate) { loadTemplates(); return; }
    var currentGeneration = ++generation;
    var template = selectedTemplate;
    var previousCode = deviceCode;
    stopTimers();
    active = false;
    deviceCode = null;
    expireAt = null;
    retry.classList.remove('on');
    setState('');
    core.style.display = 'block';
    code.style.display = 'none';
    sweep.style.display = 'none';
    say('正在生成二维码…');
    metaEl.textContent = '';
    beamTrack.classList.remove('on');
    beamFill.style.width = '0%';
    if (previousCode) fetch('/onboard/cancel', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceCode: previousCode }), keepalive: true,
    }).catch(function () {});

    try {
      var res = await fetch('/onboard/feishu/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateId: template.id }),
      });
      var data = await res.json();
      if (currentGeneration !== generation) {
        if (data.deviceCode) fetch('/onboard/cancel', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({deviceCode:data.deviceCode}), keepalive:true }).catch(function () {});
        return;
      }
      if (!data.ok) throw new Error(data.message || '通道开启失败');

      active = true;
      deviceCode = data.deviceCode;
      core.style.display = 'none';
      code.src = data.qrDataUri || data.qrUrl;
      code.style.display = 'block';
      sweep.style.display = 'block';
      setState('live');
      say('飞书扫码，创建 ' + template.name);

      expireAt = Date.now() + (data.expireIn || 300) * 1000;
      tick();
      progress(4);

      pollTimer = setInterval(poll, POLL_MS);
      tickTimer = setInterval(tick, 1000);
    } catch (err) {
      if (currentGeneration === generation) closeGate(err.message || '通道开启失败');
    }
  }

  async function poll() {
    if (!deviceCode || !active) return;
    var checkedCode = deviceCode;
    try {
      var res = await fetch('/onboard/feishu/status/' + checkedCode);
      var data = await res.json();
      if (checkedCode !== deviceCode) return;

      if (typeof data.progress === 'number') progress(data.progress);

      if (data.status === 'provisioning') {
        clearInterval(tickTimer);
        tickTimer = null;
        expireAt = null;
        setState('opening');
        say('正在为你开通 ' + selectedTemplate.name + '…');
        metaEl.textContent = '';
        sweep.style.display = 'none';
        code.style.display = 'none';
        core.style.display = 'block';
      } else if (data.status === 'completed') {
        stopTimers();
        active = false;
        core.style.display = 'none';
        code.style.display = 'none';
        progress(100);
        setState('through');
        say(selectedTemplate.name + ' 已就绪');
        metaEl.textContent = '回到飞书，开始对话';
        setTimeout(function () { beamTrack.classList.remove('on'); }, 900);
      } else if (data.status === 'failed' || data.status === 'expired' || data.status === 'cancelled') {
        closeGate(data.message || '通道已关闭');
      }
    } catch (e) { /* transient — keep polling */ }
  }

  retry.addEventListener('click', function () { if (selectedTemplate) open(); else loadTemplates(); });

  // While the user is away in Feishu scanning, this tab is hidden and every poll
  // it fires is wasted load. Resume with an immediate check so nothing is missed.
  document.addEventListener('visibilitychange', function () {
    if (!deviceCode || !active) return;
    if (document.hidden) {
      clearInterval(pollTimer);
      pollTimer = null;
    } else if (!pollTimer) {
      poll();
      pollTimer = setInterval(poll, POLL_MS);
    }
  });

  window.addEventListener('beforeunload', function () {
    if (!deviceCode || !active) return;
    try {
      navigator.sendBeacon('/onboard/cancel',
        new Blob([JSON.stringify({ deviceCode: deviceCode })], { type: 'application/json' }));
    } catch (e) {}
  });

  loadTemplates();
})();
</script>
</body>
</html>
`;
