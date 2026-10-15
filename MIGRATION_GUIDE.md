# 디스호스트 → Workers 데이터 이전

현재 확보한 Python **v1.6.1** DB 구조를 기준으로 변환합니다. 기존 ZIP·DB 백업은 그대로 보관하세요. 실행 파일만 Workers에 올리는 방식으로는 동작하지 않으며 SQLite를 D1으로 가져와야 합니다.

가장 편한 시점은 진행 중인 내전을 마친 직후입니다. 진행 중인 내전도 팀·승점·제출 대기 결과를 변환할 수 있지만 반드시 아래 시험을 거친 후 전환하세요. 원래 봇이 중지된 뒤의 최종 백업을 사용해야 전환 중 결과가 누락되지 않습니다.

## 전환 순서

1. CLOUDFLARE_GUIDE 1~4단계로 새 Worker와 **빈 D1**을 준비합니다. 아직 Discord Endpoint를 변경하지 않습니다.
2. 디스호스트에서 봇을 중지합니다.
3. `data/scrim.sqlite3`를 로컬로 백업합니다. SQLite 백업 기능으로 일관된 스냅샷을 만들거나, 봇 중지가 완료된 뒤 파일을 받으세요. `-wal` 파일이 남아 있다면 `scrim.sqlite3`, `scrim.sqlite3-wal`, `scrim.sqlite3-shm`을 함께 같은 폴더로 복사해 백업하세요. 살아 있는 프로세스의 DB 본체만 복사하지 마세요.
4. Workers 프로젝트 폴더에 백업을 `scrim.sqlite3`라는 이름으로 둡니다. 원본 디스호스트 DB를 지우지 않습니다.
5. 아래 명령으로 변환하고 가져옵니다.

```sh
python3 scripts/migrate_sqlite.py scrim.sqlite3 --output import.sql
npx wrangler d1 execute fsr-scrim --remote --file=import.sql
```

Windows에서 `python3`가 없다면 `python`으로 실행합니다. Python 외 추가 패키지는 필요 없습니다. 변환기는 원본을 읽기 전용으로 열며, 출력 경로로 원본을 덮어쓰는 것을 차단합니다.

6. 다음 명령으로 내전 목록을 확인합니다.

```sh
npx wrangler d1 execute fsr-scrim --remote --command="SELECT id,guild_id,status FROM scrims ORDER BY id;"
```

7. CLOUDFLARE_GUIDE 5~6단계로 Discord Endpoint 전환과 명령 등록을 합니다.
8. 진행 중인 내전이 있다면 `/내전상태`, `/내전관리`로 팀·승점·대진을 대조합니다. 기존 공개 패널은 1분 주기 점검 또는 관리 패널 새로고침으로 새 버튼으로 갱신됩니다.
9. 경기를 계속하기 전에 팀장 두 명의 제출·확인과 음성 이동을 확인합니다.

`scrim.sqlite3`, `import.sql`에는 참가자 정보가 있으므로 공개 업로드하지 마세요. 이 ZIP에는 실제 사용자 DB·토큰이 포함되어 있지 않습니다.

## 이전되는 내용

- 서버별 진행/종료 내전, 모집 명단과 주·보조 역할
- 팀 직접 선택 및 기존 혼합 편성 상태
- 팀원, 팀장, 팀 승점, 연결된 음성방
- 대타, 교체 기록, 기권 상태
- 확정 경기, 취소 기록, 제출/불일치 대기 결과
- 종료 기준과 종료 시각, 기존 현황 메시지 ID

Discord의 긴 숫자 ID는 문자열로 변환해 정확도를 보존합니다. Python에서만 사용하던 세부 원본 필드는 각 내전의 `legacySource`에 보관합니다. 이미 리그 완료 상태인 내전은 종료 상태로 가져옵니다. 종료 패널은 원래 종료 시각과 설정에 따라 삭제될 수 있습니다. 이전 직후 이를 보존하려면 `ENDED_PANEL_DELETE_MINUTES`를 `0`으로 배포한 뒤 나중에 다시 설정하세요.

기존 ID는 `legacy-번호`로 저장합니다. **같은 파일을 다시 가져와도 같은 ID를 덮어쓰지 않습니다.** 이는 운영 중 데이터가 과거 백업으로 되돌아가는 것을 막습니다. 변환한 SQL은 빈 DB에 처음 가져오는 용도입니다. 이미 새 내전을 연 DB에 다른 진행 내전을 합치거나 과거 데이터를 강제로 덮어쓰는 복원 도구가 아닙니다. 서버당 진행 내전이 겹치면 가져오기가 실패할 수 있으므로 새 D1에서 시험하세요.

아주 큰 단일 내전 기록은 D1 행 크기 한도 전에 변환을 중단합니다. 이런 경우 원본 DB를 보존하고 별도 분할 이전이 필요합니다. 이전 실패 후에는 오류를 해결하고 같은 파일을 재실행할 수 있지만 모든 내전의 가져오기 결과를 확인하세요. 파일 전체가 한 번에 원자적으로 적용된다고 가정하지 마세요.

## 전환 전 시험과 되돌리기

실제 계정의 기존 기록은 배포본 제작 과정에서 검증하지 않았습니다. 먼저 복사 DB를 로컬 D1 또는 별도 시험용 D1에 가져와 팀·승점·결과 상태를 확인하는 것이 좋습니다.

로컬 확인:

```sh
npm run db:local
npx wrangler d1 execute fsr-scrim --local --file=import.sql
```

전환 후 아직 새 신청·결과가 없다면 Discord Endpoint를 비우고 기존 디스호스트 봇을 시작해 이전 상태로 돌아갈 수 있습니다. Workers에서 이미 처리한 새 기록은 Python DB에 자동 반영되지 않습니다. 새 결과가 생긴 뒤에는 양쪽을 번갈아 가동하지 말고 기록을 대조해 반영해야 합니다.

Workers 운영 중 백업:

```sh
npx wrangler d1 export fsr-scrim --remote --output=fsr-d1-backup.sql
```

이 백업은 Workers D1용이며 Python SQLite로 역변환하는 기능은 포함하지 않습니다. DB 초기화나 강제 삭제 명령은 제공하지 않습니다.
