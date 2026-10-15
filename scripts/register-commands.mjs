import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const commands = [
  { name: '내전열기', description: '편성 모드와 종료 기준을 선택해 내전을 엽니다', options: [
    { type: 3, name: '제목', description: '내전 제목', max_length: 100 },
    { type: 3, name: '편성모드', description: '생략하면 선택 화면을 표시합니다', choices: [{ name: '랜덤 편성', value: 'random' }, { name: '직접 편성', value: 'manual' }] },
    { type: 3, name: '종료방식', description: '생략하면 선택 화면을 표시합니다', choices: [{ name: '1회 풀리그', value: 'round_robin' }, { name: '전체 최대 판수', value: 'match_limit' }, { name: '목표 승점', value: 'points_target' }] },
    { type: 4, name: '목표값', description: '전체 최대 판수 또는 목표 승점 (1회 풀리그에서는 생략)', min_value: 1, max_value: 999 },
    { type: 4, name: '승리승점', description: '승리 시 받는 승점 (기본 1)', min_value: 1, max_value: 100 },
  ] },
  { name: '내전관리', description: '운영진 관리 패널을 엽니다' },
  { name: '내전상태', description: '현재 내전 현황을 본인에게 표시합니다' },
  { name: '제비뽑기', description: '쉼표로 구분한 2~30개 후보 중 하나를 뽑습니다', options: [{ type: 3, name: '후보', description: '예: 철수, 영희, 민수', required: true, min_length: 3, max_length: 2500 }] },
].map(c => ({ ...c, dm_permission: false }));

async function register() {
  const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  const appId = process.env.APPLICATION_ID || config.vars.APPLICATION_ID, token = process.env.DISCORD_TOKEN;
  if (!/^\d{17,20}$/.test(appId) || !token) throw new Error('wrangler.jsonc의 APPLICATION_ID와 DISCORD_TOKEN 환경변수가 필요합니다.');
  const guilds = (process.env.TEST_GUILD_ID || '').split(',').map(s => s.trim()).filter(Boolean);
  if (guilds.some(g => !/^\d{17,20}$/.test(g))) throw new Error('TEST_GUILD_ID에는 쉼표로 구분한 서버 ID만 입력하세요.');
  const paths = guilds.length ? [...new Set(guilds)].map(g => `/applications/${appId}/guilds/${g}/commands`) : [`/applications/${appId}/commands`];
  for (const path of paths) {
    const r = await fetch(`https://discord.com/api/v10${path}`, { method: 'PUT', headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(commands) });
    if (!r.ok) throw new Error(`명령어 등록 실패: HTTP ${r.status}. 토큰·앱 ID·서버 설치를 확인하세요.`);
    console.log(`등록 완료: ${guilds.length ? path.split('/')[4] : '전체 서버'} (${commands.length}개)`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) register().catch(e => { console.error(e.message); process.exitCode = 1; });
