require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

// ── Google Drive auth ──────────────────────────────────────────────
const auth = new google.auth.GoogleAuth({
  keyFile: process.env.GOOGLE_KEY_FILE || 'credentials.json',
  scopes: ['https://www.googleapis.com/auth/drive.readonly'],
});
const drive = google.drive({ version: 'v3', auth });

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
    res.json(files);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

// ── Publish: download → save → update state.json + contributions.json → git push ──
app.post('/api/publish', async (req, res) => {
  const { fileId, conceptId, label, decision, feedback } = req.body;
  if (!fileId || !conceptId) return res.status(400).json({ error: 'Missing fileId or conceptId' });

  const safeLabel = (label || '').replace(/[^a-z0-9_-]/gi, '').toLowerCase() || 'index';
  const filename  = safeLabel + '.html';
  const fileType  = getFileType(safeLabel);  // at / hw / ic

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

    // 3. Extract title & author from HTML (different title patterns per type)
    const titleRe = fileType === 'at' ? /<title>AT:\s*([^|<]+)/i
                  : fileType === 'hw' ? /<title>HW:\s*([^|<]+)/i
                  :                     /<title>IC:\s*([^|<]+)/i;
    const titleM  = html.match(titleRe);
    const authorM = html.match(/by\s+([^<]+)<\/span>/i);
    const entryTitle  = titleM  ? titleM[1].trim()  : conceptId.replace(/_/g, ' ');
    const entryAuthor = authorM ? authorM[1].trim()  : (label || 'Unknown');

    // 4. Update state/state.json — each type updates a different field
    const statePath = path.join(__dirname, 'state', 'state.json');
    let state = [];
    if (fs.existsSync(statePath)) {
      state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    }
    const stateIdx = state.findIndex(s => s.concept_id === conceptId);
    const stateEntry = stateIdx >= 0 ? { ...state[stateIdx] } : { concept_id: conceptId };

    if (fileType === 'ic') {
      if (decision === 'revision') {
        stateEntry.status   = 'needs_revision';
        stateEntry.feedback = feedback || '';
      } else {
        // approve: IC is published (covered=true → green node); clear any revision state
        stateEntry.status = 'submitted';
        delete stateEntry.feedback;
        delete stateEntry.at_status;  // reset AT cycle so a new AT can be dispatched
      }
    } else if (fileType === 'at') {
      stateEntry.at_status = 'submitted';
    } else if (fileType === 'hw') {
      stateEntry.hw_status = 'submitted';
    }

    if (stateIdx >= 0) state[stateIdx] = stateEntry;
    else state.push(stateEntry);

    fs.mkdirSync(path.join(__dirname, 'state'), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

    // 5. Auto-update contributions.json (with type field)
    const contribPath = path.join(__dirname, 'contributions.json');
    let contribs = [];
    if (fs.existsSync(contribPath)) {
      contribs = JSON.parse(fs.readFileSync(contribPath, 'utf8'));
    }
    const entryUrl = `https://ryankcampbell.github.io/adv-physics-wiki/ics/${conceptId}/${filename}`;
    const existingIdx = contribs.findIndex(c => c.concept_id === conceptId && c.url.endsWith('/' + filename));
    const entry = { concept_id: conceptId, type: fileType, title: entryTitle, author: entryAuthor, url: entryUrl };
    if (existingIdx >= 0) { contribs[existingIdx] = entry; } else { contribs.push(entry); }
    fs.writeFileSync(contribPath, JSON.stringify(contribs, null, 2));

    // 6. Git commit + push
    const token = process.env.GITHUB_TOKEN;
    const user  = process.env.GITHUB_USER || 'ryankcampbell';
    const repo  = process.env.GITHUB_REPO || 'adv-physics-wiki';
    const typeLabel = fileType.toUpperCase();

    execSync(`git add "ics/${conceptId}/${filename}" state/state.json contributions.json`, { cwd: __dirname });
    execSync(`git commit -m "Publish ${typeLabel}: ${conceptId}/${safeLabel}"`, { cwd: __dirname });

    if (token) {
      execSync(`git remote set-url origin https://${user}:${token}@github.com/${user}/${repo}.git`, { cwd: __dirname });
    }
    execSync('git push', { cwd: __dirname });
    if (token) {
      execSync(`git remote set-url origin https://github.com/${user}/${repo}.git`, { cwd: __dirname });
    }

    res.json({ success: true, url: entryUrl, author: entryAuthor, title: entryTitle, type: fileType });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Push state.json directly ───────────────────────────────────────
app.post('/api/push-state', (req, res) => {
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
app.post('/api/add-concept', (req, res) => {
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

// ── Start ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✓ Admin server running → http://localhost:${PORT}/admin.html\n`);
});
