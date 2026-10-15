# Cloudflare 설치 안내

## 1. 준비

기존 Discord 애플리케이션을 그대로 사용할 수 있습니다. 토큰을 대화창이나 공개 저장소에 올리지 마세요.

- Cloudflare 계정
- Discord Developer Portal에서 기존 봇을 관리할 권한
- Node.js 22.9 이상(24 권장)
- 기존 DB 이전을 할 경우 Python 3.10 이상

ZIP 압축을 푼 폴더에서 터미널을 엽니다. `package.json`이 보이는 폴더가 기준입니다.

```sh
npm ci
npx wrangler login
npx wrangler d1 create fsr-scrim
```

마지막 명령 결과의 `database_id`를 복사합니다.

## 2. 설정 파일 수정

`wrangler.jsonc`에서 다음 값을 수정합니다. 이 파일은 JSON 형식이므로 숫자처럼 보이는 ID도 따옴표로 둘러싼 문자열로 유지하세요.

| 항목 | 넣을 값 |
| --- | --- |
| `d1_databases[0].database_id` | 방금 만든 D1의 ID |
| `vars.APPLICATION_ID` | Developer Portal → General Information → Application ID |
| `vars.DISCORD_PUBLIC_KEY` | 같은 화면의 Public Key, 64자리 16진수 |
| `vars.ADMIN_ROLE_ID` | 운영진 역할 ID. 복수는 영문 쉼표로 구분 |
| `vars.WAITING_CHANNEL_NAME` | 기존 대기실 음성채널 이름 |
| `vars.TEAM_CHANNEL_TEMPLATE` | 예: `팀-{number}` 또는 `팀 {number}` |
| `vars.BIG_CHANNEL_NAME` | 기존 빅 음성채널 이름 |
| `vars.MAKER_CHANNEL_NAME` | 기존 메이커 음성채널 이름 |
| `vars.SCORER_CHANNEL_NAME` | 기존 스코어러 음성채널 이름 |
| `vars.ENDED_PANEL_DELETE_MINUTES` | 종료 패널 삭제까지 분. 기본 `60`, `0`이면 삭제 안 함 |

예시:

```json
"ADMIN_ROLE_ID": "111111111111111111,222222222222222222",
"WAITING_CHANNEL_NAME": "대기실",
"TEAM_CHANNEL_TEMPLATE": "팀-{number}"
```

채널 이름은 공백·이모티콘·구분 기호를 제거하고 비교합니다. 예를 들어 `🎙 · 빅`은 `빅`으로 찾을 수 있습니다. 같은 서버에서 정규화 후 이름이 같은 방을 중복해서 만들면 먼저 검색된 방이 선택됩니다. 팀 방은 실제 필요한 번호만 준비하면 되며 TEAM 20까지 지원합니다. 방을 봇이 자동으로 만들지는 않습니다.

`compatibility_flags`와 `triggers.crons`는 그대로 두세요. `WORKER_URL`은 첫 배포 후 채웁니다.

## 3. 토큰과 DB 준비

```sh
npx wrangler secret put DISCORD_TOKEN
npm run db:remote
```

첫 명령의 입력란에 기존 Discord 봇 토큰을 붙여 넣습니다. 토큰을 `wrangler.jsonc`의 `vars`에 쓰지 마세요.

기존 DB도 가져올 경우 [MIGRATION_GUIDE.md](MIGRATION_GUIDE.md)의 순서를 따릅니다. 테스트 중에는 기존 봇이 사용하는 진행 내전을 동시에 수정하지 마세요.

## 4. 배포와 재시도 주소 설정

```sh
npm run deploy
```

배포 결과의 주소를 확인합니다. 예: `https://fsr-scrim-bot.your-name.workers.dev`

`wrangler.jsonc`의 `vars.WORKER_URL`에 이 주소를 넣고 다시 배포합니다.

```json
"WORKER_URL": "https://fsr-scrim-bot.your-name.workers.dev"
```

```sh
npm run deploy
```

이 주소는 여러 음성 이동 작업과 미완료 작업을 별도 요청으로 이어 처리할 때 사용합니다. 내부 작업 요청은 서명을 검증합니다. `/health`를 열면 버전과 `ok: true`가 나옵니다. Workers 주소에 Cloudflare Access 로그인 화면을 걸면 Discord와 내부 재시도가 접근할 수 없으므로 봇 엔드포인트는 직접 접근 가능하게 두세요.

## 5. Discord 수신 주소 전환

기존 디스호스트 봇을 중지합니다. DB 이전이 필요하다면 중지 직후의 최종 백업을 가져온 뒤 아래 주소를 설정하세요.

1. [Discord Developer Portal](https://discord.com/developers/applications)에서 기존 앱을 선택합니다.
2. General Information → Interactions Endpoint URL을 찾습니다.
3. `https://본인주소.workers.dev/interactions`를 넣고 저장합니다.
4. 저장 시 Discord의 서명 검증 요청에 정상 응답해야 합니다.

디스호스트의 Python 봇과 Workers를 동시에 운영하지 마세요. 이제 슬래시 명령과 버튼은 Workers에서 받습니다. `Message Content Intent`는 이 버전에 필요하지 않습니다.

## 6. 슬래시 명령 등록

`.dev.vars.example`을 같은 폴더의 `.dev.vars`로 복사합니다. Windows에서는 파일 확장자가 `.txt`로 붙지 않았는지 확인하세요.

```env
DISCORD_TOKEN=실제_봇_토큰
```

기본적으로 모든 설치 서버용 명령을 등록합니다.

```sh
npm run register
```

기존에 `TEST_GUILD_ID`를 사용했다면 해당 서버의 명령이 전역 명령보다 우선할 수 있습니다. 그 서버의 명령도 이번 버전으로 등록하려면 `.dev.vars`에 다음 줄을 추가하고 등록 명령을 다시 실행하세요.

```env
TEST_GUILD_ID=111111111111111111,222222222222222222
```

`TEST_GUILD_ID`가 있으면 나열한 서버에만 명령을 등록합니다. 복수 서버를 즉시 시험할 때도 같은 형식을 씁니다. 새 서버에서 자동으로 사용할 전역 명령도 필요하면 이 줄을 잠시 제거하고 한 번 더 등록하세요. 이 변수는 등록 대상만 정하며 내전 데이터의 서버 분리는 항상 적용됩니다.

전역 명령은 Discord 화면에 반영되는 데 시간이 걸릴 수 있습니다. 명령 등록은 이 앱의 같은 범위 명령 목록을 교체합니다. Discord 앱 하나를 여러 프로그램이 공유하고 있다면 먼저 README의 주의사항을 확인하세요.

## 7. 봇 권한

텍스트 채널: View Channel, Send Messages, Embed Links, Read Message History.

음성 채널: 출발·도착 방의 View Channel과 Connect, 서버의 Move Members.

참가자가 이미 음성채널에 접속해 있어야 이동할 수 있습니다. 역할별 이동은 **대기실에 있는 등록 참가자만** 주 역할 기준으로 옮깁니다. 팀별 이동은 현재 팀원 중 접속 중인 사람을 옮깁니다. 대기실 이동은 팀방·역할방에 있는 등록 참가자만 대상으로 합니다. 봇에 채널 관리 권한을 줄 필요는 없습니다.

다른 서버에도 설치할 경우 OAuth2 URL Generator의 `bot`, `applications.commands` 범위로 초대하고 해당 서버에서 같은 권한을 설정하세요. 각 서버의 운영진 역할 ID를 `ADMIN_ROLE_ID`에 모두 넣을 수 있습니다. 관리자·서버 관리·채널 관리 권한 보유자도 운영할 수 있습니다. 개최자 본인으로 제한하지 않습니다.

## 8. 첫 시험 운영

1. 테스트 서버 또는 실제 내전이 없는 시간에 `/내전열기`를 실행합니다.
2. 랜덤/직접 모드, 종료 방식 화면이 순서대로 뜨는지 확인합니다.
3. 6명으로 참가 → 편성 → 확정 → 양 팀장 결과 제출·확인을 시험합니다.
4. 기존 대기실에서 역할별 이동과 팀별 이동을 시험합니다.
5. `/제비뽑기 후보:가, 나, 다`를 실행합니다.
6. 종료 후 패널 자동 삭제를 확인합니다. 빨리 시험하려면 삭제 분을 `2`로 바꿔 재배포한 뒤 다시 `60`으로 돌리세요.

이 배포본은 자동 테스트와 로컬 Workers/D1 실행 검증을 마쳤습니다. 사용자의 실제 Discord·Cloudflare 계정에 배포하거나 음성채널에서 실사용 검증한 상태는 아닙니다.

## 문제 해결

| 현상 | 확인할 곳 |
| --- | --- |
| Endpoint 저장 실패 | `/interactions` 경로, Public Key, Application ID, 배포 URL, Access 로그인 차단 |
| 운영진만 사용할 수 있다고 나옴 | 같은 서버의 역할 ID인지, 실제 보유 역할인지, 쉼표 형식, 설정 수정 후 재배포 여부 |
| 종료 방식 선택이 안 보임 | `/내전열기`에 옵션을 전부 넣으면 바로 열립니다. 빈 명령은 선택 화면이 나옵니다. 명령 등록 범위도 확인 |
| 결과 반영이 늦음 | Discord API 제한, Workers 오류, D1 제한. `/내전상태`로 확인. 미완료 작업은 1분 주기 재시도 |
| 음성 이동 실패 | 출발·도착 방 Connect와 Move Members, 실제 접속 상태, 채널 이름 중복 |
| 봇이 오프라인으로 보임 | Gateway 접속을 하지 않아 정상입니다. 슬래시 명령으로 확인 |
| 종료 패널이 남음 | 삭제 분 설정, Cron 트리거 활성화, Workers 오류, 메시지 접근 권한 |
| 배포 후 설정이 다시 바뀜 | 대시보드만 수정하지 말고 `wrangler.jsonc`도 함께 수정. 다음 배포가 파일 설정을 적용함 |

오류 확인은 Cloudflare 대시보드 → Workers & Pages → 해당 Worker → Metrics/Logs 또는 `npx wrangler tail`을 사용합니다. 실행 중 기록의 백업·복원은 MIGRATION_GUIDE를 참고하세요.

## 확인한 공식 문서

- [Discord Interactions 수신·응답·서명](https://docs.discord.com/developers/interactions/receiving-and-responding)
- [Discord 음성 상태 조회](https://docs.discord.com/developers/resources/voice)
- [Discord 서버 멤버 수정·이동](https://docs.discord.com/developers/resources/guild#modify-guild-member)
- [Workers 제한](https://developers.cloudflare.com/workers/platform/limits/)
- [D1 제한](https://developers.cloudflare.com/d1/platform/limits/)
- [Workers fetch](https://developers.cloudflare.com/workers/runtime-apis/fetch/)
