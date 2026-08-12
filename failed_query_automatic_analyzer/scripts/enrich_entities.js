#!/usr/bin/env node
'use strict';

// keyword_analysis_*.json(오탈자가 아닌 항목)을 배치로 나눠 headless Claude CLI를 호출,
// 콘텐츠 매핑에 필요한 구조화된 엔티티 정보를 추출한다:
//   - self_entity: 검색어 자신이 해외 아티스트/곡일 경우의 원어명/영문독음명 (동의어 매핑용)
//   - mentioned_artist / mentioned_song: description에 언급된 실제 아티스트/곡
//   - fallback_theme_keywords: 멜론에 매칭되는 콘텐츠가 없을 때 쓸 주제/테마 키워드 3~4개
// 이 단계는 LLM 추출만 담당하고, 실제 멜론 검색 API 호출/판정은
// generate_content_suggestions.js(결정론적 단계)에서 수행한다.
//
// 사용법:
//   node scripts/enrich_entities.js --range 20260730_20260805

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

// classify_keywords.js가 단문/자모/식별불가 입력에 붙이는 고정 문구 — 이런 항목은
// 콘텐츠 매핑이 의미가 없으므로 LLM 호출 없이 바로 빈 결과로 처리한다.
function isUnidentifiableJunk(row) {
  return !!row.description && row.description.includes('의미 파악이 어려운');
}

function emptyExtraction(searchKeyword) {
  return {
    search_keyword: searchKeyword,
    self_entity: null,
    mentioned_artist: null,
    mentioned_song: null,
    fallback_theme_keywords: [],
  };
}

function buildPrompt(items) {
  const list = items
    .map(
      (it, i) =>
        `${i + 1}. search_keyword="${it.search_keyword}" | category=${it.category} | description="${it.description || ''}"`
    )
    .join('\n');

  return `You are helping map failed Melon (Korean music streaming service) search keywords to real content that may already exist on Melon, or to fallback theme suggestions. Melon's search does NOT handle synonyms across languages/scripts well (e.g. a Japanese artist searched by their Korean-transliterated name may fail even if the artist has content on Melon under their original-script or English name).

For EACH item below (already classified as non-typo, with a category and grounded description from a previous step), extract:

1. "self_entity": ONLY if category is "아티스트" or "음원" AND the entity itself is a NON-Korean (foreign) act/song (per the description) — i.e. this is specifically for the "foreign artist/song synonym not handled by Melon search" case. Output { "type": "artist"|"song", "is_domestic": false, "name_original": "<official name in its native script/spelling>", "name_english": "<English phonetic transliteration/romanization>", "artist_name_original": "...", "artist_name_english": "..." or null }. The "artist_name_*" fields are ONLY needed when type="song" — they identify WHO performs that song, and are used later to reject a same-titled-but-wrong-artist song match (song titles are often generic/reused by many artists). Omit/null artist_name_* when type="artist" (the self entity already IS the artist). If domestic or category isn't 아티스트/음원, set self_entity to null.

2. "mentioned_artist": if the description explicitly names a REAL, SPECIFIC artist different from (or clarifying) the search keyword itself (e.g. description "가수 성리가 ... 방미의 곡 '뜬소문' 커버" mentions artist 성리) — output { "name_original": "...", "is_domestic": true/false, "name_english": "..." or null (null if is_domestic=true, since domestic names don't need an English transliteration query) }. If no specific artist is named in the description, set to null.

3. "mentioned_song": if the description explicitly names a REAL, SPECIFIC song title different from (or clarifying) the search keyword itself (e.g. the same example mentions the original song '뜬소문' performed by 성리) — output { "name_original": "...", "is_domestic": true/false, "name_english": "..." or null, "artist_name_original": "<the artist who performs THIS song, per the description>", "artist_name_english": "..." or null }. Song titles are frequently generic and reused across many unrelated artists (e.g. "눈물"/"Tears" has dozens of versions) — "artist_name_original" is REQUIRED whenever you set mentioned_song (best-effort from the description; only null if the description truly gives no performer name at all), because it will be used to reject search matches by the wrong artist. If no specific song is named, set mentioned_song to null.

4. "fallback_theme_keywords": ALWAYS provide exactly 3-4 short Korean topic/theme/genre keywords (e.g. "국악 밈", "여름 감성 발라드", "게임 커뮤니티 용어") that Melon could use for a related-content/theme recommendation, based on the description — this is used as a fallback ONLY when no real Melon content match is found downstream, so generate it regardless of whether you think a match exists. Do NOT mention or reference other platforms (e.g. 스포티파이/Spotify, 애플뮤직/Apple Music, 유튜브/YouTube, 틱톡/TikTok, 샤잠/Shazam, 인스타그램/Instagram, 사운드클라우드/SoundCloud) inside the keywords themselves — these are about where the keyword was found, not a Melon theme/genre. E.g. write "글로벌 인디음악" or "인디 드림팝", NOT "스포티파이 인디아티스트" or "유튜브 커버곡".

Items:
${list}

Return ONLY a JSON array (no markdown fences, no extra prose), one object per item, in this exact shape:
[
  {
    "search_keyword": "...",
    "self_entity": null | { "type": "artist"|"song", "is_domestic": false, "name_original": "...", "name_english": "...", "artist_name_original": "..." or null, "artist_name_english": "..." or null },
    "mentioned_artist": null | { "name_original": "...", "is_domestic": true/false, "name_english": "..." or null },
    "mentioned_song": null | { "name_original": "...", "is_domestic": true/false, "name_english": "..." or null, "artist_name_original": "..." or null, "artist_name_english": "..." or null },
    "fallback_theme_keywords": ["...", "...", "..."]
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

  const inputPath = path.join(DATA_DIR, `keyword_analysis_${range}.json`);
  const all = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const nonTypo = all.filter((r) => r.is_typo === false);
  const junkRows = nonTypo.filter(isUnidentifiableJunk);
  const candidates = nonTypo.filter((r) => !isUnidentifiableJunk(r));
  const batches = chunk(candidates, batchSize);

  console.log(`[enrich] 오탈자 제외 ${nonTypo.length}건 (단문/입력오류 ${junkRows.length}건은 LLM 호출 없이 제외), ${batches.length}개 배치로 엔티티 추출 시작`);

  const results = junkRows.map((r) => emptyExtraction(r.search_keyword));
  const failedBatches = [];

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.log(`[enrich] 배치 ${i + 1}/${batches.length} (${batch.length}건) 처리 중...`);
    try {
      const resultText = callClaude(buildPrompt(batch));
      const parsed = extractJsonArray(resultText);
      if (parsed.length !== batch.length) {
        console.warn(`[enrich] 배치 ${i + 1}: 요청 ${batch.length}건 vs 응답 ${parsed.length}건 — 개수 불일치`);
      }
      results.push(...parsed);
    } catch (err) {
      console.error(`[enrich] 배치 ${i + 1} 실패: ${err.message}`);
      failedBatches.push({ batchIndex: i, keywords: batch.map((b) => b.search_keyword) });
    }
  }

  const outPath = path.join(DATA_DIR, `entity_extraction_${range}.json`);
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2), 'utf8');
  console.log(`[enrich] 저장 완료: ${outPath} (${results.length}/${nonTypo.length}건, LLM 대상 ${candidates.length}건 중 성공 ${results.length - junkRows.length}건)`);

  if (failedBatches.length > 0) {
    const failedPath = path.join(DATA_DIR, `enrich_failed_${range}.json`);
    fs.writeFileSync(failedPath, JSON.stringify(failedBatches, null, 2), 'utf8');
    console.error(`[enrich] 실패한 배치 ${failedBatches.length}개 — 상세: ${failedPath}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`[enrich] 오류: ${err.message}`);
  process.exitCode = 1;
});
