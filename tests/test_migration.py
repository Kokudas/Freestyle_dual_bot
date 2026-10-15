import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('migration', ROOT / 'scripts/migrate_sqlite.py')
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'scrim.sqlite3'
        db = sqlite3.connect(self.path)
        db.executescript((ROOT / 'tests/fixtures/legacy_schema.sql').read_text())
        db.execute('INSERT INTO scrims VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', (1, 123456789012345678, "클럽's 내전", 'running', 2, 'points_target', 20, 'manual', None, None, 123456789012345679, 123456789012345680, 123456789012345681, '2026-01-01T00:00:00+00:00', None))
        for team in [1, 2]:
            db.execute('INSERT INTO teams VALUES(?,?,?,?,?,?,?,?)', (team, 1, team, str(team), 123456789012345690 + team, 4 if team == 1 else 0, 123456789012345700 + team, None))
            for slot, role, pos in [(1, 'BIG', 'C'), (2, 'SCORER', 'SF'), (3, 'MAKER', 'PG')]:
                uid = 123456789012345690 + (team - 1) * 3 + slot
                db.execute('INSERT INTO team_members VALUES(?,?,?,?,?,?,?)', (team, slot, uid, f'선수{uid}', role, pos, 0))
                db.execute('INSERT INTO participants VALUES(?,?,?,?,?,?,?,?,?,?,?)', (1, uid, f'선수{uid}', role, pos, None, None, 1, team, role, '2026-01-01T00:00:00Z'))
        db.execute('INSERT INTO fixtures VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', (1, 1, 1, 1, 1, 2, 'completed', None, None, None, None, None, 1, 1, 'forfeit', 2, '2026-01-01T01:00:00Z'))
        db.execute('INSERT INTO fixtures VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', (2, 1, 2, 1, 1, 2, 'reported', 123456789012345691, 1, None, None, None, None, None, 'played', None, None))
        db.execute('INSERT INTO matches VALUES(?,?,?,?,?,?,?,?,?)', (1, 1, 1, 2, 1, 2, 0, '2026-01-01T01:00:00Z', 1))
        db.execute('INSERT INTO substitutes VALUES(?,?,?,?,?,?)', (1, 123456789012345799, '대타', '["BIG"]', '["C"]', '2026-01-01T00:00:00Z'))
        db.commit()
        db.close()

    def test_precision_pending_reports_and_original_unchanged(self):
        before = hashlib.sha256(self.path.read_bytes()).hexdigest()
        s = migration.convert(self.path)[0]
        self.assertEqual(s['guildId'], '123456789012345678')
        self.assertEqual(s['panel']['messageId'], '123456789012345680')
        self.assertEqual(s['fixtures'][1]['reporter'], '123456789012345691')
        self.assertEqual(s['matches'][0]['type'], 'forfeit')
        self.assertEqual(s['teams'][0]['points'], 4)
        self.assertEqual(s['nextFixture'], 3)
        self.assertEqual(s['legacySource']['scrim']['guild_id'], s['guildId'])
        self.assertEqual(hashlib.sha256(self.path.read_bytes()).hexdigest(), before)

    def test_large_sql_import_is_valid_chunked_and_idempotent(self):
        db = sqlite3.connect(self.path)
        db.execute('UPDATE participants SET member_name=?', ("한글'" * 8000,))
        db.commit()
        db.close()
        output = Path(self.temp.name) / 'import.sql'
        subprocess.run([sys.executable, str(ROOT / 'scripts/migrate_sqlite.py'), str(self.path), '--output', str(output)], check=True, capture_output=True)
        text = output.read_text()
        self.assertTrue(all(len(line.encode()) < 100000 for line in text.splitlines()))
        target = sqlite3.connect(':memory:')
        target.executescript((ROOT / 'migrations/0001_initial.sql').read_text())
        target.executescript(text)
        state = json.loads(target.execute('SELECT state FROM scrims').fetchone()[0])
        self.assertEqual(state['participants'][0]['name'], "한글'" * 8000)
        target.execute("UPDATE scrims SET revision=9")
        target.executescript(text)
        self.assertEqual(target.execute('SELECT COUNT(*),revision FROM scrims').fetchone(), (1, 9))

    def test_completed_old_league_becomes_ended(self):
        db = sqlite3.connect(self.path)
        db.execute("UPDATE scrims SET league_completed_at='2026-01-01T01:00:00+00:00',league_end_reason='points_target_reached'")
        db.commit()
        db.close()
        s = migration.convert(self.path)[0]
        self.assertEqual(s['status'], 'ended')
        self.assertEqual(s['endedAt'], '2026-01-01T01:00:00.000Z')

    def test_existing_fixed_slots_preserved_as_legacy_mixed(self):
        db = sqlite3.connect(self.path)
        db.execute("UPDATE scrims SET formation_mode='random'")
        db.commit()
        db.close()
        self.assertEqual(migration.convert(self.path)[0]['mode'], 'legacy_mixed')

    def test_output_cannot_overwrite_original(self):
        before = self.path.read_bytes()
        result = subprocess.run([sys.executable, str(ROOT / 'scripts/migrate_sqlite.py'), str(self.path), '--output', str(self.path)], capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.path.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
