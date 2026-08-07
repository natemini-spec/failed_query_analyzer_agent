'use strict';

// 로컬에 설치된 headless Claude Code CLI 호출 + 응답에서 JSON 배열 추출하는 공용 유틸.

const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const CLAUDE_BIN = process.env.CLAUDE_BIN || path.join(os.homedir(), '.npm-global', 'bin', 'claude');
const DEFAULT_TIMEOUT_MS = 8 * 60 * 1000;

function claudeBinExists() {
  const fs = require('fs');
  return fs.existsSync(CLAUDE_BIN);
}

function callClaude(prompt, opts = {}) {
  const args = [
    '-p', prompt,
    '--output-format', 'json',
    '--allowedTools', opts.allowedTools || 'WebSearch',
    '--permission-mode', 'bypassPermissions',
  ];
  const stdout = execFileSync(CLAUDE_BIN, args, {
    encoding: 'utf8',
    timeout: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout);
  if (parsed.is_error) {
    throw new Error(`claude CLI 오류: ${JSON.stringify(parsed).slice(0, 500)}`);
  }
  return parsed.result;
}

function extractJsonArray(text) {
  let t = text.trim();
  const fenceMatch = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) t = fenceMatch[1].trim();
  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`응답에서 JSON 배열을 찾지 못했습니다: ${t.slice(0, 300)}`);
  }
  return JSON.parse(t.slice(start, end + 1));
}

module.exports = { CLAUDE_BIN, claudeBinExists, callClaude, extractJsonArray };
