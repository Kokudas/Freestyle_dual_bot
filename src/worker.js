import { Store } from './storage.js';
import { applyAction, newScrim, ensure, UserError, currentFixtures, teamById, lottery, ROLES, availableTeamNumbers } from './domain.js';
import { message, note, defer, modal, setupView, registrationView, subView, publicPanel, adminPanel, flowView, esc, cut } from './ui.js';
import { api, replyJob, DiscordError, describeDiscordError, diagnosePanelAccess, discoverVoice, voiceTargets, moveVoiceChunk } from './discord.js';

const encoder = new TextEncoder();
const hex = s => Uint8Array.from(s.match(/../g) || [], v => Number.parseInt(v, 16));
export async function verifySignature(request, body, publicKey) {
  const stamp = request.headers.get('x-signature-timestamp') || '', signature = request.headers.get('x-signature-ed25519') || '';
  if (!/^[a-f\d]{64}$/i.test(publicKey || '') || !/^[a-f\d]{128}$/i.test(signature) || !/^\d{10,11}$/.test(stamp) || Math.abs(Date.now() / 1000 - Number(stamp)) > 300) return false;
  try { const key = await crypto.subtle.importKey('raw', hex(publicKey), { name: 'Ed25519' }, false, ['verify']); return await crypto.subtle.verify('Ed25519', key, hex(signature), encoder.encode(stamp + body)); } catch { return false; }
}
export function actorOf(i, env) {
  const user = i.member?.user || i.user;
  ensure(i.guild_id && user, '이 기능은 Discord 서버에서 사용해주세요.');
  const roles = String(env.ADMIN_ROLE_ID || '').split(',').map(s => s.trim()).filter(Boolean);
  let permissions = 0n; try { permissions = BigInt(i.member?.permissions || '0'); } catch { /* deny by default */ }
  return { id: user.id, name: i.member?.nick || user.global_name || user.username, manager: Boolean(permissions & (8n | 16n | 32n)) || (i.member?.roles || []).some(id => roles.includes(id)) };
}
function requireManager(actor) { ensure(actor.manager, '내전 운영진만 사용할 수 있습니다.'); }
const number = (s, min, max) => { ensure(/^\d+$/.test(String(s)), `${min}~${max} 사이의 숫자를 입력해주세요.`); const n = Number(s); ensure(Number.isInteger(n) && n >= min && n <= max, `${min}~${max} 사이의 숫자를 입력해주세요.`); return n; };
const formValue = i => i.data.components?.flatMap(c => c.components || []).find(c => c.custom_id === 'value')?.value || '';
const dataOptions = i => Object.fromEntries((i.data.options || []).map(o => [o.name, o.value]));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function signInternal(env, text) { const key = await crypto.subtle.importKey('raw', encoder.encode(env.DISCORD_TOKEN), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(text))); }
async function nudge(env, task) {
  if (!env.WORKER_URL) return;
  const body = JSON.stringify({ ...task, timestamp: Date.now() }), signature = [...await signInternal(env, body)].map(n => n.toString(16).padStart(2, '0')).join('');
  // This endpoint only acknowledges; the next invocation gets its own subrequest budget.
  const r = await fetch(`${env.WORKER_URL.replace(/\/$/, '')}/_run`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-task-signature': signature }, body });
  if (!r.ok) throw new Error('Background wake-up failed');
}
async function validInternal(env, body, header) {
  if (!/^[a-f\d]{64}$/i.test(header || '')) return false;
  try { const d = JSON.parse(body); if (Math.abs(Date.now() - d.timestamp) > 60_000) return false; const key = await crypto.subtle.importKey('raw', encoder.encode(env.DISCORD_TOKEN), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']); return await crypto.subtle.verify('HMAC', key, hex(header), encoder.encode(body)); } catch { return false; }
}
const needsNewPanel = s => !s.panel?.messageId || !s.panel?.channelId || ['undefined', 'null'].includes(String(s.panel.channelId)) || s.panel.deleted || s.panelError?.includes('10003');
export async function flushPanel(env, store, id, guildId, force = false, publication = null) {
  const lease = await store.claimPanel(id, force); if (!lease) return { pending: true };
  let revision = -1, succeeded = false, snapshot;
  try {
    const row = await store.get(id, guildId), s = row.value; snapshot = s; revision = row.revision;
    if (!s.panel || s.panel.deleted) { succeeded = true; return { missing: true }; }
    // A competing repair must not turn its own response into a second roster.
    if (publication && s.panel.publicationJob !== publication.id) return { superseded: true };
    ensure(s.panel.channelId && !['undefined', 'null'].includes(String(s.panel.channelId)), '공개 패널을 보낼 채널 ID가 저장되지 않았습니다. 현재 텍스트 채널에서 /내전관리 → 패널 복구를 눌러주세요.');
    const body = publicPanel(s);
    if (s.panel.messageId) {
      try { await api(env, `/channels/${s.panel.channelId}/messages/${s.panel.messageId}`, { method: 'PATCH', body }); }
      catch (e) {
        if (e.code === 10008) await store.mutate(id, guildId, `panel-missing:${lease}`, state => { if (state.panel?.messageId === s.panel.messageId) state.panel.deleted = true; return '패널이 삭제되어 복구가 필요합니다.'; }, { dirty: false });
        throw e;
      }
    } else {
      // Cron cannot create an interaction response: its short-lived token belongs
      // to the durable job. Never fall back to the failing channel-message POST.
      if (s.panel.transport === 'interaction' && !publication) return { pending: true };
      const sent = s.panel.transport === 'interaction'
        ? await api(env, `/webhooks/${publication.data.applicationId}/${publication.data.token}/messages/@original`, { method: 'PATCH', token: false, body: { content: null, ...body } })
        : await api(env, `/channels/${s.panel.channelId}/messages`, { method: 'POST', body: { ...body, nonce: (s.panel.nonce || s.id).slice(-25), enforce_nonce: true } });
      ensure(sent?.id, 'Discord가 공개 패널 메시지 ID를 반환하지 않았습니다. 패널 복구를 다시 눌러주세요.');
      const written = await store.mutate(id, guildId, `panel:${sent.id}`, state => {
        // A repair may have superseded this send while Discord was responding.
        if (publication && state.panel?.publicationJob !== publication.id) return '다른 패널 복구가 진행 중입니다.';
        state.panel.messageId ||= sent.id; return '패널 연결';
      }, { dirty: false });
      // Record the new panel id, then render a newer snapshot if a signup arrived meanwhile.
      const fresh = await store.get(id, guildId); revision = fresh.revision;
      if (publication && fresh.value.panel?.publicationJob !== publication.id) {
        await replyJob(env, publication, '다른 운영진이 공개 패널을 복구하고 있습니다. 채널의 최신 패널을 사용해주세요.');
        return { superseded: true };
      }
      if (fresh.revision > row.revision + (written.replay ? 0 : 1)) {
        await api(env, `/channels/${fresh.value.panel.channelId}/messages/${sent.id}`, { method: 'PATCH', body: publicPanel(fresh.value) });
      }
    }
    if (s.panelError) {
      await store.mutate(id, guildId, `panel-ok:${lease}`, state => { state.panelError = null; return '공개 패널 정상'; }, { dirty: false });
      const fresh = await store.get(id, guildId);
      // Only absorb our own error-clear write; keep concurrent signups dirty.
      if (fresh.revision === revision + 1) revision = fresh.revision;
    }
    succeeded = true;
    return { published: true };
  } catch (e) {
    if (snapshot) {
      const reason = e instanceof UserError ? e.message : describeDiscordError(e);
      if (snapshot.panelError !== reason) await store.mutate(id, guildId, `panel-error:${lease}`, state => { if (state.panel?.channelId === snapshot.panel?.channelId) state.panelError = reason; return '공개 패널 전송 실패'; }, { dirty: false }).catch(() => {});
      console.error('Public panel delivery failed', id, e.status || e.name, e.code || '');
    }
    throw e;
  } finally { await store.releasePanel(id, lease, revision, succeeded); }
}
async function queue(i, env, store, actor, kind, data, scrimId, ctx) {
  const publicReply = kind === 'create' || (kind === 'repairPanel' && needsNewPanel((await store.get(scrimId, i.guild_id)).value));
  const update = !publicReply && Boolean(i.message?.flags & 64) && [3, 5].includes(i.type);
  const replyView = update && String(i.data.custom_id || '').startsWith('a:') ? 'admin' : null;
  const id = await store.enqueue(i, actor, kind, data, scrimId, { publicReply, replyView });
  ctx.waitUntil(runJob(env, id).catch(() => console.error('Job dispatch failed; scheduled retry retained.')));
  return defer(!publicReply, update);
}
async function jobNotice(env, store, job, content) {
  // Once the original response IS the public panel, a status notice would erase it.
  if (job.data.publicReply && job.data.scrimId) {
    const { value: s } = await store.get(job.data.scrimId, job.guild_id);
    if (s.panel?.publicationJob === job.id && s.panel?.messageId) return;
  }
  const view = job.data.replyView === 'admin' && job.data.actor.manager && job.data.scrimId ? adminPanel((await store.get(job.data.scrimId, job.guild_id)).value) : null;
  await replyJob(env, job, content, view);
}
async function showFlow(store, s, actor, data, update = false) { const w = await store.wizard(actor.id, s.guildId, { sid: s.id, ...data }); return message(flowView(s, w), update); }
export async function routeInteraction(i, env, store, ctx) {
  if (i.type === 1) return { type: 1 };
  const actor = actorOf(i, env);
  if (i.type === 2) {
    const options = dataOptions(i);
    if (i.data.name === '제비뽑기') {
      await store.cooldown(`lottery:${actor.id}`, 3);
      const result = lottery(String(options['후보'] || ''));
      return { type: 4, data: { content: `🎟️ 후보 ${result.entries.length}개: ${cut(result.entries.map(esc).join(', '), 1600)}\n🎉 결과: **${esc(result.winner)}**`, allowed_mentions: { parse: [] } } };
    }
    if (i.data.name === '내전열기') {
      requireManager(actor); ensure(!await store.active(i.guild_id), '이미 진행 중인 내전이 있습니다.');
      const d = { kind: 'setup', title: String(options['제목'] || '프리스타일 리부트 클럽 내전').slice(0, 100), winPoints: options['승리승점'] ?? 1, mode: options['편성모드'] || null, endMode: options['종료방식'] || null, target: options['목표값'] ?? null, leagueRepeats: options['풀리그횟수'] ?? null };
      ensure(d.endMode || d.target == null, '목표값을 지정하려면 종료방식도 선택해주세요.');
      ensure(d.endMode !== 'round_robin' || d.target == null, '1회 풀리그에는 목표값이 필요하지 않습니다.');
      ensure(!d.endMode || d.endMode === 'round_robin' || d.leagueRepeats == null, '풀리그횟수는 풀리그 종료 방식에서만 지정해주세요.');
      if (d.mode && d.endMode && (d.endMode === 'round_robin' ? d.leagueRepeats != null : d.target != null)) { newScrim('check', i.guild_id, d); return queue(i, env, store, actor, 'create', d, null, ctx); }
      const w = await store.wizard(actor.id, i.guild_id, d);
      if (d.mode && d.endMode && d.endMode !== 'round_robin' && d.target == null) return modal(`w:${w.id}:target`, '목표값 설정', '전체 최대 판수 또는 목표 승점', '', '예: 20');
      return message(setupView(w));
    }
    const row = await store.active(i.guild_id); ensure(row, '현재 진행 중인 내전이 없습니다.');
    if (i.data.name === '내전관리') { requireManager(actor); return message(adminPanel(row.value)); }
    if (i.data.name === '내전상태') return message(publicPanel(row.value));
    throw new UserError('등록되지 않은 명령어입니다. 명령어 등록 스크립트를 다시 실행해주세요.');
  }
  const parts = String(i.data.custom_id || '').split(':'), [scope, id, op, arg] = parts;
  if (scope === 'p' || scope === 'a') {
    const s = (await store.get(id, i.guild_id)).value;
    if (scope === 'a') {
      requireManager(actor);
      if (['draft', 'finalize', 'voiceConnect', 'voiceTeams', 'voiceRoles', 'voiceWaiting', 'refresh', 'repairPanel'].includes(op)) return queue(i, env, store, actor, op, {}, s.id, ctx);
      ensure(s.status !== 'ended', '종료된 내전입니다.');
      if (['finish', 'undo'].includes(op)) return showFlow(store, s, actor, { kind: 'confirm', op, label: op === 'finish' ? '내전 종료 (음성채널은 유지)' : '마지막 결과와 승점 취소' }, Boolean(i.message?.flags & 64));
      if (['substitute', 'captain', 'withdraw', 'points', 'fixtures', 'addTeam', 'cancelTeam'].includes(op)) { ensure(s.status === 'running', '편성 확정 후 사용할 수 있습니다.');
        if (op === 'addTeam') ensure(availableTeamNumbers(s).length, '최대 20팀까지 편입할 수 있습니다.');
        if (op === 'cancelTeam') ensure(s.pendingTeams?.length, '편입 대기 팀이 없습니다.');
        return showFlow(store, s, actor, { kind: 'flow', op, ...(op === 'addTeam' ? { teamNo: availableTeamNumbers(s)[0], members: [], captainId: null } : {}) }, Boolean(i.message?.flags & 64)); }
    } else {
      ensure(s.status !== 'ended', '종료된 내전입니다.');
      if (op === 'join') {
        ensure(s.status === 'recruiting', '모집이 끝났습니다.');
        const p = s.participants.find(p => p.id === actor.id) || { primaryRole: null, primaryPosition: null, secondaryRole: null, secondaryPosition: null, captain: false, teamNo: null, fixedRole: null };
        const w = await store.wizard(actor.id, s.guildId, { kind: 'register', sid: s.id, p: structuredClone(p), useSecondary: Boolean(p.fixedRole && p.fixedRole === p.secondaryRole) });
        return message(registrationView(s, w));
      }
      if (op === 'sub') { const p = s.subs.find(p => p.id === actor.id); const w = await store.wizard(actor.id, s.guildId, { kind: 'sub', sid: s.id, roles: p?.roles || [], positions: p?.positions || [] }); return message(subView(w)); }
      if (op === 'cancel') return showFlow(store, s, actor, { kind: 'confirm', op: 'cancel', label: '본인의 참가 신청 취소' });
      if (op === 'info') {
        const t = s.teams.find(t => t.members.some(m => m.id === actor.id)), p = s.participants.find(p => p.id === actor.id), sub = s.subs.find(p => p.id === actor.id);
        const pending = (s.pendingTeams || []).find(t => t.members.some(m => m.id === actor.id));
        if (pending) return note(`TEAM ${pending.no} · 편입 대기\nROUND ${pending.activateAfterRound} 종료 후 합류 예정${pending.captainId === actor.id ? ' · 팀장 👑' : ''}`);
        if (t) { const m = t.members.find(m => m.id === actor.id); return note(`TEAM ${t.no} · ${m.role}/${m.position}${t.captainId === actor.id ? ' · 팀장 👑' : ''}`); }
        return note(sub ? `대기/대타 · ${sub.roles.join('/')} · ${sub.positions.join('/')}` : p ? `${p.primaryRole}/${p.primaryPosition}\n보조 ${p.secondaryRole || '없음'}/${p.secondaryPosition || ''}\n${p.teamNo ? `TEAM ${p.teamNo} · ${p.fixedRole}` : '랜덤 배정'}` : '등록된 참가 정보가 없습니다.');
      }
      if (op === 'result') {
        ensure(s.status === 'running', '진행 중인 내전이 아닙니다.');
        const t = s.teams.find(t => t.captainId === actor.id && !t.withdrawnAt); ensure(t, '현재 팀장만 결과를 처리할 수 있습니다.');
        const f = currentFixtures(s).find(f => [f.a, f.b].includes(t.id)); ensure(f, '이번 라운드는 휴식이거나 진행할 경기가 없습니다.'); ensure(f.status !== 'completed', '이번 라운드의 결과는 이미 확정됐습니다.');
        return showFlow(store, s, actor, { kind: 'result', fixtureId: f.id, manager: false });
      }
    }
    throw new UserError('지원하지 않는 버튼입니다.');
  }
  ensure(scope === 'w', '이전 버전 패널입니다. /내전관리 또는 새 모집 패널을 사용해주세요.');
  const w = await store.getWizard(id, actor.id, i.guild_id), d = w.data;
  const admin = d.kind === 'setup' || d.kind === 'flow' || (d.kind === 'confirm' && d.op !== 'cancel') || (d.kind === 'result' && d.manager);
  if (admin) requireManager(actor);
  if (op === 'close') return message({ content: '입력을 취소했습니다.', embeds: [], components: [] }, true);
  if (d.kind === 'setup') {
    if (op === 'mode') { ensure(['random', 'manual'].includes(arg), '편성 모드를 확인해주세요.'); d.mode = arg; await store.saveWizard(w);
      if (!d.endMode) return message(setupView(w), true);
      if (d.endMode !== 'round_robin' && d.target == null) return modal(`w:${w.id}:target`, '목표값 설정', '전체 최대 판수 또는 목표 승점');
    } else if (op === 'end') { ensure(d.mode && ['round_robin', 'match_limit', 'points_target'].includes(arg), '종료 방식을 확인해주세요.'); d.endMode = arg; await store.saveWizard(w); if (arg !== 'round_robin') return modal(`w:${w.id}:target`, '목표값 설정', '전체 최대 판수 또는 목표 승점');
    } else if (op === 'target') { d.target = number(formValue(i), 1, 999); await store.saveWizard(w); }
    else if (op === 'repeats') { ensure(d.endMode === 'round_robin', '풀리그를 먼저 선택해주세요.'); d.leagueRepeats = number(i.data.values?.[0], 1, 10); await store.saveWizard(w); }
    else throw new UserError('설정 화면을 다시 열어주세요.');
    if (d.endMode === 'round_robin' && d.leagueRepeats == null) return message(setupView(w), true);
    if (d.endMode !== 'round_robin') d.leagueRepeats = null;
    newScrim('check', i.guild_id, d); return queue(i, env, store, actor, 'create', d, null, ctx);
  }
  const s = (await store.get(d.sid, i.guild_id)).value;
  if (d.kind === 'register') {
    ensure(s.status === 'recruiting', '모집이 끝났습니다.'); const p = d.p;
    if (op === 'submit') { const probe = structuredClone(s); applyAction(probe, { kind: 'register', data: p }, actor); return queue(i, env, store, actor, 'register', p, s.id, ctx); }
    if (op === 'primary') [p.primaryRole, p.primaryPosition] = i.data.values[0].split('|');
    else if (op === 'secondary') { if (i.data.values[0] === 'NONE') { p.secondaryRole = p.secondaryPosition = null; d.useSecondary = false; } else [p.secondaryRole, p.secondaryPosition] = i.data.values[0].split('|'); }
    else if (op === 'team') { ensure(s.mode !== 'random', '랜덤 모드에는 팀 선택이 없습니다.'); const v = i.data.values[0]; ensure(v !== 'NONE', '빈자리가 없습니다.'); p.teamNo = v === 'RANDOM' && s.mode === 'legacy_mixed' ? null : number(v, 1, 20); }
    else if (op === 'captain') p.captain = !p.captain;
    else if (op === 'fixed') { ensure(s.mode !== 'random' && p.secondaryRole, '보조 역할을 먼저 선택해주세요.'); d.useSecondary = !d.useSecondary; }
    else throw new UserError('지원하지 않는 입력입니다.');
    p.fixedRole = p.teamNo ? (d.useSecondary ? p.secondaryRole : p.primaryRole) : null;
    await store.saveWizard(w); return message(registrationView(s, w), true);
  }
  if (d.kind === 'sub') {
    if (op === 'submit') { const probe = structuredClone(s); applyAction(probe, { kind: 'subregister', data: d }, actor); return queue(i, env, store, actor, 'subregister', { roles: d.roles, positions: d.positions }, s.id, ctx); }
    if (op === 'roles') d.roles = i.data.values; else if (op === 'positions') d.positions = i.data.values; else throw new UserError('입력을 확인해주세요.');
    await store.saveWizard(w); return message(subView(w), true);
  }
  if (d.kind === 'confirm') { ensure(op === 'submit', '확정 버튼을 눌러주세요.'); return queue(i, env, store, actor, d.op, {}, s.id, ctx); }
  if (d.kind === 'result') {
    const kind = op === 'winner' ? d.manager ? 'resolve' : 'report' : op === 'accept' ? 'confirm' : op === 'dispute' ? 'dispute' : null;
    ensure(kind, '결과를 다시 선택해주세요.'); return queue(i, env, store, actor, kind, { fixtureId: d.fixtureId, winner: arg }, s.id, ctx);
  }
  if (d.kind === 'flow') {
    if (d.op === 'addTeam') {
      ensure(s.status === 'running', '진행 중인 내전에서만 편입할 수 있습니다.');
      d.members ||= [];
      if (op === 'submit') { const data = { teamNo: d.teamNo, members: d.members, captainId: d.captainId }; const probe = structuredClone(s); applyAction(probe, { kind: 'addTeam', data }, actor); return queue(i, env, store, actor, 'addTeam', data, s.id, ctx); }
      if (op === 'newnumber') { const no = number(i.data.values?.[0], 1, 20); ensure(availableTeamNumbers(s).includes(no), '해당 팀 번호는 이미 사용 중입니다.'); d.teamNo = no; }
      else if (op === 'newplayer') {
        ensure(Object.hasOwn(ROLES, arg), '역할을 확인해주세요.'); const uid = i.data.values?.[0], user = i.data.resolved?.users?.[uid], member = i.data.resolved?.members?.[uid];
        ensure(user?.id === uid && member && !user.bot, '이 서버의 일반 회원을 선택해주세요.');
        ensure(!d.members.some(m => m.id === uid && m.role !== arg), '서로 다른 선수 3명을 선택해주세요.');
        d.members = d.members.filter(m => m.role !== arg); d.members.push({ id: uid, name: String(member.nick || user.global_name || user.username || uid).slice(0, 100), role: arg, position: null }); d.captainId = null;
      } else if (op === 'newnext') { ensure(d.teamNo && d.members.length === 3, '팀 번호와 선수 3명을 선택해주세요.'); d.positions = true; }
      else if (op === 'newback') d.positions = false;
      else if (op === 'newposition') { const m = d.members.find(m => m.role === arg), pos = i.data.values?.[0]; ensure(m && ROLES[arg]?.includes(pos), '해당 역할의 포지션을 선택해주세요.'); m.position = pos; }
      else if (op === 'newcaptain') { ensure(d.members.some(m => m.id === i.data.values?.[0]), '팀원 중 팀장을 선택해주세요.'); d.captainId = i.data.values[0]; }
      else throw new UserError('편입 설정 화면을 다시 열어주세요.');
      await store.saveWizard(w); return message(flowView(s, w), true);
    }
    if (d.op === 'cancelTeam') {
      if (op === 'pendingteam') { ensure(s.pendingTeams?.some(t => t.id === i.data.values?.[0]), '편입 대기 팀을 선택해주세요.'); d.teamId = i.data.values[0]; await store.saveWizard(w); return message(flowView(s, w), true); }
      ensure(op === 'submit' && d.teamId, '취소할 편입 대기 팀을 선택해주세요.'); return queue(i, env, store, actor, 'cancelTeam', { teamId: d.teamId }, s.id, ctx);
    }
    if (op === 'pickteam') { teamById(s, i.data.values[0]); d.teamId = i.data.values[0];
      if (d.op === 'points') { await store.saveWizard(w); return modal(`w:${w.id}:pointsvalue`, '팀 승점 수정', '새 승점 (0~9999)', String(teamById(s, d.teamId).points)); }
    } else if (op === 'member') d.memberId = i.data.values[0];
    else if (op === 'outgoing') d.outgoingId = i.data.values[0];
    else if (op === 'incoming') d.incomingId = i.data.values[0];
    else if (op === 'fixture') { d.kind = 'result'; d.manager = true; d.fixtureId = i.data.values[0]; }
    else if (op === 'pointsvalue' && d.op === 'points') return queue(i, env, store, actor, 'points', { teamId: d.teamId, points: number(formValue(i), 0, 9999) }, s.id, ctx);
    else if (op === 'submit') { ensure(['captain', 'withdraw', 'substitute'].includes(d.op), '작업을 다시 선택해주세요.'); return queue(i, env, store, actor, d.op, d, s.id, ctx); }
    else throw new UserError('설정 내용을 다시 확인해주세요.');
    await store.saveWizard(w); return message(flowView(s, w), true);
  }
  throw new UserError('만료된 화면입니다. 다시 실행해주세요.');
}
export async function runJob(env, id) {
  const store = new Store(env.DB), job = await store.claimJob(id); if (!job) return;
  const p = job.data;
  try {
    let s, notice = p.notice || '';
    if (p.kind === 'create') {
      requireManager(p.actor); s = newScrim(`w${id}`, job.guild_id, p.data); s.panel = { channelId: p.channelId, messageId: null, ...(p.publicReply ? { transport: 'interaction', publicationJob: id } : {}) };
      await store.create(s); p.scrimId = s.id; s = (await store.get(s.id, job.guild_id)).value; notice = '내전 모집을 시작했습니다.';
    } else if (p.kind === 'refresh') { requireManager(p.actor); await store.markDirty(p.scrimId, job.guild_id); s = (await store.get(p.scrimId, job.guild_id)).value; notice = '공개 현황을 갱신합니다.'; }
    else if (p.kind === 'repairPanel') {
      requireManager(p.actor);
      const result = await store.mutate(p.scrimId, job.guild_id, id, state => {
        ensure(state.status !== 'ended', '종료된 내전입니다.');
        if (needsNewPanel(state)) state.panel = { channelId: p.channelId, messageId: null, nonce: id, ...(p.publicReply ? { transport: 'interaction', publicationJob: id } : {}) };
        return '기존 내전의 공개 패널을 복구합니다.';
      });
      s = result.state; notice = result.result;
    }
    else if (['voiceTeams', 'voiceRoles', 'voiceWaiting'].includes(p.kind)) { requireManager(p.actor); s = (await store.get(p.scrimId, job.guild_id)).value; ensure(s.status !== 'ended', '종료된 내전입니다.'); }
    else {
      if (!['register', 'subregister', 'cancel', 'report', 'confirm', 'dispute'].includes(p.kind)) requireManager(p.actor);
      let data = p.data;
      if (p.kind === 'voiceConnect') { s = (await store.get(p.scrimId, job.guild_id)).value; const voice = await discoverVoice(env, s); ensure(voice.waitingId && !voice.missing.length, '대기실 또는 팀 음성방이 없습니다: ' + voice.missing.join(', ')); data = voice; }
      const result = await store.mutate(p.scrimId, job.guild_id, id, state => {
        const changes = state.rosterChanges?.length || 0;
        const result = applyAction(state, { kind: p.kind, data }, p.actor);
        if ((state.rosterChanges?.length || 0) > changes) state.rosterChanges.at(-1).operationId = id;
        return result;
      }); s = result.state; notice = result.result;
    }
    if (p.kind === 'finalize' || (s?.status === 'running' && s.rosterChanges?.some(change => change.operationId === id) && s.teams.some(t => t.joinedAt && !t.voiceId))) {
      try {
        const voice = await discoverVoice(env, s);
        ensure(voice.waitingId && !voice.missing.length, '대기실 또는 일부 팀 음성방을 찾을 수 없습니다.');
        const linked = await store.mutate(s.id, s.guildId, `${id}:auto-voice`, state => applyAction(state, { kind: 'voiceConnect', data: voice }, p.actor));
        s = linked.state; notice += '\n기존 음성방을 자동 연결했습니다. 팀별 이동 버튼을 사용할 수 있습니다.';
      } catch (e) {
        if (!(e instanceof UserError) && !(e instanceof DiscordError && [400, 403, 404].includes(e.status))) throw e;
        notice += '\n⚠️ 팀 편성은 반영됐지만 음성방 연결이 필요합니다. 채널 이름·권한 확인 후 채널 연결을 눌러주세요.';
      }
    }
    if (['voiceTeams', 'voiceRoles', 'voiceWaiting', 'substitute'].includes(p.kind)) {
      // Store per-chunk progress. If the runtime stops, Cron resumes from this cursor.
      if (!p.voice) p.voice = { targets: await voiceTargets(env, s, p.kind === 'substitute' ? 'subVoice' : p.kind, p.data), index: 0, moved: 0, skipped: 0, failed: 0 };
      p.notice = notice;
      const finished = await moveVoiceChunk(env, job.guild_id, p.voice);
      if (!finished) { await store.checkpoint(job, p); await jobNotice(env, store, job, `🎤 이동 처리 중 (${p.voice.index}/${p.voice.targets.length})`); await nudge(env, { kind: 'job', id }).catch(() => {}); return; }
      notice = `${notice ? notice + '\n' : ''}🎤 이동 ${p.voice.moved}명 · 미접속/조건 제외/이미 도착 ${p.voice.skipped}명 · 권한 등 실패 ${p.voice.failed}명`;
    }
    // Publication is a separate outcome: saved scrims/results must not be reported as lost.
    const needsPublication = ['create', 'refresh', 'repairPanel'].includes(p.kind);
    if (p.publicReply && s) {
      await wait(650);
      const result = await flushPanel(env, store, s.id, s.guildId, true, job);
      if (result?.pending) throw new Error('Public panel publication is busy; retry the durable job');
      if (result?.superseded || result?.missing) await jobNotice(env, store, job, '공개 패널의 연결 상태가 변경됐습니다. /내전관리에서 최신 패널을 확인해주세요.');
      await store.finishJob(job);
      return;
    }
    if (needsPublication && s) {
      try {
        await wait(650);
        const result = await flushPanel(env, store, s.id, s.guildId);
        notice += result?.published ? '\n공개 패널을 채널에 게시했습니다.' : result?.missing ? '\n⚠️ 공개 패널이 없습니다. /내전관리 → 패널 복구를 눌러주세요.' : '\n공개 패널 갱신을 처리 중입니다. 잠시 후 채널을 확인해주세요.';
      } catch (e) {
        const reason = p.kind === 'repairPanel' ? await diagnosePanelAccess(env, s, e) : e instanceof UserError ? e.message : describeDiscordError(e);
        if (p.kind === 'repairPanel') await store.mutate(s.id, s.guildId, `diagnostic:${id}`, state => { state.panelError = reason; return '연결 점검 완료'; }, { dirty: false });
        notice = `내전 데이터는 저장되어 있습니다. 공개 패널 전송에 실패했습니다.\n${reason}\n점검 후 패널 복구를 다시 눌러주세요. 새 내전을 다시 열거나 DB를 초기화할 필요는 없습니다.`;
        await jobNotice(env, store, job, `⚠️ ${notice}`); await store.finishJob(job); return;
      }
    }
    if (s && !needsPublication) {
      // Background panel errors cannot overwrite a successfully saved operation.
      try { await wait(650); await flushPanel(env, store, s.id, s.guildId); const fresh = await store.get(s.id, s.guildId); if (fresh.dirty_at != null) await nudge(env, { kind: 'panel', id: s.id, guildId: s.guildId }).catch(() => {}); }
      catch { notice += '\n⚠️ 저장은 완료됐지만 공개 현황 갱신이 지연되고 있습니다. 운영진이 관리창에서 확인할 수 있습니다.'; }
    }
    await jobNotice(env, store, job, `✅ ${notice}`);
    await store.finishJob(job);
  } catch (e) {
    if (e instanceof UserError || (e instanceof DiscordError && [400, 401, 403, 404].includes(e.status))) {
      const reason = e instanceof UserError ? e.message : describeDiscordError(e);
      await jobNotice(env, store, job, `⚠️ ${reason}${p.publicReply ? '\n내전 데이터는 유지됩니다. /내전관리 → 패널 복구를 눌러주세요.' : ''}`).catch(() => {}); await store.finishJob(job, 'failed', reason);
    } else if (job.attempts >= 8 || Date.now() - job.created_at > 12 * 60_000) {
      await jobNotice(env, store, job, '⚠️ 일시 오류가 반복됐습니다. /내전상태로 반영 여부를 확인하고 다시 시도해주세요.').catch(() => {});
      await store.finishJob(job, 'failed', 'Repeated transient failure'); console.error('Background job failed', job.id, e.status || e.name);
    } else {
      await store.checkpoint(job, p, Math.min(Math.max(e.retryAfter || 3000, 1000), 120_000));
      console.error('Background job deferred for retry', job.id, e.status || e.name);
    }
  }
}
async function scheduled(env) {
  const store = new Store(env.DB);
  const jobs = await store.dueJobs();
  // Fan out jobs into separate HTTP invocations instead of one 50-subrequest budget.
  if (env.WORKER_URL) { for (const job of jobs) await nudge(env, { kind: 'job', id: job.id }).catch(() => {}); }
  else if (jobs[0]) await runJob(env, jobs[0].id);
  const panels = await store.dirtyPanels();
  if (env.WORKER_URL) { for (const panel of panels) await nudge(env, { kind: 'panel', id: panel.id, guildId: panel.guild_id }).catch(() => {}); }
  else if (panels[0]) await flushPanel(env, store, panels[0].id, panels[0].guild_id);
  const minutes = Number(env.ENDED_PANEL_DELETE_MINUTES ?? 60);
  if (minutes > 0) for (const row of await store.endedPanels(new Date(Date.now() - minutes * 60_000).toISOString())) {
    const s = JSON.parse(row.state);
    try { await api(env, `/channels/${s.panel.channelId}/messages/${s.panel.messageId}`, { method: 'DELETE' }); }
    catch (e) { if (e.status !== 404) continue; }
    await store.mutate(s.id, s.guildId, `cleanup:${s.panel.messageId}`, state => { state.panel = null; return '종료 패널 삭제'; }, { dirty: false });
  }
  await store.cleanup();
}
export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path === '/health' && request.method === 'GET') return Response.json({ ok: true, version: '2.1.0' });
    if (request.method !== 'POST') return new Response('Not found', { status: 404 });
    const text = await request.text(); if (text.length > 65_536) return new Response('Too large', { status: 413 });
    if (path === '/_run') {
      if (!await validInternal(env, text, request.headers.get('x-task-signature'))) return new Response('Unauthorized', { status: 401 });
      const task = JSON.parse(text);
      ctx.waitUntil((async () => { if (task.kind === 'job') await runJob(env, task.id); else if (task.kind === 'panel') { await wait(650); await flushPanel(env, new Store(env.DB), task.id, task.guildId); } })().catch(() => console.error('Internal task retained for scheduled recovery.')));
      return new Response(null, { status: 202 });
    }
    if (path !== '/interactions') return new Response('Not found', { status: 404 });
    if (!await verifySignature(request, text, env.DISCORD_PUBLIC_KEY)) return new Response('Invalid signature', { status: 401 });
    let interaction; try { interaction = JSON.parse(text); } catch { return new Response('Invalid JSON', { status: 400 }); }
    if (interaction.application_id && interaction.application_id !== env.APPLICATION_ID) return new Response('Invalid application', { status: 401 });
    try { return Response.json(await routeInteraction(interaction, env, new Store(env.DB), ctx)); }
    catch (e) { if (!(e instanceof UserError)) console.error('Interaction failed', e.name); return Response.json(note(`⚠️ ${e instanceof UserError ? e.message : '일시 오류입니다. 잠시 후 다시 눌러주세요.'}`)); }
  },
  scheduled(event, env, ctx) { ctx.waitUntil(scheduled(env)); },
};
