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

// queries: 검색에 사용할 쿼리 문자열 배열 (예: [원어명] 또는 [원어명, 영문독음명])
// 여러 쿼리의 결과를 합쳐 threshold를 만족하는 항목 중 exact_score가 가장 높은 1건을 반환.
async function findBestMatch(type, queries) {
  const threshold = THRESHOLDS[type];
  const all = [];
  for (const q of queries.filter(Boolean)) {
    const list = await search(type, q);
    all.push(...list);
  }

  const valid = all.filter(
    (item) => (item.exact_score || 0) >= threshold.exactScore && (item.popularity_cnt || 0) >= threshold.popularityCnt
  );
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
