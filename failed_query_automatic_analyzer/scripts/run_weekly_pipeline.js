#!/usr/bin/env node
'use strict';

// 전체 파이프라인(다운로드 → 필터 → 분류 → 병합 → 엔티티추출 → 콘텐츠매핑)을
// 하나의 range로 순서대로 실행한다. 운영자가 수동으로 실행하거나 cron/launchd에
// 등록해 주기적으로 실행할 수 있는 단일 진입점.
//
// 사용법:
//   node scripts/run_weekly_pipeline.js
//   node scripts/run_weekly_pipeline.js --asOf 2026-08-06

const path = require('path');
const { execFileSync } = require('child_process');
const { computeDefaultRange } = require('./lib/date_range');

const ROOT = path.resolve(__dirname, '..');
const SCRIPTS_DIR = __dirname;
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

// partialOk=true 인 단계는 배치 일부 실패에도 결과 파일을 남기고 exitCode 1로 끝날 수 있음 —
// 파이프라인 전체를 중단시키지 않고 경고만 남긴 뒤 다음 단계로 진행한다.
function runStep(label, scriptName, scriptArgs, { partialOk = false } = {}) {
  console.log(`\n=== [pipeline] ${label} ===`);
  try {
    execFileSync('node', [path.join(SCRIPTS_DIR, scriptName), ...scriptArgs], {
      stdio: 'inherit',
      cwd: ROOT,
    });
  } catch (err) {
    if (partialOk) {
      console.warn(`[pipeline] ${label} 단계에서 일부 실패가 있었지만 부분 결과로 계속 진행합니다.`);
      return;
    }
    throw new Error(`${label} 단계 실패로 파이프라인을 중단합니다: ${err.message}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const asOf = args.asOf ? new Date(args.asOf) : new Date();
  const { from, to } = computeDefaultRange(asOf);
  const range = `${from}_${to}`;

  console.log(`[pipeline] range=${range} 로 전체 파이프라인 시작`);

  runStep('1/7 Redash CSV 다운로드', 'download_failed_keywords.js', ['--from', from, '--to', to]);
  runStep('2/7 click_rate 필터링', 'filter_low_click_rate.js', ['--file', path.join('data', `failed_keywords_${range}.csv`)]);
  runStep('3/7 오탈자 판별 + 그라운딩 분류', 'classify_keywords.js', ['--range', range], { partialOk: true });
  runStep('4/7 분류 결과 병합', 'merge_classification_results.js', ['--range', range]);
  runStep('5/7 엔티티 추출', 'enrich_entities.js', ['--range', range], { partialOk: true });
  runStep('6/7 콘텐츠 매핑 제안 생성', 'generate_content_suggestions.js', ['--range', range]);
  runStep('7/7 대시보드 생성', 'generate_dashboard.js', ['--range', range]);

  console.log(`\n[pipeline] 완료: ${path.join(DATA_DIR, `dashboard_${range}.html`)}`);
}

main();
