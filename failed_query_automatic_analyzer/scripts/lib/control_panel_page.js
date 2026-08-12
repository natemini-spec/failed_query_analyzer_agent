'use strict';

module.exports = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>검색 실패 키워드 파이프라인 — 컨트롤 패널</title>
<style>
  .viz-root {
    color-scheme: light;
    --surface-1: #fcfcfb; --surface-2: #f5f4f1;
    --text-primary: #0b0b0b; --text-secondary: #52514e; --text-muted: #85837c;
    --border: #e3e1dc;
    --series-1: #2a78d6; --good: #0ca30c; --critical: #d03b3b; --warning: #fab219;
  }
  @media (prefers-color-scheme: dark) {
    :root:where(:not([data-theme="light"])) .viz-root {
      color-scheme: dark;
      --surface-1: #1a1a19; --surface-2: #232322;
      --text-primary: #ffffff; --text-secondary: #c3c2b7; --text-muted: #8b8a82;
      --border: #35342f; --series-1: #3987e5;
    }
  }
  :root[data-theme="dark"] .viz-root {
    color-scheme: dark;
    --surface-1: #1a1a19; --surface-2: #232322;
    --text-primary: #ffffff; --text-secondary: #c3c2b7; --text-muted: #8b8a82;
    --border: #35342f; --series-1: #3987e5;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; overflow-x: hidden; }
  .viz-root {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Malgun Gothic", sans-serif;
    background: var(--surface-1); color: var(--text-primary);
    padding: 24px; max-width: 760px; margin: 0 auto;
  }
  h1 { font-size: 19px; margin: 0 0 4px; }
  .subtitle { color: var(--text-secondary); font-size: 13px; margin: 0 0 24px; }
  section {
    background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px;
    padding: 16px 18px; margin-bottom: 16px;
  }
  h2 { font-size: 14px; margin: 0 0 12px; }
  .row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; font-size: 13px; }
  .badge { font-size: 12px; padding: 2px 8px; border-radius: 999px; font-weight: 600; }
  .badge.ok { background: color-mix(in srgb, var(--good) 20%, transparent); color: var(--good); }
  .badge.bad { background: color-mix(in srgb, var(--critical) 18%, transparent); color: var(--critical); }
  input[type=password], input[type=text], input[type=date] {
    background: var(--surface-1); border: 1px solid var(--border); color: var(--text-primary);
    border-radius: 6px; padding: 8px 10px; font-size: 13px; flex: 1;
  }
  button {
    background: var(--series-1); color: white; border: none; border-radius: 6px;
    padding: 8px 14px; font-size: 13px; cursor: pointer; font-weight: 600;
  }
  button.secondary { background: var(--surface-1); color: var(--text-primary); border: 1px solid var(--border); }
  button.danger { background: var(--critical); }
  button:disabled { opacity: 0.45; cursor: not-allowed; }
  .hint { font-size: 12px; color: var(--text-muted); margin-top: 4px; }
  pre#log {
    background: #0d0d0c; color: #d8d6cd; font-size: 12px; padding: 12px; border-radius: 6px;
    max-height: 320px; overflow-y: auto; white-space: pre-wrap; word-break: break-all;
    margin: 8px 0 0;
  }
  ul.dash-list { list-style: none; padding: 0; margin: 0; font-size: 13px; }
  ul.dash-list li { padding: 6px 0; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; }
  ul.dash-list li:last-child { border-bottom: none; }
  a { color: var(--series-1); text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>
<div class="viz-root">
  <h1>검색 실패 키워드 파이프라인 — 컨트롤 패널</h1>
  <p class="subtitle">로컬 전용 (127.0.0.1) — 이 페이지의 정보는 이 컴퓨터 밖으로 나가지 않습니다.</p>

  <section>
    <h2>1. 상태</h2>
    <div class="row">Redash API Key: <span id="redashBadge" class="badge">확인 중...</span></div>
    <div class="row">Claude Code 로그인: <span id="claudeBadge" class="badge">확인 중...</span></div>
    <div class="row">다음 실행 시 분석 기간: <span id="nextRange">-</span></div>
    <button class="secondary" id="refreshBtn">상태 새로고침</button>
  </section>

  <section>
    <h2>2. Redash API Key 설정</h2>
    <p class="hint">Redash → 우측 상단 프로필 → Edit Profile → API Key (쿼리별 키가 아닌 <b>개인 프로필</b> 키)</p>
    <div class="row">
      <input type="password" id="apiKeyInput" placeholder="개인 프로필 API Key 붙여넣기">
      <button id="saveKeyBtn">저장</button>
    </div>
  </section>

  <section>
    <h2>3. Claude Code 로그인</h2>
    <p class="hint">버튼을 누르면 브라우저 인증 창이 열립니다. 이미 로그인되어 있다면 건너뛰어도 됩니다.</p>
    <button id="loginBtn">Claude 로그인 시작</button>
  </section>

  <section>
    <h2>4. 파이프라인 실행</h2>
    <div class="row">
      <label for="asOfInput" class="hint" style="min-width:150px">기준 날짜(선택, 비우면 오늘):</label>
      <input type="date" id="asOfInput">
    </div>
    <div class="row">
      <button id="runBtn">파이프라인 실행</button>
      <button class="danger secondary" id="cancelBtn" disabled>취소</button>
    </div>
    <pre id="log" style="display:none"></pre>
  </section>

  <section>
    <h2>최근 결과</h2>
    <ul class="dash-list" id="dashList"><li>불러오는 중...</li></ul>
  </section>
</div>

<script>
(function () {
  var logEl = document.getElementById('log');
  var runBtn = document.getElementById('runBtn');
  var cancelBtn = document.getElementById('cancelBtn');
  var loginBtn = document.getElementById('loginBtn');
  var saveKeyBtn = document.getElementById('saveKeyBtn');
  var refreshBtn = document.getElementById('refreshBtn');
  var currentEs = null;

  function setBadge(el, ok, textOk, textBad) {
    el.textContent = ok ? textOk : textBad;
    el.className = 'badge ' + (ok ? 'ok' : 'bad');
  }

  function refreshStatus() {
    fetch('/api/status').then(function (r) { return r.json(); }).then(function (s) {
      setBadge(document.getElementById('redashBadge'), s.redashConfigured, '설정됨 (' + s.redashKeyMasked + ')', '미설정');
      setBadge(document.getElementById('claudeBadge'), s.claudeAuth && s.claudeAuth.loggedIn, '로그인됨 (' + (s.claudeAuth.email || '') + ')', '로그인 필요');
      document.getElementById('nextRange').textContent = s.nextRange.from + ' ~ ' + s.nextRange.to;
      loginBtn.disabled = !!(s.claudeAuth && s.claudeAuth.loggedIn) || s.running;
      runBtn.disabled = !s.redashConfigured || !(s.claudeAuth && s.claudeAuth.loggedIn) || s.running;
      cancelBtn.disabled = !s.running;

      var list = document.getElementById('dashList');
      if (s.dashboards.length === 0) {
        list.innerHTML = '<li>아직 생성된 결과가 없습니다.</li>';
      } else {
        list.innerHTML = s.dashboards.map(function (d) {
          return '<li><span>' + d.range + '</span><a href="/data/' + d.file + '" target="_blank" rel="noopener">대시보드 열기</a></li>';
        }).join('');
      }

      if (s.running && s.activeJobId && !currentEs) {
        attachStream(s.activeJobId);
      }
    });
  }

  function attachStream(jobId) {
    logEl.style.display = 'block';
    runBtn.disabled = true;
    loginBtn.disabled = true;
    cancelBtn.disabled = false;
    if (currentEs) currentEs.close();
    currentEs = new EventSource('/api/stream/' + encodeURIComponent(jobId));
    currentEs.onmessage = function (e) {
      logEl.textContent += JSON.parse(e.data);
      logEl.scrollTop = logEl.scrollHeight;
    };
    currentEs.addEventListener('done', function () {
      currentEs.close();
      currentEs = null;
      refreshStatus();
    });
  }

  saveKeyBtn.addEventListener('click', function () {
    var key = document.getElementById('apiKeyInput').value.trim();
    if (!key) return;
    fetch('/api/env', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: key }) })
      .then(function () { document.getElementById('apiKeyInput').value = ''; refreshStatus(); });
  });

  loginBtn.addEventListener('click', function () {
    fetch('/api/claude-login', { method: 'POST' }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.jobId) attachStream(d.jobId);
    });
  });

  runBtn.addEventListener('click', function () {
    var asOf = document.getElementById('asOfInput').value;
    logEl.textContent = '';
    fetch('/api/run-pipeline', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(asOf ? { asOf: asOf } : {}) })
      .then(function (r) { return r.json(); }).then(function (d) {
        if (d.jobId) attachStream(d.jobId);
        else alert(d.error || '실행 실패');
      });
  });

  cancelBtn.addEventListener('click', function () {
    fetch('/api/cancel', { method: 'POST' }).then(refreshStatus);
  });

  refreshBtn.addEventListener('click', refreshStatus);

  refreshStatus();
  setInterval(refreshStatus, 5000);
})();
</script>
</body>
</html>
`;
