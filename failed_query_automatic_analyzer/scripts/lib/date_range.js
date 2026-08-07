'use strict';

function formatYYYYMMDD(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

// 실행일 기준 직전 1주일: 8/6 실행 -> FROM 7/30, TO 8/5
function computeDefaultRange(asOf) {
  const to = addDays(asOf, -1);
  const from = addDays(asOf, -7);
  return { from: formatYYYYMMDD(from), to: formatYYYYMMDD(to) };
}

module.exports = { formatYYYYMMDD, addDays, computeDefaultRange };
