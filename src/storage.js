import { UserError, ensure } from './domain.js';
export const interactionChannelId = i => [i.channel?.id, i.channel_id, i.message?.channel_id].find(id => typeof id === 'string' && /^\d{1,20}$/.test(id)) || null;
export class Store {
  constructor(db) { this.db = db; }
  async active(guildId) { const row = await this.db.prepare("SELECT * FROM scrims WHERE guild_id=? AND status!='ended'").bind(guildId).first(); return row ? { ...row, value: JSON.parse(row.state) } : null; }
  async get(id, guildId) {
    const row = await this.db.prepare('SELECT * FROM scrims WHERE id=? AND guild_id=?').bind(id, guildId).first();
    ensure(row, '내전 정보를 찾을 수 없습니다.'); return { ...row, value: JSON.parse(row.state) };
  }
  async create(s) {
    const prior = await this.db.prepare('SELECT id FROM scrims WHERE id=?').bind(s.id).first(); if (prior) return;
    try { await this.db.prepare('INSERT INTO scrims(id,guild_id,status,state,dirty_at,updated_at) VALUES(?,?,?,?,?,?)').bind(s.id, s.guildId, s.status, JSON.stringify(s), Date.now(), Date.now()).run(); }
    catch (e) { if (await this.active(s.guildId)) throw new UserError('이 서버에는 이미 진행 중인 내전이 있습니다.'); throw e; }
  }
  async mutate(id, guildId, operationId, fn, { dirty = true } = {}) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const row = await this.get(id, guildId), s = row.value;
      s.applied ||= {};
      if (Object.hasOwn(s.applied, operationId)) return { state: s, result: s.applied[operationId], replay: true };
      const result = fn(s); // Pure synchronous domain work; no Discord calls in a retry.
      s.applied[operationId] = result ?? null;
      const text = JSON.stringify(s); ensure(new TextEncoder().encode(text).length < 1_800_000, '내전 기록 크기가 한도에 접근했습니다. 기록을 백업한 뒤 새 내전을 열어주세요.');
      const written = await this.db.prepare('UPDATE scrims SET state=?,status=?,revision=revision+1,updated_at=?,dirty_at=CASE WHEN ? THEN COALESCE(dirty_at,?) ELSE dirty_at END WHERE id=? AND guild_id=? AND revision=?').bind(text, s.status, Date.now(), dirty ? 1 : 0, Date.now(), id, guildId, row.revision).run();
      if (written.meta.changes === 1) return { state: s, result, replay: false };
    }
    // Let the persistent job retry later instead of rejecting a valid signup.
    throw new Error('Concurrent state update; retry the queued operation');
  }
  async wizard(ownerId, guildId, data) {
    const id = crypto.randomUUID();
    await this.db.prepare('INSERT INTO wizards(id,owner_id,guild_id,state,expires_at) VALUES(?,?,?,?,?)').bind(id, ownerId, guildId, JSON.stringify(data), Date.now() + 900_000).run();
    return { id, ownerId, guildId, revision: 0, data };
  }
  async getWizard(id, ownerId, guildId) {
    const r = await this.db.prepare('SELECT * FROM wizards WHERE id=? AND owner_id=? AND guild_id=? AND expires_at>?').bind(id, ownerId, guildId, Date.now()).first();
    ensure(r, '입력 화면이 만료됐습니다. 명령어 또는 개인 참가 버튼을 다시 눌러주세요.');
    return { id, ownerId, guildId, revision: r.revision, data: JSON.parse(r.state) };
  }
  async saveWizard(w) {
    const r = await this.db.prepare('UPDATE wizards SET state=?,revision=revision+1 WHERE id=? AND owner_id=? AND revision=? AND expires_at>?').bind(JSON.stringify(w.data), w.id, w.ownerId, w.revision, Date.now()).run();
    ensure(r.meta.changes === 1, '선택 내용이 변경됐습니다. 참가 화면을 다시 열어주세요.'); w.revision++;
  }
  async enqueue(i, actor, kind, data, scrimId = null, { publicReply = false } = {}) {
    // Persist the job before acknowledging it. Interaction tokens are never logged.
    const channelId = interactionChannelId(i);
    ensure(channelId, '실행한 채널의 ID를 가져오지 못했습니다. 서버의 텍스트 채널에서 명령어를 다시 열어주세요.');
    const payload = { applicationId: i.application_id, token: i.token, channelId, actor, kind, data, scrimId, publicReply };
    await this.db.prepare('INSERT OR IGNORE INTO jobs(id,guild_id,payload,available_at,created_at) VALUES(?,?,?,?,?)').bind(i.id, i.guild_id, JSON.stringify(payload), Date.now(), Date.now()).run();
    return i.id;
  }
  async claimJob(id) {
    const lease = crypto.randomUUID(), time = Date.now();
    const r = await this.db.prepare("UPDATE jobs SET status='running',lease=?,lease_until=?,attempts=attempts+1 WHERE id=? AND available_at<=? AND (status='pending' OR (status='running' AND lease_until<?))").bind(lease, time + 90_000, id, time, time).run();
    if (!r.meta.changes) return null;
    const row = await this.db.prepare('SELECT * FROM jobs WHERE id=? AND lease=?').bind(id, lease).first();
    return row ? { ...row, data: JSON.parse(row.payload) } : null;
  }
  async checkpoint(job, payload, delay = 0) {
    await this.db.prepare("UPDATE jobs SET payload=?,status='pending',available_at=?,lease=NULL,lease_until=NULL WHERE id=? AND lease=?").bind(JSON.stringify(payload), Date.now() + delay, job.id, job.lease).run();
  }
  async finishJob(job, status = 'done', error = null) {
    await this.db.prepare('UPDATE jobs SET status=?,payload=NULL,last_error=?,completed_at=?,lease=NULL,lease_until=NULL WHERE id=? AND lease=?').bind(status, error ? String(error).slice(0, 300) : null, Date.now(), job.id, job.lease).run();
  }
  async dueJobs() { return (await this.db.prepare("SELECT id FROM jobs WHERE available_at<=? AND (status='pending' OR (status='running' AND lease_until<?)) ORDER BY created_at LIMIT 8").bind(Date.now(), Date.now()).all()).results; }
  async markDirty(id, guildId) { await this.db.prepare('UPDATE scrims SET dirty_at=COALESCE(dirty_at,?) WHERE id=? AND guild_id=?').bind(Date.now(), id, guildId).run(); }
  async dirtyPanels() { return (await this.db.prepare('SELECT id,guild_id FROM scrims WHERE dirty_at IS NOT NULL ORDER BY dirty_at LIMIT 8').all()).results; }
  async claimPanel(id, force = false) {
    const lease = crypto.randomUUID(), time = Date.now();
    const r = await this.db.prepare('UPDATE scrims SET panel_lock=?,panel_lock_until=? WHERE id=? AND dirty_at IS NOT NULL AND (? OR dirty_at<=?) AND (panel_lock_until IS NULL OR panel_lock_until<?)').bind(lease, time + 30_000, id, force ? 1 : 0, time - 600, time).run();
    return r.meta.changes ? lease : null;
  }
  async releasePanel(id, lease, revision, succeeded) {
    await this.db.prepare('UPDATE scrims SET panel_lock=NULL,panel_lock_until=NULL,dirty_at=CASE WHEN revision=? AND ? THEN NULL ELSE dirty_at END,panel_revision=CASE WHEN ? THEN ? ELSE panel_revision END WHERE id=? AND panel_lock=?').bind(revision, succeeded ? 1 : 0, succeeded ? 1 : 0, revision, id, lease).run();
  }
  async endedPanels(cutoff) { return (await this.db.prepare("SELECT id,guild_id,state,revision FROM scrims WHERE status='ended' AND json_extract(state,'$.panel.messageId') IS NOT NULL AND json_extract(state,'$.endedAt')<=? LIMIT 5").bind(cutoff).all()).results; }
  async cooldown(key, seconds) {
    const r = await this.db.prepare('INSERT INTO cooldowns(key,until_at) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET until_at=excluded.until_at WHERE cooldowns.until_at<=?').bind(key, Date.now() + seconds * 1000, Date.now()).run();
    ensure(r.meta.changes, '잠시 후 다시 시도해주세요.');
  }
  async cleanup() {
    await this.db.batch([
      this.db.prepare('DELETE FROM wizards WHERE expires_at<?').bind(Date.now()),
      this.db.prepare('DELETE FROM cooldowns WHERE until_at<?').bind(Date.now() - 3_600_000),
      this.db.prepare("DELETE FROM jobs WHERE status IN ('done','failed') AND completed_at<?").bind(Date.now() - 7 * 86_400_000),
    ]);
  }
}
