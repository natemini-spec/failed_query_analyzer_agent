#!/usr/bin/env node
'use strict';

// low_click_rate_*.json (search_cnt/click_cnt/click_rate) 과
// classification_raw_*.json (오탈자 판별 + 그라운딩 분류 결과) 을 키워드 기준으로 병합해
// 최종 keyword_analysis_*.json / .csv 를 생성한다.
//
// 사용법:
//   node scripts/merge_classification_results.js --range 20260730_20260805

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

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const range = args.range;
  if (!range) throw new Error('--range 20260730_20260805 형태로 지정해주세요.');

  const lowClickPath = path.join(DATA_DIR, `low_click_rate_${range}.json`);
  const classificationPath = path.join(DATA_DIR, `classification_raw_${range}.json`);

  const lowClick = JSON.parse(fs.readFileSync(lowClickPath, 'utf8'));
  const classification = JSON.parse(fs.readFileSync(classificationPath, 'utf8'));

  const classMap = new Map(classification.map((c) => [c.search_keyword, c]));

  const missing = [];
  const merged = lowClick.map((row) => {
    const c = classMap.get(row.search_keyword);
    if (!c) {
      missing.push(row.search_keyword);
      return { ...row, is_typo: null, corrected_keyword: null, description: null, category: null, confidence: null };
    }
    return { ...row, ...c };
  });

  if (missing.length > 0) {
    console.warn(`[merge] 경고: 분류 결과를 찾지 못한 키워드 ${missing.length}건: ${missing.join(', ')}`);
  }
  const extra = classification.filter((c) => !lowClick.some((r) => r.search_keyword === c.search_keyword));
  if (extra.length > 0) {
    console.warn(`[merge] 경고: low_click_rate 목록에 없는 분류 결과 ${extra.length}건: ${extra.map((e) => e.search_keyword).join(', ')}`);
  }

  const outJsonPath = path.join(DATA_DIR, `keyword_analysis_${range}.json`);
  fs.writeFileSync(outJsonPath, JSON.stringify(merged, null, 2), 'utf8');

  const header = ['search_keyword', 'search_cnt', 'click_cnt', 'click_rate', 'is_typo', 'corrected_keyword', 'description', 'category', 'confidence'];
  const csvLines = [header.join(',')];
  for (const row of merged) {
    csvLines.push(header.map((h) => csvEscape(row[h])).join(','));
  }
  const outCsvPath = path.join(DATA_DIR, `keyword_analysis_${range}.csv`);
  fs.writeFileSync(outCsvPath, csvLines.join('\n'), 'utf8');

  const typoCount = merged.filter((r) => r.is_typo === true).length;
  const byCategory = {};
  for (const r of merged) {
    if (r.is_typo === false && r.category) {
      byCategory[r.category] = (byCategory[r.category] || 0) + 1;
    }
  }

  console.log(`[merge] 총 ${merged.length}건 병합 완료`);
  console.log(`[merge] 오탈자: ${typoCount}건`);
  console.log(`[merge] 유형별(오탈자 제외): ${JSON.stringify(byCategory, null, 2)}`);
  console.log(`[merge] 저장 완료: ${outJsonPath}`);
  console.log(`[merge] 저장 완료: ${outCsvPath}`);
}

main();
