export const ROLES = { BIG: ['C', 'PF'], SCORER: ['PF', 'SF', 'SG'], MAKER: ['PG', 'SG'] };
export const ROLE_KEYS = Object.keys(ROLES);
export class UserError extends Error {}
export const ensure = (ok, message) => { if (!ok) throw new UserError(message); };
export const now = () => new Date().toISOString();
export const teamById = (s, id) => { const t = s.teams.find(t => t.id === id); ensure(t, '팀을 찾을 수 없습니다.'); return t; };
export const fixtureById = (s, id) => { const f = s.fixtures.find(f => f.id === id); ensure(f, '대진을 찾을 수 없습니다.'); return f; };
export const currentRound = s => { const rounds = s.fixtures.filter(f => f.status !== 'completed').map(f => f.round); return rounds.length ? Math.min(...rounds) : null; };
export const currentFixtures = s => { const r = currentRound(s); return Number.isFinite(r) ? s.fixtures.filter(f => f.round === r) : []; };
export function shuffle(a, rng = Math.random) { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
export function newScrim(id, guildId, data) {
  ensure(['random', 'manual'].includes(data.mode), '편성 모드를 선택해주세요.');
  ensure(['round_robin', 'match_limit', 'points_target'].includes(data.endMode), '종료 방식을 선택해주세요.');
  ensure(Number.isInteger(data.winPoints) && data.winPoints >= 1 && data.winPoints <= 100, '승리 승점은 1~100입니다.');
  ensure(data.endMode === 'round_robin' || (Number.isInteger(data.target) && data.target >= 1 && data.target <= 999), '목표값은 1~999입니다.');
  const repeats = data.leagueRepeats ?? 1;
  ensure(Number.isInteger(repeats) && repeats >= 1 && repeats <= 10, '풀리그 반복 횟수는 1~10회입니다.');
  ensure(data.endMode === 'round_robin' || data.leagueRepeats == null, '풀리그 반복 횟수는 풀리그 종료 방식에서만 지정해주세요.');
  return { id, guildId, title: String(data.title || '프리스타일 리부트 클럽 내전').slice(0, 100), mode: data.mode,
    endMode: data.endMode, leagueRepeats: repeats, target: data.endMode === 'round_robin' ? null : data.target, winPoints: data.winPoints,
    status: 'recruiting', participants: [], subs: [], teams: [], fixtures: [], matches: [], substitutions: [],
    createdAt: now(), endedAt: null, completedAt: null, endReason: null, panel: null, waitingId: null,
    applied: {}, nextFixture: 1, nextMatch: 1, pendingTeams: [], rosterChanges: [] };
}
function requireRecruiting(s) { ensure(s.status === 'recruiting', '모집 중에만 변경할 수 있습니다.'); }
function requireRunning(s) { ensure(s.status === 'running' && !s.completedAt, '진행 중인 내전에서만 사용할 수 있습니다.'); }
function validatePlayer(p) {
  ensure(typeof p.id === 'string' && /^\d+$/.test(p.id), '참가자 ID가 잘못되었습니다.');
  ensure(ROLES[p.primaryRole]?.includes(p.primaryPosition), '주 역할·포지션을 선택해주세요.');
  ensure(!p.secondaryRole || (p.secondaryRole !== p.primaryRole && ROLES[p.secondaryRole]?.includes(p.secondaryPosition)), '보조 역할·포지션을 확인해주세요.');
  if (p.teamNo != null) {
    ensure(Number.isInteger(p.teamNo) && p.teamNo >= 1 && p.teamNo <= 20, '팀 번호는 1~20입니다.');
    ensure([p.primaryRole, p.secondaryRole].includes(p.fixedRole) && p.fixedRole, '직접 배정 역할을 선택해주세요.');
  } else ensure(!p.fixedRole, '직접 배정 역할은 팀 선택 후 사용할 수 있습니다.');
}
function assigned(p, role) { return { id: p.id, name: p.name, role, position: role === p.primaryRole ? p.primaryPosition : p.secondaryPosition, isSub: false }; }

// Min-cost max-flow: maximize complete teams first, then minimize secondary-role use.
// At most 60 assigned players / 20 teams; no exponential lineup enumeration.
export function fillRoles(players, quotas, rng = Math.random) {
  players = shuffle(players, rng);
  const n = players.length, source = 0, sink = n + 4, g = Array.from({ length: sink + 1 }, () => []);
  function edge(a, b, cap, cost) { const e = { to: b, rev: g[b].length, cap, cost }; g[a].push(e); g[b].push({ to: a, rev: g[a].length - 1, cap: 0, cost: -cost }); return e; }
  const choices = [];
  players.forEach((p, i) => {
    edge(source, i + 1, 1, 0);
    choices[i] = shuffle([p.primaryRole, ...(p.secondaryRole ? [p.secondaryRole] : [])], rng).map(role => [role, edge(i + 1, n + 1 + ROLE_KEYS.indexOf(role), 1, role === p.primaryRole ? 0 : 1)]);
  });
  ROLE_KEYS.forEach((role, i) => edge(n + 1 + i, sink, quotas[role], 0));
  const target = Object.values(quotas).reduce((a, b) => a + b, 0);
  for (let flow = 0; flow < target; flow++) {
    const dist = Array(g.length).fill(Infinity), prev = Array(g.length), queue = [source], queued = Array(g.length).fill(false);
    dist[source] = 0; queued[source] = true;
    for (let at = 0; at < queue.length; at++) {
      const a = queue[at]; queued[a] = false;
      g[a].forEach((e, i) => { if (e.cap && dist[e.to] > dist[a] + e.cost) { dist[e.to] = dist[a] + e.cost; prev[e.to] = [a, i]; if (!queued[e.to]) { queue.push(e.to); queued[e.to] = true; } } });
    }
    if (!prev[sink]) return null;
    for (let b = sink; b !== source;) { const [a, i] = prev[b], e = g[a][i]; e.cap--; g[b][e.rev].cap++; b = a; }
  }
  const pools = Object.fromEntries(ROLE_KEYS.map(r => [r, []]));
  players.forEach((p, i) => choices[i].forEach(([r, e]) => { if (e.cap === 0) pools[r].push(p); }));
  return pools;
}
export function draft(s, rng = Math.random) {
  requireRecruiting(s); ensure(s.mode !== 'manual', '직접 편성 모드에서는 랜덤으로 섞을 수 없습니다.');
  ensure(s.participants.length >= 6, '최소 6명(2팀)이 필요합니다.');
  const fixed = new Map();
  for (const p of s.participants.filter(p => p.teamNo != null)) {
    const slots = fixed.get(p.teamNo) || {};
    ensure(!slots[p.fixedRole], '직접 선택 역할이 중복되었습니다.'); slots[p.fixedRole] = p; fixed.set(p.teamNo, slots);
  }
  const randomPlayers = s.participants.filter(p => p.teamNo == null);
  let count = Math.min(20, Math.floor(s.participants.length / 3)), pools = null;
  for (; count >= Math.max(2, fixed.size); count--) {
    const quotas = Object.fromEntries(ROLE_KEYS.map(role => [role, count - [...fixed.values()].filter(slots => slots[role]).length]));
    pools = fillRoles(randomPlayers, quotas, rng); if (pools) break;
  }
  ensure(pools, '역할이 맞는 팀을 최소 2개 구성할 수 없습니다. 직접 선택 팀의 빈 역할과 참가 인원을 확인해주세요.');
  const numbers = [...fixed.keys()]; for (let i = 1; numbers.length < count; i++) if (!numbers.includes(i)) numbers.push(i); numbers.sort((a, b) => a - b);
  let best = [], score = -1;
  for (let trial = 0; trial < 100; trial++) {
    const rest = Object.fromEntries(ROLE_KEYS.map(r => [r, shuffle(pools[r], rng)]));
    const rosters = numbers.map(no => ({ no, players: ROLE_KEYS.map(role => ({ p: fixed.get(no)?.[role] || rest[role].pop(), role })) }));
    const value = rosters.filter(t => t.players.some(({ p }) => p.captain)).length;
    if (value > score) { best = rosters; score = value; }
    if (score === count) break;
  }
  s.teams = best.map(({ no, players }) => makeTeam(no, players, rng));
  return `${s.teams.length}팀 편성 미리보기를 만들었습니다. 직접 선택이 있다면 그대로 유지됩니다.`;
}
function makeTeam(no, players, rng) {
  const willing = players.filter(({ p }) => p.captain), candidates = willing.length ? willing : players;
  return { id: String(no), no, captainId: candidates[Math.floor(rng() * candidates.length)].p.id,
    points: 0, voiceId: null, withdrawnAt: null, members: players.map(({ p, role }) => assigned(p, role)) };
}
function directTeams(s, rng) {
  const groups = new Map();
  s.participants.forEach(p => { ensure(p.teamNo != null, '모든 참가자가 팀을 선택해야 합니다.'); const slots = groups.get(p.teamNo) || {}; ensure(!slots[p.fixedRole], '팀 역할이 중복되었습니다.'); slots[p.fixedRole] = p; groups.set(p.teamNo, slots); });
  const missing = [...groups].filter(([, slots]) => ROLE_KEYS.some(r => !slots[r]));
  ensure(!missing.length, '미완성 팀: ' + missing.map(([n, slots]) => `TEAM ${n} (${ROLE_KEYS.filter(r => !slots[r]).join('/')} 필요)`).join(', '));
  ensure(groups.size >= 2 && groups.size <= 20, '2~20팀이 필요합니다.');
  return [...groups].sort(([a], [b]) => a - b).map(([no, slots]) => makeTeam(no, ROLE_KEYS.map(role => ({ p: slots[role], role })), rng));
}
export function roundRobin(ids) {
  const ring = [...ids]; if (ring.length % 2) ring.push(null);
  const rounds = [];
  for (let r = 0; r < ring.length - 1; r++) { const pairs = []; for (let j = 0; j < ring.length / 2; j++) if (ring[j] != null && ring[ring.length - 1 - j] != null) pairs.push([ring[j], ring[ring.length - 1 - j]]); rounds.push(pairs); ring.splice(1, 0, ring.pop()); }
  return rounds;
}
const pairKey = (a, b) => [a, b].sort().join(':');
export function balancedPairs(teams, fixtures, count) {
  const games = new Map(teams.map(t => [t.id, 0])), meetings = new Map(), last = new Map();
  for (const f of fixtures) { for (const id of [f.a, f.b]) if (games.has(id)) games.set(id, games.get(id) + 1); const k = pairKey(f.a, f.b); meetings.set(k, (meetings.get(k) || 0) + 1); last.set(k, f.round); }
  const compare = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
  const available = teams.map(t => t.id), pairs = [];
  while (pairs.length < count && available.length >= 2) {
    available.sort((a, b) => games.get(a) - games.get(b) || Number(a) - Number(b)); const a = available.shift();
    available.sort((b, c) => compare([meetings.get(pairKey(a, b)) || 0, games.get(b), last.get(pairKey(a, b)) || -1, Number(b)], [meetings.get(pairKey(a, c)) || 0, games.get(c), last.get(pairKey(a, c)) || -1, Number(c)]));
    pairs.push([a, available.shift()]);
  }
  // Local pair swaps improve repeat avoidance without exponential enumeration.
  for (let pass = 0; pass < 5; pass++) for (let i = 0; i < pairs.length; i++) for (let j = i + 1; j < pairs.length; j++) {
    const [a, b] = pairs[i], [c, d] = pairs[j];
    const cost = ps => { const m = ps.map(([x, y]) => meetings.get(pairKey(x, y)) || 0); return [Math.max(...m), m.reduce((x, y) => x + y, 0), ps.reduce((x, [a, b]) => x + (last.get(pairKey(a, b)) || -1), 0)]; };
    for (const alt of [[[a, c], [b, d]], [[a, d], [b, c]]]) if (compare(cost(alt), cost([pairs[i], pairs[j]])) < 0) [pairs[i], pairs[j]] = alt;
  }
  return pairs;
}
function insertRound(s, round, pairs, cycle = null, generation = 1) {
  for (const [a, b] of pairs) s.fixtures.push({ id: String(s.nextFixture++), round, cycle, generation, a, b, status: 'pending', reporter: null, proposed: null, winner: null, resultType: 'played', matchId: null, completedAt: null });
}
function cancelPending(s, reason) {
  if (s.pendingTeams?.length) { s.cancelledTeams = [...(s.cancelledTeams || []), ...s.pendingTeams.map(t => ({ ...t, cancelledAt: now(), reason }))]; s.pendingTeams = []; }
}
function end(s, reason) { s.status = 'ended'; s.completedAt = now(); s.endedAt = s.completedAt; s.endReason = reason; cancelPending(s, reason); }
function buildLeague(s, startRound = 1, fromCycle = 1) {
  const ids = s.teams.filter(t => !t.withdrawnAt).map(t => t.id), generation = (s.rosterChanges?.length || 0) + 1;
  let round = startRound;
  for (let cycle = fromCycle; cycle <= (s.leagueRepeats || 1); cycle++) for (const pairs of roundRobin(ids)) insertRound(s, round++, pairs, cycle, generation);
}
export function availableTeamNumbers(s) {
  const used = new Set([...s.teams, ...(s.pendingTeams || [])].map(t => t.no));
  return Array.from({ length: 20 }, (_, i) => i + 1).filter(n => !used.has(n));
}
const reserved = (s, id) => (s.pendingTeams || []).some(t => t.members.some(m => m.id === id));
function queueTeam(s, d) {
  ensure(Number.isInteger(d.teamNo) && availableTeamNumbers(s).includes(d.teamNo), '비어 있는 TEAM 1~20 번호를 선택해주세요.');
  ensure(Array.isArray(d.members) && d.members.length === 3 && new Set(d.members.map(m => m.role)).size === 3 && d.members.every(m => ROLE_KEYS.includes(m.role) && ROLES[m.role].includes(m.position)), 'BIG·SCORER·MAKER를 한 명씩, 올바른 포지션으로 지정해주세요.');
  ensure(d.members.every(m => typeof m.id === 'string' && /^\d{1,20}$/.test(m.id) && !m.bot), '서버의 일반 회원을 선수로 선택해주세요.');
  ensure(new Set(d.members.map(m => m.id)).size === 3, '서로 다른 선수 3명이 필요합니다.');
  ensure(d.members.every(m => !s.teams.some(t => t.members.some(x => x.id === m.id)) && !reserved(s, m.id)), '이미 팀에 배정됐거나 편입 예약된 선수가 포함되어 있습니다.');
  ensure(d.members.some(m => m.id === d.captainId), '팀원 중 팀장을 지정해주세요.');
  const round = currentRound(s); ensure(Number.isFinite(round), '현재 진행 중인 라운드가 없습니다.');
  const team = { id: String(d.teamNo), no: d.teamNo, captainId: d.captainId, points: 0, voiceId: null, withdrawnAt: null, queuedAt: now(), activateAfterRound: round,
    members: ROLE_KEYS.map(role => { const m = d.members.find(m => m.role === role); return { id: m.id, name: String(m.name || m.id).slice(0, 100), role, position: m.position, isSub: false }; }) };
  (s.pendingTeams ||= []).push(team);
  return `TEAM ${team.no} 편입을 예약했습니다. ROUND ${round} 종료 후 합류합니다.${s.endMode === 'round_robin' ? ' 현재 풀리그 회차부터 새 팀 수로 다시 진행하며 완료 경기·승점은 유지합니다.' : ' 종료 기준이 이번 라운드에서 달성되면 예약은 취소됩니다.'}`;
}
function activateTeams(s, round) {
  const teams = (s.pendingTeams || []).filter(t => t.activateAfterRound <= round); if (!teams.length) return false;
  const cycle = s.fixtures.find(f => f.round === round)?.cycle || 1;
  for (const t of teams) {
    s.teams.push({ ...t, joinedAt: now() });
    for (const m of t.members) {
      s.subs = s.subs.filter(p => p.id !== m.id); s.participants = s.participants.filter(p => p.id !== m.id);
      s.participants.push({ id: m.id, name: m.name, primaryRole: m.role, primaryPosition: m.position, secondaryRole: null, secondaryPosition: null, teamNo: t.no, fixedRole: m.role, captain: t.captainId === m.id });
    }
  }
  s.pendingTeams = s.pendingTeams.filter(t => !teams.includes(t));
  // Discard only untouched future fixtures; completed forfeits and all results stay.
  s.fixtures = s.fixtures.filter(f => f.round <= round || f.status === 'completed');
  (s.rosterChanges ||= []).push({ afterRound: round, cycle, teamIds: teams.map(t => t.id), createdAt: now() });
  if (s.endMode === 'round_robin') buildLeague(s, Math.max(0, ...s.fixtures.map(f => f.round)) + 1, cycle);
  return true;
}
function scheduleNext(s) {
  const active = s.teams.filter(t => !t.withdrawnAt); if (active.length < 2) { end(s, 'insufficient_teams'); return; }
  let count = Math.floor(active.length / 2);
  if (s.endMode === 'match_limit') count = Math.min(count, s.target - s.fixtures.filter(f => f.status === 'completed').length);
  if (count <= 0) { end(s, 'match_limit_reached'); return; }
  const round = Math.max(0, ...s.fixtures.map(f => f.round)) + 1;
  insertRound(s, round, balancedPairs(active, s.fixtures, count));
}
function advance(s, completedRound) {
  if (s.fixtures.some(f => f.round === completedRound && f.status !== 'completed')) return;
  if (s.endMode === 'match_limit' && s.fixtures.filter(f => f.status === 'completed').length >= s.target) { end(s, 'match_limit_reached'); return; }
  if (s.endMode === 'points_target' && s.teams.some(t => !t.withdrawnAt && t.points >= s.target)) { end(s, 'points_target_reached'); return; }
  activateTeams(s, completedRound);
  if (s.fixtures.some(f => f.status !== 'completed')) return;
  if (s.endMode === 'round_robin') end(s, 'round_robin_completed'); else scheduleNext(s);
}
function finalize(s) {
  requireRecruiting(s);
  if (s.mode === 'manual') s.teams = directTeams(s, Math.random);
  if (s.mode === 'legacy_mixed' && !s.teams.length && s.participants.every(p => p.teamNo != null)) draft(s);
  ensure(s.teams.length >= 2, '먼저 최소 2팀을 랜덤 편성하거나 직접 선택 팀을 완성해주세요.');
  const assignedIds = new Set(s.teams.flatMap(t => t.members.map(m => m.id)));
  for (const p of s.participants) if (!assignedIds.has(p.id) && !s.subs.some(x => x.id === p.id)) s.subs.push({ id: p.id, name: p.name, roles: [p.primaryRole, ...(p.secondaryRole ? [p.secondaryRole] : [])], positions: [p.primaryPosition, ...(p.secondaryPosition ? [p.secondaryPosition] : [])] });
  s.status = 'running'; s.fixtures = []; s.matches = []; s.nextFixture = 1; s.nextMatch = 1;
  if (s.endMode === 'round_robin') buildLeague(s); else scheduleNext(s);
  return `${s.teams.length}팀 편성과 대진을 확정했습니다. 음성방은 채널 연결 후 팀별 이동을 사용하세요.`;
}
function complete(s, f, winner, type = 'played') {
  ensure([f.a, f.b].includes(winner), '현재 경기의 승리 팀을 선택해주세요.');
  ensure(f.status !== 'completed', '이미 완료된 경기입니다.');
  const t = teamById(s, winner); t.points += s.winPoints;
  f.status = 'completed'; f.winner = winner; f.resultType = type; f.completedAt = now(); f.reporter = null; f.proposed = null;
  f.matchId = String(s.nextMatch++);
  s.matches.push({ id: f.matchId, fixtureId: f.id, a: f.a, b: f.b, winner, points: s.winPoints, reversed: false, createdAt: f.completedAt, type });
}
function activeFixture(s, id) { requireRunning(s); const f = fixtureById(s, id); ensure(f.round === currentRound(s), '현재 라운드의 경기만 처리할 수 있습니다.'); ensure(!teamById(s, f.a).withdrawnAt && !teamById(s, f.b).withdrawnAt, '기권 팀의 경기는 직접 입력할 수 없습니다.'); return f; }
function captainFor(s, f, user) { ensure([teamById(s, f.a).captainId, teamById(s, f.b).captainId].includes(user), '현재 경기의 팀장만 처리할 수 있습니다.'); }
export function applyAction(s, action, actor, rng = Math.random) {
  const d = action.data || {};
  if (action.kind === 'register') {
    requireRecruiting(s); const p = { ...d, id: actor.id, name: String(actor.name).slice(0, 100) }; validatePlayer(p);
    ensure(!(s.mode === 'random' && p.teamNo != null), '랜덤 내전에서는 팀을 직접 선택할 수 없습니다.');
    ensure(!(s.mode === 'manual' && p.teamNo == null), '직접 내전에서는 팀을 선택해야 합니다.');
    ensure(!s.subs.some(x => x.id === p.id), '이미 대타로 등록되어 있습니다. 참가 취소 후 신청해주세요.');
    ensure(!s.participants.some(x => x.id !== p.id && p.teamNo != null && x.teamNo === p.teamNo && x.fixedRole === p.fixedRole), '해당 팀의 역할 자리가 이미 찼습니다. 다시 선택해주세요.');
    s.participants = s.participants.filter(x => x.id !== p.id); s.participants.push(p); s.teams = [];
    return p.teamNo ? `TEAM ${p.teamNo} · ${p.fixedRole}로 신청했습니다.` : '랜덤 편성 참가 신청을 완료했습니다.';
  }
  if (action.kind === 'subregister') {
    ensure(s.status !== 'ended', '종료된 내전입니다.');
    ensure(!reserved(s, actor.id), '새 팀 편입 예약 중입니다. 운영진에게 확인해주세요.');
    ensure(d.roles?.length && d.positions?.length && d.roles.every(r => ROLE_KEYS.includes(r)) && d.positions.every(p => Object.values(ROLES).flat().includes(p)), '가능한 역할과 포지션을 선택해주세요.');
    ensure(d.roles.every(r => d.positions.some(p => ROLES[r].includes(p))), '각 역할에 맞는 포지션을 한 개 이상 선택해주세요.');
    ensure(!s.teams.some(t => t.members.some(m => m.id === actor.id)) && (!s.participants.some(p => p.id === actor.id) || s.subs.some(p => p.id === actor.id)), '이미 참가 신청 또는 팀 배정된 사용자입니다.');
    s.subs = s.subs.filter(p => p.id !== actor.id); s.subs.push({ id: actor.id, name: actor.name, roles: d.roles, positions: d.positions }); return '대타 등록을 완료했습니다.';
  }
  if (action.kind === 'cancel') {
    ensure(s.status !== 'ended', '종료된 내전입니다.');
    ensure(!reserved(s, actor.id), '새 팀 편입 예약 중입니다. 운영진에게 편입 취소를 요청해주세요.');
    if (s.status === 'recruiting' && s.participants.some(p => p.id === actor.id)) { s.participants = s.participants.filter(p => p.id !== actor.id); s.teams = []; return '개인 참가를 취소했습니다.'; }
    ensure(s.subs.some(p => p.id === actor.id), '진행 중인 선수는 운영진의 선수 교체를 이용해주세요.');
    s.subs = s.subs.filter(p => p.id !== actor.id); s.participants = s.participants.filter(p => p.id !== actor.id); return '대타 등록을 취소했습니다.';
  }
  if (action.kind === 'draft') return draft(s, rng);
  if (action.kind === 'finalize') return finalize(s);
  if (action.kind === 'finish') { ensure(s.status !== 'ended', '이미 종료된 내전입니다.'); s.status = 'ended'; s.endedAt = now(); cancelPending(s, 'manual_finish'); return '내전을 종료했습니다. 기존 음성채널은 유지됩니다.'; }
  if (action.kind === 'voiceConnect') { ensure(s.status !== 'ended', '종료된 내전입니다.'); s.waitingId = d.waitingId; s.teams.forEach(t => { if (!t.withdrawnAt) t.voiceId = d.teamIds[t.id] || null; }); return '기존 대기실과 팀 음성방을 연결했습니다.'; }
  requireRunning(s);
  if (action.kind === 'addTeam') return queueTeam(s, d);
  if (action.kind === 'cancelTeam') {
    const team = (s.pendingTeams || []).find(t => t.id === d.teamId); ensure(team, '아직 편입되지 않은 예약 팀을 선택해주세요.');
    s.pendingTeams = s.pendingTeams.filter(t => t.id !== team.id); return `TEAM ${team.no} 편입 예약을 취소했습니다.`;
  }
  if (action.kind === 'captain') {
    const t = teamById(s, d.teamId); ensure(!t.withdrawnAt && t.members.some(m => m.id === d.memberId), '현재 팀원 중 새 팀장을 선택해주세요.');
    const old = t.captainId; t.captainId = d.memberId;
    s.fixtures.filter(f => f.status === 'reported' && f.reporter === old && [f.a, f.b].includes(t.id)).forEach(f => { f.reporter = d.memberId; });
    return `TEAM ${t.no} 팀장을 변경했습니다.`;
  }
  if (action.kind === 'substitute') {
    const t = teamById(s, d.teamId), index = t.members.findIndex(m => m.id === d.outgoingId), p = s.subs.find(x => x.id === d.incomingId);
    ensure(!t.withdrawnAt && index >= 0 && p, '선수 또는 대타 정보가 변경됐습니다. 다시 선택해주세요.');
    ensure(!reserved(s, p.id), '새 팀 편입 예약 선수는 대타로 투입할 수 없습니다. 먼저 편입 예약을 취소해주세요.');
    ensure(!s.teams.some(t => t.members.some(m => m.id === p.id)), '이미 팀에 배정된 선수입니다.');
    const out = t.members[index], positions = ROLES[out.role].filter(pos => p.roles.includes(out.role) && p.positions.includes(pos));
    ensure(positions.length, '이 역할을 맡을 수 없는 대타입니다.');
    t.members[index] = { id: p.id, name: p.name, role: out.role, position: positions.includes(out.position) ? out.position : positions[0], isSub: true };
    s.subs = s.subs.filter(x => x.id !== p.id);
    if (t.captainId === out.id) { t.captainId = p.id; s.fixtures.filter(f => f.status === 'reported' && f.reporter === out.id && [f.a, f.b].includes(t.id)).forEach(f => { f.reporter = p.id; }); }
    s.substitutions.push({ teamId: t.id, outgoing: out, incoming: t.members[index], createdAt: now() });
    return `TEAM ${t.no}: ${out.name} → ${p.name}. 팀 승점과 대진은 유지됩니다.`;
  }
  if (action.kind === 'withdraw') {
    const t = teamById(s, d.teamId); ensure(!t.withdrawnAt, '이미 기권한 팀입니다.'); t.withdrawnAt = now();
    const changes = s.rosterChanges?.length || 0, round = currentRound(s); let count = 0;
    for (const f of s.fixtures) if (f.status !== 'completed' && [f.a, f.b].includes(t.id)) { complete(s, f, f.a === t.id ? f.b : f.a, 'forfeit'); count++; }
    if (Number.isFinite(round)) advance(s, round);
    return `TEAM ${t.no} 기권 처리: 미완료 ${count}경기 몰수패. 완료된 결과는 유지됩니다.` + ((s.rosterChanges?.length || 0) > changes ? '\n예약한 새 팀이 편입됐습니다. 다음 라운드 대진을 확인해주세요.' : '');
  }
  if (action.kind === 'undo') {
    const m = [...s.matches].reverse().find(x => !x.reversed); ensure(m, '취소할 결과가 없습니다.'); ensure(m.type !== 'forfeit', '기권 몰수승은 개별 취소할 수 없습니다.');
    teamById(s, m.winner).points = Math.max(0, teamById(s, m.winner).points - m.points); m.reversed = true;
    if (m.fixtureId) { const f = fixtureById(s, m.fixtureId); Object.assign(f, { status: 'pending', winner: null, reporter: null, proposed: null, matchId: null, resultType: 'played', completedAt: null }); }
    return '마지막 확정 결과와 승점을 되돌렸습니다.';
  }
  if (action.kind === 'points') { ensure(Number.isInteger(d.points) && d.points >= 0 && d.points <= 9999, '승점은 0~9999입니다.'); const t = teamById(s, d.teamId); t.points = d.points; return `TEAM ${t.no}: ${d.points}점으로 수정했습니다.`; }
  if (['report', 'confirm', 'dispute', 'resolve'].includes(action.kind)) {
    const f = activeFixture(s, d.fixtureId);
    if (action.kind !== 'resolve') captainFor(s, f, actor.id);
    if (action.kind === 'report') { ensure(f.status === 'pending', '이미 결과가 제출됐습니다. 다시 경기 종료를 눌러 확인해주세요.'); ensure([f.a, f.b].includes(d.winner), '승리 팀이 잘못되었습니다.'); f.reporter = actor.id; f.proposed = d.winner; f.reportId = d.reportId || null; f.resultAlert = null; f.status = 'reported'; return '결과를 제출했습니다. 패널 채널에서 상대 팀장을 멘션합니다. 알림 또는 공개 패널의 경기 종료 버튼에서 확인해주세요.'; }
    if (action.kind === 'confirm' || action.kind === 'dispute') {
      ensure(f.status === 'reported' && f.reporter !== actor.id, '상대 팀장이 제출한 결과만 확인할 수 있습니다.');
      ensure(!d.reportId || d.reportId === f.reportId, '다시 제출된 결과입니다. 최신 알림 또는 공개 패널의 경기 종료 버튼에서 확인해주세요.');
      if (action.kind === 'dispute') { f.status = 'disputed'; return '결과 불일치로 운영진 판정을 요청했습니다.'; }
    }
    const winner = action.kind === 'resolve' ? d.winner : f.proposed;
    const changes = s.rosterChanges?.length || 0;
    complete(s, f, winner); advance(s, f.round);
    return `TEAM ${teamById(s, winner).no} 승리 확정 (+${s.winPoints}점).` + (s.status === 'ended' ? ' 종료 기준을 달성해 내전이 자동 종료됐습니다.' : '') + ((s.rosterChanges?.length || 0) > changes ? '\n예약한 새 팀이 편입됐습니다. 다음 라운드 대진을 확인해주세요.' : '');
  }
  throw new UserError('지원하지 않는 작업입니다.');
}
export function leaders(s) { const teams = s.teams.filter(t => !t.withdrawnAt); const top = Math.max(...teams.map(t => t.points)); return teams.filter(t => t.points === top); }
export function lottery(raw, randomIndex = n => { const buf = new Uint32Array(1), limit = Math.floor(2 ** 32 / n) * n; do { crypto.getRandomValues(buf); } while (buf[0] >= limit); return buf[0] % n; }) {
  const entries = raw.split(',').map(s => s.trim()).filter(Boolean);
  ensure(entries.length >= 2 && entries.length <= 30, '쉼표로 구분한 후보를 2~30개 입력해주세요.'); ensure(entries.every(s => s.length <= 80), '후보 하나는 최대 80자입니다.');
  ensure(new Set(entries.map(s => s.toLowerCase())).size === entries.length, '중복 후보를 넣을 수 없습니다.');
  return { entries, winner: entries[randomIndex(entries.length)] };
}
