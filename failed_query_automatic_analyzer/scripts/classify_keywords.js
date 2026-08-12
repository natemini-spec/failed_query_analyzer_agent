#!/usr/bin/env node
'use strict';

// low_click_rate_*.json의 키워드를 배치로 나눠 로컬에 설치된 Claude Code CLI를
// headless(-p)로 호출해 (1) 오탈자 판별, (2) 그라운딩 기반 유형 분류를 수행하고
// classification_raw_*.json 으로 저장한다. 사람 개입 없이 cron에서 실행 가능하다.
//
// 사용법:
//   node scripts/classify_keywords.js --range 20260730_20260805
//   node scripts/classify_keywords.js --range 20260730_20260805 --batchSize 15

const fs = require('fs');
const path = require('path');
const { CLAUDE_BIN, claudeBinExists, callClaude, extractJsonArray } = require('./lib/claude_cli');

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

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function buildPrompt(items) {
  const list = items
    .map((it, i) => `${i + 1}. "${it.search_keyword}" (search_cnt=${it.search_cnt}, click_rate=${it.click_rate})`)
    .join('\n');

  return `You are analyzing failed search keywords from Melon (a Korean music streaming service). These are keywords that users searched for but got a very low click-through rate on the search results (meaning the search likely failed to surface what they wanted, or the keyword itself might be malformed).

For EACH of the following keywords, do this two-step process:

STEP 1 — Typo check: Determine if this keyword is very likely a simple typo/misspelling/fragment/spacing-variant of a well-known, correctly-spelled term (an artist name, song title, or common Korean/English word/phrase). If it's a typo, truncated fragment, or spacing variant of something well-known, set is_typo=true and give the corrected/full keyword in corrected_keyword.

STEP 2 — If NOT a typo (is_typo=false): use web search to research what this keyword actually refers to (could be a song, an artist/group, a meme/trending phrase, a Melon app feature/menu term, general knowledge, or something else). Write a concise 1-2 sentence description in Korean of what it is, grounded in your search results (don't guess without searching). Then classify into EXACTLY ONE category:
- 밈/트렌드 (meme/trend)
- 아티스트 (artist/group)
- 음원 (song/track/album)
- 지식 (general knowledge topic, unrelated to music)
- 앱기능/서비스 (Melon app/service feature or menu term, e.g. 해지/쿠폰/투표/이용권/내정보)
- 기타 (other — junk/unidentifiable input, or anything that doesn't fit the above)

Search strategy — apply a music-relevance prior: every one of these keywords was typed into a MUSIC STREAMING SERVICE's search box, so the user almost certainly meant something music-related (an artist, band, producer, label, song, or album), even if the term is a small/new/obscure act. Before settling on an unrelated generic meaning, run at least one search specifically qualified with music terms (e.g. "<keyword> 아티스트", "<keyword> 가수", "<keyword> 뮤지션", "<keyword> 음악 프로듀서", "<keyword> music artist", "<keyword> band") to check for a plausible music-industry match — a small Spotify/SoundCloud artist, a producer alias, a label, a session musician, etc. Only fall back to an unrelated interpretation (e.g. a classic novel, a cosmetics brand, a company name, a generic dictionary word) if a dedicated music-focused search turns up no credible music entity at all. Do not let an unrelated meaning "win" by default just because it's more famous or easier to find — the music-context interpretation takes priority whenever it's genuinely plausible, even with lower confidence.

Special guidance: if a keyword is a bare single character, jamo, or otherwise too short/random to identify any meaning, do NOT guess — set is_typo=false, category="기타", description="의미 파악이 어려운 단문/입력 오류로 추정", confidence="low".

Keywords to analyze:
${list}

Return ONLY a JSON array (no markdown fences, no extra prose) with one object per keyword, in this exact shape:
[
  {
    "search_keyword": "...",
    "is_typo": true/false,
    "corrected_keyword": "..." or null,
    "description": "..." or null,
    "category": "밈/트렌드"|"아티스트"|"음원"|"지식"|"앱기능/서비스"|"기타" or null,
    "confidence": "high"|"medium"|"low"
  },
  ...
]

Your final message must be exactly this JSON array (${items.length} objects) and nothing else.`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const range = args.range;
  if (!range) throw new Error('--range 20260730_20260805 형태로 지정해주세요.');
  const batchSize = args.batchSize ? parseInt(args.batchSize, 10) : 15;

  if (!claudeBinExists()) {
    throw new Error(`claude CLI를 찾을 수 없습니다: ${CLAUDE_BIN} (CLAUDE_BIN 환경변수로 경로를 지정할 수 있습니다)`);
  }

  const inputPath = path.join(DATA_DIR, `low_click_rate_${range}.json`);
  const candidates = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const batches = chunk(candidates, batchSize);

  console.log(`[classify] 총 ${candidates.length}건, ${batches.length}개 배치(배치당 최대 ${batchSize}건)로 분류 시작`);

  const results = [];
  const failedBatches = [];

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.log(`[classify] 배치 ${i + 1}/${batches.length} (${batch.length}건) 처리 중...`);
    try {
      const resultText = callClaude(buildPrompt(batch));
      const parsed = extractJsonArray(resultText);
      if (parsed.length !== batch.length) {
        console.warn(`[classify] 배치 ${i + 1}: 요청 ${batch.length}건 vs 응답 ${parsed.length}건 — 개수 불일치`);
      }
      results.push(...parsed);
    } catch (err) {
      console.error(`[classify] 배치 ${i + 1} 실패: ${err.message}`);
      failedBatches.push({ batchIndex: i, keywords: batch.map((b) => b.search_keyword) });
    }
  }

  const outPath = path.join(DATA_DIR, `classification_raw_${range}.json`);
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2), 'utf8');
  console.log(`[classify] 저장 완료: ${outPath} (${results.length}/${candidates.length}건 성공)`);

  if (failedBatches.length > 0) {
    const failedPath = path.join(DATA_DIR, `classification_failed_${range}.json`);
    fs.writeFileSync(failedPath, JSON.stringify(failedBatches, null, 2), 'utf8');
    console.error(`[classify] 실패한 배치 ${failedBatches.length}개 — 상세: ${failedPath}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`[classify] 오류: ${err.message}`);
  process.exitCode = 1;
});
