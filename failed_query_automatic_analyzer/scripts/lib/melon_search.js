'use strict';

// 멜론 내부 검색 API(멜론사내망) 호출 + "유효 콘텐츠 존재" 판정 공용 유틸.

const BASE_URL = process.env.MELON_SEARCH_API_BASE || 'http://melonsearch-api.melon.com';

const THRESHOLDS = {
  artist: { exactScore: 5000, popularityCnt: 500 },
  song: { exactScore: 5000, popularityCnt: 50 },
};

async function search(type, query, timeoutMs = 15000) {
  const endpoint = type === 'artist' ? 'artist' : 'song';
  const url = `${BASE_URL}/api/v3/mse/${endpoint}/search.json?searchField=ALL&size=50&serviceYn=ALL&sort=W&page=0&query=${encodeURIComponent(query)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return [];
    const data = await res.json();
    return (data && data.resultData && data.resultData.resultList) || [];
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

function idField(type) {
  return type === 'artist' ? 'artist_id' : 'song_id';
}

function titleField(type) {
  return type === 'artist' ? 'title_web_list' : 'title_web_list';
}

function detailUrl(type, id) {
  return type === 'artist'
    ? `https://www.melon.com/artist/timeline.htm?artistId=${id}`
    : `https://www.melon.com/song/detail.htm?songId=${id}`;
}

function normalizeForMatch(s) {
  return (s || '').toLowerCase().replace(/[\s·\-_.]/g, '');
}

// 곡 검색 결과의 artist_nm_basket 중 하나라도 candidateNames(원어명/영문독음명)와
// 부분일치(양방향 substring)하면 true. 곡 제목은 여러 아티스트가 재사용하는 경우가
// 많아(예: "눈물"), 제목만으로는 다른 아티스트의 동명곡이 최상위로 잡힐 수 있다.
function artistPartiallyMatches(item, candidateNames) {
  const artists = (item.artist_nm_basket || []).map(normalizeForMatch).filter(Boolean);
  if (artists.length === 0) return false;
  return candidateNames.some((cand) => {
    const c = normalizeForMatch(cand);
    if (!c) return false;
    return artists.some((a) => a.includes(c) || c.includes(a));
  });
}

// queries: 검색에 사용할 쿼리 문자열 배열 (예: [원어명] 또는 [원어명, 영문독음명])
// opts.requireArtistMatch: (곡 검색 전용) 지정 시, 결과의 artist_nm_basket이 이 이름들 중
// 하나와 부분일치하지 않으면 후보에서 제외한다.
// 여러 쿼리의 결과를 합쳐 threshold(+아티스트 일치 조건)를 만족하는 항목 중
// exact_score가 가장 높은 1건을 반환.
async function findBestMatch(type, queries, opts = {}) {
  const threshold = THRESHOLDS[type];
  const all = [];
  for (const q of queries.filter(Boolean)) {
    const list = await search(type, q);
    all.push(...list);
  }

  let valid = all.filter(
    (item) => (item.exact_score || 0) >= threshold.exactScore && (item.popularity_cnt || 0) >= threshold.popularityCnt
  );

  if (type === 'song' && opts.requireArtistMatch && opts.requireArtistMatch.length > 0) {
    valid = valid.filter((item) => artistPartiallyMatches(item, opts.requireArtistMatch));
  }

  if (valid.length === 0) return null;

  valid.sort((a, b) => (b.exact_score || 0) - (a.exact_score || 0));
  const top = valid[0];
  const id = top[idField(type)];
  return {
    id,
    title: top[titleField(type)],
    exact_score: top.exact_score,
    popularity_cnt: top.popularity_cnt,
    url: detailUrl(type, id),
  };
}

module.exports = { findBestMatch, THRESHOLDS };
