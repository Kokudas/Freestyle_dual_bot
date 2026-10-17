#!/usr/bin/env python3
"""Package source without local databases, credentials or installed dependencies."""
import hashlib
import json
from pathlib import Path
import zipfile

root = Path(__file__).resolve().parents[1]
allowed_top = {'README.md', 'CLOUDFLARE_GUIDE.md', 'MIGRATION_GUIDE.md', 'USER_GUIDE.md', 'VALIDATION.md', 'UPDATE_PANEL_FIX.md', 'UPDATE_HTTP400.md', 'UPDATE_PUBLIC_RESPONSE.md', 'UPDATE_EDIT_FIX.md', 'UPDATE_LEAGUE_ADMISSION.md', 'package.json', 'package-lock.json', 'wrangler.jsonc', '.dev.vars.example', '.gitignore'}
allowed_dirs = {'src', 'scripts', 'migrations', 'tests'}
files = sorted(p for p in root.rglob('*') if p.is_file() and '__pycache__' not in p.parts and (p.relative_to(root).as_posix() in allowed_top or (p.relative_to(root).parts[0] in allowed_dirs and p.suffix in {'.js', '.mjs', '.py', '.sql', '.md', '.json'})))
version = json.loads((root / 'package.json').read_text())['version']
out = root.parent / f'FSR_scrim_bot_Cloudflare_Workers_v{version}.zip'
hashes = []
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for path in files:
        name = path.relative_to(root).as_posix()
        data = path.read_bytes()
        z.writestr(name, data)
        hashes.append(f'{hashlib.sha256(data).hexdigest()}  {name}')
    z.writestr('SHA256SUMS', '\n'.join(hashes) + '\n')
with zipfile.ZipFile(out) as z:
    assert z.testzip() is None
    assert not any(n == '.dev.vars' or n.startswith(('node_modules/', '.wrangler/')) or n.endswith(('.sqlite3', '.pyc')) for n in z.namelist())
print(f'{out}\n{len(files)} source files; {out.stat().st_size} bytes; SHA256 {hashlib.sha256(out.read_bytes()).hexdigest()}')
