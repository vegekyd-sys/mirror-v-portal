/**
 * Nexus Onboarding — the gate.
 *
 * One QR code, nothing else. No forms, no tenant identifiers, no plan tiers:
 * the page shows a portal, you scan it, you are through. Customer-identifying
 * details are deliberately absent from every state, including success.
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
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<meta name="color-scheme" content="dark">
<title>NEXUS</title>
<style>
  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

  :root {
    --void: #04050a;
    --deep: #0a0e1f;
    --beam: #3ddad7;
    --beam-soft: rgba(61, 218, 215, 0.55);
    --arc: #7b6cf6;
    --text: #e8ecf8;
    --dim: rgba(232, 236, 248, 0.42);
    --faint: rgba(232, 236, 248, 0.18);
    --gate: 248px;
  }

  html, body { height: 100%; }

  body {
    background: var(--void);
    color: var(--text);
    font-family: ui-sans-serif, -apple-system, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif;
    min-height: 100dvh;
    display: grid;
    place-items: center;
    overflow: hidden;
    position: relative;
    -webkit-font-smoothing: antialiased;
  }

  /* ── depth: the void behind the gate ───────────────────────── */
  .depth {
    position: fixed; inset: 0; pointer-events: none;
    background:
      radial-gradient(ellipse 70% 50% at 50% 50%, rgba(123, 108, 246, 0.16), transparent 70%),
      radial-gradient(ellipse 40% 30% at 50% 50%, rgba(61, 218, 215, 0.10), transparent 70%),
      var(--void);
  }

  /* starfield — two drifting layers, pure CSS */
  .stars {
    position: fixed; inset: -50%; pointer-events: none;
    background-image:
      radial-gradient(1px 1px at 20% 30%, rgba(255,255,255,.7), transparent),
      radial-gradient(1px 1px at 65% 15%, rgba(255,255,255,.5), transparent),
      radial-gradient(1px 1px at 82% 62%, rgba(255,255,255,.6), transparent),
      radial-gradient(1px 1px at 35% 78%, rgba(255,255,255,.4), transparent),
      radial-gradient(1px 1px at 12% 55%, rgba(255,255,255,.5), transparent),
      radial-gradient(1px 1px at 92% 38%, rgba(255,255,255,.35), transparent),
      radial-gradient(1px 1px at 48% 45%, rgba(255,255,255,.45), transparent);
    background-size: 380px 380px;
    animation: drift 140s linear infinite;
    opacity: .55;
  }
  .stars.far { background-size: 220px 220px; animation-duration: 240s; opacity: .3; }

  @keyframes drift { to { transform: translate3d(-380px, -380px, 0); } }

  /* ── stage ─────────────────────────────────────────────────── */
  .stage {
    position: relative; z-index: 2;
    display: flex; flex-direction: column; align-items: center;
    padding: 32px 24px;
  }

  .mark {
    font-size: 13px; font-weight: 500;
    letter-spacing: .62em; text-indent: .62em;
    color: var(--text);
    opacity: .92;
    margin-bottom: 8px;
  }
  .tagline {
    font-size: 11px; letter-spacing: .3em; text-indent: .3em;
    color: rgba(232, 236, 248, .38);
    margin-bottom: 44px;
    text-transform: uppercase;
  }

  /* ── the gate ──────────────────────────────────────────────── */
  .gate {
    position: relative;
    width: var(--gate); height: var(--gate);
    display: grid; place-items: center;
  }

  /* rotating rings — the aperture */
  .ring {
    position: absolute; inset: 0;
    border-radius: 50%;
    border: 1px solid transparent;
    animation: spin 24s linear infinite;
  }
  .ring.a {
    border-top-color: var(--beam-soft);
    border-right-color: rgba(123, 108, 246, .3);
    inset: -22px;
  }
  .ring.b {
    border-bottom-color: rgba(123, 108, 246, .45);
    border-left-color: rgba(61, 218, 215, .2);
    inset: -36px;
    animation-duration: 38s;
    animation-direction: reverse;
  }
  .ring.c {
    inset: -52px;
    border-top-color: rgba(232, 236, 248, .08);
    border-bottom-color: rgba(232, 236, 248, .08);
    animation-duration: 60s;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* the glow well behind the code */
  .well {
    position: absolute; inset: -10px;
    border-radius: 24px;
    background: radial-gradient(circle at 50% 50%, rgba(61,218,215,.22), transparent 68%);
    filter: blur(14px);
    animation: breathe 5.5s ease-in-out infinite;
  }
  @keyframes breathe {
    0%, 100% { opacity: .55; transform: scale(1); }
    50%      { opacity: 1;  transform: scale(1.06); }
  }

  /* the portal surface that holds the QR */
  .portal {
    position: relative;
    width: 216px; height: 216px;
    border-radius: 18px;
    background: linear-gradient(160deg, rgba(255,255,255,.06), rgba(255,255,255,.02));
    border: 1px solid rgba(232, 236, 248, .14);
    backdrop-filter: blur(6px);
    display: grid; place-items: center;
    overflow: hidden;
    transition: box-shadow .6s ease, border-color .6s ease, transform .6s cubic-bezier(.2,.8,.2,1);
    box-shadow: 0 0 0 1px rgba(61,218,215,.06), 0 18px 60px rgba(4,5,10,.9);
  }

  /* corner brackets — targeting reticle */
  .bracket {
    position: absolute; width: 18px; height: 18px;
    border: 1.5px solid var(--beam); opacity: .7;
    transition: opacity .5s ease;
  }
  .bracket.tl { top: 10px; left: 10px; border-right: 0; border-bottom: 0; border-radius: 4px 0 0 0; }
  .bracket.tr { top: 10px; right: 10px; border-left: 0; border-bottom: 0; border-radius: 0 4px 0 0; }
  .bracket.bl { bottom: 10px; left: 10px; border-right: 0; border-top: 0; border-radius: 0 0 0 4px; }
  .bracket.br { bottom: 10px; right: 10px; border-left: 0; border-top: 0; border-radius: 0 0 4px 0; }

  /* the QR itself, inset so the portal frame reads as a doorway */
  #code {
    width: 176px; height: 176px;
    border-radius: 8px;
    background: #fff;
    padding: 8px;
    display: none;
    animation: arrive .7s cubic-bezier(.2,.8,.2,1);
  }
  @keyframes arrive {
    from { opacity: 0; transform: scale(.9) translateZ(0); filter: blur(6px); }
    to   { opacity: 1; transform: scale(1);                filter: blur(0); }
  }

  /* scan sweep */
  .sweep {
    position: absolute; left: 0; right: 0; height: 28%;
    background: linear-gradient(180deg, transparent, rgba(61,218,215,.16), transparent);
    animation: sweep 2.6s ease-in-out infinite;
    pointer-events: none; display: none;
  }
  @keyframes sweep {
    0%, 100% { transform: translateY(-40%); opacity: 0; }
    50%      { transform: translateY(300%); opacity: 1; }
  }

  /* idle / loading core */
  .core {
    width: 46px; height: 46px; border-radius: 50%;
    border: 1.5px solid var(--faint);
    border-top-color: var(--beam);
    animation: spin 1.1s linear infinite;
  }

  /* ── states ────────────────────────────────────────────────── */
  .gate.live .portal { box-shadow: 0 0 44px rgba(61,218,215,.28), 0 18px 60px rgba(4,5,10,.9); border-color: rgba(61,218,215,.3); }

  .gate.opening .portal { box-shadow: 0 0 78px rgba(123,108,246,.5), 0 18px 60px rgba(4,5,10,.9); border-color: rgba(123,108,246,.55); }
  .gate.opening .ring { animation-duration: 3.2s; }

  .gate.through .portal { transform: scale(.94); border-color: rgba(61,218,215,.55); box-shadow: 0 0 110px rgba(61,218,215,.45), 0 18px 60px rgba(4,5,10,.9); }
  .gate.through .ring { animation-duration: 90s; opacity: .35; }
  .gate.through .bracket { opacity: 0; }

  .gate.lost .portal { border-color: rgba(232,236,248,.1); box-shadow: 0 18px 60px rgba(4,5,10,.9); }
  .gate.lost .ring { animation-play-state: paused; opacity: .18; }
  .gate.lost .well { animation-play-state: paused; opacity: .15; }
  .gate.lost .bracket { opacity: .15; }
  .gate.lost #code { filter: grayscale(1) brightness(.45); }

  /* the arrival glyph */
  .arrived {
    position: absolute; display: none; place-items: center;
    width: 64px; height: 64px;
  }
  .arrived svg { width: 100%; height: 100%; }
  .arrived circle, .arrived path {
    stroke: var(--beam); fill: none; stroke-width: 1.5;
    stroke-linecap: round; stroke-linejoin: round;
  }
  .arrived circle { stroke-dasharray: 189; stroke-dashoffset: 189; animation: draw .8s ease forwards; opacity: .5; }
  .arrived path   { stroke-dasharray: 40;  stroke-dashoffset: 40;  animation: draw .5s ease .55s forwards; stroke-width: 2; }
  @keyframes draw { to { stroke-dashoffset: 0; } }

  .gate.through .arrived { display: grid; }
  .gate.through #code, .gate.through .sweep { display: none; }

  /* ── readout ───────────────────────────────────────────────── */
  .readout {
    margin-top: 40px;
    height: 52px;
    display: flex; flex-direction: column; align-items: center; gap: 9px;
  }
  .status {
    font-size: 13.5px; letter-spacing: .04em; color: var(--text);
    opacity: .88; text-align: center;
    transition: color .4s ease;
  }
  .status.warn { color: #f0a868; }
  .meta {
    font-size: 11px; letter-spacing: .18em;
    color: var(--dim);
    font-variant-numeric: tabular-nums;
    min-height: 14px;
  }

  /* progress — a thin beam, not a bar */
  .beam-track {
    margin-top: 22px;
    width: 216px; height: 1px;
    background: rgba(232,236,248,.1);
    position: relative; overflow: hidden;
    opacity: 0; transition: opacity .5s ease;
  }
  .beam-track.on { opacity: 1; }
  .beam-fill {
    position: absolute; inset: 0 auto 0 0; width: 0%;
    background: linear-gradient(90deg, var(--arc), var(--beam));
    box-shadow: 0 0 10px var(--beam-soft);
    transition: width .7s cubic-bezier(.2,.8,.2,1);
  }

  /* a single, quiet affordance — only when the gate has closed */
  .retry {
    margin-top: 26px;
    background: transparent;
    border: 1px solid rgba(232,236,248,.2);
    color: var(--dim);
    padding: 9px 22px; border-radius: 999px;
    font-size: 12px; letter-spacing: .16em;
    cursor: pointer; opacity: 0; pointer-events: none;
    transition: opacity .45s ease, color .25s ease, border-color .25s ease;
    font-family: inherit;
  }
  .retry.on { opacity: 1; pointer-events: auto; }
  .retry:hover { color: var(--text); border-color: rgba(61,218,215,.5); }

  @media (max-width: 400px) {
    :root { --gate: 210px; }
    .portal { width: 188px; height: 188px; }
    #code { width: 152px; height: 152px; }
    .mark { letter-spacing: .5em; text-indent: .5em; }
  }

  @media (prefers-reduced-motion: reduce) {
    .stars, .ring, .well, .sweep, .core { animation: none; }
    .arrived circle, .arrived path { animation: none; stroke-dashoffset: 0; }
  }
</style>
</head>
<body>
<div class="depth"></div>
<div class="stars far"></div>
<div class="stars"></div>

<main class="stage">
  <div class="mark">NEXUS</div>
  <div class="tagline">scan to cross</div>

  <div class="gate" id="gate">
    <div class="ring c"></div>
    <div class="ring b"></div>
    <div class="ring a"></div>
    <div class="well"></div>

    <div class="portal">
      <span class="bracket tl"></span>
      <span class="bracket tr"></span>
      <span class="bracket bl"></span>
      <span class="bracket br"></span>

      <div class="core" id="core"></div>
      <img id="code" alt="">
      <div class="sweep" id="sweep"></div>

      <div class="arrived">
        <svg viewBox="0 0 64 64" aria-hidden="true">
          <circle cx="32" cy="32" r="30"></circle>
          <path d="M20 33 l9 9 l16 -19"></path>
        </svg>
      </div>
    </div>
  </div>

  <div class="beam-track" id="beamTrack"><div class="beam-fill" id="beamFill"></div></div>

  <div class="readout">
    <div class="status" id="status">正在开启通道…</div>
    <div class="meta" id="meta"></div>
  </div>

  <button class="retry" id="retry" type="button">重新开启</button>
</main>

<script>
(function () {
  var deviceCode = null, pollTimer = null, tickTimer = null, expireAt = null;
  var gate = document.getElementById('gate');
  var core = document.getElementById('core');
  var code = document.getElementById('code');
  var sweep = document.getElementById('sweep');
  var statusEl = document.getElementById('status');
  var metaEl = document.getElementById('meta');
  var beamTrack = document.getElementById('beamTrack');
  var beamFill = document.getElementById('beamFill');
  var retry = document.getElementById('retry');

  function setState(cls) { gate.className = 'gate' + (cls ? ' ' + cls : ''); }
  function say(text, warn) {
    statusEl.textContent = text;
    statusEl.className = 'status' + (warn ? ' warn' : '');
  }
  function progress(pct) {
    beamTrack.classList.add('on');
    beamFill.style.width = Math.max(0, Math.min(100, pct)) + '%';
  }
  function stopTimers() { clearInterval(pollTimer); clearInterval(tickTimer); pollTimer = tickTimer = null; }

  function closeGate(message) {
    stopTimers();
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
    metaEl.textContent = '通道将在 ' + m + ':' + (s < 10 ? '0' + s : s) + ' 后关闭';
    if (left <= 0) closeGate('通道已关闭');
  }

  async function open() {
    retry.classList.remove('on');
    setState('');
    core.style.display = 'block';
    code.style.display = 'none';
    sweep.style.display = 'none';
    say('正在开启通道…');
    metaEl.textContent = '';
    beamTrack.classList.remove('on');
    beamFill.style.width = '0%';

    try {
      var res = await fetch('/onboard/feishu/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
      });
      var data = await res.json();
      if (!data.ok) throw new Error(data.message || '通道开启失败');

      deviceCode = data.deviceCode;
      core.style.display = 'none';
      code.src = data.qrDataUri || data.qrUrl;
      code.style.display = 'block';
      sweep.style.display = 'block';
      setState('live');
      say('用飞书扫描，即刻穿过');

      expireAt = Date.now() + (data.expireIn || 300) * 1000;
      tick();
      progress(4);

      pollTimer = setInterval(poll, 2000);
      tickTimer = setInterval(tick, 1000);
    } catch (err) {
      closeGate(err.message || '通道开启失败');
    }
  }

  async function poll() {
    if (!deviceCode) return;
    try {
      var res = await fetch('/onboard/feishu/status/' + deviceCode);
      var data = await res.json();

      if (typeof data.progress === 'number') progress(data.progress);

      if (data.status === 'provisioning') {
        setState('opening');
        say('正在构建你的世界…');
        metaEl.textContent = '';
        sweep.style.display = 'none';
        code.style.display = 'none';
        core.style.display = 'block';
      } else if (data.status === 'completed') {
        stopTimers();
        progress(100);
        setState('through');
        say('你已穿过');
        metaEl.textContent = '回到飞书，开始对话';
        setTimeout(function () { beamTrack.classList.remove('on'); }, 900);
      } else if (data.status === 'failed' || data.status === 'expired' || data.status === 'cancelled') {
        closeGate(data.message || '通道已关闭');
      }
    } catch (e) { /* transient — keep polling */ }
  }

  retry.addEventListener('click', open);

  window.addEventListener('beforeunload', function () {
    if (!deviceCode) return;
    try {
      navigator.sendBeacon('/onboard/cancel',
        new Blob([JSON.stringify({ deviceCode: deviceCode })], { type: 'application/json' }));
    } catch (e) {}
  });

  open();
})();
</script>
</body>
</html>
`;
