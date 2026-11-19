# 강호록 세이브 에디터 v1.0.0 (`JianghuChroniclesSaveEditor`)

**강호록(`Jianghu Chronicles`, Steam AppID `1909840`, BuildID `22708874`)** 전용 오프라인 3-Surface 세이브 편집기입니다.

## 주요 실행 방식 (3종 표면)

- **Windows x64 단독 실행 파일**: `JianghuChroniclesSaveEditor-v1.0.0.exe` (`.NET Framework 4.8` + `WebView2` 내장, `%USERPROFILE%\AppData\LocalLow\Yipinge\JHL\JHL_SAV\` 및 로컬 경로 탐색)
- **단독 오프라인 HTML**: `dist/JianghuChroniclesSaveEditor-v1.0.0.html` (CSP `default-src 'none'; connect-src 'none'` 적용, 외부 네트워크 요청 0건, 자동/밝음/어두움 테마 지원)
- **Python 3 CLI 및 로컬 웹 서버**: `jhl_editor.py` (`discover`, `inspect`, `validate`, `presets`, `apply`, `restore`, `serve`, `--self-test`)

## 지원 세이브 형식 및 구조 (REA 검증 기반)

- **바이너리 포맷**: `.NET BinaryFormatter` (MS-NRBF) 양방향 순수 JavaScript / Python stdlib 코덱 (무손실 SHA-256 라운드트립)
  - `JHL_GameData*_*.sav`: `SGame.PlayerGameData` (`playerSchool` 및 `schoolGameDataList` 동시 동기화, 공유 참조 `buildingList` 보존)
  - `JHL_Summary_Data*.sav`: `SGame.StoreData`
- **순수 한국어 카탈로그 (`tools/extract_catalog.py` → `src/catalog-data.js`)**: 한자·가나·외부 URL 0건
  - 15개 분류: 물품 997종, 무기 88종, 무기 분류 28종, 무기 속성 202종, 무공 223종, 특성 243종, 칭호 257종, 직책 10종, 문파 103종, 시설 28종, 선물 상품 16종, 연도 40종, 능력치 등급 7종, 명성 등급 5종, 전투 계산식 7종

## 편집 기능

- **요약 · 파생 계산기 · 프리셋 6종**: 문파 단계·은전·강호 자금·식량·경험치·선악 수치·날짜, 최대 체력(`vit * 417`)·공격력(`max(str, agi) * 11.4`)·단전 상한(`200`) 실시간 계산, 원클릭 프리셋 6종 (`wealth`, `school_max`, `disciples_god`, `disciples_heal`, `supply_pack`, `diplomacy_max`)
- **제자 · 무공 · 창고 · 강호**: 제자 능력치/특성/칭호/질병 치료/무공 숙련, 무기·방어구 및 6종 창고 물품, 건물·문파 우호도·선물 시세율 편집
- **변경 내역 및 검증**: 실시간 변경 diff 표, 숫자/목록 불변식 검사, 원본 파일 SHA-256 동시성 검사

## 안전 장치

- 게임 실행 중(`JHL_SIMULATE_GAME_RUNNING=1` 또는 실행 프로세스 감지) 저장 차단
- 덮어쓰기 전 원본 SHA-256 동시성 검사(충돌 시 `409`), `.jhl_backups/*.bak.*` 최대 20개 SHA-256 검증 백업 및 `os.replace`/`MoveFileExW` 원자적 파일 교체
- 심볼릭 링크·디렉터리 정션·하드링크·NTFS ADS(`:` 스트림)·`..` 상위 이동·예약 장치명(`CON`, `PRN`, `AUX`, `NUL`, `COM1..9`, `LPT1..9`)·UNC 경로 차단
- 로컬 웹 서버 `127.0.0.1` 루프백 + `Host`/`Origin`/`Sec-Fetch-Site` 검사 + 일회성 `X-Jhl-Token` 인증; WebView2 호스트 URL 및 발신 문서 검증

## 빠른 실행 및 검증

```text
python3 tools/extract_catalog.py --check-only
python3 build.py --check
python3 -W error -B -m unittest discover -s tests -v
node tests/test_editor.cjs
NODE_PATH=/home/jiyoung/.local/lib/node_modules/@playwright/cli/node_modules node tests/test_playwright_e2e.cjs
```

## 라이선스

- 본 프로젝트 소스 코드: [MIT License](LICENSE)
- 내장 Microsoft WebView2 로더 재배포 고지: Windows 배포 압축에 `WebView2-LICENSE.txt` 포함
