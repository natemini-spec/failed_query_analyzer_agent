#!/usr/bin/env node
'use strict';

// data/ 폴더의 최신 failed_keywords_*.csv를 읽어 click_rate <= threshold인
// 키워드만 추려 JSON으로 저장한다 (분석 대상 후보).
//
// 사용법:
//   node scripts/filter_low_click_rate.js
//   node scripts/filter_low_click_rate.js --file data/failed_keywords_20260730_20260805.csv --threshold 0.05

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');

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

function findLatestCsv() {
  const files = fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.startsWith('failed_keywords_') && f.endsWith('.csv'))
    .map((f) => ({ name: f, mtime: fs.statSync(path.join(DATA_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (files.length === 0) {
    throw new Error(`${DATA_DIR}에서 failed_keywords_*.csv 파일을 찾을 수 없습니다.`);
  }
  return path.join(DATA_DIR, files[0].name);
}

// 쿼터(") 내부의 쉼표/줄바꿈을 다루는 간단한 CSV 파서
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ''));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const threshold = args.threshold !== undefined ? parseFloat(args.threshold) : 0.05;
  const csvPath = args.file ? path.resolve(ROOT, args.file) : findLatestCsv();

  console.log(`[filter] 입력 파일: ${csvPath}`);
  console.log(`[filter] click_rate <= ${threshold} 기준으로 필터링`);

  const text = fs.readFileSync(csvPath, 'utf8');
  const rows = parseCsv(text);
  const header = rows[0].map((h) => h.trim());
  const idx = {
    search_keyword: header.indexOf('search_keyword'),
    search_cnt: header.indexOf('search_cnt'),
    click_cnt: header.indexOf('click_cnt'),
    click_rate: header.indexOf('click_rate'),
  };
  for (const [key, i] of Object.entries(idx)) {
    if (i === -1) throw new Error(`CSV 헤더에 '${key}' 컬럼이 없습니다. 헤더: ${header.join(', ')}`);
  }

  const candidates = [];
  for (const r of rows.slice(1)) {
    if (r.length < header.length) continue;
    const clickRate = parseFloat(r[idx.click_rate]);
    if (Number.isNaN(clickRate) || clickRate > threshold) continue;
    candidates.push({
      search_keyword: r[idx.search_keyword],
      search_cnt: parseInt(r[idx.search_cnt], 10),
      click_cnt: parseInt(r[idx.click_cnt], 10),
      click_rate: clickRate,
    });
  }

  candidates.sort((a, b) => b.search_cnt - a.search_cnt);

  const base = path.basename(csvPath, '.csv').replace(/^failed_keywords_/, '');
  const outPath = path.join(DATA_DIR, `low_click_rate_${base}.json`);
  fs.writeFileSync(outPath, JSON.stringify(candidates, null, 2), 'utf8');

  console.log(`[filter] 전체 ${rows.length - 1}건 중 ${candidates.length}건이 임계값 이하`);
  console.log(`[filter] 저장 완료: ${outPath}`);
}

main();
