import { currentFixtures, teamById, ensure, UserError } from './domain.js';
import { api, DiscordError } from './discord.js';
import { resultAlert, resultAlertId } from './ui.js';

export function waitingCaptain(s, f) {
  if (s.status !== 'running' || !f || f.status !== 'reported' || !currentFixtures(s).some(x => x.id === f.id)) return null;
  const teams = [teamById(s, f.a), teamById(s, f.b)];
  if (teams.some(t => t.withdrawnAt) || !teams.some(t => t.captainId === f.reporter)) return null;
  return teams.find(t => t.captainId !== f.reporter)?.captainId || null;
}
const active = (s, a) => { const f = s.fixtures.find(f => f.id === a.fixtureId); return f?.reportId === a.reportId && waitingCaptain(s, f) === a.recipientId; };
const retryable = e => !(e instanceof UserError) && (!(e instanceof DiscordError) || e.status === 429 || e.status >= 500);
export async function enqueueStaleAlerts(env, store, s) {
  const ids = [];
  for (const a of s.resultAlerts || []) if (!active(s, a)) for (const messageId of a.messageIds) {
    const id = `alert-cleanup:${a.channelId}:${messageId}`;
    await store.enqueue({ id, application_id: env.APPLICATION_ID, token: null, guild_id: s.guildId, channel_id: a.channelId }, { id: a.recipientId, manager: false }, 'cleanupResultAlert', { alertId: a.id, channelId: a.channelId, messageId }, s.id); ids.push(id);
  }
  return ids;
}
export async function enqueueResultTasks(env, store, job, s) {
  const p = job.data, ids = [];
  if (['report', 'captain', 'substitute'].includes(p.kind)) for (const f of currentFixtures(s)) {
    if (p.kind === 'report' ? f.id !== p.data.fixtureId : ![f.a, f.b].includes(p.data.teamId)) continue;
    const recipientId = waitingCaptain(s, f); if (!recipientId || !f.reportId) continue;
    const id = `result-alert:${f.reportId}:${recipientId}`;
    await store.enqueue({ id, application_id: env.APPLICATION_ID, token: p.token, guild_id: s.guildId, channel_id: s.panel?.channelId || p.channelId }, { id: recipientId, manager: false }, 'resultAlert', {
      fixtureId: f.id, reportId: f.reportId, recipientId, sourceChannelId: p.channelId, expiresAt: job.created_at + 14 * 60_000,
    }, s.id); ids.push(id);
  }
  return [...ids, ...await enqueueStaleAlerts(env, store, s)];
}
async function remember(store, job, status, messageId = null) {
  const p = job.data, d = p.data;
  return store.mutate(p.scrimId, job.guild_id, `${job.id}:${status}:${messageId || ''}`, s => {
    s.resultAlerts ||= [];
    let a = s.resultAlerts.find(a => a.id === job.id);
    if (!a && (messageId || status === 'pending')) { a = { id: job.id, fixtureId: d.fixtureId, reportId: d.reportId, recipientId: d.recipientId, channelId: p.channelId, messageIds: [] }; s.resultAlerts.push(a); }
    if (a && messageId && !a.messageIds.includes(messageId)) a.messageIds.push(messageId);
    const f = s.fixtures.find(f => f.id === d.fixtureId);
    if (active(s, d)) f.resultAlert = { reportId: d.reportId, recipientId: d.recipientId, status };
    if (status === 'failed' && a && !a.messageIds.length) s.resultAlerts = s.resultAlerts.filter(x => x !== a);
    return '채널 결과 알림 처리';
  }, { dirty: status === 'failed' });
}
async function recoverMessages(env, job) {
  const p = job.data, d = p.data, customId = resultAlertId(p.scrimId, d.fixtureId, d.reportId, d.recipientId);
  try {
    const messages = await api(env, `/channels/${p.channelId}/messages?limit=50`);
    return (Array.isArray(messages) ? messages : []).filter(m => !(m.flags & 64) && (m.author?.id === env.APPLICATION_ID || m.application_id === env.APPLICATION_ID) && m.components?.some(row => row.components?.some(c => c.custom_id === customId)));
  } catch (e) { if (e instanceof DiscordError && e.status === 403) return []; throw e; }
}
export async function runResultAlert(env, store, job) {
  const p = job.data, d = p.data;
  const discardEmpty = () => store.mutate(p.scrimId, job.guild_id, `${job.id}:retired`, s => { s.resultAlerts = (s.resultAlerts || []).filter(a => a.id !== job.id || a.messageIds.length); return '미전송 알림 정리'; }, { dirty: false });
  try {
    let s = (await store.get(p.scrimId, job.guild_id)).value;
    if (job.attempts > 1 && !s.resultAlerts?.find(a => a.id === job.id)?.messageIds.length) for (const m of await recoverMessages(env, job)) { await remember(store, job, 'sent', m.id); }
    s = (await store.get(p.scrimId, job.guild_id)).value;
    const prior = s.resultAlerts?.find(a => a.id === job.id);
    if (prior?.messageIds.length || !active(s, d)) {
      if (prior && !prior.messageIds.length) await discardEmpty();
      const cleanup = await enqueueStaleAlerts(env, store, s); await store.finishJob(job); return cleanup;
    }
    await remember(store, job, 'pending');
    s = (await store.get(p.scrimId, job.guild_id)).value;
    if (!active(s, d)) { await discardEmpty(); await store.finishJob(job); return []; }
    const f = s.fixtures.find(f => f.id === d.fixtureId), body = resultAlert(s, f, d.recipientId);
    let sent;
    if (p.token && d.sourceChannelId === p.channelId && Date.now() < d.expiresAt) {
      // The private original is updated separately; this is a PUBLIC followup.
      // Keep its token only in the short-lived job, never in scrim state.
      sent = await api(env, `/webhooks/${p.applicationId}/${p.token}`, { method: 'POST', token: false, body: { ...body, flags: 0 } });
    } else {
      // A followup cannot be redirected to a different channel.
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(job.id)), nonce = [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('').slice(0, 25);
      sent = await api(env, `/channels/${p.channelId}/messages`, { method: 'POST', body: { ...body, nonce, enforce_nonce: true } });
    }
    ensure(sent?.id && !(sent.flags & 64) && (!sent.channel_id || sent.channel_id === p.channelId), '공개 결과 알림의 전송을 확인할 수 없습니다.');
    const saved = await remember(store, job, 'sent', sent.id), cleanup = await enqueueStaleAlerts(env, store, saved.state);
    await store.finishJob(job); return cleanup;
  } catch (e) {
    if (retryable(e) && job.attempts < 5 && Date.now() - job.created_at < 10 * 60_000) {
      await store.checkpoint(job, p, Math.min(Math.max(e.retryAfter || 3000, 1000), 120_000));
      console.error('Result channel alert deferred', job.id, e.status || e.name);
    } else {
      await remember(store, job, 'failed'); await store.finishJob(job, 'failed', `Channel alert failed: ${e.status || e.name}`);
      console.error('Result channel alert unavailable; panel confirmation retained', job.id, e.status || e.name);
    }
    return [];
  }
}
export async function runAlertCleanup(env, store, job) {
  const p = job.data, d = p.data;
  try {
    try { await api(env, `/channels/${d.channelId}/messages/${d.messageId}`, { method: 'DELETE' }); }
    catch (e) { if (!(e instanceof DiscordError) || e.status !== 404) throw e; }
    await store.mutate(p.scrimId, job.guild_id, job.id, s => {
      s.resultAlerts = (s.resultAlerts || []).map(a => a.id === d.alertId ? { ...a, messageIds: a.messageIds.filter(id => id !== d.messageId) } : a).filter(a => a.id !== d.alertId || a.messageIds.length);
      return '처리된 결과 알림 삭제';
    }, { dirty: false });
    await store.finishJob(job);
  } catch (e) {
    if (retryable(e) && job.attempts < 8) await store.checkpoint(job, p, Math.min(Math.max(e.retryAfter || 3000, 1000), 120_000));
    else await store.finishJob(job, 'failed', `Channel alert cleanup failed: ${e.status || e.name}`);
  }
}
