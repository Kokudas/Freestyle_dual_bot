#!/usr/bin/env python3
"""Read a v1.6.1 SQLite backup without modifying it; generate a D1 import file."""
import argparse
import datetime as dt
import json
from pathlib import Path
import sqlite3
import sys


def ident(value):
    return None if value is None else str(value)


def stamp(value):
    if not value:
        return None
    parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def sql_string(value):
    return "'" + str(value).replace("'", "''") + "'"


def convert(source):
    source = Path(source).resolve(strict=True)
    db = sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if 'scrims' not in tables:
        raise ValueError('내전 봇 SQLite DB가 아닙니다.')
    def rows(table, field=None, value=None):
        if table not in tables:
            return []
        query = f'SELECT * FROM {table}'
        return [dict(r) for r in db.execute(query + (f' WHERE {field}=?' if field else ''), (value,) if field else ())]
    states = []
    for r in rows('scrims'):
        sid = r['id']
        originals = {t: rows(t, 'scrim_id', sid) for t in ['participants', 'teams', 'substitutes', 'fixtures', 'matches', 'substitutions']}
        originals['scrim'] = r
        originals['team_members'] = [m for t in originals['teams'] for m in rows('team_members', 'team_id', t['id'])]
        mode = r.get('formation_mode', 'legacy_mixed')
        if mode not in ['random', 'manual', 'legacy_mixed']:
            raise ValueError(f'지원하지 않는 편성 모드: {mode} (내전 {sid})')
        participants = [dict(id=ident(p['member_id']), name=p['member_name'], primaryRole=p['primary_role'], primaryPosition=p['primary_position'], secondaryRole=p.get('secondary_role'), secondaryPosition=p.get('secondary_position'), captain=bool(p.get('captain_willing')), teamNo=p.get('preferred_team_no'), fixedRole=p.get('fixed_role')) for p in originals['participants']]
        if mode == 'random' and any(p['teamNo'] for p in participants):
            mode = 'legacy_mixed'
        fixtures = [dict(id=ident(f['id']), round=f['round_no'], a=ident(f['team_a_id']), b=ident(f['team_b_id']), status=f['status'], reporter=ident(f.get('reported_by')), proposed=ident(f.get('proposed_winner_id')), winner=ident(f.get('winner_team_id')), resultType=f.get('result_type', 'played'), matchId=ident(f.get('match_id')), completedAt=stamp(f.get('completed_at'))) for f in originals['fixtures']]
        result_types = {f['id']: f['resultType'] for f in fixtures}
        completed_at = stamp(r.get('league_completed_at'))
        s = dict(id=f'legacy-{sid}', guildId=ident(r['guild_id']), title=r['title'], mode=mode, endMode=r.get('end_mode', 'round_robin'), target=r.get('target_value'), winPoints=r['points_per_win'], status='ended' if completed_at else r['status'],
                 participants=participants, subs=[dict(id=ident(p['member_id']), name=p['member_name'], roles=json.loads(p['roles_json']), positions=json.loads(p['positions_json'])) for p in originals['substitutes']],
                 teams=[dict(id=ident(t['id']), no=t['team_no'], captainId=ident(t['captain_id']), points=t['points'], voiceId=ident(t.get('voice_channel_id')), withdrawnAt=stamp(t.get('withdrawn_at')), members=[dict(id=ident(m['member_id']), name=m['member_name'], role=m['role'], position=m['position'], isSub=bool(m.get('is_substitute'))) for m in originals['team_members'] if m['team_id'] == t['id']]) for t in originals['teams']],
                 fixtures=fixtures, matches=[dict(id=ident(m['id']), fixtureId=ident(m.get('fixture_id')), a=ident(m['team_a_id']), b=ident(m['team_b_id']), winner=ident(m['winner_team_id']), points=m['points_awarded'], reversed=bool(m['reversed']), createdAt=stamp(m['created_at']), type=result_types.get(ident(m.get('fixture_id')), 'played')) for m in originals['matches']],
                 substitutions=[dict(teamId=ident(t['team_id']), outgoing=dict(id=ident(t['outgoing_id']), name=t['outgoing_name']), incoming=dict(id=ident(t['incoming_id']), name=t['incoming_name'], role=t['role'], position=t['position']), createdAt=stamp(t['created_at'])) for t in originals['substitutions']],
                 createdAt=stamp(r['created_at']), endedAt=stamp(r.get('ended_at')) or completed_at, completedAt=completed_at, endReason=r.get('league_end_reason'),
                 panel=dict(channelId=ident(r['panel_channel_id']), messageId=ident(r['panel_message_id'])) if r.get('panel_channel_id') and r.get('panel_message_id') else None,
                 waitingId=ident(r.get('waiting_channel_id')), applied={}, nextFixture=max((f['id'] for f in originals['fixtures']), default=0) + 1, nextMatch=max((m['id'] for m in originals['matches']), default=0) + 1)
        # Retain fields used only by the Python version for audit/rollback, with IDs as strings.
        def safe_raw(value):
            if isinstance(value, dict):
                return {k: ident(v) if (k == 'id' or k.endswith('_id') or k in ['reported_by', 'confirmed_by', 'disputed_by']) and v is not None else safe_raw(v) for k, v in value.items()}
            return [safe_raw(v) for v in value] if isinstance(value, list) else value
        s['legacySource'] = safe_raw(originals)
        if len(json.dumps(s, ensure_ascii=False).encode()) >= 1_800_000:
            raise ValueError(f'내전 {sid}의 기록이 너무 큽니다. DB를 보존하고 별도 분할 이전을 요청하세요.')
        states.append(s)
    db.close()
    return states


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('database', type=Path, help='복사/백업한 scrim.sqlite3')
    p.add_argument('--output', type=Path, default=Path('import.sql'))
    args = p.parse_args()
    if args.output.resolve() == args.database.resolve():
        p.error('출력 파일은 원본 DB와 달라야 합니다.')
    states = convert(args.database)
    active = [s['guildId'] for s in states if s['status'] != 'ended']
    if len(active) != len(set(active)):
        raise ValueError('한 서버에 여러 진행 내전이 있어 이전을 중단했습니다.')
    time_ms = int(dt.datetime.now(dt.timezone.utc).timestamp() * 1000)
    lines = ['-- FSR SQLite -> Cloudflare D1. Apply migrations first. Existing IDs are preserved.',
             'CREATE TABLE IF NOT EXISTS fsr_legacy_import_chunks (id TEXT NOT NULL, seq INTEGER NOT NULL, part TEXT NOT NULL, PRIMARY KEY(id,seq));']
    for s in states:
        payload = json.dumps(s, ensure_ascii=False, separators=(',', ':'))
        # Small statements stay below D1's SQL text limit, including large histories.
        key = sql_string(s['id'])
        lines.append(f'DELETE FROM fsr_legacy_import_chunks WHERE id={key};')
        for seq, start in enumerate(range(0, len(payload), 6000)):
            lines.append(f'INSERT INTO fsr_legacy_import_chunks(id,seq,part) VALUES({key},{seq},{sql_string(payload[start:start + 6000])});')
        state_sql = f"(SELECT group_concat(part,'') FROM (SELECT part FROM fsr_legacy_import_chunks WHERE id={key} ORDER BY seq))"
        lines.append('INSERT INTO scrims(id,guild_id,status,state,dirty_at,updated_at) VALUES(' + ','.join([key, sql_string(s['guildId']), sql_string(s['status']), state_sql, str(time_ms), str(time_ms)]) + ') ON CONFLICT(id) DO NOTHING;')
        lines.append(f'DELETE FROM fsr_legacy_import_chunks WHERE id={key};')
    lines.append('DROP TABLE fsr_legacy_import_chunks;')
    args.output.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(f'변환 완료: 내전 {len(states)}개 / 진행 {len(active)}개 -> {args.output}')
    print('원본 DB는 수정하지 않았습니다. import.sql에는 참가자 정보가 있으므로 공개 업로드하지 마세요.')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, sqlite3.Error, OSError) as exc:
        print(f'변환 중단: {exc}', file=sys.stderr)
        sys.exit(1)
