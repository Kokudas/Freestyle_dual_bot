import { UserError } from './domain.js';
export const DISCORD_USER_AGENT = 'DiscordBot (https://developers.cloudflare.com/workers/, 2.0.5) FSR-Scrim-Workers';
export function botToken(env) {
  let value = String(env.DISCORD_TOKEN || '').trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1).trim();
  value = value.replace(/^Bot\s+/i, '').trim();
  if (!value || !/^[A-Za-z\d._-]+$/.test(value)) throw new UserError('DISCORD_TOKEN이 비어 있거나 형식이 올바르지 않습니다. Cloudflare Secret에 봇 토큰 값만 입력해주세요. 실제 토큰을 채팅에 올리지 마세요.');
  return value;
}
export class DiscordError extends Error {
  constructor(status, retryAfter = 0, data = {}, scope = 'bot', diagnostic = {}) {
    super(`Discord API ${status}`); this.status = status; this.retryAfter = retryAfter;
    this.code = Number.isInteger(data?.code) ? data.code : /^\d{1,8}$/.test(String(data?.code)) ? Number(data.code) : null; this.scope = scope;
    this.responseType = diagnostic.responseType || null;
    this.edgeCode = diagnostic.edgeCode || null;
    this.requestKind = diagnostic.requestKind || null;
    this.requestFormat = diagnostic.requestFormat || null;
    // Keep field names only. Discord's raw error text may contain submitted values.
    this.fields = [];
    const visit = (node, path = '') => {
      if (!node || typeof node !== 'object' || this.fields.length >= 5) return;
      if (Array.isArray(node._errors) && path) this.fields.push(path.slice(0, 100));
      for (const [key, value] of Object.entries(node)) if (key !== '_errors') visit(value, [path, key.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40)].filter(Boolean).join('.'));
    };
    visit(data?.errors);
  }
}
export function describeDiscordError(e) {
  if (!(e instanceof DiscordError)) return '일시적인 통신 오류입니다. 잠시 후 다시 시도해주세요.';
  const code = `HTTP ${e.status}${e.code == null ? '' : ` / ${e.code}`}${e.edgeCode ? ` · edge ${e.edgeCode}` : ''}${e.responseType && e.code == null ? ` · 응답 ${e.responseType}` : ''}${e.requestKind ? ` · ${e.requestKind}` : ''}${e.requestFormat ? ` · ${e.requestFormat}` : ''}`;
  let reason;
  if (e.status === 401) reason = e.scope === 'bot' ? 'Cloudflare의 DISCORD_TOKEN이 유효하지 않습니다. 현재 앱의 새 봇 토큰으로 교체해주세요.' : '결과 안내의 유효시간이 지났습니다. /내전상태로 반영 여부를 확인해주세요.';
  else if (e.code === 50001) reason = '봇이 이 서버에 설치되어 있는지와 해당 채널의 채널 보기 권한을 확인해주세요.';
  else if (e.status === 403 || e.code === 50013) reason = '봇의 채널 보기·메시지 보내기·링크 첨부 권한과 채널별 거부 설정을 확인해주세요. 스레드는 스레드 메시지 보내기도 필요합니다.';
  else if (e.code === 10003) reason = '대상 채널을 찾을 수 없습니다. 현재 채팅 채널에서 패널 복구를 눌러주세요.';
  else if (e.code === 10008) reason = '기존 공개 패널 메시지가 삭제됐습니다. /내전관리 → 패널 복구를 눌러주세요.';
  else if (e.code === 50005) reason = '현재 토큰의 봇이 기존 패널의 작성자와 다릅니다. 같은 Discord 앱의 토큰인지 확인해주세요.';
  else if (e.code === 50035) reason = `공개 패널의 전송 형식이 Discord 검증을 통과하지 못했습니다.${e.fields.length ? ` 오류 항목: ${e.fields.join(', ')}` : ''} 이 오류 코드를 알려주세요.`;
  else if (e.code === 40058) reason = '포럼 채널에는 직접 게시할 수 없습니다. 일반 텍스트 채널이나 포럼 게시글 안에서 패널 복구를 눌러주세요.';
  else if (e.status === 400 && e.code == null) reason = 'Discord가 상세 오류 코드 없이 요청을 거절했습니다. 응답 형식과 요청 종류를 확인해주세요. 식별 헤더·채널 ID·전송 형식 또는 Discord 앞단 차단 여부를 추가로 확인해야 합니다.';
  else if (e.status === 429 || e.status >= 500) reason = 'Discord의 일시 제한 또는 서버 오류입니다. 저장된 공개 패널은 주기 점검에서 다시 전송합니다.';
  else reason = 'Discord 전송에 실패했습니다. 오류 코드와 해당 채널 설정을 확인해주세요.';
  return `${reason} (${code})`;
}
export async function api(env, path, { method = 'GET', body, token = true, format = 'JSON' } = {}) {
  const headers = { Accept: 'application/json', 'User-Agent': DISCORD_USER_AGENT }; if (token) headers.Authorization = `Bot ${botToken(env)}`;
  let payload;
  if (body !== undefined) {
    if (format === 'multipart') { payload = new FormData(); payload.set('payload_json', JSON.stringify(body)); }
    else { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  }
  const response = await fetch(`https://discord.com/api/v10${path}`, { method, headers, body: payload });
  // Retain safe metadata for non-JSON failures, without storing upstream text or values.
  const raw = response.status === 204 ? '' : await response.text();
  let data = null; try { data = raw ? JSON.parse(raw) : null; } catch { /* gateway/edge errors may be HTML or text */ }
  // An empty 400 supplies no Discord validation details. Retry idempotent message
  // edits once using Discord's documented payload_json multipart representation.
  // Never retry permission/form errors, rate limits, or non-idempotent sends here.
  if (response.status === 400 && !raw.trim() && token && method === 'PATCH' && /^\/channels\/[^/]+\/messages\/[^/]+$/.test(path) && body !== undefined && format === 'JSON') return api(env, path, { method, body, token, format: 'multipart' });
  if (!response.ok) {
    const responseType = data !== null ? 'JSON' : !raw.trim() ? 'empty' : /<(!doctype|html|head|body)\b/i.test(raw.slice(0, 2048)) ? 'HTML' : 'text';
    const match = raw.slice(0, 8192).match(/(?:error(?:\s+code)?|code)\s*[:#]?\s*(1\d{3})\b/i);
    const requestKind = /^\/channels\/[^/]+\/messages(?:\/[^/]+)?$/.test(path) ? `${method} channel-message` : path.startsWith('/webhooks/') ? `${method} interaction-response` : `${method} Discord-API`;
    const retry = data?.retry_after ?? response.headers.get('retry-after') ?? 1;
    throw new DiscordError(response.status, response.status === 429 ? Math.max(1000, (Number(retry) || 1) * 1000) : 0, data, token ? 'bot' : 'interaction', { responseType, edgeCode: match ? Number(match[1]) : null, requestKind, requestFormat: body === undefined ? null : format });
  }
  return data;
}
export async function replyJob(env, job, content, view = null) {
  if (Date.now() - job.created_at > 14 * 60_000) return;
  try { await api(env, `/webhooks/${job.data.applicationId}/${job.data.token}/messages/@original`, { method: 'PATCH', token: false, body: { embeds: [], components: [], ...view, content: String(content).slice(0, 1900), allowed_mentions: { parse: [] } } }); }
  catch (e) { if (![401, 404].includes(e.status)) throw e; }
}
export async function diagnosePanelAccess(env, s, error) {
  const reason = error instanceof UserError ? error.message : describeDiscordError(error);
  if (!(error instanceof DiscordError) || error.status !== 400 || error.code != null || error.responseType !== 'empty') return reason;
  // A bounded, read-only check separates authentication and channel access from
  // message-body failures. Never expose account IDs, tokens, or upstream text.
  try {
    const user = await api(env, '/users/@me');
    if (!user?.id) return `${reason}\nBot 인증 점검: 계정 정보가 없는 응답입니다.`;
    if (env.APPLICATION_ID && user.id !== env.APPLICATION_ID) return `${reason}\nBot 인증 점검: DISCORD_TOKEN과 APPLICATION_ID가 서로 다른 앱입니다. 현재 앱의 봇 토큰으로 Secret을 수정해주세요.`;
  } catch (e) { return `${reason}\n본문 없는 Bot 인증 점검도 실패했습니다: ${e instanceof UserError ? e.message : describeDiscordError(e)}`; }
  try { await api(env, `/channels/${s.panel.channelId}`); }
  catch (e) { return `${reason}\nBot 인증은 성공했지만 채널 조회가 실패했습니다: ${e instanceof UserError ? e.message : describeDiscordError(e)}`; }
  return `${reason}\nBot 인증·채널 조회는 성공했습니다. 두 전송 형식 모두 메시지 수정 단계에서 실패했습니다.`;
}
export const normalize = s => String(s).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
export function channelByNames(channels, names) { const wanted = names.map(normalize); return channels.find(c => c.type === 2 && wanted.includes(normalize(c.name))); }
export function teamNames(env, no) { return [(env.TEAM_CHANNEL_TEMPLATE || '팀 {number}').replace('{number}', no), `팀 ${no}`, `${no}팀`, `TEAM ${no}`]; }
export async function discoverVoice(env, s) {
  const channels = await api(env, `/guilds/${s.guildId}/channels`), waiting = channelByNames(channels, [env.WAITING_CHANNEL_NAME || '대기실']);
  const teamIds = {}, missing = [];
  for (const t of s.teams.filter(t => !t.withdrawnAt)) { const c = channels.find(c => c.type === 2 && c.id === t.voiceId) || channelByNames(channels, teamNames(env, t.no)); if (c) teamIds[t.id] = c.id; else missing.push(`TEAM ${t.no}`); }
  return { channels, waitingId: waiting?.id || null, teamIds, missing };
}
export async function voiceTargets(env, s, kind, data = {}) {
  const { channels, waitingId, teamIds, missing } = await discoverVoice(env, s);
  const players = new Map(s.participants.map(p => [p.id, { id: p.id, role: p.primaryRole }]));
  s.teams.forEach(t => t.members.forEach(m => { if (!players.has(m.id)) players.set(m.id, m); }));
  if (kind === 'voiceTeams') {
    if (missing.length) throw new UserError(`음성방 없음: ${missing.join(', ')}. 채널 이름을 확인해주세요.`);
    return s.teams.filter(t => !t.withdrawnAt).flatMap(t => t.members.map(m => ({ id: m.id, target: teamIds[t.id] })));
  }
  if (kind === 'subVoice') { const t = s.teams.find(t => t.id === data.teamId); const target = t && teamIds[t.id]; return target ? [{ id: data.incomingId, target }] : []; }
  if (!waitingId) throw new UserError('대기실 음성채널을 찾을 수 없습니다.');
  if (kind === 'voiceRoles') {
    const names = { BIG: [env.BIG_CHANNEL_NAME || '빅'], SCORER: [env.SCORER_CHANNEL_NAME || '스코어러'], MAKER: [env.MAKER_CHANNEL_NAME || '메이커', '베이커'] };
    const roles = Object.fromEntries(Object.entries(names).map(([r, n]) => [r, channelByNames(channels, n)?.id]));
    if (Object.values(roles).some(x => !x)) throw new UserError('빅·메이커·스코어러 음성방을 확인해주세요.');
    return [...players.values()].map(p => ({ id: p.id, target: roles[p.role], sources: [waitingId] }));
  }
  const roles = [env.BIG_CHANNEL_NAME || '빅', env.MAKER_CHANNEL_NAME || '메이커', env.SCORER_CHANNEL_NAME || '스코어러', '베이커'];
  const sources = [...Object.values(teamIds), ...channels.filter(c => c.type === 2 && roles.map(normalize).includes(normalize(c.name))).map(c => c.id)];
  return [...players.values()].map(p => ({ id: p.id, target: waitingId, sources }));
}
// Each chunk stays under the Workers Free 50-subrequest limit, including D1 calls.
export async function moveVoiceChunk(env, guildId, progress) {
  for (let count = 0; progress.index < progress.targets.length && count < 8; count++) {
    const p = progress.targets[progress.index];
    try {
      const state = await api(env, `/guilds/${guildId}/voice-states/${p.id}`);
      if (!state?.channel_id || (p.sources && !p.sources.includes(state.channel_id))) progress.skipped++;
      else if (state.channel_id === p.target) progress.skipped++;
      else { await api(env, `/guilds/${guildId}/members/${p.id}`, { method: 'PATCH', body: { channel_id: p.target } }); progress.moved++; }
    } catch (e) { if (!(e instanceof DiscordError) || e.status === 429 || e.status >= 500) throw e; if ([400, 404].includes(e.status)) progress.skipped++; else progress.failed++; }
    progress.index++;
  }
  return progress.index >= progress.targets.length;
}
