#!/usr/bin/env node
'use strict';

// 검색 실패 키워드 Redash 쿼리(16305) 결과를 API Key로 직접 받아 CSV로 저장한다.
// 로그인/브라우저 없이 동작하므로 cron에서 그대로 실행 가능하다.
//
// Redash의 /results.csv 엔드포인트는 "캐시된" 결과만 반환하므로, 새로운 FROM/TO
// 조합에 대해서는 먼저 실행을 트리거(POST)하고 완료될 때까지 job을 폴링한 뒤
// 완료된 결과의 id로 CSV를 내려받는 절차가 필요하다.
//
// 사용법:
//   node scripts/download_failed_keywords.js
//   node scripts/download_failed_keywords.js --from 20260730 --to 20260805
//   node scripts/download_failed_keywords.js --asOf 2026-08-06   (해당 날짜 기준으로 직전 1주일 계산)

const fs = require('fs');
const path = require('path');
const { computeDefaultRange } = require('./lib/date_range');

const ROOT = path.resolve(__dirname, '..');
loadEnv(path.join(ROOT, '.env'));

const BASE_URL = process.env.REDASH_BASE_URL || 'https://melonredash.melon.com';
const QUERY_ID = process.env.REDASH_QUERY_ID || '16305';
const API_KEY = process.env.REDASH_API_KEY;
const PARAM_FROM_NAME = process.env.REDASH_PARAM_FROM || 'FROM';
const PARAM_TO_NAME = process.env.REDASH_PARAM_TO || 'TO';
const OUTPUT_DIR = path.join(ROOT, 'data');
const TIMEOUT_MS = 10 * 60 * 1000; // 쿼리 실행이 수 분 걸릴 수 있음
const POLL_INTERVAL_MS = 5000;

function loadEnv(envPath) {
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, options, deadline) {
  if (Date.now() > deadline) {
    throw new Error('쿼리 실행 대기 시간이 초과되었습니다. Redash에서 직접 진행 상태를 확인하세요.');
  }
  const remaining = deadline - Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), remaining);
  let res;
  try {
    res = await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('쿼리 실행 대기 시간이 초과되었습니다. Redash에서 직접 진행 상태를 확인하세요.');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Redash 요청 실패 (status=${res.status}): ${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`JSON 응답을 예상했지만 다른 형식을 받았습니다: ${text.slice(0, 300)}`);
  }
}

async function triggerExecution(from, to, deadline) {
  const url = `${BASE_URL}/api/queries/${QUERY_ID}/results?api_key=${encodeURIComponent(API_KEY)}`;
  const body = JSON.stringify({
    parameters: {
      [PARAM_FROM_NAME]: from,
      [PARAM_TO_NAME]: to,
    },
    max_age: 0, // 캐시 무시하고 항상 새로 실행
  });
  return fetchJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }, deadline);
}

async function pollJob(jobId, deadline) {
  const url = `${BASE_URL}/api/jobs/${jobId}?api_key=${encodeURIComponent(API_KEY)}`;
  while (true) {
    const data = await fetchJson(url, { method: 'GET' }, deadline);
    const job = data.job || data;
    // Redash job status: 1=WAITING, 2=PROCESSING, 3=DONE, 4=FAILED, 5=CANCELLED
    if (job.status === 3) {
      return job.query_result_id;
    }
    if (job.status === 4 || job.status === 5) {
      throw new Error(`쿼리 실행 실패: ${job.error || '알 수 없는 오류'}`);
    }
    if (Date.now() + POLL_INTERVAL_MS > deadline) {
      throw new Error('쿼리 실행 대기 시간이 초과되었습니다. Redash에서 직접 진행 상태를 확인하세요.');
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function downloadCsv(queryResultId, deadline) {
  const url = `${BASE_URL}/api/queries/${QUERY_ID}/results/${queryResultId}.csv?api_key=${encodeURIComponent(API_KEY)}`;
  const remaining = Math.max(deadline - Date.now(), 1000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), remaining);
  let res;
  try {
    res = await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`CSV 다운로드 실패 (status=${res.status}): ${body.slice(0, 500)}`);
  }
  return res.text();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!API_KEY) {
    throw new Error(
      `REDASH_API_KEY가 설정되지 않았습니다. ${path.join(ROOT, '.env')} 파일에 REDASH_API_KEY=<값>을 추가하세요. (.env.example 참고)`
    );
  }

  const asOf = args.asOf ? new Date(args.asOf) : new Date();
  const defaults = computeDefaultRange(asOf);
  const from = args.from || defaults.from;
  const to = args.to || defaults.to;
  const deadline = Date.now() + TIMEOUT_MS;

  console.log(`[failed-keywords] range=${from}~${to} 쿼리 실행 요청 중...`);
  const triggerRes = await triggerExecution(from, to, deadline);

  let queryResultId;
  if (triggerRes.query_result) {
    queryResultId = triggerRes.query_result.id;
    console.log('[failed-keywords] 캐시된 결과 즉시 반환됨');
  } else if (triggerRes.job) {
    console.log(`[failed-keywords] job ${triggerRes.job.id} 실행 중... (수 분 소요될 수 있음)`);
    queryResultId = await pollJob(triggerRes.job.id, deadline);
  } else {
    throw new Error(`예상치 못한 응답 형식: ${JSON.stringify(triggerRes).slice(0, 300)}`);
  }

  console.log(`[failed-keywords] 결과(id=${queryResultId}) CSV 다운로드 중...`);
  const csvText = await downloadCsv(queryResultId, deadline);
  const rowCount = csvText.trim().split('\n').length - 1; // 헤더 제외

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const filename = `failed_keywords_${from}_${to}.csv`;
  const outPath = path.join(OUTPUT_DIR, filename);
  fs.writeFileSync(outPath, csvText, 'utf8');

  console.log(`[failed-keywords] 저장 완료: ${outPath} (${rowCount}행)`);
}

main().catch((err) => {
  console.error(`[failed-keywords] 오류: ${err.message}`);
  process.exitCode = 1;
});
