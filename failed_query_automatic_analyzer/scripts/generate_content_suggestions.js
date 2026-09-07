#!/usr/bin/env node
'use strict';

// entity_extraction_*.json 에서 뽑아낸 후보 이름으로 멜론 검색 API를 호출해
// (1) 해외 아티스트/곡 동의어 매핑 제안, (2) description에 언급된 관련 아티스트/곡 제안,
// (3) 위 두 가지 모두 매칭 실패 시 주제/테마 키워드 제안(fallback) 을 만들어
// keyword_analysis_*.json 에 컬럼을 추가한 content_mapping_*.json/.csv 로 저장한다.
// 결정론적 단계(LLM 호출 없음) — 사람 개입 없이 cron에서 실행 가능하다.
//
// 사용법:
//   node scripts/generate_content_suggestions.js --range 20260730_20260805

const fs = require('fs');
const path = require('path');
const { findBestMatch } = require('./lib/melon_search');

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
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function queriesFor(entity) {
  if (!entity) return [];
  const list = [entity.name_original];
  if (entity.is_domestic === false && entity.name_english && entity.name_english !== entity.name_original) {
    list.push(entity.name_english);
  }
  return list.filter(Boolean);
}

async function buildSuggestion(entityRow) {
  const suggestion = {
    suggestion_synonym_mapping: null,
    suggestion_synonym_url: null,
    suggestion_related_artist_id: null,
    suggestion_related_artist_url: null,
    suggestion_related_artist_title: null,
    suggestion_related_song_id: null,
    suggestion_related_song_url: null,
    suggestion_related_song_title: null,
    suggestion_theme_keywords: null,
  };

  if (!entityRow) return suggestion;

  let foundAny = false;

  // Case 1: 해외 아티스트/곡 동의어 매핑 제안 (검색어 자신 = 발음/표기 차이로 실패한 기존 콘텐츠)
  // 동의어 표기 기준: 대표어 = 멜론에 실제 등록된 공식명(match.title), 동의어 = 실패한 검색어 그 자체.
  const self = entityRow.self_entity;
  if (self && self.is_domestic === false) {
    const selfOpts = self.type === 'song'
      ? { requireArtistMatch: [self.artist_name_original, self.artist_name_english].filter(Boolean) }
      : {};
    const match = await findBestMatch(self.type, queriesFor(self), selfOpts);
    if (match) {
      foundAny = true;
      suggestion.suggestion_synonym_mapping = `대표어: '${match.title}' / 동의어: '${entityRow.search_keyword}'`;
      suggestion.suggestion_synonym_url = match.url;
    }
  }

  // Case 2: 언급된 관련(원본) 아티스트 — 검색어 자체와는 다른 콘텐츠이므로 "대응"이 아니라
  // 참고용 안내로만 취급한다 (대응 제안 라벨링은 generate_dashboard.js에서 처리).
  if (entityRow.mentioned_artist) {
    const match = await findBestMatch('artist', queriesFor(entityRow.mentioned_artist));
    if (match) {
      foundAny = true;
      suggestion.suggestion_related_artist_id = match.id;
      suggestion.suggestion_related_artist_url = match.url;
      suggestion.suggestion_related_artist_title = match.title;
    }
  }

  // Case 3: 언급된 관련(원본) 곡 — 곡 제목은 여러 아티스트가 재사용하는 경우가 많아
  // (예: "눈물"), 언급된 아티스트의 원어명/영문독음명과 부분일치하지 않는 결과는 제외한다.
  if (entityRow.mentioned_song) {
    const songArtistNames = [
      entityRow.mentioned_song.artist_name_original,
      entityRow.mentioned_song.artist_name_english,
    ].filter(Boolean);
    const match = await findBestMatch('song', queriesFor(entityRow.mentioned_song), {
      requireArtistMatch: songArtistNames,
    });
    if (match) {
      foundAny = true;
      suggestion.suggestion_related_song_id = match.id;
      suggestion.suggestion_related_song_url = match.url;
      suggestion.suggestion_related_song_title = match.title;
    }
  }

  // Case 4: 위 세 가지 모두 매칭 실패 시 주제/테마 키워드 제안
  if (!foundAny && entityRow.fallback_theme_keywords && entityRow.fallback_theme_keywords.length > 0) {
    suggestion.suggestion_theme_keywords = entityRow.fallback_theme_keywords.join(', ');
  }

  return suggestion;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const range = args.range;
  if (!range) throw new Error('--range 20260730_20260805 형태로 지정해주세요.');

  const keywordAnalysisPath = path.join(DATA_DIR, `keyword_analysis_${range}.json`);
  const entityPath = path.join(DATA_DIR, `entity_extraction_${range}.json`);

  const keywordAnalysis = JSON.parse(fs.readFileSync(keywordAnalysisPath, 'utf8'));
  const entities = JSON.parse(fs.readFileSync(entityPath, 'utf8'));
  const entityMap = new Map(entities.map((e) => [e.search_keyword, e]));

  console.log(`[suggest] ${keywordAnalysis.length}건 중 오탈자 제외 대상에 대해 콘텐츠 매핑 생성 시작`);

  const merged = [];
  let synonymCount = 0;
  let artistCount = 0;
  let songCount = 0;
  let themeCount = 0;

  for (const row of keywordAnalysis) {
    if (row.is_typo !== false) {
      merged.push({
        ...row,
        suggestion_synonym_mapping: null,
        suggestion_synonym_url: null,
        suggestion_related_artist_id: null,
        suggestion_related_artist_url: null,
        suggestion_related_artist_title: null,
        suggestion_related_song_id: null,
        suggestion_related_song_url: null,
        suggestion_related_song_title: null,
        suggestion_theme_keywords: null,
      });
      continue;
    }
    const entityRow = entityMap.get(row.search_keyword);
    const suggestion = await buildSuggestion(entityRow);
    if (suggestion.suggestion_synonym_mapping) synonymCount++;
    if (suggestion.suggestion_related_artist_id) artistCount++;
    if (suggestion.suggestion_related_song_id) songCount++;
    if (suggestion.suggestion_theme_keywords) themeCount++;
    merged.push({ ...row, ...suggestion });
  }

  const outJsonPath = path.join(DATA_DIR, `content_mapping_${range}.json`);
  fs.writeFileSync(outJsonPath, JSON.stringify(merged, null, 2), 'utf8');

  const header = [
    'search_keyword', 'search_cnt', 'click_cnt', 'click_rate', 'is_typo', 'corrected_keyword',
    'description', 'category', 'confidence',
    'suggestion_synonym_mapping', 'suggestion_synonym_url',
    'suggestion_related_artist_id', 'suggestion_related_artist_url', 'suggestion_related_artist_title',
    'suggestion_related_song_id', 'suggestion_related_song_url', 'suggestion_related_song_title',
    'suggestion_theme_keywords',
  ];
  const csvLines = [header.join(',')];
  for (const row of merged) {
    csvLines.push(header.map((h) => csvEscape(row[h])).join(','));
  }
  const outCsvPath = path.join(DATA_DIR, `content_mapping_${range}.csv`);
  fs.writeFileSync(outCsvPath, csvLines.join('\n'), 'utf8');

  console.log(`[suggest] 동의어 매핑 제안: ${synonymCount}건 / 관련 아티스트: ${artistCount}건 / 관련 곡: ${songCount}건 / 테마 키워드(fallback): ${themeCount}건`);
  console.log(`[suggest] 저장 완료: ${outJsonPath}`);
  console.log(`[suggest] 저장 완료: ${outCsvPath}`);
}

main().catch((err) => {
  console.error(`[suggest] 오류: ${err.message}`);
  process.exitCode = 1;
});
