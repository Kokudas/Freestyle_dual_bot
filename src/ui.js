import { ROLES, ROLE_KEYS, currentFixtures, teamById, leaders, availableTeamNumbers } from './domain.js';
export const cut = (s, n) => String(s ?? '').length > n ? String(s).slice(0, n - 1) + '…' : String(s ?? '');
export const esc = s => String(s ?? '').replace(/[\\*_~`|>]/g, '\\$&');
export const MODE = { random: '🎲 랜덤 편성', manual: '👥 직접 편성', legacy_mixed: '📌 기존 혼합 편성' };
export const END = { round_robin: '풀리그', match_limit: '전체 최대 판수', points_target: '목표 승점' };
const ROLE_ICONS = { BIG: '🧱', SCORER: '🔥', MAKER: '🎯' };
const BUTTON_ICONS = {
  '랜덤 편성': '🎲', '편성 확정': '✅', '선수 교체': '🔄', '팀장 변경': '👑', '팀 기권': '🏳️',
  '대진 관리': '⚔️', '승점 수정': '🏆', '결과 취소': '↩️', '채널 연결': '🔗', '팀별 이동': '🎤',
  '역할별 이동': '🧭', '대기실 이동': '🪑', '새로고침': '🔄', '패널 복구': '🛠️', '내전 종료': '🏁',
  '개인 참가': '🙋', '대타 등록': '🪑', '참가 취소': '❌', '내 정보': '👤',
  '1회 풀리그': '🔁', '전체 최대 판수': '🎮', '목표 승점': '🎯', '취소': '❌', '확정': '✅',
  '대타 등록 완료': '✅', '팀장 변경 확정': '👑', '선수 교체 확정': '🔄', '기권 확정': '🏳️',
  '결과 확인': '✅', '결과가 다름': '⚠️',
  '팀 추가': '➕', '편입 취소': '↩️', '편입 예약 확정': '✅', '다음: 포지션·팀장': '➡️', '선수 다시 선택': '⬅️',
};
export const row = (...components) => ({ type: 1, components: components.flat() });
export const button = (label, id, style = 2, disabled = false) => {
  const icon = BUTTON_ICONS[label] || (label.startsWith('팀장 가능:') ? '👑' : label.startsWith('직접 배정:') ? '📌' : /^TEAM \d+ 승리$/.test(label) ? '🏆' : null);
  return { type: 2, label: icon ? `${icon} ${label}` : label, custom_id: id, style, disabled };
};
export function select(id, placeholder, options, { min = 1, max = 1 } = {}) {
  const empty = !options.length;
  return row({ type: 3, custom_id: id, placeholder: cut(placeholder, 150), min_values: min, max_values: empty ? 1 : Math.min(max, options.length), disabled: empty,
    options: (empty ? [{ label: '선택 가능한 항목이 없습니다', value: 'NONE' }] : options).slice(0, 25).map(o => ({ ...o, label: cut(o.label, 100), description: o.description ? cut(o.description, 100) : undefined })) });
}
export const message = (data, update = false) => ({ type: update ? 7 : 4, data: { allowed_mentions: { parse: [] }, ...data, ...(update ? {} : { flags: 64 }) } });
export const note = content => message({ content: cut(content, 1900) });
export const defer = (ephemeral = true, update = false) => update ? { type: 6 } : { type: 5, data: { flags: ephemeral ? 64 : 0 } };
export function modal(id, title, label, value = '', placeholder = '') {
  return { type: 9, data: { custom_id: id, title: cut(title, 45), components: [row({ type: 4, custom_id: 'value', label: cut(label, 45), style: 1, required: true, min_length: 1, max_length: 100, ...(value ? { value } : {}), ...(placeholder ? { placeholder } : {}) })] } };
}
export function setupView(w) {
  const d = w.data, base = `w:${w.id}`;
  if (d.mode && d.endMode === 'round_robin' && d.leagueRepeats == null) return { content: null, embeds: [{ title: '🔁 풀리그 반복 횟수 선택', color: 0xf1c40f, description: `${MODE[d.mode]}\n각 회차에서 모든 팀이 서로 한 번씩 대결합니다.\n예: 5팀 × 2회 = 10라운드 · 총 20경기` }], components: [select(`${base}:repeats`, '풀리그를 몇 회 반복할까요?', Array.from({ length: 10 }, (_, i) => ({ label: `풀리그 ${i + 1}회`, value: String(i + 1) }))), row(button('취소', `${base}:close`))] };
  return { content: null, embeds: [{ title: d.mode ? '🏀 종료 방식 선택' : '🏀 내전 편성 모드 선택', color: 0xf1c40f,
    description: d.mode ? `${MODE[d.mode]}\n종료 기준을 선택하세요.` : '🎲 랜덤 편성: 역할만 신청하고 운영진이 팀을 섞습니다.\n👥 직접 편성: 참가자가 원하는 팀과 역할을 선택합니다.',
    fields: [{ name: '📝 제목', value: esc(d.title) }, { name: '🏆 승리 승점', value: `${d.winPoints}점` }] }],
    components: d.mode ? [row(button('🔁 풀리그', `${base}:end:round_robin`, 1), button('전체 최대 판수', `${base}:end:match_limit`, 3), button('목표 승점', `${base}:end:points_target`, 3)), row(button('취소', `${base}:close`))] :
      [row(button('🎲 랜덤 편성', `${base}:mode:random`, 1), button('👥 직접 편성', `${base}:mode:manual`, 3)), row(button('취소', `${base}:close`))] };
}
export function registrationView(s, w) {
  const p = w.data.p, prefix = `w:${w.id}`, manual = s.mode !== 'random';
  const opts = (secondary = false) => [ ...(secondary ? [{ label: '보조 역할 없음', value: 'NONE', default: !p.secondaryRole }] : []), ...ROLE_KEYS.flatMap(r => ROLES[r].map(pos => ({ label: `${ROLE_ICONS[r]} ${r} · ${pos}`, value: `${r}|${pos}`, default: (secondary ? p.secondaryRole === r && p.secondaryPosition === pos : p.primaryRole === r && p.primaryPosition === pos) }))) ];
  const components = [select(`${prefix}:primary`, '주 역할·포지션', opts()), select(`${prefix}:secondary`, '보조 역할·포지션', opts(true))];
  if (manual) {
    const options = s.mode === 'legacy_mixed' ? [{ label: '랜덤 배정', value: 'RANDOM', default: p.teamNo == null }] : [];
    for (let n = 1; n <= 20; n++) {
      const occupied = s.participants.filter(x => x.id !== w.ownerId && x.teamNo === n).map(x => x.fixedRole);
      if (occupied.includes(p.fixedRole) || occupied.length >= 3) continue;
      options.push({ label: `TEAM ${n}`, value: String(n), default: p.teamNo === n, description: `빈 역할: ${ROLE_KEYS.filter(r => !occupied.includes(r)).join('/')}` });
    }
    components.push(select(`${prefix}:team`, '원하는 팀 선택', options));
  }
  components.push(row(button(`팀장 가능: ${p.captain ? '예' : '아니요'}`, `${prefix}:captain`, p.captain ? 3 : 2), ...(manual ? [button(`직접 배정: ${w.data.useSecondary ? '보조' : '주'} 역할`, `${prefix}:fixed`, 2, !p.secondaryRole)] : [])));
  components.push(row(button('✅ 개인 참가 완료', `${prefix}:submit`, 1), button('취소', `${prefix}:close`)));
  return { content: `**🏀 개인 참가 등록**\n주 역할: ${p.primaryRole || '미선택'} · ${p.primaryPosition || ''}\n보조: ${p.secondaryRole || '없음'} · ${p.secondaryPosition || ''}\n참가: ${p.teamNo ? `TEAM ${p.teamNo} · ${p.fixedRole}` : s.mode === 'manual' ? '팀 선택 필요' : '랜덤 배정'}\n모드: ${MODE[s.mode]}`,
    embeds: [], components };
}
export function subView(w) {
  const p = w.data, prefix = `w:${w.id}`;
  return { content: '**🪑 대타 등록**\n가능한 역할과 포지션을 선택하세요.', embeds: [], components: [
    select(`${prefix}:roles`, '가능한 역할 (복수 선택)', ROLE_KEYS.map(r => ({ label: `${ROLE_ICONS[r]} ${r}`, value: r, default: p.roles.includes(r) })), { max: 3 }),
    select(`${prefix}:positions`, '가능한 포지션 (복수 선택)', ['C', 'PF', 'SF', 'SG', 'PG'].map(pos => ({ label: pos, value: pos, default: p.positions.includes(pos) })), { max: 5 }),
    row(button('대타 등록 완료', `${prefix}:submit`, 1), button('취소', `${prefix}:close`)) ] };
}
export function publicPanel(s) {
  const recruiting = s.status === 'recruiting', ended = s.status === 'ended';
  const embed = { title: cut(`🏀 ${s.title}`, 256), color: ended ? 0x2ecc71 : recruiting ? 0xf1c40f : 0xe74c3c,
    description: `${ended ? '🏁 종료' : recruiting ? '🟡 모집 중' : '🔴 진행 중'} · ${MODE[s.mode]}\n👤 참가 ${s.participants.length}명 · 👥 ${s.teams.length}팀 · 🪑 대타 ${s.subs.length}명\n${END[s.endMode]}${s.endMode === 'round_robin' ? ` ${s.leagueRepeats || 1}회` : ''}${s.target ? ` · 목표 ${s.target}${s.endMode === 'match_limit' ? '경기' : '점'}` : ''} · 승리 +${s.winPoints}점`, fields: [] };
  const add = (name, value) => embed.fields.push({ name: cut(name, 256), value: cut(value || '없음', 1024), inline: false });
  if (recruiting) {
    for (const r of ROLE_KEYS) {
      const main = s.participants.filter(p => p.primaryRole === r), flex = s.participants.filter(p => p.secondaryRole === r);
      add(`${ROLE_ICONS[r]} ${r} · 주 ${main.length} + 보조 ${flex.length} = 가능 ${main.length + flex.length}명`, cut('**주 역할**\n' + (main.slice(0, 8).map(p => `• ${esc(cut(p.name, 24))} · ${p.primaryPosition}${p.teamNo ? ` · TEAM ${p.teamNo}(${p.fixedRole})` : ''}${p.captain ? ' 👑' : ''}`).join('\n') || '등록 없음') + (main.length > 8 ? `\n외 ${main.length - 8}명` : '') + (flex.length ? '\n**보조 가능**\n' + flex.slice(0, 4).map(p => `• ${esc(cut(p.name, 24))} → ${p.secondaryPosition}`).join('\n') + (flex.length > 4 ? `\n외 ${flex.length - 4}명` : '') : ''), s.teams.length > 10 ? 400 : 800));
    }
    const fixed = [...new Set(s.participants.filter(p => p.teamNo).map(p => p.teamNo))].sort((a, b) => a - b);
    if (fixed.length) add('📌 직접 선택 현황', fixed.map(n => { const slots = s.participants.filter(p => p.teamNo === n).map(p => p.fixedRole); return `TEAM ${n} · ${slots.length}/3 · 빈 역할 ${ROLE_KEYS.filter(r => !slots.includes(r)).join('/') || '없음 ✅'}`; }).join('\n'));
    add('➡️ 다음 단계', s.mode === 'manual' ? '원하는 팀과 역할을 선택하세요. 모든 팀이 완성되면 운영진이 편성을 확정합니다.' : s.teams.length ? '편성 미리보기 확인 후 운영진이 편성을 확정합니다.' : '모집이 끝나면 운영진이 랜덤 편성을 진행합니다.');
  } else {
    const fixtures = currentFixtures(s);
    add('📊 경기 진행 현황', progressText(s));
    if (!ended && fixtures.length) add(`⚔️ 현재 경기 · ROUND ${fixtures[0].round}`, fixtures.map(f => `${{ pending: '⚔️', reported: '⏳', disputed: '⚠️', completed: '✅' }[f.status]} TEAM ${teamById(s, f.a).no} vs TEAM ${teamById(s, f.b).no}${f.status === 'completed' ? ` → TEAM ${teamById(s, f.winner).no} ${f.resultType === 'forfeit' ? '몰수승' : '승리'}` : f.status === 'reported' ? ' · 상대 확인 대기' : f.status === 'disputed' ? ' · 운영진 판정 필요' : ' · 진행/대기'}`).join('\n') + '\n휴식: ' + (s.teams.filter(t => !t.withdrawnAt && !fixtures.some(f => [f.a, f.b].includes(t.id))).map(t => `TEAM ${t.no}`).join(', ') || '없음'));
    if (s.pendingTeams?.length) add(`➕ 편입 대기 ${s.pendingTeams.length}팀`, s.pendingTeams.map(t => `TEAM ${t.no} · ROUND ${t.activateAfterRound} 종료 후 합류\n` + t.members.map(m => `${m.role}: ${esc(cut(m.name, 18))}${m.id === t.captainId ? ' 👑' : ''}`).join(' · ')).join('\n'));
    if (s.rosterChanges?.length) add('🔁 팀 편입 안내', '완료된 경기·승점 유지. ' + (s.endMode === 'round_robin' ? '편입 시 진행 중 회차부터 새 팀 수로 다시 편성했습니다. 합류 시점에 따라 누적 경기 수는 다를 수 있습니다.' : '새 팀은 다음 라운드부터 참여하며 0점으로 시작합니다.'));
    const ranked = [...s.teams].sort((a, b) => Boolean(a.withdrawnAt) - Boolean(b.withdrawnAt) || b.points - a.points || a.no - b.no);
    add(ended ? '🏆 최종 순위' : '🏆 현재 순위', ranked.map(t => `${t.withdrawnAt ? '🏳️' : (1 + ranked.filter(x => !x.withdrawnAt && x.points > t.points).length) + '위'} TEAM ${t.no} · ${t.points}점${t.withdrawnAt ? ' · 기권' : ''}`).join('\n'));
    if (ended && s.completedAt) add('🏁 최종 결과', leaders(s).map(t => `TEAM ${t.no} · ${t.points}점`).join(', ') || '우승 팀 없음');
  }
  for (let i = 0; i < s.teams.length; i += 2) add('👥 팀 명단', s.teams.slice(i, i + 2).map(t => `**TEAM ${t.no}${t.withdrawnAt ? ' · 기권' : ''}**\n` + t.members.map(m => `${m.id === t.captainId ? '👑' : '•'} ${m.role}/${m.position} ${esc(cut(m.name, s.teams.length > 10 ? 14 : 28))}${m.isSub ? ' 🔄' : ''}`).join('\n')).join('\n\n'));
  if (s.subs.length) add(`🪑 대기/대타 ${s.subs.length}명`, s.subs.slice(0, 8).map(p => `${esc(cut(p.name, 24))} · ${p.roles.join('/')}${(s.pendingTeams || []).some(t => t.members.some(m => m.id === p.id)) ? ' · 편입 예약' : ''}`).join('\n') + (s.subs.length > 8 ? `\n외 ${s.subs.length - 8}명` : ''));
  let size = () => (embed.title.length + embed.description.length + embed.fields.reduce((n, f) => n + f.name.length + f.value.length, 0));
  while (size() > 5700) { const f = [...embed.fields].filter(f => f.name !== '👥 팀 명단' && f.value.length > 150).sort((a, b) => b.value.length - a.value.length)[0]; if (!f) break; f.value = cut(f.value, f.value.length - 100); }
  const prefix = `p:${s.id}`;
  return { embeds: [embed], allowed_mentions: { parse: [] }, components: [row(button('개인 참가', `${prefix}:join`, 1, !recruiting), button('대타 등록', `${prefix}:sub`, 3, ended), button('참가 취소', `${prefix}:cancel`, 4, ended), button('내 정보', `${prefix}:info`, 2, ended)), row(button('⚔️ 경기 종료', `${prefix}:result`, 3, s.status !== 'running'))] };
}
export function progressText(s) {
  const lastRound = Math.max(0, ...s.fixtures.map(f => f.round));
  const current = currentFixtures(s), fs = current.length ? current : s.status === 'ended' ? s.fixtures.filter(f => f.round === lastRound) : [], done = s.fixtures.filter(f => f.status === 'completed').length;
  const total = s.endMode === 'round_robin' ? s.fixtures.length : s.endMode === 'match_limit' ? s.target : null;
  const heading = fs.length ? `${s.status === 'ended' ? '종료 · 마지막' : '현재'} ROUND ${fs[0].round}${s.endMode === 'round_robin' ? ` / ${lastRound}` : ''}${s.endMode === 'round_robin' ? ` · 풀리그 ${fs[0].cycle || 1}/${s.leagueRepeats || 1}회차` : ''}` : s.status === 'ended' ? '내전 종료' : '대진 준비 중';
  return `${heading}\n이번 라운드: 완료 ${fs.filter(f => f.status === 'completed').length}/${fs.length} · 결과 미확정 ${fs.filter(f => f.status !== 'completed').length}경기\n전체: 완료 ${done}${total == null ? `경기${s.status === 'ended' ? '' : ' · 목표 승점 달성까지 진행'}` : `/${total} · ${s.status === 'ended' && done < total ? '미완료' : '남은'} ${Math.max(0, total - done)}경기`}`;
}
export function adminPanel(s) {
  const id = `a:${s.id}`, running = s.status === 'running', ended = s.status === 'ended';
  return { content: null, embeds: [{ title: '🛠️ 내전 관리', color: 0x3498db, description: `${esc(s.title)}\n${MODE[s.mode]} · ${s.status}\n👤 참가 ${s.participants.length}명 · 👥 ${s.teams.length}팀 · ✅ ${s.fixtures.filter(f => f.status === 'completed').length}경기 완료`, fields: [{ name: '➡️ 지금 할 일', value: ended ? '종료된 내전입니다.' : s.status === 'recruiting' ? s.mode === 'manual' ? '팀 직접 선택 현황을 확인하고 편성 확정을 누르세요.' : '랜덤 편성 → 미리보기 → 편성 확정' : '팀장이 경기 종료에서 결과를 입력·확인합니다.' }, ...(s.panelError ? [{ name: '⚠️ 공개 패널 전송 문제', value: cut(esc(s.panelError) + '\n설정 확인 후 아래 패널 복구를 눌러주세요.', 1000) }] : [])] }], components: [
    row(button('랜덤 편성', `${id}:draft`, 1, s.status !== 'recruiting' || s.mode === 'manual'), button('편성 확정', `${id}:finalize`, 3, s.status !== 'recruiting')),
    row(button('선수 교체', `${id}:substitute`, 1, !running), button('팀장 변경', `${id}:captain`, 2, !running), button('팀 기권', `${id}:withdraw`, 4, !running), button('팀 추가', `${id}:addTeam`, 3, !running || !availableTeamNumbers(s).length), button('편입 취소', `${id}:cancelTeam`, 2, !running || !s.pendingTeams?.length)),
    row(button('대진 관리', `${id}:fixtures`, 1, !running), button('승점 수정', `${id}:points`, 2, !running), button('결과 취소', `${id}:undo`, 2, !running)),
    row(button('채널 연결', `${id}:voiceConnect`, 2, ended), button('팀별 이동', `${id}:voiceTeams`, 3, ended), button('역할별 이동', `${id}:voiceRoles`, 2, ended), button('대기실 이동', `${id}:voiceWaiting`, 2, ended)),
    row(button('새로고침', `${id}:refresh`), button('패널 복구', `${id}:repairPanel`, 3, ended), button('내전 종료', `${id}:finish`, 4, ended)) ] };
}
export function flowView(s, w) {
  const d = w.data, p = `w:${w.id}`, active = s.teams.filter(t => !t.withdrawnAt), opts = active.map(t => ({ label: `TEAM ${t.no}`, value: t.id }));
  if (d.op === 'cancelTeam') return { content: '**편입 예약 취소**\n아직 합류하지 않은 팀만 취소할 수 있습니다.', embeds: [], components: [select(`${p}:pendingteam`, '취소할 예약 팀', (s.pendingTeams || []).map(t => ({ label: `TEAM ${t.no}`, value: t.id }))), ...(d.teamId ? [row(button('편입 취소', `${p}:submit`, 4), button('취소', `${p}:close`))] : [])] };
  if (d.op === 'addTeam') return admissionView(s, w);
  if (d.kind === 'confirm') return { content: `${d.label}\n이 작업을 진행할까요?`, embeds: [], components: [row(button('확정', `${p}:submit`, d.op === 'finish' || d.op === 'withdraw' ? 4 : 3), button('취소', `${p}:close`))] };
  if (d.kind === 'result') {
    const f = s.fixtures.find(f => f.id === d.fixtureId); if (!f) return { content: '경기 정보가 변경됐습니다.', components: [] };
    const title = `**ROUND ${f.round} · TEAM ${teamById(s, f.a).no} vs TEAM ${teamById(s, f.b).no}**`;
    if (d.manager || f.status === 'pending') return { content: `${title}\n승리 팀을 선택하세요.`, embeds: [], components: [row(...[f.a, f.b].map(t => button(`TEAM ${teamById(s, t).no} 승리`, `${p}:winner:${t}`, 1)))] };
    if (f.status === 'reported' && f.reporter !== w.ownerId) return { content: `${title}\n상대 팀장이 TEAM ${teamById(s, f.proposed).no} 승리로 제출했습니다.`, embeds: [], components: [row(button('결과 확인', `${p}:accept`, 3), button('결과가 다름', `${p}:dispute`, 4))] };
    return { content: f.status === 'reported' ? '상대 팀장의 결과 확인을 기다리고 있습니다.' : '운영진의 결과 판정을 기다리고 있습니다.', embeds: [], components: [] };
  }
  if (d.op === 'fixtures') return { content: '**현재 라운드 대진 관리**', embeds: [], components: [select(`${p}:fixture`, '판정할 경기 선택', currentFixtures(s).filter(f => f.status !== 'completed').map(f => ({ label: `R${f.round} TEAM ${teamById(s, f.a).no} vs TEAM ${teamById(s, f.b).no}`, value: f.id })))] };
  if (!d.teamId) return { content: '팀을 선택하세요.', embeds: [], components: [select(`${p}:pickteam`, '팀 선택', opts)] };
  const t = teamById(s, d.teamId);
  if (d.op === 'captain') return { content: `TEAM ${t.no}의 새 팀장을 선택하세요.`, embeds: [], components: [select(`${p}:member`, '현재 팀원 중 새 팀장', t.members.map(m => ({ label: m.name, value: m.id }))), ...(d.memberId ? [row(button('팀장 변경 확정', `${p}:submit`, 3))] : [])] };
  if (d.op === 'substitute') {
    if (!d.outgoingId) return { content: `TEAM ${t.no}에서 교체할 선수 선택`, embeds: [], components: [select(`${p}:outgoing`, '교체할 선수', t.members.map(m => ({ label: `${m.role} · ${m.name}`, value: m.id })))] };
    const out = t.members.find(m => m.id === d.outgoingId);
    const candidates = s.subs.filter(p => !(s.pendingTeams || []).some(t => t.members.some(m => m.id === p.id)) && out && p.roles.includes(out.role) && p.positions.some(pos => ROLES[out.role].includes(pos)));
    return { content: `${esc(out?.name || '')}의 대타를 선택하세요.`, embeds: [], components: [select(`${p}:incoming`, '역할에 맞는 대타 선택', candidates.map(m => ({ label: m.name, value: m.id }))), ...(d.incomingId ? [row(button('선수 교체 확정', `${p}:submit`, 3))] : [])] };
  }
  if (d.op === 'withdraw') return { content: `**TEAM ${t.no} 기권**\n완료된 결과는 유지하고 미완료 대진을 상대 몰수승 처리합니다. 되돌릴 수 없습니다.`, embeds: [], components: [row(button('기권 확정', `${p}:submit`, 4), button('취소', `${p}:close`))] };
  return { content: '설정 내용을 확인해주세요.', embeds: [], components: [] };
}
function admissionView(s, w) {
  const d = w.data, p = `w:${w.id}`, members = d.members || [], roleName = r => `${ROLE_ICONS[r]} ${r}`;
  const names = members.map(m => `${m.role} · ${esc(cut(m.name, 24))}`).join('\n') || '선수를 선택하세요.';
  if (!d.positions) return { content: `**➕ 새 팀 직접 편입 · 선수 선택**\nTEAM ${d.teamNo || '번호 미선택'}\n${names}\n현재 라운드 종료 후 합류합니다.`, embeds: [], components: [
    select(`${p}:newnumber`, '사용할 팀 번호', availableTeamNumbers(s).map(n => ({ label: `TEAM ${n}`, value: String(n), default: d.teamNo === n }))),
    ...ROLE_KEYS.map(r => { const m = members.find(m => m.role === r); return row({ type: 5, custom_id: `${p}:newplayer:${r}`, placeholder: `${roleName(r)} 선수 선택`, min_values: 1, max_values: 1, ...(m ? { default_values: [{ id: m.id, type: 'user' }] } : {}) }); }),
    row(button('다음: 포지션·팀장', `${p}:newnext`, 1, !d.teamNo || members.length !== 3), button('취소', `${p}:close`)) ] };
  return { content: `**➕ TEAM ${d.teamNo} 편입 예약 확인**\n${names}\n${s.endMode === 'round_robin' ? '현재 회차부터 새 팀 수로 풀리그를 다시 진행합니다. 완료 경기·승점은 유지되므로 누적 경기 수는 다를 수 있습니다.' : '종료 기준을 달성하면 편입 전에 내전이 종료될 수 있습니다.'}`, embeds: [], components: [
    ...ROLE_KEYS.map(r => select(`${p}:newposition:${r}`, `${roleName(r)} 포지션`, ROLES[r].map(pos => ({ label: `${r} · ${pos}`, value: pos, default: members.find(m => m.role === r)?.position === pos })))),
    select(`${p}:newcaptain`, '새 팀 팀장', members.map(m => ({ label: cut(`${m.role} · ${m.name}`, 100), value: m.id, default: d.captainId === m.id }))),
    row(button('편입 예약 확정', `${p}:submit`, 3, !d.captainId || members.some(m => !m.position)), button('선수 다시 선택', `${p}:newback`), button('취소', `${p}:close`)) ] };
}
