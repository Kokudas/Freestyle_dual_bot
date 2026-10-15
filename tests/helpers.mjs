import { newScrim, applyAction } from '../src/domain.js';
export const admin = { id: '999999999999999999', name: '운영진', manager: true };
export const player = (id, role, secondary = null, extra = {}) => ({ id: String(id), name: `선수${id}`, primaryRole: role, primaryPosition: { BIG: 'C', SCORER: 'SF', MAKER: 'PG' }[role], secondaryRole: secondary, secondaryPosition: secondary ? { BIG: 'PF', SCORER: 'SG', MAKER: 'PG' }[secondary] : null, captain: false, teamNo: null, fixedRole: null, ...extra });
export const create = (extra = {}) => newScrim('test', '123456789012345678', { title: '내전', mode: 'random', endMode: 'round_robin', winPoints: 1, ...extra });
export const act = (s, kind, data = {}, actor = admin) => applyAction(s, { kind, data }, actor);
export function recruiting(n = 4, options = {}) {
  const s = create(options); let id = 1;
  for (let t = 1; t <= n; t++) for (const role of ['BIG', 'SCORER', 'MAKER']) { const p = player(id++, role, null, s.mode === 'manual' ? { teamNo: t, fixedRole: role } : {}); act(s, 'register', p, p); }
  return s;
}
export function running(n = 4, options = {}) { const s = recruiting(n, options); if (s.mode !== 'manual') act(s, 'draft'); act(s, 'finalize'); return s; }
