#!/usr/bin/env node
'use strict';

// content_mapping_*.json 을 읽어 운영자가 브라우저로 바로 열어볼 수 있는
// 자기완결형(self-contained) 정적 HTML 대시보드를 생성한다. 외부 리소스/서버 불필요.
//
// 사용법:
//   node scripts/generate_dashboard.js --range 20260730_20260805

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');

// dataviz 스킬의 기본 검증 팔레트(카테고리 슬롯 1~6) — light/dark 모두 인접쌍 검증 통과.
const PALETTE = [
  { light: '#2a78d6', dark: '#3987e5' }, // 1 blue
  { light: '#eb6834', dark: '#d95926' }, // 2 orange
  { light: '#1baf7a', dark: '#199e70' }, // 3 aqua
  { light: '#eda100', dark: '#c98500' }, // 4 yellow
  { light: '#e87ba4', dark: '#d55181' }, // 5 magenta
  { light: '#008300', dark: '#008300' }, // 6 green
];

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

const CATEGORY_ORDER = ['아티스트', '음원', '밈/트렌드', '지식', '앱기능/서비스', '기타'];
// 실질적으로 실패 키워드를 바로 고칠 수 있는 액션(오탈자 교정, 동의어 등록)만 별도 라벨을 받는다.
// 관련 아티스트/곡 링크(원본 콘텐츠)나 테마 키워드는 검색어 자체를 고치는 액션이 아니므로
// "대응 없음"으로 집계하되, 상세 컬럼에는 참고 정보로 남긴다(테마 키워드는 제외 — 아래 참조).
const RESPONSE_ORDER = ['오탈자 교정', '동의어 등록', '대응 없음'];

function classifyResponse(row) {
  if (row.is_typo === true) return '오탈자 교정';
  if (row.suggestion_synonym_mapping) return '동의어 등록';
  return '대응 없음';
}

function countBy(rows, order, keyFn) {
  const counts = new Map(order.map((k) => [k, 0]));
  for (const r of rows) {
    const k = keyFn(r);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return order.map((k) => ({ label: k, count: counts.get(k) || 0 }));
}

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function barChartSvg(data, palette, opts = {}) {
  const width = 640;
  const barHeight = 28;
  const gap = 10;
  const leftLabelWidth = 150;
  const chartWidth = width - leftLabelWidth - 60;
  const height = data.length * (barHeight + gap) + gap;
  const max = Math.max(1, ...data.map((d) => d.count));

  const bars = data
    .map((d, i) => {
      const y = gap + i * (barHeight + gap);
      const w = Math.max(2, (d.count / max) * chartWidth);
      const color = palette[i % palette.length];
      return `
        <g class="viz-bar" data-label="${escapeHtml(d.label)}" data-count="${d.count}">
          <text x="${leftLabelWidth - 10}" y="${y + barHeight / 2}" text-anchor="end" dominant-baseline="middle" class="viz-cat-label">${escapeHtml(d.label)}</text>
          <rect x="${leftLabelWidth}" y="${y}" width="${chartWidth + 2}" height="${barHeight}" rx="4" class="viz-track"></rect>
          <rect x="${leftLabelWidth}" y="${y}" width="${w}" height="${barHeight}" rx="4" class="viz-fill" style="fill:var(--series-${i + 1})"></rect>
          <text x="${leftLabelWidth + w + 8}" y="${y + barHeight / 2}" dominant-baseline="middle" class="viz-value-label">${d.count}${opts.showPct ? ` (${((d.count / opts.total) * 100).toFixed(0)}%)` : ''}</text>
        </g>`;
    })
    .join('');

  return `<svg class="viz-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(opts.ariaLabel || '')}">${bars}</svg>`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const range = args.range;
  if (!range) throw new Error('--range 20260730_20260805 형태로 지정해주세요.');

  const inputPath = path.join(DATA_DIR, `content_mapping_${range}.json`);
  const rows = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

  const total = rows.length;
  const typoRows = rows.filter((r) => r.is_typo === true);
  const nonTypoRows = rows.filter((r) => r.is_typo === false);

  const categoryData = countBy(nonTypoRows, CATEGORY_ORDER, (r) => r.category || '기타');
  const responseData = countBy(rows, RESPONSE_ORDER, classifyResponse);

  const [fromStr, toStr] = range.split('_');
  const fmtDate = (s) => (s && s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s);

  const categoryChart = barChartSvg(categoryData, PALETTE, { total: nonTypoRows.length, showPct: true, ariaLabel: '유형별 키워드 분포' });
  const responseChart = barChartSvg(responseData, PALETTE, { total, showPct: true, ariaLabel: '대응 제안 분포' });

  const tableRows = rows
    .map((r) => {
      const response = classifyResponse(r);
      const links = [];
      if (r.corrected_keyword) links.push(`교정: ${escapeHtml(r.corrected_keyword)}`);
      if (r.suggestion_synonym_mapping) {
        links.push(`${escapeHtml(r.suggestion_synonym_mapping)} — <a href="${escapeHtml(r.suggestion_synonym_url)}" target="_blank" rel="noopener">콘텐츠 보기</a>`);
      }
      if (r.suggestion_related_artist_url) {
        links.push(`원본 아티스트: <a href="${escapeHtml(r.suggestion_related_artist_url)}" target="_blank" rel="noopener">${escapeHtml(r.suggestion_related_artist_title || '보기')}</a>`);
      }
      if (r.suggestion_related_song_url) {
        links.push(`원본 곡: <a href="${escapeHtml(r.suggestion_related_song_url)}" target="_blank" rel="noopener">${escapeHtml(r.suggestion_related_song_title || '보기')}</a>`);
      }
      // 테마 키워드 제안은 현재 검색 스펙상 실제 대응이 불가능해 대시보드에는 노출하지 않는다
      // (기저 데이터의 suggestion_theme_keywords 값과 유형 분류 자체는 CSV/JSON에 그대로 유지됨).

      const searchText = [r.search_keyword, r.corrected_keyword, r.description].filter(Boolean).join(' ').toLowerCase();
      return `<tr data-category="${escapeHtml(r.category || '')}" data-response="${escapeHtml(response)}" data-search="${escapeHtml(searchText)}">
        <td>${escapeHtml(r.search_keyword)}</td>
        <td class="num">${r.search_cnt}</td>
        <td class="num">${(r.click_rate * 100).toFixed(2)}%</td>
        <td>${r.is_typo ? '오탈자' : escapeHtml(r.category || '')}</td>
        <td class="desc">${escapeHtml(r.description || '')}</td>
        <td class="response-badge" data-response-badge="${escapeHtml(response)}">${escapeHtml(response)}</td>
        <td>${links.join('<br>') || '-'}</td>
      </tr>`;
    })
    .join('\n');

  const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>검색 실패 키워드 분석 대시보드 (${fmtDate(fromStr)} ~ ${fmtDate(toStr)})</title>
<style>
  .viz-root {
    color-scheme: light;
    --surface-1: #fcfcfb;
    --surface-2: #f5f4f1;
    --text-primary: #0b0b0b;
    --text-secondary: #52514e;
    --text-muted: #85837c;
    --border: #e3e1dc;
    --series-1: #2a78d6; --series-2: #eb6834; --series-3: #1baf7a;
    --series-4: #eda100; --series-5: #e87ba4; --series-6: #008300;
  }
  @media (prefers-color-scheme: dark) {
    :root:where(:not([data-theme="light"])) .viz-root {
      color-scheme: dark;
      --surface-1: #1a1a19; --surface-2: #232322;
      --text-primary: #ffffff; --text-secondary: #c3c2b7; --text-muted: #8b8a82;
      --border: #35342f;
      --series-1: #3987e5; --series-2: #d95926; --series-3: #199e70;
      --series-4: #c98500; --series-5: #d55181; --series-6: #008300;
    }
  }
  :root[data-theme="dark"] .viz-root {
    color-scheme: dark;
    --surface-1: #1a1a19; --surface-2: #232322;
    --text-primary: #ffffff; --text-secondary: #c3c2b7; --text-muted: #8b8a82;
    --border: #35342f;
    --series-1: #3987e5; --series-2: #d95926; --series-3: #199e70;
    --series-4: #c98500; --series-5: #d55181; --series-6: #008300;
  }

  * { box-sizing: border-box; }
  html, body { margin: 0; overflow-x: hidden; }
  .viz-root {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Malgun Gothic", sans-serif;
    background: var(--surface-1);
    color: var(--text-primary);
    padding: 24px;
    max-width: 1120px;
    margin: 0 auto;
  }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .subtitle { color: var(--text-secondary); font-size: 13px; margin: 0 0 24px; }
  .stat-row { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 28px; }
  .stat-tile {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px 18px;
    min-width: 140px;
    flex: 1;
  }
  .stat-tile .value { font-size: 24px; font-weight: 700; }
  .stat-tile .label { font-size: 12px; color: var(--text-secondary); margin-top: 2px; }
  section { margin-bottom: 32px; }
  h2 { font-size: 15px; margin: 0 0 12px; color: var(--text-primary); }
  .chart-card {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    overflow-x: auto;
  }
  .viz-chart { width: 100%; max-width: 640px; height: auto; display: block; }
  .viz-cat-label { font-size: 12px; fill: var(--text-secondary); }
  .viz-value-label { font-size: 12px; fill: var(--text-primary); }
  .viz-track { fill: var(--surface-1); }
  .viz-fill { transition: opacity 0.15s; }
  .viz-bar:hover .viz-fill { opacity: 0.8; }

  .controls { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
  .controls input, .controls select {
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--text-primary);
    border-radius: 6px;
    padding: 7px 10px;
    font-size: 13px;
  }
  .controls input { flex: 1; min-width: 200px; }

  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  thead th {
    text-align: left;
    padding: 8px 10px;
    border-bottom: 1px solid var(--border);
    color: var(--text-secondary);
    font-weight: 600;
    position: sticky;
    top: 0;
    background: var(--surface-1);
  }
  tbody td { padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
  tbody tr:hover { background: var(--surface-2); }
  td.num { text-align: right; white-space: nowrap; }
  td.desc { max-width: 320px; color: var(--text-secondary); }
  .table-wrap { max-height: 640px; overflow-y: auto; overflow-x: auto; border: 1px solid var(--border); border-radius: 8px; }
  table { min-width: 900px; }
  a { color: var(--series-1); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .response-badge { white-space: nowrap; font-size: 12px; }
  .count-note { font-size: 12px; color: var(--text-muted); margin-top: 8px; }
</style>
</head>
<body>
<div class="viz-root">
  <h1>검색 실패 키워드 분석 대시보드</h1>
  <p class="subtitle">기간: ${fmtDate(fromStr)} ~ ${fmtDate(toStr)} · 생성 파일: content_mapping_${range}.csv</p>

  <div class="stat-row">
    <div class="stat-tile"><div class="value">${total}</div><div class="label">분석 대상 키워드 (click_rate ≤ 0.05)</div></div>
    <div class="stat-tile"><div class="value">${typoRows.length}</div><div class="label">오탈자/절단 표기 (${((typoRows.length / total) * 100).toFixed(0)}%)</div></div>
    <div class="stat-tile"><div class="value">${nonTypoRows.length}</div><div class="label">오탈자 아님 (그라운딩 분류)</div></div>
    <div class="stat-tile"><div class="value">${rows.filter((r) => classifyResponse(r) !== '대응 없음').length}</div><div class="label">대응 제안 생성됨</div></div>
  </div>

  <section>
    <h2>유형별 분포 (오탈자 제외 ${nonTypoRows.length}건)</h2>
    <div class="chart-card">${categoryChart}</div>
  </section>

  <section>
    <h2>대응 제안 분포 (전체 ${total}건)</h2>
    <div class="chart-card">${responseChart}</div>
    <p class="count-note">우선순위: 오탈자 교정 &gt; 동의어 등록 &gt; 대응 없음. "동의어 등록"은 현재 검색어를 대표어(멜론 공식명)의 동의어로 바로 등록할 수 있는 경우만 해당하며, 원본 아티스트/곡 정보나 테마 키워드는 실제 대응 액션이 아니므로 대응 없음으로 집계됩니다(원본 아티스트/곡 링크는 상세에서 참고용으로 확인 가능).</p>
  </section>

  <section>
    <h2>전체 키워드 목록</h2>
    <div class="controls">
      <input type="text" id="searchBox" placeholder="키워드 또는 설명으로 검색...">
      <select id="categoryFilter"><option value="">전체 유형</option></select>
      <select id="responseFilter"><option value="">전체 대응 제안</option></select>
    </div>
    <div class="table-wrap">
      <table id="dataTable">
        <thead>
          <tr>
            <th>검색어</th><th>검색량</th><th>클릭률</th><th>유형</th><th>설명</th><th>대응 제안</th><th>상세</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows}
        </tbody>
      </table>
    </div>
  </section>
</div>
<script>
  (function () {
    var categories = ${JSON.stringify(CATEGORY_ORDER.concat(['오탈자']))};
    var responses = ${JSON.stringify(RESPONSE_ORDER)};
    var catSel = document.getElementById('categoryFilter');
    categories.forEach(function (c) {
      var opt = document.createElement('option');
      opt.value = c; opt.textContent = c;
      catSel.appendChild(opt);
    });
    var respSel = document.getElementById('responseFilter');
    responses.forEach(function (r) {
      var opt = document.createElement('option');
      opt.value = r; opt.textContent = r;
      respSel.appendChild(opt);
    });

    var searchBox = document.getElementById('searchBox');
    var rows = Array.prototype.slice.call(document.querySelectorAll('#dataTable tbody tr'));

    function applyFilters() {
      var q = searchBox.value.trim().toLowerCase();
      var cat = catSel.value;
      var resp = respSel.value;
      rows.forEach(function (tr) {
        var matchesQ = !q || tr.getAttribute('data-search').indexOf(q) !== -1;
        var matchesCat = !cat || tr.getAttribute('data-category') === cat || (cat === '오탈자' && tr.getAttribute('data-response') === '오탈자 교정');
        var matchesResp = !resp || tr.getAttribute('data-response') === resp;
        tr.style.display = (matchesQ && matchesCat && matchesResp) ? '' : 'none';
      });
    }
    searchBox.addEventListener('input', applyFilters);
    catSel.addEventListener('change', applyFilters);
    respSel.addEventListener('change', applyFilters);
  })();
</script>
</body>
</html>
`;

  const outPath = path.join(DATA_DIR, `dashboard_${range}.html`);
  fs.writeFileSync(outPath, html, 'utf8');
  console.log(`[dashboard] 저장 완료: ${outPath}`);
}

main();
