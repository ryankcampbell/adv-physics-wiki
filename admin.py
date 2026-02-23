#!/usr/bin/env python3
"""
NWA Physics Navigator — Admin Server
Run:  python3 admin.py
Open: http://localhost:8080
"""

import http.server, json, os, re, subprocess, base64
from pathlib import Path

PORT = 8080
BASE = Path(__file__).parent

# ── helpers ──────────────────────────────────────────────────────────────────

def slugify(text):
    return re.sub(r'[^a-z0-9]+', '_', text.lower()).strip('_')

def load_contributions():
    p = BASE / 'contributions.json'
    return json.loads(p.read_text()) if p.exists() else []

def save_contributions(data):
    (BASE / 'contributions.json').write_text(json.dumps(data, indent=2))

def git_push():
    for cmd in [
        ['git', 'add', '-A'],
        ['git', 'commit', '-m', 'Publish student contribution'],
        ['git', 'push', 'origin', 'main'],
    ]:
        r = subprocess.run(cmd, cwd=BASE, capture_output=True, text=True, timeout=30)
        if r.returncode != 0 and 'nothing to commit' not in r.stdout:
            if cmd[1] != 'commit':
                return False, r.stderr.strip() or r.stdout.strip()
    return True, ''

# ── HTML (served at /) ───────────────────────────────────────────────────────

HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Navigator Admin</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
     background:#0f172a;color:#e2e8f0;min-height:100vh;display:flex;flex-direction:column}

/* HEADER */
header{background:#1e3a5f;padding:12px 24px;display:flex;align-items:center;
       gap:12px;border-bottom:1px solid rgba(255,255,255,.08);flex-shrink:0}
header h1{font-size:.95rem;font-weight:700;letter-spacing:-.01em}
.mod-sel{background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);
         color:white;border-radius:6px;padding:4px 10px;font-size:.78rem;cursor:pointer}
#live-link{font-size:.75rem;color:rgba(255,255,255,.45);text-decoration:none;margin-left:4px}
#live-link:hover{color:rgba(255,255,255,.8)}
#push-wrap{margin-left:auto;display:flex;align-items:center;gap:10px}
#push-status{font-size:.75rem;color:#4ade80}
#push-btn{background:#16a34a;color:white;border:none;border-radius:7px;
          padding:7px 16px;font-size:.8rem;cursor:pointer;transition:background .15s;white-space:nowrap}
#push-btn:hover{background:#15803d}
#push-btn:disabled{background:#334155;cursor:default}

/* LAYOUT */
.page{display:flex;flex:1;min-height:0;overflow:hidden}

/* SIDEBAR */
.sidebar{width:240px;flex-shrink:0;background:#1e293b;border-right:1px solid rgba(255,255,255,.06);
         display:flex;flex-direction:column;overflow-y:auto;padding:16px}
.stat-row{display:flex;justify-content:space-between;align-items:baseline;
          padding:6px 0;border-bottom:1px solid rgba(255,255,255,.05)}
.stat-row:last-child{border:none}
.stat-label{font-size:.75rem;color:#64748b}
.stat-val{font-size:1.1rem;font-weight:700;color:#38bdf8}
.cov-bar-track{background:rgba(255,255,255,.08);border-radius:3px;height:4px;
               margin:12px 0 4px;overflow:hidden}
.cov-bar-fill{background:#16a34a;height:100%;border-radius:3px;transition:width .5s}
.cov-text{font-size:.72rem;color:#475569;margin-bottom:14px}
.sidebar-label{font-size:.65rem;font-weight:700;text-transform:uppercase;
               letter-spacing:.1em;color:#475569;margin:14px 0 8px}

/* concept list in sidebar */
.concept-row{display:flex;align-items:center;gap:7px;padding:5px 6px;
             border-radius:5px;cursor:pointer;transition:background .12s}
.concept-row:hover{background:rgba(255,255,255,.05)}
.concept-row.active{background:rgba(37,99,235,.2)}
.c-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.c-name{font-size:.78rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
.c-count{font-size:.68rem;color:#475569}

/* MAIN */
.main{flex:1;overflow-y:auto;padding:24px 28px}

/* PUBLISH CARD */
.publish-card{background:#1e293b;border:1px solid rgba(255,255,255,.07);
              border-radius:12px;padding:22px 24px;margin-bottom:24px}
.card-title{font-size:.68rem;font-weight:700;text-transform:uppercase;
            letter-spacing:.1em;color:#64748b;margin-bottom:16px}

.publish-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;align-items:start}

/* drop zone */
#drop-zone{border:2px dashed #334155;border-radius:10px;
           min-height:160px;display:flex;flex-direction:column;
           align-items:center;justify-content:center;gap:8px;
           cursor:pointer;transition:all .2s;padding:20px;text-align:center}
#drop-zone:hover,#drop-zone.drag-over{border-color:#2563eb;background:rgba(37,99,235,.07)}
#drop-zone.has-file{border-color:#16a34a;background:rgba(22,163,74,.07)}
.drop-icon{font-size:2rem;line-height:1}
.drop-label{font-size:.85rem;color:#94a3b8}
.drop-sub{font-size:.75rem;color:#475569}
.file-name{font-size:.82rem;color:#4ade80;font-weight:500;word-break:break-all}
#file-input{display:none}

/* form fields */
.fields{display:flex;flex-direction:column;gap:10px}
.field label{font-size:.72rem;color:#64748b;display:block;margin-bottom:3px}
.field input,.field select{width:100%;background:#0f172a;border:1px solid #334155;
  border-radius:6px;padding:8px 10px;color:#e2e8f0;font-size:.83rem;
  font-family:inherit;transition:border-color .15s}
.field input:focus,.field select:focus{outline:none;border-color:#2563eb}

#publish-btn{width:100%;background:#2563eb;color:white;border:none;border-radius:8px;
             padding:11px;font-size:.88rem;font-weight:600;cursor:pointer;
             transition:all .15s;margin-top:4px}
#publish-btn:hover{background:#1d4ed8}
#publish-btn:disabled{background:#334155;cursor:default}
#pub-status{font-size:.8rem;margin-top:10px;display:none;
            padding:8px 12px;border-radius:6px;text-align:center}
#pub-status.ok{background:rgba(22,163,74,.15);color:#4ade80}
#pub-status.err{background:rgba(220,38,38,.15);color:#f87171}

/* CONTRIBUTIONS TABLE */
.contrib-table{width:100%;border-collapse:collapse}
.contrib-table th{text-align:left;font-size:.68rem;font-weight:700;text-transform:uppercase;
                  letter-spacing:.08em;color:#475569;padding:6px 10px;
                  border-bottom:1px solid #1e293b}
.contrib-table td{padding:10px 10px;border-bottom:1px solid rgba(255,255,255,.04);
                  font-size:.82rem;vertical-align:middle}
.contrib-table tr:hover td{background:rgba(255,255,255,.02)}
.contrib-table a{color:#38bdf8;text-decoration:none}
.contrib-table a:hover{text-decoration:underline}
.concept-badge{background:#0f172a;border:1px solid #334155;border-radius:4px;
               padding:2px 7px;font-size:.7rem;color:#94a3b8}
.del-btn{background:transparent;border:1px solid #334155;color:#64748b;
         border-radius:5px;padding:3px 9px;font-size:.72rem;cursor:pointer;transition:all .15s}
.del-btn:hover{border-color:#dc2626;color:#dc2626}
.empty-msg{color:#475569;font-size:.85rem;padding:20px 0}
</style>
</head>
<body>

<header>
  <h1>Navigator Admin</h1>
  <select class="mod-sel" id="mod-sel" onchange="loadModule(this.value)">
    <option value="modules/quantum_spin.json">Quantum Spin</option>
    <option value="modules/special_relativity.json">Special Relativity</option>
  </select>
  <a id="live-link" href="https://ryankcampbell.github.io/adv-physics-wiki"
     target="_blank">↗ Live site</a>
  <div id="push-wrap">
    <span id="push-status"></span>
    <button id="push-btn" onclick="gitPush()">Push to GitHub →</button>
  </div>
</header>

<div class="page">

  <!-- SIDEBAR -->
  <div class="sidebar">
    <div class="stat-row"><span class="stat-label">Covered</span><span class="stat-val" id="s-cov">—</span></div>
    <div class="stat-row"><span class="stat-label">Total concepts</span><span class="stat-val" id="s-tot">—</span></div>
    <div class="stat-row"><span class="stat-label">Contributions</span><span class="stat-val" id="s-con">—</span></div>
    <div class="stat-row"><span class="stat-label">Contributors</span><span class="stat-val" id="s-aut">—</span></div>
    <div class="cov-bar-track"><div class="cov-bar-fill" id="cov-bar" style="width:0%"></div></div>
    <div class="cov-text" id="cov-text">—</div>

    <div class="sidebar-label">Concepts</div>
    <div id="concept-list"></div>
  </div>

  <!-- MAIN -->
  <div class="main">

    <!-- PUBLISH -->
    <div class="publish-card">
      <div class="card-title">Publish Student Contribution</div>
      <div class="publish-grid">

        <!-- Drop zone -->
        <div>
          <div id="drop-zone" onclick="document.getElementById('file-input').click()">
            <div class="drop-icon">📄</div>
            <div class="drop-label">Drop student's HTML file here</div>
            <div class="drop-sub">or click to browse</div>
          </div>
          <input type="file" id="file-input" accept=".html" onchange="onFileSelected(this.files[0])">
        </div>

        <!-- Fields -->
        <div class="fields">
          <div class="field">
            <label>Concept</label>
            <select id="f-concept"></select>
          </div>
          <div class="field">
            <label>Author(s)</label>
            <input id="f-author" type="text" placeholder="e.g. Marcus Chen">
          </div>
          <div class="field">
            <label>Contribution title</label>
            <input id="f-title" type="text" placeholder="e.g. Proper Time Along a Worldline">
          </div>
          <button id="publish-btn" onclick="publish()" disabled>
            Select a file to publish
          </button>
          <div id="pub-status"></div>
        </div>

      </div>
    </div>

    <!-- CONTRIBUTIONS -->
    <div class="publish-card">
      <div class="card-title">Published Contributions</div>
      <div id="contrib-area"></div>
    </div>

  </div><!-- /main -->
</div><!-- /page -->

<script>
let mod = null, contribs = [], fileData = null, fileName = null;

// ── drop zone ────────────────────────────────────────────────────────────────
const dz = document.getElementById('drop-zone');
dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over'); });
dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
dz.addEventListener('drop', e => {
  e.preventDefault(); dz.classList.remove('drag-over');
  const f = e.dataTransfer.files[0];
  if (f) onFileSelected(f);
});

function onFileSelected(file) {
  if (!file || !file.name.endsWith('.html')) {
    alert('Please select an .html file.'); return;
  }
  fileName = file.name;
  const reader = new FileReader();
  reader.onload = e => {
    fileData = e.target.result; // base64 data URL
    dz.innerHTML = `<div class="drop-icon">✅</div>
      <div class="file-name">${fileName}</div>
      <div class="drop-sub" style="margin-top:4px">Click to change</div>`;
    dz.classList.add('has-file');
    document.getElementById('publish-btn').disabled = false;
    document.getElementById('publish-btn').textContent = 'Publish & Push to GitHub →';
  };
  reader.readAsDataURL(file);
}

// ── module loading ───────────────────────────────────────────────────────────
async function loadModule(url) {
  const [mRes, cRes] = await Promise.all([fetch(url), fetch('/contributions')]);
  mod = await mRes.json();
  contribs = await cRes.json();
  renderSidebar();
  renderConceptSelect();
  renderContribTable();
}

function renderSidebar() {
  const coveredIds = new Set(contribs.map(c => c.concept_id));
  const n = coveredIds.size, t = mod.concepts.length;
  document.getElementById('s-cov').textContent = n;
  document.getElementById('s-tot').textContent = t;
  document.getElementById('s-con').textContent = contribs.length;
  document.getElementById('s-aut').textContent = new Set(contribs.map(c => c.author)).size;
  document.getElementById('cov-bar').style.width = (t ? Math.round(n/t*100) : 0) + '%';
  document.getElementById('cov-text').textContent = `${n} of ${t} concepts covered`;

  const list = document.getElementById('concept-list');
  list.innerHTML = mod.concepts.map(c => {
    const mine = contribs.filter(x => x.concept_id === c.id);
    const col = mine.length ? '#16a34a' : '#334155';
    return `<div class="concept-row" onclick="document.getElementById('f-concept').value='${c.id}'">
      <div class="c-dot" style="background:${col}"></div>
      <span class="c-name" title="${c.name}">${c.name}</span>
      <span class="c-count">${mine.length||''}</span>
    </div>`;
  }).join('');
}

function renderConceptSelect() {
  document.getElementById('f-concept').innerHTML =
    mod.concepts.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
}

function renderContribTable() {
  const el = document.getElementById('contrib-area');
  if (!contribs.length) {
    el.innerHTML = '<p class="empty-msg">No contributions yet.</p>'; return;
  }
  el.innerHTML = `<table class="contrib-table">
    <thead><tr>
      <th>Concept</th><th>Author</th><th>Title</th><th>Link</th><th></th>
    </tr></thead>
    <tbody>${contribs.map((c, i) => `
      <tr>
        <td><span class="concept-badge">${c.concept_id}</span></td>
        <td>${c.author}</td>
        <td>${c.title}</td>
        <td><a href="${c.url}" target="_blank">↗ View</a></td>
        <td><button class="del-btn" onclick="remove(${i})">Remove</button></td>
      </tr>`).join('')}
    </tbody>
  </table>`;
}

// ── publish ──────────────────────────────────────────────────────────────────
async function publish() {
  const conceptId = document.getElementById('f-concept').value;
  const author    = document.getElementById('f-author').value.trim();
  const title     = document.getElementById('f-title').value.trim();

  if (!fileData) { showPubStatus('No file selected.', false); return; }
  if (!author)   { showPubStatus('Enter the author name.', false); return; }
  if (!title)    { showPubStatus('Enter a title.', false); return; }

  const btn = document.getElementById('publish-btn');
  btn.disabled = true; btn.textContent = 'Publishing…';

  const res = await fetch('/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      concept_id: conceptId,
      author, title,
      file_data: fileData,   // base64 data URL
      file_name: fileName
    })
  });
  const j = await res.json();

  btn.disabled = false;
  btn.textContent = 'Publish & Push to GitHub →';

  if (j.ok) {
    contribs = j.contributions;
    renderSidebar();
    renderContribTable();
    showPubStatus(`✓ Published and pushed — live in ~60 seconds`, true);
    // Reset drop zone
    fileData = null; fileName = null;
    dz.classList.remove('has-file');
    dz.innerHTML = `<div class="drop-icon">📄</div>
      <div class="drop-label">Drop student's HTML file here</div>
      <div class="drop-sub">or click to browse</div>`;
    btn.disabled = true;
    btn.textContent = 'Select a file to publish';
    document.getElementById('f-author').value = '';
    document.getElementById('f-title').value = '';
  } else {
    showPubStatus('Error: ' + j.error, false);
  }
}

async function remove(idx) {
  if (!confirm('Remove this contribution?')) return;
  const res = await fetch('/remove', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ index: idx })
  });
  const j = await res.json();
  if (j.ok) { contribs = j.contributions; renderSidebar(); renderContribTable(); }
}

function showPubStatus(msg, ok) {
  const el = document.getElementById('pub-status');
  el.textContent = msg;
  el.className = ok ? 'ok' : 'err';
  el.style.display = 'block';
  if (ok) setTimeout(() => el.style.display = 'none', 8000);
}

// ── git push ─────────────────────────────────────────────────────────────────
async function gitPush() {
  const btn = document.getElementById('push-btn');
  const st  = document.getElementById('push-status');
  btn.disabled = true; btn.textContent = 'Pushing…'; st.textContent = '';
  const j = await (await fetch('/push', { method: 'POST' })).json();
  btn.disabled = false;
  if (j.ok) {
    btn.textContent = '✓ Pushed'; st.textContent = 'Live in ~60 s';
    setTimeout(() => { btn.textContent = 'Push to GitHub →'; st.textContent = ''; }, 8000);
  } else {
    btn.textContent = '✗ Failed'; st.textContent = j.error;
    st.style.color = '#f87171';
    setTimeout(() => { btn.textContent = 'Push to GitHub →'; st.textContent = ''; st.style.color='#4ade80'; }, 8000);
  }
}

loadModule(document.getElementById('mod-sel').value);
</script>
</body>
</html>
"""

# ── request handler ───────────────────────────────────────────────────────────
class Handler(http.server.BaseHTTPRequestHandler):

    def log_message(self, fmt, *args): pass

    def send_json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', len(body))
        self.end_headers()
        self.wfile.write(body)

    def send_html(self, html):
        body = html.encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', len(body))
        self.end_headers()
        self.wfile.write(body)

    def serve_file(self, path: Path):
        if not path.exists():
            self.send_response(404); self.end_headers(); return
        ext = path.suffix.lstrip('.')
        ct  = {'html':'text/html','css':'text/css','js':'application/javascript',
               'json':'application/json'}.get(ext, 'application/octet-stream')
        body = path.read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', ct)
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
            self.send_json(load_contributions())
        else:
            candidate = BASE / p.lstrip('/')
            if candidate.exists() and candidate.is_file():
                self.serve_file(candidate)
            else:
                self.send_response(404); self.end_headers()

    def do_POST(self):
        p    = self.path
        body = self.read_body()

        # ── publish: save file + update contributions.json + git push ────────
        if p == '/publish':
            required = ('concept_id', 'author', 'title', 'file_data')
            if not all(body.get(k, '').strip() if k != 'file_data' else body.get(k)
                       for k in required):
                self.send_json({'ok': False, 'error': 'Missing fields'}); return

            concept_id = body['concept_id']
            author     = body['author'].strip()
            title      = body['title'].strip()
            file_data  = body['file_data']  # base64 data URL: data:text/html;base64,...

            # Decode HTML content
            try:
                _, b64 = file_data.split(',', 1)
                html_bytes = base64.b64decode(b64)
            except Exception as e:
                self.send_json({'ok': False, 'error': f'Could not decode file: {e}'}); return

            # Determine output path — use concept_id as folder,
            # append author slug if folder already taken by a different author
            author_slug = slugify(author)
            ic_dir = BASE / 'ics' / concept_id
            if ic_dir.exists():
                existing = load_contributions()
                same_author = any(
                    c['concept_id'] == concept_id and slugify(c['author']) == author_slug
                    for c in existing
                )
                if not same_author:
                    ic_dir = BASE / 'ics' / f'{concept_id}_{author_slug}'

            ic_dir.mkdir(parents=True, exist_ok=True)
            (ic_dir / 'index.html').write_bytes(html_bytes)

            # Build the public URL (relative to repo root)
            rel = ic_dir.relative_to(BASE)
            url = f'https://ryankcampbell.github.io/adv-physics-wiki/{rel}/'

            # Update contributions.json
            data = load_contributions()
            data.append({
                'concept_id': concept_id,
                'author':     author,
                'title':      title,
                'url':        url
            })
            save_contributions(data)

            # Git push
            ok, err = git_push()
            if not ok:
                self.send_json({'ok': False, 'error': f'Saved locally but push failed: {err}'}); return

            self.send_json({'ok': True, 'contributions': data, 'url': url})

        # ── remove ───────────────────────────────────────────────────────────
        elif p == '/remove':
            idx  = body.get('index')
            data = load_contributions()
            if isinstance(idx, int) and 0 <= idx < len(data):
                data.pop(idx)
                save_contributions(data)
                self.send_json({'ok': True, 'contributions': data})
            else:
                self.send_json({'ok': False, 'error': 'Bad index'})

        # ── standalone push ──────────────────────────────────────────────────
        elif p == '/push':
            ok, err = git_push()
            self.send_json({'ok': ok, 'error': err})

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
    print(f'\n  Navigator Admin →  http://localhost:{PORT}')
    print(f'  Student navigator →  http://localhost:{PORT}/index.html')
    print(f'\n  Ctrl+C to stop\n')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n  Stopped.')
