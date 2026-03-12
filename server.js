require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const app = express();
app.use(express.json({ limit: '20mb' }));

// ── Content Security Policy ────────────────────────────────────────
// Prevents browsers from executing scripts or making network requests
// outside of our server and the explicitly trusted physics CDNs.
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' cdn.jsdelivr.net cdnjs.cloudflare.com unpkg.com cdn.plot.ly; " +
    "style-src 'self' 'unsafe-inline' cdn.jsdelivr.net cdnjs.cloudflare.com unpkg.com; " +
    "img-src 'self' data: blob:; " +
    "font-src 'self' cdnjs.cloudflare.com; " +
    "connect-src 'self'; " +        // allows fetch to our own /api/* only
    "frame-src 'self' blob:; " +    // allows blob: URLs in iframes (admin draft preview)
    "frame-ancestors 'self';"       // prevents clickjacking
  );
  next();
});

app.use(express.static(__dirname));

// ── Google Drive auth ──────────────────────────────────────────────
const auth = new google.auth.GoogleAuth({
  keyFile: process.env.GOOGLE_KEY_FILE || 'credentials.json',
  scopes: ['https://www.googleapis.com/auth/drive.readonly'],
});
const drive = google.drive({ version: 'v3', auth });

// ── Admin auth ─────────────────────────────────────────────────────
const adminSessions = new Map();
function requireAdmin(req, res, next) {
  const token = req.headers.authorization?.slice(7);
  if (!token || !adminSessions.has(token)) return res.status(401).json({ error: 'Admin auth required' });
  next();
}
app.post('/api/admin/auth', (req, res) => {
  const { password } = req.body;
  const adminPw = readSimSettings().adminPassword || 'admin';
  if (password !== adminPw) return res.status(401).json({ error: 'Wrong password' });
  const token = require('crypto').randomUUID();
  adminSessions.set(token, true);
  res.json({ token });
});
app.get('/api/admin/verify', (req, res) => {
  const token = req.headers.authorization?.slice(7);
  res.json({ ok: !!(token && adminSessions.has(token)) });
});

// ── Dismissed file IDs ─────────────────────────────────────────────
const DISMISSED_PATH = path.join(__dirname, 'state', 'dismissed.json');
function readDismissed() {
  try { return JSON.parse(fs.readFileSync(DISMISSED_PATH, 'utf8')); } catch { return []; }
}
function writeDismissed(ids) {
  fs.writeFileSync(DISMISSED_PATH, JSON.stringify(ids, null, 2));
}

// ── ICs folder ID (set DRIVE_FOLDER_ID in .env) ───────────────────
function getIcsFolderId() {
  const id = process.env.DRIVE_FOLDER_ID;
  if (!id) throw new Error('DRIVE_FOLDER_ID not set in .env — paste the folder ID from your Drive URL.');
  return id;
}

// ── Determine submission type from filename ────────────────────────
function getFileType(filename) {
  const lower = (filename || '').toLowerCase();
  if (lower.startsWith('at_')) return 'at';
  if (lower.startsWith('hw_')) return 'hw';
  return 'ic';
}

// ── Load all known concept IDs from module JSON files ─────────────
function getKnownConceptIds() {
  const modulesDir = path.join(__dirname, 'modules');
  const ids = new Set();
  if (fs.existsSync(modulesDir)) {
    fs.readdirSync(modulesDir)
      .filter(f => f.endsWith('.json'))
      .forEach(f => {
        try {
          const mod = JSON.parse(fs.readFileSync(path.join(modulesDir, f), 'utf8'));
          (mod.concepts || []).forEach(c => { if (c.id) ids.add(c.id); });
        } catch (_) {}
      });
  }
  return ids;
}

// ── Parse concept_id and author from new filename format ──────────
// New format: IC_{concept_id}_{author}.html  (same for AT_ and HW_)
function parseSubmission(filename) {
  const base = (filename || '').replace(/\.html$/i, '').toLowerCase();
  const knownIds = getKnownConceptIds();

  for (const type of ['ic', 'at', 'hw']) {
    if (!base.startsWith(type + '_')) continue;
    const rest = base.slice(type.length + 1); // e.g. "em_waves_max_brunsfeld"
    for (const conceptId of knownIds) {
      if (rest.startsWith(conceptId + '_')) {
        const rawAuthor = rest.slice(conceptId.length + 1).replace(/_/g, ' ');
        const author = rawAuthor.replace(/\b\w/g, c => c.toUpperCase());
        return { type, conceptId, author };
      }
    }
  }
  return { type: getFileType(filename), conceptId: null, author: null };
}

// ── Auto-update state.json when new Drive files are detected ──────
// Called on every inbox poll; only fires a git push when state changes.
function autoProcessNewFiles(files) {
  const seenPath  = path.join(__dirname, 'state', 'seen_files.json');
  const statePath = path.join(__dirname, 'state', 'state.json');

  let seen = new Set(
    fs.existsSync(seenPath) ? JSON.parse(fs.readFileSync(seenPath, 'utf8')) : []
  );
  const newFiles = files.filter(f => !seen.has(f.id));

  // Always persist seen IDs so we don't re-check on next poll
  newFiles.forEach(f => seen.add(f.id));
  fs.mkdirSync(path.join(__dirname, 'state'), { recursive: true });
  fs.writeFileSync(seenPath, JSON.stringify([...seen], null, 2));

  if (!newFiles.length) return false;

  let state = fs.existsSync(statePath)
    ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : [];
  const original = JSON.stringify(state);

  newFiles.forEach(f => {
    const { type, conceptId, author } = parseSubmission(f.name);
    if (!conceptId) return; // old filename format — skip auto-state

    let idx   = state.findIndex(s => s.concept_id === conceptId);
    let entry = idx >= 0 ? { ...state[idx] } : { concept_id: conceptId };

    if (type === 'ic') {
      if (entry.status === 'certified') return; // never auto-demote certified
      entry.status = 'submitted';
      if (author) entry.claimed_by = author;
      delete entry.feedback; // clear revision note — new file supersedes it
    } else if (type === 'at') {
      if (!entry.at_status || entry.at_status === 'dismissed') {
        entry.at_status = 'submitted';
      }
    } else if (type === 'hw') {
      if (!entry.hw_status) entry.hw_status = 'submitted';
    }

    if (idx >= 0) state[idx] = entry; else state.push(entry);
  });

  if (JSON.stringify(state) === original) return false;

  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  try {
    const token = process.env.GITHUB_TOKEN;
    const user  = process.env.GITHUB_USER || 'ryankcampbell';
    const repo  = process.env.GITHUB_REPO || 'adv-physics-wiki';
    execSync('git add state/state.json', { cwd: __dirname });
    execSync('git commit -m "Auto-state: new Drive submission detected"', { cwd: __dirname });
    if (token) execSync(`git remote set-url origin https://${user}:${token}@github.com/${user}/${repo}.git`, { cwd: __dirname });
    execSync('git push', { cwd: __dirname });
    if (token) execSync(`git remote set-url origin https://github.com/${user}/${repo}.git`, { cwd: __dirname });
    console.log('Auto-state: pushed state.json update');
  } catch (e) {
    console.error('Auto-state push failed (state written locally):', e.message);
  }
  return true;
}

// ── List files in Drive ICs folder ────────────────────────────────
app.get('/api/drive/pending', async (req, res) => {
  try {
    const folderId = getIcsFolderId();
    const result = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      fields: 'files(id, name, createdTime, modifiedTime)',
      orderBy: 'modifiedTime desc',
    });
    const files = (result.data.files || []).map(f => ({
      ...f,
      type: getFileType(f.name),
    }));
    // Auto-update state.json for any new files with parseable concept IDs
    try { autoProcessNewFiles(files); } catch (e) { console.error('auto-state:', e.message); }
    const dismissed = readDismissed();
    if (req.query.all === '1') {
      res.json(files.map(f => dismissed.includes(f.id) ? { ...f, dismissed: true } : f));
    } else {
      res.json(files.filter(f => !dismissed.includes(f.id)));
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Dismiss / restore a file from the inbox ────────────────────────
app.post('/api/drive/dismiss', requireAdmin, (req, res) => {
  const { fileId } = req.body;
  if (!fileId) return res.status(400).json({ error: 'Missing fileId' });
  const ids = readDismissed();
  if (!ids.includes(fileId)) { ids.push(fileId); writeDismissed(ids); }
  res.json({ ok: true });
});

app.post('/api/drive/undismiss', requireAdmin, (req, res) => {
  const { fileId } = req.body;
  if (!fileId) return res.status(400).json({ error: 'Missing fileId' });
  writeDismissed(readDismissed().filter(id => id !== fileId));
  res.json({ ok: true });
});

// ── Preview a Drive file inline ────────────────────────────────────
app.get('/api/drive/preview/:fileId', async (req, res) => {
  try {
    const result = await drive.files.get(
      { fileId: req.params.fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'text' }
    );
    res.setHeader('Content-Type', 'text/html');
    res.send(result.data);
  } catch (e) {
    res.status(500).send(`<p style="color:red;padding:20px">Error loading preview: ${e.message}</p>`);
  }
});

// ── Review: download → save → update state/workflow/contributions → git push ──
//
// New pipeline semantics:
//   IC  + approve  → save file, add type='ic-draft' to contributions.json, advance workflow to AT
//   AT  + approve  → save file, advance workflow to HW (no contributions.json change)
//   HW  + approve  → save file, flip ic-draft→ic (node turns green), advance workflow to complete
//   any + revision → save file, write feedback to BOTH state.json AND workflow.json
//
app.post('/api/publish', requireAdmin, async (req, res) => {
  const { fileId, conceptId, label, decision, feedback } = req.body;
  if (!fileId || !conceptId) return res.status(400).json({ error: 'Missing fileId or conceptId' });

  const safeLabel = (label || '').replace(/[^a-z0-9_-]/gi, '').toLowerCase() || 'index';
  const fileType  = getFileType(safeLabel);  // 'ic' / 'at' / 'hw'
  const isRevision = decision === 'revision';

  // Reuse existing filename if available (prevents duplicate entries on re-submission)
  const contribPath = path.join(__dirname, 'contributions.json');
  const existingContribs = fs.existsSync(contribPath)
    ? JSON.parse(fs.readFileSync(contribPath, 'utf8')) : [];
  const existingIcEntry = existingContribs.find(
    c => c.concept_id === conceptId && (c.type === 'ic' || c.type === 'ic-draft')
  );
  const existingFilename = (fileType === 'ic' && existingIcEntry)
    ? existingIcEntry.url.split('/').pop() : null;
  const filename = existingFilename || (safeLabel + '.html');

  try {
    // 1. Download HTML from Drive
    const result = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'text' }
    );
    const html = result.data;

    // 2. Write to ics/[conceptId]/[filename]
    const dir = path.join(__dirname, 'ics', conceptId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), html);

    // 3. Extract title & author from HTML
    const titleRe = fileType === 'at' ? /<title>AT:\s*([^|<]+)/i
                  : fileType === 'hw' ? /<title>HW:\s*([^|<]+)/i
                  :                     /<title>IC:\s*([^|<]+)/i;
    const titleM  = html.match(titleRe);
    const authorM = html.match(/by\s+([^<]+)<\/span>/i);
    const entryTitle  = titleM  ? titleM[1].trim()  : conceptId.replace(/_/g, ' ');
    const entryAuthor = authorM ? authorM[1].trim()  : (label || 'Unknown');
    const entryUrl    = `https://ryankcampbell.github.io/adv-physics-wiki/ics/${conceptId}/${filename}`;

    // 4. Update state/state.json (used by IC editor feedback banner as fallback)
    const statePath = path.join(__dirname, 'state', 'state.json');
    let state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : [];
    const stateIdx   = state.findIndex(s => s.concept_id === conceptId);
    const stateEntry = stateIdx >= 0 ? { ...state[stateIdx] } : { concept_id: conceptId };

    if (isRevision) {
      stateEntry.status   = 'needs_revision';
      stateEntry.feedback = feedback || '';
    } else {
      // On any approval, clear revision state
      delete stateEntry.feedback;
      if (fileType === 'ic') stateEntry.status = 'in_progress';
      if (fileType === 'hw') { stateEntry.status = 'complete'; delete stateEntry.at_status; }
    }
    if (stateIdx >= 0) state[stateIdx] = stateEntry; else state.push(stateEntry);
    fs.mkdirSync(path.join(__dirname, 'state'), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

    // 5. Update contributions.json
    //    IC approve  → add/update with type='ic-draft' (AT editor can find it; node stays dark)
    //    HW approve  → flip existing ic-draft → 'ic' (concept node turns green)
    //    AT approve  → no contributions.json change
    //    any revision → add/update with type='ic-draft' (so "View Submitted IC" works in editor)
    let contribs = [...existingContribs];
    if (fileType === 'ic' || isRevision) {
      // IC file (approve or revision): upsert with ic-draft
      const icIdx = contribs.findIndex(c => c.concept_id === conceptId && (c.type === 'ic' || c.type === 'ic-draft'));
      const icEntry = { concept_id: conceptId, type: 'ic-draft', title: entryTitle, author: entryAuthor, url: entryUrl };
      if (icIdx >= 0) contribs[icIdx] = icEntry; else contribs.push(icEntry);
    } else if (fileType === 'hw' && !isRevision) {
      // HW final approval: flip ic-draft → ic so concept node turns green
      const icIdx = contribs.findIndex(c => c.concept_id === conceptId && c.type === 'ic-draft');
      if (icIdx >= 0) contribs[icIdx] = { ...contribs[icIdx], type: 'ic' };
      // Also add hw entry for concept viewer
      const hwEntry = { concept_id: conceptId, type: 'hw', title: entryTitle, author: entryAuthor, url: entryUrl };
      const hwIdx = contribs.findIndex(c => c.concept_id === conceptId && c.type === 'hw');
      if (hwIdx >= 0) contribs[hwIdx] = hwEntry; else contribs.push(hwEntry);
    }
    fs.writeFileSync(contribPath, JSON.stringify(contribs, null, 2));

    // 6. Sync workflow.json
    const wf = readWorkflow();
    const authorKey = entryAuthor.toLowerCase().trim();
    for (const [studentName, topics] of Object.entries(wf)) {
      if (!topics[conceptId]) continue;
      const firstName = studentName.split(' ')[0];
      if (!authorKey.includes(firstName)) continue;

      if (isRevision) {
        // Send to revision: set needs_revision + store notes for workspace card + IC editor
        topics[conceptId].status         = 'needs_revision';
        topics[conceptId].revision_notes = feedback || '';
      } else {
        // Approve: advance stage
        const stageMap = { ic: 'at', at: 'hw', hw: 'complete' };
        const next = stageMap[fileType];
        if (next) {
          topics[conceptId].stage          = next;
          topics[conceptId].status         = next === 'complete' ? 'complete' : 'draft';
          topics[conceptId].revision_notes = '';
        }
      }
      topics[conceptId].updated_at = new Date().toISOString().slice(0, 10);
    }
    writeWorkflow(wf);

    // 7. Git commit + push
    const token = process.env.GITHUB_TOKEN;
    const user  = process.env.GITHUB_USER || 'ryankcampbell';
    const repo  = process.env.GITHUB_REPO || 'adv-physics-wiki';
    const actionLabel = isRevision ? 'Revision' : (fileType === 'hw' ? 'Publish' : `Approve-${fileType.toUpperCase()}`);

    execSync(`git add "ics/${conceptId}/${filename}" state/state.json contributions.json state/workflow.json`, { cwd: __dirname });
    execSync(`git commit -m "${actionLabel}: ${conceptId}/${safeLabel}"`, { cwd: __dirname });
    if (token) execSync(`git remote set-url origin https://${user}:${token}@github.com/${user}/${repo}.git`, { cwd: __dirname });
    execSync('git push', { cwd: __dirname });
    if (token) execSync(`git remote set-url origin https://github.com/${user}/${repo}.git`, { cwd: __dirname });

    res.json({ success: true, url: entryUrl, author: entryAuthor, title: entryTitle, type: fileType, action: actionLabel });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Push state.json directly ───────────────────────────────────────
app.post('/api/push-state', requireAdmin, (req, res) => {
  const { state } = req.body;
  if (!Array.isArray(state)) return res.status(400).json({ error: 'state must be an array' });
  try {
    const statePath = path.join(__dirname, 'state', 'state.json');
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    execSync('git add state/state.json', { cwd: __dirname });
    execSync('git commit -m "Update state.json via admin"', { cwd: __dirname });
    const token = process.env.GITHUB_TOKEN;
    const user  = process.env.GITHUB_USER  || 'ryankcampbell';
    const repo  = process.env.GITHUB_REPO  || 'adv-physics-wiki';
    try {
      execSync(`git remote set-url origin https://${user}:${token}@github.com/${user}/${repo}.git`, { cwd: __dirname });
      execSync('git push', { cwd: __dirname });
    } finally {
      execSync(`git remote set-url origin https://github.com/${user}/${repo}.git`, { cwd: __dirname });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Claim a concept (manual or future admin-UI use) ───────────────
// Only advances state — never overwrites submitted/certified/needs_revision.
app.post('/api/claim', (req, res) => {
  const { concept_id, author } = req.body;
  if (!concept_id) return res.status(400).json({ error: 'concept_id required' });
  try {
    const statePath = path.join(__dirname, 'state', 'state.json');
    let state = fs.existsSync(statePath)
      ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : [];

    let idx   = state.findIndex(s => s.concept_id === concept_id);
    let entry = idx >= 0 ? { ...state[idx] } : { concept_id };

    const claimable = ['unclaimed', 'wanted', undefined, null, ''];
    if (!claimable.includes(entry.status)) {
      return res.json({ ok: true, updated: false, current_status: entry.status });
    }

    entry.status = 'claimed';
    if (author) entry.claimed_by = author;
    if (idx >= 0) state[idx] = entry; else state.push(entry);

    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    const token = process.env.GITHUB_TOKEN;
    const user  = process.env.GITHUB_USER || 'ryankcampbell';
    const repo  = process.env.GITHUB_REPO || 'adv-physics-wiki';
    execSync('git add state/state.json', { cwd: __dirname });
    execSync(`git commit -m "Claim: ${concept_id} by ${author || 'unknown'}"`, { cwd: __dirname });
    if (token) execSync(`git remote set-url origin https://${user}:${token}@github.com/${user}/${repo}.git`, { cwd: __dirname });
    execSync('git push', { cwd: __dirname });
    if (token) execSync(`git remote set-url origin https://github.com/${user}/${repo}.git`, { cwd: __dirname });
    res.json({ ok: true, updated: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Add concept to module JSON + push ─────────────────────────────
app.post('/api/add-concept', requireAdmin, (req, res) => {
  const { moduleFile, concept } = req.body;
  if (!moduleFile || !concept || !concept.id || !concept.name) {
    return res.status(400).json({ error: 'Missing moduleFile or concept fields' });
  }

  try {
    const modulePath = path.join(__dirname, moduleFile);
    const mod = JSON.parse(fs.readFileSync(modulePath, 'utf8'));

    if (mod.concepts.find(c => c.id === concept.id)) {
      return res.status(400).json({ error: `Concept ID "${concept.id}" already exists in this module.` });
    }

    mod.concepts.push(concept);
    fs.writeFileSync(modulePath, JSON.stringify(mod, null, 2));

    const token = process.env.GITHUB_TOKEN;
    const user  = process.env.GITHUB_USER || 'ryankcampbell';
    const repo  = process.env.GITHUB_REPO || 'adv-physics-wiki';

    execSync(`git add "${moduleFile}"`, { cwd: __dirname });
    execSync(`git commit -m "Add concept: ${concept.id}"`, { cwd: __dirname });
    if (token) {
      execSync(`git remote set-url origin https://${user}:${token}@github.com/${user}/${repo}.git`, { cwd: __dirname });
    }
    execSync('git push', { cwd: __dirname });
    if (token) {
      execSync(`git remote set-url origin https://github.com/${user}/${repo}.git`, { cwd: __dirname });
    }

    res.json({ success: true, concept });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── H-Index: scan published ICs for cross-citations ───────────────
app.get('/api/h-index', (req, res) => {
  try {
    const contribPath = path.join(__dirname, 'contributions.json');
    if (!fs.existsSync(contribPath)) return res.json({ authors: [] });
    const contribs = JSON.parse(fs.readFileSync(contribPath, 'utf8'));

    // Only IC-type contributions count toward h-index
    const icContribs = contribs.filter(c => !c.type || c.type === 'ic');
    if (!icContribs.length) return res.json({ authors: [] });

    // Map known IC base URLs → contribution entry
    const urlToContrib = {};
    icContribs.forEach(c => { urlToContrib[c.url.split('#')[0]] = c; });
    const knownUrls = new Set(Object.keys(urlToContrib));

    // Citation count per IC URL
    const citCount = {};
    knownUrls.forEach(u => { citCount[u] = 0; });

    // Scan every published IC HTML for hrefs matching known IC URLs
    const icsDir = path.join(__dirname, 'ics');
    if (fs.existsSync(icsDir)) {
      fs.readdirSync(icsDir).forEach(conceptId => {
        const cDir = path.join(icsDir, conceptId);
        if (!fs.statSync(cDir).isDirectory()) return;
        fs.readdirSync(cDir).filter(f => f.endsWith('.html')).forEach(fname => {
          const sourceUrl = `https://ryankcampbell.github.io/adv-physics-wiki/ics/${conceptId}/${fname}`;
          const html = fs.readFileSync(path.join(cDir, fname), 'utf8');
          const hrefRe = /href="([^"]+)"/gi;
          let m;
          while ((m = hrefRe.exec(html)) !== null) {
            const base = m[1].split('#')[0];
            if (knownUrls.has(base) && base !== sourceUrl) {
              citCount[base]++;
            }
          }
        });
      });
    }

    // Group ICs by author, calculate h-index
    const byAuthor = {};
    icContribs.forEach(c => {
      const cnt = citCount[c.url.split('#')[0]] || 0;
      (byAuthor[c.author] = byAuthor[c.author] || []).push(
        { title: c.title, url: c.url, citations: cnt }
      );
    });

    const authors = Object.entries(byAuthor).map(([author, ics]) => {
      const sorted = [...ics].sort((a, b) => b.citations - a.citations);
      let h = 0;
      for (let i = 0; i < sorted.length; i++) {
        if (sorted[i].citations >= i + 1) h = i + 1; else break;
      }
      return { author, h, ics: sorted,
               totalCitations: sorted.reduce((s, x) => s + x.citations, 0) };
    }).sort((a, b) => b.h - a.h || b.totalCitations - a.totalCitations);

    res.json({ authors });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── AI Sim Builder ─────────────────────────────────────────────────
const Anthropic = require('@anthropic-ai/sdk');
const anthropic  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SIM_MODELS = {
  haiku:  'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6'
};
const SIM_MODEL_DEFAULT = 'haiku';
const MAX_TURNS = 20;

// In-memory stores — reset on server restart (fine for class pilot)
const simSessions     = new Map(); // token → { studentName, expires }
const sessionTurns    = new Map(); // token → turn count
const studentSessions = new Map(); // token → { name, expires }

// ── Workflow state ──────────────────────────────────────────────
const WORKFLOW_PATH = path.join(__dirname, 'state', 'workflow.json');
function readWorkflow() {
  try { return JSON.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8')); } catch { return {}; }
}
function writeWorkflow(data) {
  fs.mkdirSync(path.join(__dirname, 'state'), { recursive: true });
  fs.writeFileSync(WORKFLOW_PATH, JSON.stringify(data, null, 2));
}
function slugify(str) {
  return str.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// ── Student session middleware ───────────────────────────────────
function requireStudentToken(req, res, next) {
  const auth = req.headers.authorization;
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const session = studentSessions.get(token);
  if (!session || Date.now() > session.expires) {
    studentSessions.delete(token);
    return res.status(401).json({ error: 'Session expired — please log in again.' });
  }
  req.studentName = session.name;
  next();
}

// ── Sim settings helpers (model + password) ──
const SIM_SETTINGS_PATH = path.join(__dirname, 'state', 'sim-settings.json');
function readSimSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(SIM_SETTINGS_PATH, 'utf8'));
    if (!s.password) s.password = process.env.SIM_PASSWORD || 'changeme';
    return s;
  } catch {
    return { model: SIM_MODEL_DEFAULT, password: process.env.SIM_PASSWORD || 'changeme' };
  }
}
function writeSimSettings(s) {
  fs.mkdirSync(path.join(__dirname, 'state'), { recursive: true });
  fs.writeFileSync(SIM_SETTINGS_PATH, JSON.stringify(s, null, 2));
}
function getActiveModel() {
  const { model } = readSimSettings();
  return SIM_MODELS[model] || SIM_MODELS[SIM_MODEL_DEFAULT];
}

// ── Sim log helpers ──
const SIM_LOG_PATH = path.join(__dirname, 'state', 'sim-log.json');
function readSimLog() {
  try { return JSON.parse(fs.readFileSync(SIM_LOG_PATH, 'utf8')); } catch { return []; }
}
function writeSimLog(log) {
  fs.mkdirSync(path.join(__dirname, 'state'), { recursive: true });
  fs.writeFileSync(SIM_LOG_PATH, JSON.stringify(log, null, 2));
}

// ── Session token middleware ──
function requireSimToken(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const session = simSessions.get(token);
  if (!session || session.expires < Date.now()) {
    return res.status(401).json({ error: 'Session expired — please re-enter the class password.' });
  }
  req.simStudent = session.studentName;
  req.simToken   = token;
  next();
}

// ── XSS sanitizer ──
// Trusted CDNs: jsdelivr, cdnjs, unpkg — read-only library hosts, no data exfiltration risk.
// fetch/XHR/WebSocket remain blocked to prevent sims from phoning home.
const TRUSTED_CDNS = /https?:\/\/(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com|cdn\.plot\.ly)\//i;
// Runtime nullification injected at the top of every sim <head>.
// This is a second layer: even if a regex pattern is bypassed, the
// browser-level APIs are overwritten to no-ops before any sim code runs.
const SIM_SECURITY_PREAMBLE = `<script>
/* Physics sim security preamble — do not remove */
(function(){
  'use strict';
  // Null out network APIs so sims cannot phone home
  window.fetch       = function(){ return Promise.reject('fetch disabled'); };
  window.XMLHttpRequest = function(){ throw new Error('XHR disabled'); };
  window.WebSocket   = function(){ throw new Error('WebSocket disabled'); };
  // Block dynamic code execution vectors
  window.eval        = function(){ throw new Error('eval disabled'); };
  window.Function    = function(){ throw new Error('Function constructor disabled'); };
  // Block navigation away from the page
  window.open        = function(){ return null; };
  Object.freeze(window.location);
})();
</script>`;

function sanitizeSimHtml(html) {
  // ── Static regex blocklist ────────────────────────────────────────
  // Catches the obvious patterns before the file is stored.
  html = html.replace(/\bfetch\s*\(/gi,          '/* fetch blocked */ void(');
  html = html.replace(/XMLHttpRequest/gi,         '/* XHR blocked */ Object');
  html = html.replace(/\bWebSocket\s*\(/gi,       '/* WS blocked */ void(');
  // Dynamic bypass patterns (e.g. window['fetch'](...), eval(), new Function())
  html = html.replace(/window\s*\[\s*['"`]fetch['"`]\s*\]/gi, '/* fetch blocked */ window.__blocked__');
  html = html.replace(/\beval\s*\(/gi,            '/* eval blocked */ void(');
  html = html.replace(/new\s+Function\s*\(/gi,    '/* Function blocked */ void(');
  html = html.replace(/setTimeout\s*\(\s*['"`]/gi,'/* setTimeout string blocked */ setTimeout(()=>{},');
  html = html.replace(/setInterval\s*\(\s*['"`]/gi,'/* setInterval string blocked */ setInterval(()=>{},');
  // Block creating script tags at runtime
  html = html.replace(/createElement\s*\(\s*['"`]script['"`]\s*\)/gi, 'createElement("span")');
  // Strip external <script src> — but allow trusted CDNs
  html = html.replace(/<script([^>]+)src=["'](https?:\/\/[^"']*)["']([^>]*)>/gi, (m, pre, url, post) =>
    TRUSTED_CDNS.test(url) ? m : '<!-- external script blocked -->');
  // Strip <link> — but allow trusted CDNs
  html = html.replace(/<link\b([^>]*)>/gi, (m, attrs) =>
    TRUSTED_CDNS.test(attrs) ? m : '<!-- link blocked -->');
  // ── Runtime preamble injection ────────────────────────────────────
  // Inject nullification script immediately after <head> (or at top if no head)
  if (/<head\b/i.test(html)) {
    html = html.replace(/(<head\b[^>]*>)/i, `$1\n${SIM_SECURITY_PREAMBLE}`);
  } else {
    html = SIM_SECURITY_PREAMBLE + '\n' + html;
  }
  return html;
}

// ── Edit-mode prompt ──
const SIM_EDIT_PROMPT = `You are a physics simulation editor for a high school Advanced Physics class. You are making targeted edits to an existing student simulation. The current HTML is provided in the first message.

SAFETY RULES — NON-NEGOTIABLE:
- You only help with physics or mathematics simulations. Refuse anything else.
- Never produce content inappropriate for a high school classroom.
- Never include fetch(), XMLHttpRequest(), WebSocket(), or any network requests.

EDIT FORMAT — FOLLOW THIS EXACTLY:

For simple changes (relabeling text, changing colors, adjusting numbers, small bug fixes):
  You may write one brief sentence describing the change (no markdown, no asterisks), then output a JSON array of edit operations.
  Format:
  Changed the label from "X" to "Y".
  [{"old": "exact string from HTML", "new": "replacement string"}]

  Rules:
  - Copy the "old" value CHARACTER FOR CHARACTER from the simulation HTML — whitespace and all
  - Multiple operations are fine: [{"old":"...", "new":"..."}, ...]
  - Do NOT output any HTML. Only the optional sentence + JSON array.

For large structural changes (adding a new major feature, restructuring layout, rewriting core logic):
  Write {"full_regen": true} on the first line, then output the complete updated HTML in a \`\`\`html fence.

When in doubt, use the JSON patch format — it is faster and more reliable.`;

// ── System prompt ──
const SIM_SYSTEM_PROMPT = `You are a physics and mathematics simulation builder for a high school Advanced Physics research class. Students use you to build interactive HTML/JS simulations that accompany their Insight Card research projects.

SAFETY RULES — NON-NEGOTIABLE:
- You only help build physics or mathematics simulations. If a student asks for anything else (stories, essays, general coding help, anything non-physics), respond only with: "I can only help build physics or math simulations for your IC project."
- Never produce content that is violent, sexual, or inappropriate for a high school classroom.
- Never include fetch(), XMLHttpRequest(), WebSocket(), or any code that makes network requests.
- KaTeX (from cdn.jsdelivr.net/npm/katex) is the only allowed external library. No other CDN links.

TECHNICAL RULES:
1. Output a complete, self-contained HTML file every time — never a diff or partial update.
2. Use only vanilla JS and CSS. The one exception is KaTeX for math rendering:
   <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
   <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script>
   <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js"
     onload="renderMathInElement(document.body,{delimiters:[{left:'$$',right:'$$',display:true},{left:'$',right:'$',display:false}]})"></script>
3. Always wrap the sim HTML in a fenced code block:
   \`\`\`html
   <!DOCTYPE html>
   ...
   \`\`\`
4. Each new version replaces the entire file — always output the full HTML.
5. Keep explanations short. The student wants to see the sim, not read a lecture.
6. NEVER put explanation text inside the HTML body. Any description of what you built goes in your chat reply OUTSIDE the code fence — never as a <div> or <p> appended to the sim HTML itself.
6. If the student describes something physically wrong, gently correct it and proceed with the correct physics.
7. CRITICAL — canvas sizing: NEVER use canvas.offsetWidth or canvas.offsetHeight to set canvas dimensions (they return 0 inside iframes before layout). Always set explicit pixel values: canvas.width = 900; canvas.height = 500; Then use requestAnimationFrame to start drawing — never draw before the animation loop starts.

VISUAL STYLE — follow this closely. Here is the design language used by the class:

CSS palette and component patterns (copy these exactly):
\`\`\`css
* { box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  margin: 0; padding: 15px;
  background: #1a1a2e; color: #eee;
}
h1 { text-align: center; font-size: 22px; color: #c8d8e8; margin: 8px 0 4px; }
.subtitle { text-align: center; font-size: 12px; color: #667; margin-bottom: 12px; }

/* Layout: sidebar (controls) + main (canvas) */
.main-row { display: flex; gap: 14px; max-width: 1200px; margin: 0 auto; align-items: flex-start; }
.sidebar { width: 280px; flex-shrink: 0; display: flex; flex-direction: column; gap: 10px; }
.canvas-wrap { flex: 1; min-width: 0; }
canvas { display: block; width: 100%; height: 500px; border-radius: 8px; background: #0d0d1a; max-width: 100%; }

/* Control panel */
.panel { background: #252540; padding: 12px; border-radius: 8px; }
.panel h3 { margin: 0 0 8px; color: #7eb8da; font-size: 13px;
            border-bottom: 1px solid #3a3a5a; padding-bottom: 5px; }

/* Slider row */
.slider-row { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
.slider-row label { font-size: 11px; color: #aab; min-width: 90px; }
.slider-row input[type=range] { flex: 1; accent-color: #7eb8da; }
.slider-row .val { font-size: 11px; color: #7eb8da; min-width: 70px;
                   text-align: right; font-family: monospace; }

/* Live readout */
.readout { background: #1a1a2e; border-radius: 6px; padding: 10px;
           font-family: monospace; font-size: 12px; line-height: 1.8; margin-top: 6px; }
.readout-row { display: flex; justify-content: space-between; }
.readout-label { color: #8899aa; }
.readout-value { color: #7eb8da; }

/* Buttons */
.btn { padding: 7px 16px; border: none; border-radius: 6px; font-size: 12px;
       cursor: pointer; background: #3a3a6a; color: #ccc; }
.btn:hover { background: #5a5a8a; color: #fff; }
.btn.primary { background: #4a6a9a; color: #fff; }
\`\`\`

WHAT MAKES A GREAT SIMULATION:
- Sidebar with labeled sliders for every adjustable parameter (include units)
- Animated canvas updated with requestAnimationFrame — smooth 60fps
- Live readout panel showing key computed values (energy, period, force magnitude, etc.)
- KaTeX math labels for any equation shown — e.g. $F = ma$, $E = \\frac{1}{2}mv^2$
- A one-sentence caption at the bottom describing the physics being shown
- For multi-concept sims: tabs to switch between views
- Color-coded highlights: use #6ecf6e (green), #e07050 (red/warm), #7eb8da (blue), #e8c050 (gold), #b08aff (purple) to distinguish quantities

WHAT YOU ARE BUILDING FOR:
These simulations accompany student research projects (Insight Cards) in a high school Advanced Physics class. Students explore physics concepts through original research and build sims to illustrate their findings. The sims should be physically accurate, aesthetically polished, and suitable for sharing with the class as part of the student's published IC.`;

// ── Daily turn limit (persisted, resets at midnight) ─────────────
const DAILY_LIMITS_PATH = path.join(__dirname, 'state', 'daily-limits.json');
const DAILY_MAX_TURNS = 20;

function _dailyKey(name) {
  const today = new Date().toISOString().slice(0, 10);
  return `${name.toLowerCase().trim()}_${today}`;
}
function getDailyTurns(name) {
  try { return JSON.parse(fs.readFileSync(DAILY_LIMITS_PATH, 'utf8'))[_dailyKey(name)] || 0; }
  catch { return 0; }
}
function incrementDailyTurns(name) {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(DAILY_LIMITS_PATH, 'utf8')); } catch {}
  const key = _dailyKey(name);
  data[key] = (data[key] || 0) + 1;
  // Prune entries older than 7 days
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 7);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  for (const k of Object.keys(data)) { if (k.split('_').pop() < cutoffStr) delete data[k]; }
  fs.mkdirSync(path.join(__dirname, 'state'), { recursive: true });
  fs.writeFileSync(DAILY_LIMITS_PATH, JSON.stringify(data, null, 2));
  return data[key];
}

// ── Student entry helper (handles old format: number, new format: object) ──
function getStudentEntry(students, nameKey) {
  const v = students[nameKey];
  if (v === undefined) return null;
  if (typeof v === 'number') return { limit: v, password: null, locked: false };
  return { limit: v.limit ?? 20, password: v.password ?? null, locked: v.locked ?? false };
}

// ── Password generator (6 readable chars, no ambiguous 0/O/1/l) ──
function genStudentPassword() {
  const chars = 'bcdfghjkmnpqrstvwxyz23456789';
  return Array.from(require('crypto').randomBytes(6))
    .map(b => chars[b % chars.length]).join('');
}

// ── Route: Auth ──────────────────────────────────────────────────
app.post('/api/sim/auth', (req, res) => {
  const { name, password } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  const settings = readSimSettings();
  const students = settings.students || {};
  const nameKey = name.trim().toLowerCase();

  // If approved list exists, student must be on it
  if (Object.keys(students).length > 0 && !(nameKey in students)) {
    return res.status(403).json({ error: 'Name not on the approved list — check spelling or ask your teacher.' });
  }

  const entry = getStudentEntry(students, nameKey);

  // Check per-student password first; fall back to class password
  const expectedPw = entry?.password || settings.password;
  if (password !== expectedPw) return res.status(401).json({ error: 'Wrong password' });

  // Locked students can't access AI
  if (entry?.locked) return res.status(403).json({ error: 'Your AI access has been paused — see your teacher.' });

  const token = require('crypto').randomUUID();
  simSessions.set(token, { studentName: name.trim(), expires: Date.now() + 8 * 60 * 60 * 1000 });
  res.json({ token });
});

// ── Patch helper ──
function applyPatches(html, ops) {
  let result = html;
  for (const op of ops) {
    if (!result.includes(op.old)) {
      console.warn('[patch] string not found:', JSON.stringify(op.old).slice(0, 80));
      return null;
    }
    result = result.split(op.old).join(op.new);
  }
  return result;
}

// ── Route: Chat (streaming SSE) ──────────────────────────────────
app.post('/api/sim/chat', requireSimToken, async (req, res) => {
  const { messages } = req.body;
  const token = req.simToken;

  const settings = readSimSettings();
  const _entry = getStudentEntry(settings.students || {}, req.simStudent.toLowerCase());
  const studentLimit = _entry?.limit ?? DAILY_MAX_TURNS;
  const dailyTurns = getDailyTurns(req.simStudent);
  if (dailyTurns >= studentLimit) {
    return res.status(429).json({ error: `Daily turn limit (${studentLimit}) reached. Come back tomorrow!` });
  }
  incrementDailyTurns(req.simStudent);

  // Also enforce per-session cap as a secondary guard
  const turns = sessionTurns.get(token) || 0;
  if (turns >= MAX_TURNS) {
    return res.status(429).json({ error: `Session limit reached — close and reopen the sim builder to continue (subject to daily limit).` });
  }
  sessionTurns.set(token, turns + 1);

  // Detect edit mode: first message contains existing sim HTML
  const isEditMode = messages.length >= 2 &&
    typeof messages[0]?.content === 'string' &&
    messages[0].content.includes('current simulation HTML');

  // Extract current HTML for patching
  let currentSimHtml = null;
  if (isEditMode) {
    const m = messages[0].content.match(/```html\n([\s\S]*?)\n```/);
    currentSimHtml = m ? m[1] : null;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (obj) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };

  try {
    // Edits always use Sonnet for spatial/geometric reasoning; creation uses admin-configured model
    const activeModel = isEditMode ? SIM_MODELS['sonnet'] : getActiveModel();
    const stream = anthropic.messages.stream({
      model: activeModel,
      max_tokens: 64000,
      system: isEditMode ? SIM_EDIT_PROMPT : SIM_SYSTEM_PROMPT,
      messages
    });

    stream.on('text', (text) => send({ type: 'text', delta: text }));
    res.on('close', () => { try { stream.abort(); } catch {} });

    const finalMsg     = await stream.finalMessage();
    const rawReply     = finalMsg.content[0].text;
    const inputTokens  = finalMsg.usage.input_tokens;
    const outputTokens = finalMsg.usage.output_tokens;

    // ── Try JSON patch (edit mode only) ──────────────────────────
    let simHtml = null;
    let reply   = rawReply;
    let patchApplied = false;

    if (isEditMode && currentSimHtml && !rawReply.trimStart().startsWith('{"full_regen"')) {
      const jsonMatch = rawReply.match(/\[[\s\S]*?\]/);
      if (jsonMatch) {
        try {
          const ops = JSON.parse(jsonMatch[0]);
          if (Array.isArray(ops) && ops.length > 0 && ops[0]?.old !== undefined) {
            const patched = applyPatches(currentSimHtml, ops);
            if (patched) {
              simHtml = sanitizeSimHtml(patched);
              patchApplied = true;
              // Extract the human-readable sentence before the JSON (if any)
              const preText = rawReply.slice(0, rawReply.indexOf(jsonMatch[0])).trim();
              reply = preText || `Applied ${ops.length} edit${ops.length > 1 ? 's' : ''}.`;
            }
          }
        } catch (e) {
          console.warn('[patch] JSON parse failed:', e.message);
        }
      }
    }

    // ── Fall back to full HTML extraction ────────────────────────
    if (!simHtml) {
      const htmlBodyMatch = rawReply.match(/<!DOCTYPE\s+html[\s\S]*|<html[\s\S]*/i);
      if (htmlBodyMatch) {
        const raw = htmlBodyMatch[0].replace(/\n`{3,}[\s\S]*$/, '').trim();
        simHtml = sanitizeSimHtml(raw);
      }
    }

    const log      = readSimLog();
    const existing = log.find(s => s.token === token);
    const entry    = { timestamp: new Date().toISOString(), inputTokens, outputTokens, hasSim: !!simHtml, model: activeModel, patched: patchApplied };
    if (existing) {
      existing.turns.push(entry);
      existing.totalInputTokens  = (existing.totalInputTokens  || 0) + inputTokens;
      existing.totalOutputTokens = (existing.totalOutputTokens || 0) + outputTokens;
    } else {
      log.push({ token, studentName: req.simStudent, startedAt: new Date().toISOString(),
                 turns: [entry], totalInputTokens: inputTokens, totalOutputTokens: outputTokens });
    }
    writeSimLog(log);

    send({ type: 'done', simHtml, reply, patchApplied });
    res.end();
  } catch (e) {
    console.error('Sim chat error:', e);
    send({ type: 'error', message: e.message });
    res.end();
  }
});

// ── Route: Usage log (admin) ─────────────────────────────────────
app.get('/api/sim/log', requireAdmin, (req, res) => {
  res.json(readSimLog());
});

// ── Route: Settings — model + password (admin) ───────────────────
app.get('/api/sim/settings', requireAdmin, (req, res) => {
  res.json(readSimSettings());
});

app.post('/api/sim/settings', requireAdmin, (req, res) => {
  const current = readSimSettings();
  const updated = { ...current };
  if (req.body.model !== undefined) {
    if (!SIM_MODELS[req.body.model]) return res.status(400).json({ error: 'Unknown model key' });
    updated.model = req.body.model;
    console.log(`[sim] Model switched to ${req.body.model}`);
  }
  if (req.body.password !== undefined) {
    if (!req.body.password.trim()) return res.status(400).json({ error: 'Password cannot be empty' });
    updated.password = req.body.password.trim();
    simSessions.clear();
    sessionTurns.clear();
    console.log('[sim] Password changed — all sessions invalidated');
  }
  writeSimSettings(updated);
  res.json({ ok: true });
});

// ── Route: Student roster ─────────────────────────────────────────
// GET  /api/sim/students            → { students: { name: limit, ... } }
// POST /api/sim/students/add        → { name, limit }
// POST /api/sim/students/remove     → { name }
// POST /api/sim/students/setLimit   → { name, limit }
app.get('/api/sim/students', requireAdmin, (req, res) => {
  res.json({ students: readSimSettings().students || {} });
});
app.post('/api/sim/students/add', requireAdmin, (req, res) => {
  const name = req.body.name?.trim().toLowerCase();
  const limit = parseInt(req.body.limit) || DAILY_MAX_TURNS;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const s = readSimSettings();
  s.students = s.students || {};
  const existing = getStudentEntry(s.students, name);
  const pw = existing?.password || genStudentPassword();
  s.students[name] = { limit, password: pw, locked: false };
  writeSimSettings(s);
  res.json({ ok: true, password: pw });
});
app.post('/api/sim/students/remove', requireAdmin, (req, res) => {
  const name = req.body.name?.trim().toLowerCase();
  if (!name) return res.status(400).json({ error: 'Name required' });
  const s = readSimSettings();
  if (s.students) delete s.students[name];
  writeSimSettings(s);
  res.json({ ok: true });
});
app.post('/api/sim/students/setLimit', requireAdmin, (req, res) => {
  const name = req.body.name?.trim().toLowerCase();
  const limit = parseInt(req.body.limit);
  if (!name || isNaN(limit)) return res.status(400).json({ error: 'Name and limit required' });
  const s = readSimSettings();
  if (!s.students?.[name]) return res.status(404).json({ error: 'Student not found' });
  const entry = getStudentEntry(s.students, name);
  s.students[name] = { ...entry, limit };
  writeSimSettings(s);
  res.json({ ok: true });
});
app.post('/api/sim/students/genpassword', requireAdmin, (req, res) => {
  const name = req.body.name?.trim().toLowerCase();
  if (!name) return res.status(400).json({ error: 'Name required' });
  const s = readSimSettings();
  if (!s.students?.[name]) return res.status(404).json({ error: 'Student not found' });
  const entry = getStudentEntry(s.students, name);
  const pw = genStudentPassword();
  s.students[name] = { ...entry, password: pw };
  writeSimSettings(s);
  res.json({ ok: true, password: pw });
});
app.post('/api/sim/students/setLocked', requireAdmin, (req, res) => {
  const name = req.body.name?.trim().toLowerCase();
  const locked = !!req.body.locked;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const s = readSimSettings();
  if (!s.students?.[name]) return res.status(404).json({ error: 'Student not found' });
  const entry = getStudentEntry(s.students, name);
  s.students[name] = { ...entry, locked };
  writeSimSettings(s);
  res.json({ ok: true });
});

// ── Student portal routes ────────────────────────────────────────

// Public: student names list (no passwords exposed)
app.get('/api/students/list', (req, res) => {
  const names = Object.keys(readSimSettings().students || {}).sort();
  res.json({ names });
});

// Student login → returns student token + pre-created sim token
app.post('/api/student/login', (req, res) => {
  const { name, password } = req.body;
  if (!name?.trim() || !password) return res.status(400).json({ error: 'Name and password required' });
  const settings = readSimSettings();
  const nameKey = name.trim().toLowerCase();
  const entry = getStudentEntry(settings.students || {}, nameKey);
  if (!entry) return res.status(403).json({ error: 'Name not on the approved list.' });
  const expectedPw = entry.password || settings.password;
  if (password !== expectedPw) return res.status(401).json({ error: 'Wrong password.' });
  if (entry.locked) return res.status(403).json({ error: 'Your account has been paused — see your teacher.' });

  const studentToken = require('crypto').randomUUID();
  studentSessions.set(studentToken, { name: name.trim(), expires: Date.now() + 12 * 60 * 60 * 1000 });

  // Also pre-create sim session so the AI tool needs no second password
  const simToken = require('crypto').randomUUID();
  simSessions.set(simToken, { studentName: name.trim(), expires: Date.now() + 8 * 60 * 60 * 1000 });

  res.json({ token: studentToken, simToken, name: name.trim() });
});

// Get student's workflow topics
app.get('/api/student/topics', requireStudentToken, (req, res) => {
  const wf = readWorkflow();
  res.json({ topics: wf[req.studentName.toLowerCase()] || {} });
});

// Start a new topic
app.post('/api/student/topic/start', requireStudentToken, (req, res) => {
  const { module, title } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Title required' });
  const wf = readWorkflow();
  const nameKey = req.studentName.toLowerCase();
  wf[nameKey] = wf[nameKey] || {};
  const slug = slugify(title);
  if (wf[nameKey][slug]) return res.status(409).json({ error: 'A topic with that title already exists.' });
  wf[nameKey][slug] = {
    slug, title: title.trim(), module: module?.trim() || 'General',
    stage: 'ic', status: 'draft', revision_notes: '',
    created_at: new Date().toISOString().slice(0, 10),
    updated_at: new Date().toISOString().slice(0, 10)
  };
  writeWorkflow(wf);
  res.json({ ok: true, slug });
});

// Mark topic as opened/in-progress (clears needs_revision back to draft)
app.post('/api/student/topic/:slug/open', requireStudentToken, (req, res) => {
  const { slug } = req.params;
  const wf = readWorkflow();
  const nameKey = req.studentName.toLowerCase();
  if (!wf[nameKey]?.[slug]) return res.status(404).json({ error: 'Topic not found' });
  if (wf[nameKey][slug].status === 'needs_revision') {
    wf[nameKey][slug].status = 'draft';
    wf[nameKey][slug].updated_at = new Date().toISOString().slice(0, 10);
    writeWorkflow(wf);
  }
  res.json({ ok: true });
});

// Mark topic as submitted (called by ic_editor after Drive upload)
app.post('/api/student/topic/:slug/submit', requireStudentToken, (req, res) => {
  const { slug } = req.params;
  const wf = readWorkflow();
  const nameKey = req.studentName.toLowerCase();
  if (!wf[nameKey]?.[slug]) return res.status(404).json({ error: 'Topic not found' });
  wf[nameKey][slug].status = 'submitted';
  wf[nameKey][slug].updated_at = new Date().toISOString().slice(0, 10);
  writeWorkflow(wf);
  res.json({ ok: true });
});

// ── Admin: workflow management ───────────────────────────────────
app.get('/api/admin/workflow', requireAdmin, (req, res) => {
  res.json(readWorkflow());
});

app.post('/api/admin/workflow/advance', requireAdmin, (req, res) => {
  const { name, slug, action, notes } = req.body;
  if (!name || !slug || !action) return res.status(400).json({ error: 'name, slug, action required' });
  const wf = readWorkflow();
  const nameKey = name.toLowerCase();
  if (!wf[nameKey]?.[slug]) return res.status(404).json({ error: 'Topic not found' });
  const topic = wf[nameKey][slug];
  const stages = ['ic', 'at', 'hw', 'complete'];
  const idx = stages.indexOf(topic.stage);
  if (action === 'advance' && idx < stages.length - 1) {
    topic.stage = stages[idx + 1];
    topic.status = topic.stage === 'complete' ? 'complete' : 'draft';
    topic.revision_notes = '';
  } else if (action === 'sendback') {
    topic.status = 'needs_revision';
    topic.revision_notes = notes || '';
  }
  topic.updated_at = new Date().toISOString().slice(0, 10);
  writeWorkflow(wf);
  res.json({ ok: true, topic });
});

// ── Route: Daily usage per student (for admin display) ────────────
app.get('/api/sim/daily', requireAdmin, (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(DAILY_LIMITS_PATH, 'utf8'))); }
  catch { res.json({}); }
});

// ── Concept Resources ───────────────────────────────────────────────
const RESOURCES_PATH = path.join(__dirname, 'state', 'resources.json');
const RESOURCES_DIR  = path.join(__dirname, 'resources');

function readResources() {
  try { return JSON.parse(fs.readFileSync(RESOURCES_PATH, 'utf8')); }
  catch { return {}; }
}
function writeResources(data) {
  fs.writeFileSync(RESOURCES_PATH, JSON.stringify(data, null, 2));
}

// Public: list resources for a concept
app.get('/api/resources/:slug', (req, res) => {
  const { slug } = req.params;
  const all = readResources();
  res.json({ resources: all[slug] || [] });
});

// Public: serve a resource file
app.get('/api/resources/file/:slug/:filename', (req, res) => {
  const { slug, filename } = req.params;
  // Sanitize: no path traversal
  if (filename.includes('..') || filename.includes('/') || slug.includes('..')) {
    return res.status(400).json({ error: 'Invalid path' });
  }
  const filePath = path.join(RESOURCES_DIR, slug, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(filePath);
});

// Admin: upload a resource file (multipart via raw body + query params)
// Client sends: POST /api/admin/resources/upload?slug=SLUG&title=TITLE
// with Content-Type: application/octet-stream and filename header
app.post('/api/admin/resources/upload', requireAdmin, (req, res) => {
  const { slug, title } = req.query;
  const filename = req.headers['x-filename'];
  if (!slug || !filename) return res.status(400).json({ error: 'slug and x-filename required' });
  if (filename.includes('..') || filename.includes('/') || slug.includes('..')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  const dir = path.join(RESOURCES_DIR, slug);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const buf = Buffer.concat(chunks);
    fs.writeFileSync(path.join(dir, filename), buf);

    const all = readResources();
    if (!all[slug]) all[slug] = [];
    // Remove any existing entry with same filename, then add fresh
    all[slug] = all[slug].filter(r => r.filename !== filename);
    all[slug].push({ filename, title: title || filename, uploaded: new Date().toISOString().slice(0, 10) });
    writeResources(all);

    res.json({ ok: true, filename });
  });
  req.on('error', () => res.status(500).json({ error: 'Upload failed' }));
});

// Admin: delete a resource file
app.delete('/api/admin/resources/:slug/:filename', requireAdmin, (req, res) => {
  const { slug, filename } = req.params;
  if (filename.includes('..') || filename.includes('/') || slug.includes('..')) {
    return res.status(400).json({ error: 'Invalid path' });
  }
  const filePath = path.join(RESOURCES_DIR, slug, filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  const all = readResources();
  if (all[slug]) {
    all[slug] = all[slug].filter(r => r.filename !== filename);
    if (all[slug].length === 0) delete all[slug];
  }
  writeResources(all);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════
// AT TOOL ROUTES
// ══════════════════════════════════════════════════════════════════

const LIT_SOURCES_PATH = path.join(__dirname, 'state', 'lit-sources.json');

function readLitSources() {
  try { return JSON.parse(fs.readFileSync(LIT_SOURCES_PATH, 'utf8')); }
  catch { return { approved_domains: [] }; }
}

// AT daily limit helpers (separate key from sim builder)
function _atDailyKey(name) {
  const today = new Date().toISOString().slice(0, 10);
  return `${name.toLowerCase().trim()}_at_${today}`;
}
function getATDailyTurns(name) {
  try { return JSON.parse(fs.readFileSync(DAILY_LIMITS_PATH, 'utf8'))[_atDailyKey(name)] || 0; }
  catch { return 0; }
}
function incrementATDailyTurns(name) {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(DAILY_LIMITS_PATH, 'utf8')); } catch {}
  const key = _atDailyKey(name);
  data[key] = (data[key] || 0) + 1;
  fs.writeFileSync(DAILY_LIMITS_PATH, JSON.stringify(data, null, 2));
  return data[key];
}
function checkATLimit(req, res) {
  const settings = readSimSettings();
  const entry    = getStudentEntry(settings.students || {}, req.simStudent.toLowerCase());
  const maxTurns = entry?.at_limit ?? Math.max(30, (entry?.limit ?? 20) * 2);
  const used     = getATDailyTurns(req.simStudent);
  if (used >= maxTurns) {
    res.status(429).json({ error: `AT daily limit (${maxTurns}) reached. Come back tomorrow!` });
    return false;
  }
  return true;
}

// Socratic system prompt (server-side only — never from client)
const AT_SOCRATIC_PROMPT = `You are a Socratic dialogue partner for physics adversarial testing at a high school level.

YOUR ROLE:
- Help students understand what their findings mean — never tell them the answer
- Never state "the simulation passes" or "the simulation fails" — the student decides
- When a student asks a conceptual question, first ask what they already understand
- When a student shows you data, ask what they think it means before interpreting
- When a student is stuck, ask a simpler question that builds toward the answer
- You may confirm that a calculation is correct or incorrect once the student has done it
- Keep responses concise (2–4 sentences). Ask one focused question at a time.

IMPORTANT: Do not give verdicts. Do not answer physics questions directly without first checking understanding. Be encouraging but do not validate incorrect reasoning.`;

// POST /api/at/chat — Socratic chat (SSE streaming)
app.post('/api/at/chat', requireSimToken, async (req, res) => {
  if (!checkATLimit(req, res)) return;
  const { messages, icContext, toolResults } = req.body;
  if (!messages?.length) return res.status(400).json({ error: 'messages required' });

  incrementATDailyTurns(req.simStudent);

  // Build dynamic system prompt with IC context
  const ctx = icContext || {};
  const toolSummary = toolResults ? JSON.stringify(toolResults, null, 2).slice(0, 800) : 'No tool results yet.';
  const systemPrompt = AT_SOCRATIC_PROMPT + `\n\nCONCEPT: ${ctx.conceptTitle || 'Unknown'}\n` +
    `IC RESEARCH QUESTION: ${ctx.rq || '—'}\n` +
    `IC EXPLAINER EXCERPT: ${(ctx.explainer || '').slice(0, 400)}\n\n` +
    `CURRENT TOOL RESULTS:\n${toolSummary}`;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = obj => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };

  try {
    const stream = anthropic.messages.stream({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system: systemPrompt,
      messages: messages.slice(-12)   // keep context window manageable
    });
    stream.on('text', text => send({ type: 'text', delta: text }));
    stream.on('finalMessage', () => send({ type: 'done' }));
    stream.on('error', err => { send({ type: 'error', message: err.message }); res.end(); });
  } catch(err) {
    send({ type: 'error', message: err.message });
    res.end();
  }
});

// POST /api/at/propose-cases — Case Builder AI proposals
app.post('/api/at/propose-cases', requireSimToken, async (req, res) => {
  if (!checkATLimit(req, res)) return;
  const { conceptTitle, rq, explainer, simCaption } = req.body;

  incrementATDailyTurns(req.simStudent);

  const prompt = `You are helping a physics student adversarially test an interactive simulation.

CONCEPT: ${conceptTitle || 'Unknown'}
RESEARCH QUESTION: ${rq || '—'}
EXPLAINER: ${(explainer || '').slice(0, 600)}
SIM DESCRIPTION: ${simCaption || 'An interactive simulation.'}

Propose 4–5 boundary/limiting test cases a scientist would use to validate this simulation.
For each case, provide:
- label: short name for the case (e.g. "Zero velocity limit")
- reasoning: WHY this case reveals whether the physics is correct (1–2 sentences)
- suggestedInput: what the student should set in the sim (specific, concrete)
- expectedBehavior: what should happen if the physics is correct

Return ONLY valid JSON: { "cases": [ { "label", "reasoning", "suggestedInput", "expectedBehavior" }, ... ] }`;

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }]
    });
    const text = msg.content[0]?.text || '';
    const m = text.match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : { cases: [] };
    res.json(parsed);
  } catch(err) {
    res.status(500).json({ error: err.message, cases: [] });
  }
});

// POST /api/at/parse-claims — Claim Audit AI extraction
app.post('/api/at/parse-claims', requireSimToken, async (req, res) => {
  if (!checkATLimit(req, res)) return;
  const { explainer, rq, conceptTitle } = req.body;

  incrementATDailyTurns(req.simStudent);

  const prompt = `You are helping a physics student audit the testable claims in an Insight Card.

CONCEPT: ${conceptTitle || 'Unknown'}
RESEARCH QUESTION: ${rq || '—'}
EXPLAINER TEXT: ${(explainer || '').slice(0, 800)}

Extract 3–6 specific, testable factual claims from the explainer.
For each claim:
- text: the exact or close-paraphrase claim from the text
- testable: true/false
- howToTest: concrete suggestion for how to verify this claim using the simulation (if testable)

Return ONLY valid JSON: { "claims": [ { "text", "testable", "howToTest" }, ... ] }`;

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }]
    });
    const text = msg.content[0]?.text || '';
    const m = text.match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : { claims: [] };
    res.json(parsed);
  } catch(err) {
    res.status(500).json({ error: err.message, claims: [] });
  }
});

// POST /api/at/fetch-url — URL proxy with domain allowlist + SSRF guards
app.post('/api/at/fetch-url', requireSimToken, async (req, res) => {
  if (!checkATLimit(req, res)) return;
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  let parsed;
  try { parsed = new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
  if (!['http:', 'https:'].includes(parsed.protocol)) return res.status(400).json({ error: 'Only http/https URLs allowed' });

  const hostname = parsed.hostname.toLowerCase();

  // SSRF hard-blocks (belt-and-suspenders regardless of allowlist)
  const blocked = /^(localhost|127\.|0\.0\.0\.0|::1|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|.*\.(local|internal|lan))/.test(hostname);
  if (blocked) return res.status(403).json({ error: 'That address is not allowed.' });

  // Domain allowlist check
  const { approved_domains } = readLitSources();
  const isApproved = approved_domains.some(d => hostname === d || hostname.endsWith('.' + d));
  if (!isApproved) {
    return res.status(403).json({
      error: 'notApproved', domain: hostname,
      message: `${hostname} is not on the approved sources list. Ask your teacher to add it, or use Text Paste instead.`
    });
  }

  incrementATDailyTurns(req.simStudent);

  try {
    const https = require('https'), http = require('http');
    const fetcher = parsed.protocol === 'https:' ? https : http;
    const text = await new Promise((resolve, reject) => {
      const reqOut = fetcher.get(url, { timeout: 5000, headers: { 'User-Agent': 'Mozilla/5.0 (AdvPhysics Wiki; educational)' } }, r => {
        let body = '';
        r.on('data', chunk => { body += chunk; if (body.length > 100000) reqOut.destroy(); });
        r.on('end', () => resolve(body));
      });
      reqOut.on('error', reject);
      reqOut.on('timeout', () => { reqOut.destroy(); reject(new Error('Timeout')); });
    });
    // Strip HTML tags, collapse whitespace, cap at 50KB
    const stripped = text.replace(/<style[\s\S]*?<\/style>/gi,'').replace(/<script[\s\S]*?<\/script>/gi,'')
      .replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0, 50000);
    const titleMatch = text.match(/<title[^>]*>([^<]+)<\/title>/i);
    res.json({ text: stripped, title: titleMatch?.[1]?.trim() || hostname });
  } catch(err) {
    res.status(502).json({ error: err.message });
  }
});

// POST /api/at/lit-search — AI-assisted literature search
app.post('/api/at/lit-search', requireSimToken, async (req, res) => {
  if (!checkATLimit(req, res)) return;
  const { query, conceptTitle } = req.body;
  if (!query) return res.status(400).json({ error: 'query required' });

  incrementATDailyTurns(req.simStudent);

  const { approved_domains } = readLitSources();
  const domainList = approved_domains.slice(0, 8).join(', ');

  const prompt = `A high school physics student needs to find a reliable source for their literature review.

Concept they are studying: ${conceptTitle || 'physics'}
What they need: ${query}

Suggest 3–4 specific sources from trusted educational/scientific sites (prefer: ${domainList}).
For each, provide:
- title: specific article/chapter/page title
- description: 1–2 sentences explaining what it covers and why it's relevant
- url: a real, working URL to the specific page (not just a homepage)
- sourceType: "textbook" | "educational" | "peer-reviewed" | "reference"

Return ONLY valid JSON: { "results": [ { "title", "description", "url", "sourceType" }, ... ] }`;

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }]
    });
    const text = msg.content[0]?.text || '';
    const m = text.match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : { results: [] };
    res.json(parsed);
  } catch(err) {
    res.status(500).json({ error: err.message, results: [] });
  }
});

// GET /api/lit-sources — public, returns approved domain list
app.get('/api/lit-sources', (req, res) => {
  res.json(readLitSources());
});

// POST /api/admin/lit-sources — admin, replace the approved domain list
app.post('/api/admin/lit-sources', requireAdmin, (req, res) => {
  const { approved_domains } = req.body;
  if (!Array.isArray(approved_domains)) return res.status(400).json({ error: 'approved_domains array required' });
  const sanitized = approved_domains.map(d => d.trim().toLowerCase()).filter(d => /^[a-z0-9.\-]+$/.test(d));
  fs.writeFileSync(LIT_SOURCES_PATH, JSON.stringify({ approved_domains: sanitized }, null, 2));
  res.json({ ok: true, approved_domains: sanitized });
});

// ── Bug Reports ────────────────────────────────────────────────────
const BUG_REPORTS_PATH = path.join(__dirname, 'state', 'bug-reports.json');
function readBugReports() {
  try { return JSON.parse(fs.readFileSync(BUG_REPORTS_PATH, 'utf8')); } catch { return []; }
}
function writeBugReports(reports) {
  fs.writeFileSync(BUG_REPORTS_PATH, JSON.stringify(reports, null, 2));
}

// POST /api/bug-report — student submits a bug report (student token required)
app.post('/api/bug-report', requireSimToken, (req, res) => {
  const { description, snapshot, page } = req.body;
  if (!description || typeof description !== 'string' || !description.trim()) {
    return res.status(400).json({ error: 'description required' });
  }
  // Validate snapshot: must be a data URL image or absent
  if (snapshot && (typeof snapshot !== 'string' || !snapshot.startsWith('data:image/'))) {
    return res.status(400).json({ error: 'snapshot must be a data URL image' });
  }
  // Limit snapshot size to 4 MB (base64)
  if (snapshot && snapshot.length > 4 * 1024 * 1024 * 1.37) {
    return res.status(400).json({ error: 'snapshot too large (max ~4 MB)' });
  }
  const reports = readBugReports();
  const report = {
    id: require('crypto').randomUUID(),
    timestamp: new Date().toISOString(),
    reporter: req.simStudent,
    source: 'student',
    page: (page || '').slice(0, 80),
    description: description.trim().slice(0, 2000),
    snapshot: snapshot || null,
    status: 'open',
    admin_notes: ''
  };
  reports.unshift(report);  // newest first
  writeBugReports(reports);
  res.json({ ok: true, id: report.id });
});

// GET /api/admin/bug-reports — admin reads all reports
app.get('/api/admin/bug-reports', requireAdmin, (req, res) => {
  res.json(readBugReports());
});

// POST /api/admin/bug-reports — admin logs a bug directly
app.post('/api/admin/bug-reports', requireAdmin, (req, res) => {
  const { description, snapshot } = req.body;
  if (!description || typeof description !== 'string' || !description.trim()) {
    return res.status(400).json({ error: 'description required' });
  }
  if (snapshot && (typeof snapshot !== 'string' || !snapshot.startsWith('data:image/'))) {
    return res.status(400).json({ error: 'snapshot must be a data URL image' });
  }
  if (snapshot && snapshot.length > 4 * 1024 * 1024 * 1.37) {
    return res.status(400).json({ error: 'snapshot too large (max ~4 MB)' });
  }
  const reports = readBugReports();
  const report = {
    id: require('crypto').randomUUID(),
    timestamp: new Date().toISOString(),
    reporter: 'admin',
    source: 'admin',
    page: '',
    description: description.trim().slice(0, 2000),
    snapshot: snapshot || null,
    status: 'open',
    admin_notes: ''
  };
  reports.unshift(report);
  writeBugReports(reports);
  res.json({ ok: true, id: report.id });
});

// PATCH /api/admin/bug-reports/:id — update status and/or notes
app.patch('/api/admin/bug-reports/:id', requireAdmin, (req, res) => {
  const reports = readBugReports();
  const idx = reports.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  const { status, admin_notes } = req.body;
  if (status && ['open', 'resolved'].includes(status)) reports[idx].status = status;
  if (typeof admin_notes === 'string') reports[idx].admin_notes = admin_notes.slice(0, 1000);
  writeBugReports(reports);
  res.json({ ok: true });
});

// ── Submitted Draft Snapshots ──────────────────────────────────────
// Saves a copy of submitted IC/AT/HW HTML server-side so students can
// restore their work if sent back for revision (localStorage is cleared
// on submit). Admin can also preview any student's last submission.

const DRAFTS_DIR = path.join(__dirname, 'state', 'drafts');
fs.mkdirSync(DRAFTS_DIR, { recursive: true });

function draftFilename(studentName, slug) {
  const safeName = studentName.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_');
  const safeSlug = slug.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_');
  return `${safeName}__${safeSlug}.html`;
}

// POST /api/student/draft/:slug — save submitted HTML snapshot
app.post('/api/student/draft/:slug', requireStudentToken, (req, res) => {
  const { html } = req.body;
  if (!html || typeof html !== 'string') {
    return res.status(400).json({ error: 'html required' });
  }
  if (html.length > 5 * 1024 * 1024) {
    return res.status(400).json({ error: 'Draft too large (max 5 MB)' });
  }
  const slug = req.params.slug.replace(/[^a-z0-9_-]/gi, '').slice(0, 80);
  if (!slug) return res.status(400).json({ error: 'invalid slug' });
  const filename = draftFilename(req.studentName, slug);
  fs.writeFileSync(path.join(DRAFTS_DIR, filename), html, 'utf8');
  res.json({ ok: true });
});

// GET /api/student/draft/:slug — restore own submitted draft
app.get('/api/student/draft/:slug', requireStudentToken, (req, res) => {
  const slug = req.params.slug.replace(/[^a-z0-9_-]/gi, '').slice(0, 80);
  const filename = draftFilename(req.studentName, slug);
  const filepath = path.join(DRAFTS_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'No saved draft found' });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(fs.readFileSync(filepath, 'utf8'));
});

// GET /api/admin/draft/:studentName/:slug — admin preview of any student's draft
app.get('/api/admin/draft/:studentName/:slug', requireAdmin, (req, res) => {
  const slug = req.params.slug.replace(/[^a-z0-9_-]/gi, '').slice(0, 80);
  const filename = draftFilename(req.params.studentName, slug);
  const filepath = path.join(DRAFTS_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'No saved draft found' });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(fs.readFileSync(filepath, 'utf8'));
});

// ── HW Question Bank ───────────────────────────────────────────────
const QUESTIONS_PATH = path.join(__dirname, 'state', 'questions.json');
function readQuestions() {
  try { return JSON.parse(fs.readFileSync(QUESTIONS_PATH, 'utf8')); } catch { return []; }
}
function writeQuestions(qs) {
  fs.writeFileSync(QUESTIONS_PATH, JSON.stringify(qs, null, 2));
}

// HW daily limit (separate key from sim/AT)
function _hwDailyKey(name) {
  const today = new Date().toISOString().slice(0, 10);
  return `${name.toLowerCase().trim()}_hw_${today}`;
}
function getHWDailyTurns(name) {
  try { return JSON.parse(fs.readFileSync(DAILY_LIMITS_PATH, 'utf8'))[_hwDailyKey(name)] || 0; }
  catch { return 0; }
}
function incrementHWDailyTurns(name) {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(DAILY_LIMITS_PATH, 'utf8')); } catch {}
  const key = _hwDailyKey(name);
  data[key] = (data[key] || 0) + 1;
  fs.writeFileSync(DAILY_LIMITS_PATH, JSON.stringify(data, null, 2));
}
function checkHWLimit(req, res) {
  const settings = readSimSettings();
  const entry    = getStudentEntry(settings.students || {}, req.simStudent.toLowerCase());
  const maxTurns = entry?.hw_limit ?? 20;
  const used     = getHWDailyTurns(req.simStudent);
  if (used >= maxTurns) {
    res.status(429).json({ error: `HW daily limit (${maxTurns} turns) reached. Come back tomorrow!` });
    return false;
  }
  return true;
}

const HW_SYSTEM_PROMPT = `You are helping a high school physics student write a homework problem based on their research investigation (Insight Card).

YOUR ROLE:
- Help the student craft a clear, well-structured physics problem that tests the concept they investigated
- Draw on their own IC context: research question, explainer, simulation, and AT findings
- Guide them toward 1–3 parts (a, b, c) with specific calculations or conceptual questions
- Suggest concrete numbers and scenarios grounded in their actual work

When you update the question structure, embed the current version as valid JSON in <question> tags on its own line:
<question>{"stem":"...","parts":[{"label":"a","prompt":"...","answer":null}],"difficulty":"medium","tags":["..."]}</question>

The "answer" field starts null during drafting. When the student writes their solution, it goes there.

ANSWER VALIDATION — when the student presents their solution:
- Do NOT reveal the correct answer
- Say clearly whether their reasoning is correct or contains a flaw
- If wrong: ask one guiding question that points toward the error without giving it away
- If correct: confirm with a brief explanation of why it is right

Keep responses concise (3–5 sentences). This is a working session.`;

// POST /api/hw/chat — collaborative HW problem authoring + answer validation
app.post('/api/hw/chat', requireSimToken, async (req, res) => {
  if (!checkHWLimit(req, res)) return;
  const { messages, icContext, currentQuestion } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' });
  }

  incrementHWDailyTurns(req.simStudent);

  const ctx = icContext || {};
  const contextParts = [
    `CONCEPT: ${(ctx.conceptTitle || 'Unknown').slice(0, 80)}`,
    `MODULE: ${(ctx.module || '—').slice(0, 40)}`,
    `RESEARCH QUESTION: ${(ctx.rq || '—').slice(0, 200)}`,
    `EXPLAINER: ${(ctx.explainer || '—').slice(0, 600)}`,
    ctx.simCaption ? `SIMULATION: ${ctx.simCaption.slice(0, 200)}` : null,
    ctx.atSummary  ? `AT FINDINGS: ${ctx.atSummary.slice(0, 400)}` : null,
    currentQuestion ? `CURRENT QUESTION:\n${JSON.stringify(currentQuestion)}` : null,
  ].filter(Boolean).join('\n');

  const safeMessages = messages.slice(-14).map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content).slice(0, 3000)
  }));

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1200,
      system: HW_SYSTEM_PROMPT + '\n\n' + contextParts,
      messages: safeMessages
    });
    const rawText = msg.content[0]?.text || '';

    // Extract <question>...</question> block if present
    let question = null;
    const qMatch = rawText.match(/<question>([\s\S]*?)<\/question>/);
    if (qMatch) {
      try { question = JSON.parse(qMatch[1].trim()); } catch {}
    }
    const message = rawText.replace(/<question>[\s\S]*?<\/question>/g, '').trim();
    res.json({ message, question });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/hw/submit — student submits finalized question + answer key
app.post('/api/hw/submit', requireStudentToken, (req, res) => {
  const { concept_slug, module, title, question, figure_dataurl } = req.body;
  if (!concept_slug || !question?.stem) {
    return res.status(400).json({ error: 'concept_slug and question.stem required' });
  }
  if (!Array.isArray(question.parts) || question.parts.length === 0) {
    return res.status(400).json({ error: 'question must have at least one part' });
  }
  const hasAnswer = question.parts.some(p => p.answer && String(p.answer).trim());
  if (!hasAnswer) {
    return res.status(400).json({ error: 'At least one part must have a written answer' });
  }
  if (figure_dataurl && (typeof figure_dataurl !== 'string' || !figure_dataurl.startsWith('data:image/'))) {
    return res.status(400).json({ error: 'figure_dataurl must be a data URL image' });
  }
  if (figure_dataurl && figure_dataurl.length > 4 * 1024 * 1024 * 1.37) {
    return res.status(400).json({ error: 'Figure too large (max ~4 MB)' });
  }

  const questions = readQuestions();
  const record = {
    id: require('crypto').randomUUID(),
    student: req.studentName,
    concept_slug: concept_slug.trim().slice(0, 80),
    module: (module || '').trim().slice(0, 40),
    title: (title || question.stem.slice(0, 60)).trim().slice(0, 120),
    stem: question.stem.slice(0, 2000),
    parts: question.parts.slice(0, 5).map(p => ({
      label: String(p.label || '').slice(0, 4),
      prompt: String(p.prompt || '').slice(0, 1000),
      answer: String(p.answer || '').slice(0, 2000)
    })),
    difficulty: ['easy','medium','hard'].includes(question.difficulty) ? question.difficulty : 'medium',
    tags: Array.isArray(question.tags) ? question.tags.slice(0, 8).map(t => String(t).slice(0, 30)) : [],
    figure_dataurl: figure_dataurl || null,
    status: 'submitted',
    admin_notes: '',
    created_at: new Date().toISOString().slice(0, 10)
  };
  questions.unshift(record);
  writeQuestions(questions);
  res.json({ ok: true, id: record.id });
});

// GET /api/admin/hw/questions — list with optional ?concept= and ?status= filters
app.get('/api/admin/hw/questions', requireAdmin, (req, res) => {
  let qs = readQuestions();
  if (req.query.concept) qs = qs.filter(q => q.concept_slug === req.query.concept);
  if (req.query.status)  qs = qs.filter(q => q.status  === req.query.status);
  res.json({ questions: qs });
});

// PATCH /api/admin/hw/questions/:id — approve / reject / reopen
app.patch('/api/admin/hw/questions/:id', requireAdmin, (req, res) => {
  const qs  = readQuestions();
  const idx = qs.findIndex(q => q.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  const { status, admin_notes } = req.body;
  if (!['approved','rejected','submitted'].includes(status)) {
    return res.status(400).json({ error: 'status must be approved, rejected, or submitted' });
  }
  qs[idx].status = status;
  if (typeof admin_notes === 'string') qs[idx].admin_notes = admin_notes.slice(0, 500);
  writeQuestions(qs);
  res.json({ ok: true });
});

// GET /api/admin/hw/export/:slug — clean text dump of approved questions
app.get('/api/admin/hw/export/:slug', requireAdmin, (req, res) => {
  const qs = readQuestions().filter(q => q.concept_slug === req.params.slug && q.status === 'approved');
  if (qs.length === 0) return res.json({ text: '', count: 0 });
  const lines = [
    `APPROVED HW QUESTIONS — ${req.params.slug}`,
    `Exported: ${new Date().toLocaleDateString()}`,
    '='.repeat(60)
  ];
  qs.forEach((q, i) => {
    lines.push('', `Q${i + 1}. [${q.difficulty.toUpperCase()}] — ${q.student}`);
    if (q.tags.length) lines.push(`Tags: ${q.tags.join(', ')}`);
    lines.push('', q.stem);
    q.parts.forEach(p => {
      lines.push('', `  (${p.label}) ${p.prompt}`, `  Answer: ${p.answer}`);
    });
    if (q.figure_dataurl) lines.push('  [Figure attached — see admin panel]');
    lines.push('-'.repeat(60));
  });
  res.json({ text: lines.join('\n'), count: qs.length });
});

// ── Start ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✓ Admin server running → http://localhost:${PORT}/admin.html\n`);
});
