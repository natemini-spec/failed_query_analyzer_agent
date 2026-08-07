# 검색 실패 키워드 분석 파이프라인 — 운영자 가이드

Melon 검색 실패 키워드(Redash 쿼리 16305)를 매주 자동으로 다운로드 → 오탈자/유형 분류 →
관련 콘텐츠 매핑 제안 → 대시보드까지 생성하는 파이프라인입니다. 각 운영자가 **자기
계정으로 자기 컴퓨터에서** 독립적으로 실행하는 구조입니다 (공유 서비스 계정 아님).

## 1. 사전 준비물

- Node.js 18 이상 (내장 `fetch` 사용, 별도 패키지 설치 불필요)
- 사내망 VPN 연결 (Redash, 멜론 내부 검색 API 접근용)
- Redash(melonredash.melon.com) 계정 — 쿼리 16305 조회 권한
- Claude Code 팀 시트 (조직: KakaoEntertainment3) 로그인 계정

## 2. 코드 받기

내부 git 저장소를 clone 하거나, 공유된 압축본을 받아 압축 해제합니다.

## 3. Redash API Key 설정

1. Redash 로그인 → 우측 상단 프로필 아이콘 → **Edit Profile**
2. 페이지 하단 **API Key** 값을 복사 (재발급 버튼으로 새로 만들 수도 있음)
   - ⚠️ 쿼리 페이지의 "Show API Key"(쿼리별 키)가 아니라 **개인 프로필의 API Key**를
     써야 합니다. 쿼리별 키로는 이 쿼리의 파라미터(FROM/TO) 실행이 403으로 차단됩니다.
3. 프로젝트 루트에서:
   ```bash
   cp .env.example .env
   ```
4. `.env` 파일을 열어 `REDASH_API_KEY=` 뒤에 복사한 키를 붙여넣고 저장

## 4. Claude Code CLI 설치 및 로그인

macOS에서 `/usr/local`에 쓰기 권한이 없을 수 있어 사용자 홈 아래에 설치합니다.

```bash
mkdir -p ~/.npm-global
npm config set prefix ~/.npm-global
npm install -g @anthropic-ai/claude-code
```

셸 프로필(`~/.bash_profile` 또는 `~/.zshrc`)에 추가:
```bash
export PATH="$HOME/.npm-global/bin:$PATH"
```

새 터미널을 열고 로그인 (브라우저 인증):
```bash
claude auth login
```

확인:
```bash
claude auth status   # "loggedIn": true 가 나오면 정상
```

## 5. 수동 실행해보기

```bash
node scripts/run_weekly_pipeline.js
```

기본적으로 실행일 기준 직전 1주일(예: 8/10 실행 시 8/3~8/9)을 분석합니다. 특정 기간을
테스트하려면:
```bash
node scripts/run_weekly_pipeline.js --asOf 2026-08-06
```

전체 소요 시간은 대략 10~20분입니다 (Redash 쿼리 실행 수 분 + LLM 그라운딩 배치 여러 건).
완료되면 `data/dashboard_<FROM>_<TO>.html` 파일을 브라우저로 더블클릭해서 열면 됩니다 —
서버 없이 바로 열리는 자기완결형 페이지입니다.

## 6. 매주 자동 실행되게 등록하기 (선택)

macOS crontab 예시 (매주 월요일 08:00, 프로젝트 경로는 본인 환경에 맞게 수정):

```bash
crontab -e
```
아래 줄을 추가:
```
0 8 * * 1 cd /절대/경로/failed_query_automatic_analyzer && /usr/local/bin/node scripts/run_weekly_pipeline.js >> logs/pipeline_$(date +\%Y\%m\%d).log 2>&1
```

`which node` 로 확인한 본인 환경의 node 절대경로를 넣어주세요. 로그는 `logs/` 폴더에
날짜별로 쌓입니다.

**주의 — 이 모델의 한계**: cron이 정해진 시각에 실제로 동작하려면 그 순간에 (1) 노트북이
켜져 있고 로그인된 상태이며 (2) VPN이 연결되어 있어야 합니다. 노트북이 잠자기/꺼짐/VPN
미접속 상태면 그 주는 조용히 실패합니다. 실행 후 `logs/`의 최신 로그를 가끔 확인해주세요.

## 7. 파이프라인 단계 요약

| 단계 | 스크립트 | 산출물 |
|---|---|---|
| 1 | download_failed_keywords.js | data/failed_keywords_{범위}.csv |
| 2 | filter_low_click_rate.js | data/low_click_rate_{범위}.json |
| 3 | classify_keywords.js | data/classification_raw_{범위}.json |
| 4 | merge_classification_results.js | data/keyword_analysis_{범위}.csv/.json |
| 5 | enrich_entities.js | data/entity_extraction_{범위}.json |
| 6 | generate_content_suggestions.js | data/content_mapping_{범위}.csv/.json |
| 7 | generate_dashboard.js | data/dashboard_{범위}.html |

각 단계는 `--range YYYYMMDD_YYYYMMDD` 인자로 개별 실행도 가능합니다 (디버깅/재실행 시 유용).

## 8. 자주 겪을 수 있는 문제

- **`claude auth status`에서 loggedIn: false`** → `claude auth login` 다시 실행
- **Redash 403 "potentially unsafe parameters"** → `.env`의 키가 쿼리별 키인지 확인, 개인
  프로필 API Key로 교체
- **`classification_failed_{범위}.json` / `enrich_failed_{범위}.json` 파일이 생김** → 해당
  배치가 실패한 것. 파일 안의 키워드 목록을 보고 필요시 해당 단계만 재실행
- **멜론 검색 API 응답이 비거나 타임아웃** → VPN 연결 상태 확인
