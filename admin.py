#!/usr/bin/env python3
"""
NWA Physics Navigator — Admin Server
Run: python3 admin.py
Then open: http://localhost:8080
"""

import http.server, json, os, subprocess, urllib.parse, sys
from pathlib import Path

PORT = 8080
BASE = Path(__file__).parent

# ── tiny HTML page (served at /) ─────────────────────────────────────────────
HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Navigator Admin</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
<script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script>
<style>
* { box-sizing:border-box; margin:0; padding:0; }
body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
       background:#0f172a; color:#e2e8f0; min-height:100vh; }

header { background:#1e3a5f; padding:14px 28px; display:flex;
         align-items:center; gap:16px; border-bottom:1px solid rgba(255,255,255,.1); }
header h1 { font-size:1rem; font-weight:600; }
.badge { background:rgba(255,255,255,.12); padding:3px 10px;
         border-radius:12px; font-size:.78rem; }
#module-sel { background:rgba(255,255,255,.1); border:1px solid rgba(255,255,255,.2);
              color:white; border-radius:6px; padding:4px 10px; font-size:.8rem; cursor:pointer; }
#push-btn { margin-left:auto; background:#16a34a; color:white; border:none;
            border-radius:7px; padding:7px 18px; font-size:.82rem; cursor:pointer;
            transition:background .15s; }
#push-btn:hover { background:#15803d; }
#push-btn:disabled { background:#334155; cursor:default; }
#push-status { font-size:.78rem; color:#94a3b8; }

main { padding:24px 28px; max-width:1100px; }

.section-label { font-size:.68rem; font-weight:700; text-transform:uppercase;
                 letter-spacing:.1em; color:#64748b; margin:24px 0 12px; }

/* stats bar */
.stats { display:flex; gap:16px; margin-bottom:8px; }
.stat { background:#1e293b; border-radius:10px; padding:14px 20px; flex:1;
        border:1px solid rgba(255,255,255,.06); }
.stat-n { font-size:1.6rem; font-weight:700; color:#38bdf8; }
.stat-l { font-size:.75rem; color:#64748b; margin-top:2px; }

/* pending queue */
.queue-empty { color:#475569; font-size:.85rem; padding:16px 0; }
.submission { background:#1e293b; border:1px solid rgba(255,255,255,.07);
              border-radius:10px; padding:14px 16px; margin-bottom:10px;
              display:flex; align-items:flex-start; gap:14px; }
.submission.approved { border-color:#166534; background:#052e16; }
.sub-dot { width:10px; height:10px; border-radius:50%; flex-shrink:0; margin-top:4px; }
.sub-info { flex:1; min-width:0; }
.sub-title { font-size:.9rem; font-weight:500; margin-bottom:3px; }
.sub-meta  { font-size:.75rem; color:#64748b; }
.sub-concept { font-size:.72rem; background:#0f172a; border:1px solid #334155;
               border-radius:5px; padding:2px 7px; margin-top:5px; display:inline-block; }
.sub-url { font-size:.75rem; color:#38bdf8; word-break:break-all; margin-top:3px; }
.sub-url a { color:inherit; }
.sub-actions { display:flex; flex-direction:column; gap:6px; flex-shrink:0; }
.approve-btn { background:#16a34a; color:white; border:none; border-radius:6px;
               padding:6px 14px; font-size:.78rem; cursor:pointer; transition:background .15s; }
.approve-btn:hover { background:#15803d; }
.approve-btn:disabled { background:#334155; cursor:default; }
.reject-btn  { background:transparent; color:#94a3b8; border:1px solid #334155;
               border-radius:6px; padding:5px 14px; font-size:.78rem; cursor:pointer;
               transition:all .15s; }
.reject-btn:hover { border-color:#dc2626; color:#dc2626; }

/* add-contribution form */
.add-form { background:#1e293b; border:1px solid rgba(255,255,255,.07);
            border-radius:10px; padding:18px; }
.form-row { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:10px; }
.form-row.wide { grid-template-columns:1fr; }
label { font-size:.72rem; color:#64748b; display:block; margin-bottom:3px; }
input, select { width:100%; background:#0f172a; border:1px solid #334155;
                border-radius:6px; padding:7px 10px; color:#e2e8f0;
                font-size:.83rem; font-family:inherit; transition:border-color .15s; }
input:focus, select:focus { outline:none; border-color:#2563eb; }
.submit-btn { background:#2563eb; color:white; border:none; border-radius:7px;
              padding:8px 20px; font-size:.82rem; cursor:pointer; transition:background .15s; }
.submit-btn:hover { background:#1d4ed8; }
#form-msg { font-size:.8rem; margin-top:8px; display:none; }

/* concepts grid */
.concepts-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(240px,1fr)); gap:10px; }
.concept-card { background:#1e293b; border:1px solid rgba(255,255,255,.07);
                border-radius:9px; padding:13px 15px; }
.concept-card.covered { border-color:#166534; }
.card-top { display:flex; align-items:center; gap:8px; margin-bottom:6px; }
.card-dot { width:9px; height:9px; border-radius:50%; flex-shrink:0; }
.card-name { font-size:.84rem; font-weight:500; }
.card-level { font-size:.7rem; color:#475569; }
.card-contribs { font-size:.75rem; color:#64748b; margin-top:4px; }
.card-contrib-link { color:#38bdf8; text-decoration:none; font-size:.74rem;
                     display:block; margin-top:3px; overflow:hidden;
                     text-overflow:ellipsis; white-space:nowrap; }
.card-contrib-link:hover { text-decoration:underline; }
</style>
</head>
<body>

<header>
  <h1>Navigator Admin</h1>
  <select id="module-sel" onchange="loadModule(this.value)">
    <option value="modules/quantum_spin.json">Quantum Spin</option>
    <option value="modules/special_relativity.json">Special Relativity</option>
  </select>
  <span class="badge" id="mod-label">—</span>
  <span id="push-status"></span>
  <button id="push-btn" onclick="gitPush()">Push to GitHub →</button>
</header>

<main>
  <!-- Stats -->
  <div class="stats">
    <div class="stat"><div class="stat-n" id="stat-covered">—</div><div class="stat-l">Concepts covered</div></div>
    <div class="stat"><div class="stat-n" id="stat-total">—</div><div class="stat-l">Total concepts</div></div>
    <div class="stat"><div class="stat-n" id="stat-contribs">—</div><div class="stat-l">Contributions</div></div>
    <div class="stat"><div class="stat-n" id="stat-authors">—</div><div class="stat-l">Contributors</div></div>
  </div>

  <!-- Add contribution manually -->
  <div class="section-label">Add Contribution</div>
  <div class="add-form">
    <div class="form-row">
      <div>
        <label>Concept</label>
        <select id="f-concept"></select>
      </div>
      <div>
        <label>Author</label>
        <input id="f-author" type="text" placeholder="Student name">
      </div>
    </div>
    <div class="form-row">
      <div>
        <label>Contribution title</label>
        <input id="f-title" type="text" placeholder="e.g. Proper Time Along a Worldline">
      </div>
      <div>
        <label>Wiki / Notion URL</label>
        <input id="f-url" type="url" placeholder="https://notion.so/...">
      </div>
    </div>
    <button class="submit-btn" onclick="addContrib()">Add &amp; Save</button>
    <div id="form-msg"></div>
  </div>

  <!-- Coverage grid -->
  <div class="section-label">Concept Coverage</div>
  <div class="concepts-grid" id="concepts-grid"></div>
</main>

<script>
let mod = null, contribs = [], pendingPush = false;

async function loadModule(url) {
  const [mRes, cRes] = await Promise.all([fetch(url), fetch('/contributions')]);
  mod = await mRes.json();
  contribs = await cRes.json();
  document.getElementById('mod-label').textContent = mod.module;
  renderAll();
}

function renderAll() {
  renderStats();
  renderConceptSelect();
  renderGrid();
}

function renderStats() {
  const coveredIds = new Set(contribs.map(c => c.concept_id));
  document.getElementById('stat-covered').textContent  = coveredIds.size;
  document.getElementById('stat-total').textContent    = mod.concepts.length;
  document.getElementById('stat-contribs').textContent = contribs.length;
  const authors = new Set(contribs.map(c => c.author));
  document.getElementById('stat-authors').textContent  = authors.size;
}

function renderConceptSelect() {
  const sel = document.getElementById('f-concept');
  sel.innerHTML = mod.concepts.map(c =>
    `<option value="${c.id}">${c.name}</option>`
  ).join('');
}

function renderGrid() {
  const grid = document.getElementById('concepts-grid');
  const coveredIds = new Set(contribs.map(c => c.concept_id));
  grid.innerHTML = mod.concepts.map(c => {
    const myContribs = contribs.filter(x => x.concept_id === c.id);
    const covered = myContribs.length > 0;
    const dot = covered ? '#16a34a' : '#475569';
    const links = myContribs.map(x =>
      `<a class="card-contrib-link" href="${x.url}" target="_blank">↗ ${x.author}: ${x.title}</a>`
    ).join('');
    return `<div class="concept-card ${covered ? 'covered' : ''}">
      <div class="card-top">
        <div class="card-dot" style="background:${dot}"></div>
        <span class="card-name">${c.name}</span>
      </div>
      <div class="card-level">Level ${c.level} · ${c.tags.join(', ')}</div>
      <div class="card-contribs">${myContribs.length} contribution${myContribs.length!==1?'s':''}</div>
      ${links}
    </div>`;
  }).join('');
}

async function addContrib() {
  const entry = {
    concept_id: document.getElementById('f-concept').value,
    author:     document.getElementById('f-author').value.trim(),
    title:      document.getElementById('f-title').value.trim(),
    url:        document.getElementById('f-url').value.trim()
  };
  if (!entry.author || !entry.title || !entry.url) {
    showMsg('Fill in all fields.', '#dc2626'); return;
  }
  const res = await fetch('/add', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify(entry)
  });
  const j = await res.json();
  if (j.ok) {
    contribs = j.contributions;
    renderAll();
    document.getElementById('f-author').value = '';
    document.getElementById('f-title').value  = '';
    document.getElementById('f-url').value    = '';
    showMsg('Saved to contributions.json — push to deploy.', '#16a34a');
    setPushReady(true);
  } else {
    showMsg(j.error, '#dc2626');
  }
}

async function removeContrib(idx) {
  const res = await fetch('/remove', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({index: idx})
  });
  const j = await res.json();
  if (j.ok) { contribs = j.contributions; renderAll(); setPushReady(true); }
}

function showMsg(text, color) {
  const el = document.getElementById('form-msg');
  el.textContent = text; el.style.color = color; el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 4000);
}

function setPushReady(yes) {
  pendingPush = yes;
  const btn = document.getElementById('push-btn');
  btn.textContent = yes ? '⬆ Push to GitHub →' : 'Push to GitHub →';
  btn.style.background = yes ? '#ca8a04' : '';
}

async function gitPush() {
  const btn = document.getElementById('push-btn');
  const status = document.getElementById('push-status');
  btn.disabled = true; btn.textContent = 'Pushing…';
  status.textContent = '';
  const res = await fetch('/push', {method:'POST'});
  const j = await res.json();
  btn.disabled = false;
  if (j.ok) {
    btn.textContent = '✓ Pushed';
    btn.style.background = '#16a34a';
    status.textContent = 'Live in ~60 seconds';
    status.style.color = '#4ade80';
    setPushReady(false);
    setTimeout(() => { btn.textContent = 'Push to GitHub →'; btn.style.background=''; status.textContent=''; }, 6000);
  } else {
    btn.textContent = '✗ Push failed';
    btn.style.background = '#dc2626';
    status.textContent = j.error;
    status.style.color = '#f87171';
    setTimeout(() => { btn.textContent = 'Push to GitHub →'; btn.style.background=''; }, 6000);
  }
}

// boot
loadModule(document.getElementById('module-sel').value);
</script>
</body>
</html>
"""

# ── request handler ───────────────────────────────────────────────────────────
class Handler(http.server.BaseHTTPRequestHandler):

    def log_message(self, fmt, *args):
        pass  # silence default access log

    def send_json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', len(body))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def send_html(self, html):
        body = html.encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', len(body))
        self.end_headers()
        self.wfile.write(body)

    def serve_file(self, path: Path, content_type: str):
        if not path.exists():
            self.send_response(404); self.end_headers(); return
        body = path.read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', len(body))
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        length = int(self.headers.get('Content-Length', 0))
        return json.loads(self.rfile.read(length)) if length else {}

    # ── routing ──────────────────────────────────────────────────────────────
    def do_GET(self):
        p = self.path.split('?')[0]

        if p in ('/', '/admin', '/admin.html'):
            self.send_html(HTML)

        elif p == '/contributions':
            c_path = BASE / 'contributions.json'
            data = json.loads(c_path.read_text()) if c_path.exists() else []
            self.send_json(data)

        elif p.startswith('/modules/') and p.endswith('.json'):
            self.serve_file(BASE / p.lstrip('/'), 'application/json')

        elif p.startswith('/') and (BASE / p.lstrip('/')).exists():
            ext = p.rsplit('.', 1)[-1] if '.' in p else ''
            ct = {'html':'text/html','css':'text/css','js':'application/javascript',
                  'json':'application/json'}.get(ext, 'application/octet-stream')
            self.serve_file(BASE / p.lstrip('/'), ct)
        else:
            self.send_response(404); self.end_headers()

    def do_POST(self):
        p = self.path

        if p == '/add':
            entry = self.read_body()
            required = ('concept_id', 'author', 'title', 'url')
            if not all(entry.get(k, '').strip() for k in required):
                self.send_json({'ok': False, 'error': 'Missing fields'}); return
            c_path = BASE / 'contributions.json'
            data = json.loads(c_path.read_text()) if c_path.exists() else []
            data.append({k: entry[k].strip() for k in required})
            c_path.write_text(json.dumps(data, indent=2))
            self.send_json({'ok': True, 'contributions': data})

        elif p == '/remove':
            body = self.read_body()
            idx = body.get('index')
            c_path = BASE / 'contributions.json'
            data = json.loads(c_path.read_text()) if c_path.exists() else []
            if isinstance(idx, int) and 0 <= idx < len(data):
                data.pop(idx)
                c_path.write_text(json.dumps(data, indent=2))
                self.send_json({'ok': True, 'contributions': data})
            else:
                self.send_json({'ok': False, 'error': 'Bad index'})

        elif p == '/push':
            try:
                result = subprocess.run(
                    ['git', 'add', 'contributions.json'],
                    cwd=BASE, capture_output=True, text=True, timeout=15
                )
                result = subprocess.run(
                    ['git', 'commit', '-m', 'Update contributions'],
                    cwd=BASE, capture_output=True, text=True, timeout=15
                )
                # nothing to commit is fine
                result = subprocess.run(
                    ['git', 'push'],
                    cwd=BASE, capture_output=True, text=True, timeout=30
                )
                if result.returncode == 0:
                    self.send_json({'ok': True})
                else:
                    err = result.stderr.strip() or result.stdout.strip()
                    self.send_json({'ok': False, 'error': err})
            except subprocess.TimeoutExpired:
                self.send_json({'ok': False, 'error': 'Git push timed out'})
            except FileNotFoundError:
                self.send_json({'ok': False, 'error': 'git not found — is git installed?'})
        else:
            self.send_response(404); self.end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()


# ── main ─────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    os.chdir(BASE)
    server = http.server.HTTPServer(('', PORT), Handler)
    print(f'\n  Navigator Admin running at  http://localhost:{PORT}')
    print(f'  Student navigator at        http://localhost:{PORT}/index.html')
    print(f'\n  Ctrl+C to stop\n')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n  Stopped.')
