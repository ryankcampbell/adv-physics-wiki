#!/usr/bin/env node
/**
 * NWA Physics Navigator — Automated Test Suite
 * Run: node test/run-tests.js
 *
 * Tests all server routes that don't require live external services
 * (Google Drive, Anthropic API, git push). SSE/streaming routes and
 * the /api/publish pipeline are excluded because they need live credentials.
 *
 * Exit code: 0 = all pass, 1 = any failure.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const BASE       = 'http://localhost:3000';
const STATE_DIR  = path.join(__dirname, '..', 'state');
const SETTINGS   = path.join(STATE_DIR, 'sim-settings.json');
const WORKFLOW   = path.join(STATE_DIR, 'workflow.json');
const BUGS       = path.join(STATE_DIR, 'bug-reports.json');
const LIT        = path.join(STATE_DIR, 'lit-sources.json');

const TEST_STUDENT = '_test_student_';
const TEST_SLUG    = '_test_topic_';
const TEST_TITLE   = '_Test Topic_';

// ── Colors ────────────────────────────────────────────────────────
const G = s => `\x1b[32m${s}\x1b[0m`;
const R = s => `\x1b[31m${s}\x1b[0m`;
const Y = s => `\x1b[33m${s}\x1b[0m`;
const B = s => `\x1b[1m${s}\x1b[0m`;
const D = s => `\x1b[2m${s}\x1b[0m`;

// ── State ─────────────────────────────────────────────────────────
let passed = 0, failed = 0, skipped = 0;
const failures = [];
let adminToken  = null;
let studentToken = null;
let simToken     = null;
let testStudentPw = null;

// ── Helpers ───────────────────────────────────────────────────────
async function req(method, url, body = null, token = null, extraHeaders = {}) {
  const headers = { 'Content-Type': 'application/json', ...extraHeaders };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const opts = { method, headers };
  if (body !== null && method !== 'GET' && method !== 'HEAD') opts.body = JSON.stringify(body);
  const r = await fetch(BASE + url, opts);
  let data;
  const ct = r.headers.get('content-type') || '';
  try { data = ct.includes('json') ? await r.json() : await r.text(); }
  catch { data = null; }
  return { status: r.status, data, headers: r.headers };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function assertIncludes(str, sub, msg) {
  if (!String(str).includes(sub)) throw new Error(`${msg}: "${sub}" not found in "${String(str).slice(0, 80)}"`);
}

// ── Test runner ───────────────────────────────────────────────────
let currentSection = '';
async function section(name) {
  currentSection = name;
  console.log(`\n${B(name)}`);
}
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ${G('✓')} ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ${R('✗')} ${name}`);
    console.log(`      ${D(e.message)}`);
    failed++;
    failures.push({ section: currentSection, name, error: e.message });
  }
}
function skip(name, reason) {
  console.log(`  ${Y('–')} ${name} ${D('(skipped: ' + reason + ')')}`);
  skipped++;
}

// ── Read admin password from state file (test runs locally) ───────
function readAdminPw() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
    return s.adminPassword || 'admin';
  } catch {
    return 'admin';
  }
}

// ── Cleanup helpers ───────────────────────────────────────────────
function cleanupTestStudent() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
    if (s.students?.[TEST_STUDENT]) {
      delete s.students[TEST_STUDENT];
      fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2));
    }
  } catch {}
}

function cleanupTestWorkflow() {
  try {
    const wf = JSON.parse(fs.readFileSync(WORKFLOW, 'utf8'));
    if (wf[TEST_STUDENT]) {
      delete wf[TEST_STUDENT];
      fs.writeFileSync(WORKFLOW, JSON.stringify(wf, null, 2));
    }
  } catch {}
}

function cleanupTestBugs() {
  try {
    const bugs = JSON.parse(fs.readFileSync(BUGS, 'utf8'));
    const filtered = bugs.filter(b => !b.description?.startsWith('[TEST]'));
    fs.writeFileSync(BUGS, JSON.stringify(filtered, null, 2));
  } catch {}
}

// ── MAIN ──────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${B('NWA Physics Navigator — Test Suite')}`);
  console.log(D(`Server: ${BASE}`));
  console.log(D(`Time:   ${new Date().toLocaleString()}`));

  // ── Verify server is up ──────────────────────────────────────
  try {
    await fetch(BASE + '/admin.html', { signal: AbortSignal.timeout(3000) });
  } catch {
    console.log(R('\n✗ Server not reachable at ' + BASE + ' — is it running?'));
    process.exit(1);
  }

  // ══════════════════════════════════════════════════════════════
  await section('1. CSP Header + Static Files');
  // ══════════════════════════════════════════════════════════════

  await test('index.html returns 200', async () => {
    const { status } = await req('GET', '/index.html');
    assertEqual(status, 200, 'status');
  });

  await test('admin.html returns 200', async () => {
    const { status } = await req('GET', '/admin.html');
    assertEqual(status, 200, 'status');
  });

  await test('CSP header present on all responses', async () => {
    const r = await fetch(BASE + '/admin.html');
    const csp = r.headers.get('content-security-policy') || '';
    assertIncludes(csp, "connect-src 'self'", 'CSP connect-src self');
    assertIncludes(csp, "frame-ancestors 'self'", 'CSP frame-ancestors');
  });

  await test('404 for nonexistent route returns 404', async () => {
    const { status } = await req('GET', '/api/nonexistent-route-xyz');
    assertEqual(status, 404, 'status');
  });

  // ══════════════════════════════════════════════════════════════
  await section('2. Admin Authentication');
  // ══════════════════════════════════════════════════════════════

  const adminPw = readAdminPw();

  await test('POST /api/admin/auth — wrong password returns 401', async () => {
    const { status, data } = await req('POST', '/api/admin/auth', { password: 'wrong_pw_xyz' });
    assertEqual(status, 401, 'status');
    assert(data.error, 'has error field');
  });

  await test('POST /api/admin/auth — correct password returns token', async () => {
    const { status, data } = await req('POST', '/api/admin/auth', { password: adminPw });
    assertEqual(status, 200, 'status');
    assert(data.token, 'has token');
    adminToken = data.token;
  });

  await test('GET /api/admin/verify — valid token returns ok:true', async () => {
    const { status, data } = await req('GET', '/api/admin/verify', null, adminToken);
    assertEqual(status, 200, 'status');
    assertEqual(data.ok, true, 'ok');
  });

  await test('GET /api/admin/verify — no token returns ok:false', async () => {
    const { status, data } = await req('GET', '/api/admin/verify');
    assertEqual(data.ok, false, 'ok');
  });

  await test('GET /api/admin/verify — bad token returns ok:false', async () => {
    const { data } = await req('GET', '/api/admin/verify', null, 'fake-token-xyz');
    assertEqual(data.ok, false, 'ok');
  });

  // ══════════════════════════════════════════════════════════════
  await section('3. Auth Enforcement — 401 on Protected Routes');
  // ══════════════════════════════════════════════════════════════

  const adminRoutes = [
    ['GET',    '/api/sim/log'],
    ['GET',    '/api/sim/settings'],
    ['GET',    '/api/sim/students'],
    ['GET',    '/api/sim/daily'],
    ['GET',    '/api/admin/workflow'],
    ['GET',    '/api/admin/bug-reports'],
    ['POST',   '/api/drive/dismiss'],
    ['POST',   '/api/drive/undismiss'],
    ['POST',   '/api/sim/settings'],
    ['POST',   '/api/sim/students/add'],
    ['POST',   '/api/sim/students/remove'],
    ['POST',   '/api/sim/students/setLimit'],
    ['POST',   '/api/sim/students/genpassword'],
    ['POST',   '/api/sim/students/setLocked'],
    ['POST',   '/api/admin/workflow/advance'],
    ['POST',   '/api/admin/bug-reports'],
    ['POST',   '/api/admin/lit-sources'],
  ];

  for (const [method, url] of adminRoutes) {
    await test(`${method} ${url} — no auth → 401`, async () => {
      const { status } = await req(method, url, {});
      assertEqual(status, 401, 'status');
    });
  }

  const simTokenRoutes = [
    ['POST', '/api/bug-report'],
    ['POST', '/api/at/propose-cases'],
    ['POST', '/api/at/parse-claims'],
    ['POST', '/api/at/fetch-url'],
    ['POST', '/api/at/lit-search'],
    ['POST', '/api/sim/chat'],
  ];

  for (const [method, url] of simTokenRoutes) {
    await test(`${method} ${url} — no token → 401`, async () => {
      const { status } = await req(method, url, {});
      assertEqual(status, 401, 'status');
    });
  }

  const studentTokenRoutes = [
    ['GET',  '/api/student/topics'],
    ['POST', '/api/student/topic/start'],
    ['POST', '/api/student/topic/x/open'],
    ['POST', '/api/student/topic/x/submit'],
  ];

  for (const [method, url] of studentTokenRoutes) {
    await test(`${method} ${url} — no token → 401`, async () => {
      const { status } = await req(method, url, {});
      assertEqual(status, 401, 'status');
    });
  }

  // ══════════════════════════════════════════════════════════════
  await section('4. Student Roster Management');
  // ══════════════════════════════════════════════════════════════

  // Clean any leftover test student first
  cleanupTestStudent();
  cleanupTestWorkflow();

  await test('POST /api/sim/students/add — creates test student', async () => {
    const { status, data } = await req('POST', '/api/sim/students/add',
      { name: TEST_STUDENT, limit: 5 }, adminToken);
    assertEqual(status, 200, 'status');
    assert(data.ok, 'ok');
    assert(data.password, 'has password');
    assert(data.password.length >= 6, 'password length');
    testStudentPw = data.password;
  });

  await test('GET /api/sim/students — test student appears in roster', async () => {
    const { status, data } = await req('GET', '/api/sim/students', null, adminToken);
    assertEqual(status, 200, 'status');
    assert(data.students?.[TEST_STUDENT], 'test student in roster');
    assertEqual(data.students[TEST_STUDENT].limit, 5, 'limit matches');
  });

  await test('GET /api/students/list — public endpoint returns names array', async () => {
    const { status, data } = await req('GET', '/api/students/list');
    assertEqual(status, 200, 'status');
    assert(Array.isArray(data.names), 'names is array');
    assert(data.names.includes(TEST_STUDENT), 'test student in list');
    assert(!JSON.stringify(data).includes(testStudentPw), 'password NOT in response');
  });

  await test('POST /api/sim/students/setLimit — updates limit', async () => {
    const { status, data } = await req('POST', '/api/sim/students/setLimit',
      { name: TEST_STUDENT, limit: 10 }, adminToken);
    assertEqual(status, 200, 'status');
    assert(data.ok, 'ok');
    // Verify
    const { data: s } = await req('GET', '/api/sim/students', null, adminToken);
    assertEqual(s.students[TEST_STUDENT].limit, 10, 'limit updated');
  });

  await test('POST /api/sim/students/setLocked — locks student', async () => {
    const { status, data } = await req('POST', '/api/sim/students/setLocked',
      { name: TEST_STUDENT, locked: true }, adminToken);
    assertEqual(status, 200, 'status');
    assert(data.ok, 'ok');
  });

  await test('POST /api/sim/students/setLocked — unlocks student', async () => {
    const { status, data } = await req('POST', '/api/sim/students/setLocked',
      { name: TEST_STUDENT, locked: false }, adminToken);
    assertEqual(status, 200, 'status');
    assert(data.ok, 'ok');
  });

  await test('POST /api/sim/students/genpassword — generates new password', async () => {
    const { status, data } = await req('POST', '/api/sim/students/genpassword',
      { name: TEST_STUDENT }, adminToken);
    assertEqual(status, 200, 'status');
    assert(data.password, 'has password');
    assert(data.password !== testStudentPw, 'password changed');
    testStudentPw = data.password;  // update for login tests
  });

  await test('POST /api/sim/students/setLimit — 404 for unknown student', async () => {
    const { status } = await req('POST', '/api/sim/students/setLimit',
      { name: 'no_such_student_xyz', limit: 5 }, adminToken);
    assertEqual(status, 404, 'status');
  });

  // ══════════════════════════════════════════════════════════════
  await section('5. Student Login + Portal Auth');
  // ══════════════════════════════════════════════════════════════

  await test('POST /api/student/login — wrong password returns 401', async () => {
    const { status } = await req('POST', '/api/student/login',
      { name: TEST_STUDENT, password: 'wrong_pw_xyz' });
    assertEqual(status, 401, 'status');
  });

  await test('POST /api/student/login — unknown student returns 403', async () => {
    const { status } = await req('POST', '/api/student/login',
      { name: 'no_such_student_xyz', password: 'anything' });
    assertEqual(status, 403, 'status');
  });

  await test('POST /api/student/login — correct credentials returns student + sim tokens', async () => {
    const { status, data } = await req('POST', '/api/student/login',
      { name: TEST_STUDENT, password: testStudentPw });
    assertEqual(status, 200, 'status');
    assert(data.token, 'has student token');
    assert(data.simToken, 'has sim token (pre-created)');
    assert(data.name, 'has name');
    studentToken = data.token;
    simToken     = data.simToken;
  });

  await test('POST /api/student/login — locked student returns 403', async () => {
    // Lock the student
    await req('POST', '/api/sim/students/setLocked',
      { name: TEST_STUDENT, locked: true }, adminToken);
    const { status } = await req('POST', '/api/student/login',
      { name: TEST_STUDENT, password: testStudentPw });
    assertEqual(status, 403, 'status');
    // Unlock for remaining tests
    await req('POST', '/api/sim/students/setLocked',
      { name: TEST_STUDENT, locked: false }, adminToken);
  });

  await test('POST /api/sim/auth — sim builder auth with correct per-student password', async () => {
    const { status, data } = await req('POST', '/api/sim/auth',
      { name: TEST_STUDENT, password: testStudentPw });
    assertEqual(status, 200, 'status');
    assert(data.token, 'has token');
    simToken = data.token; // Use this as our simToken for remaining tests
  });

  await test('POST /api/sim/auth — wrong password returns 401', async () => {
    const { status } = await req('POST', '/api/sim/auth',
      { name: TEST_STUDENT, password: 'wrong_pw' });
    assertEqual(status, 401, 'status');
  });

  // ══════════════════════════════════════════════════════════════
  await section('6. Student Workflow (Topics)');
  // ══════════════════════════════════════════════════════════════

  await test('GET /api/student/topics — empty for new student', async () => {
    const { status, data } = await req('GET', '/api/student/topics', null, studentToken);
    assertEqual(status, 200, 'status');
    assert(typeof data.topics === 'object', 'topics is object');
    assert(!data.topics[TEST_SLUG], 'no test slug yet');
  });

  await test('POST /api/student/topic/start — creates new topic', async () => {
    const { status, data } = await req('POST', '/api/student/topic/start',
      { title: TEST_TITLE, module: 'Test Module' }, studentToken);
    assertEqual(status, 200, 'status');
    assert(data.ok, 'ok');
    assert(data.slug, 'has slug');
  });

  await test('POST /api/student/topic/start — duplicate title returns 409', async () => {
    const { status } = await req('POST', '/api/student/topic/start',
      { title: TEST_TITLE, module: 'Test Module' }, studentToken);
    assertEqual(status, 409, 'status');
  });

  await test('POST /api/student/topic/start — missing title returns 400', async () => {
    const { status } = await req('POST', '/api/student/topic/start',
      { title: '', module: 'Test Module' }, studentToken);
    assertEqual(status, 400, 'status');
  });

  await test('GET /api/student/topics — topic appears after creation', async () => {
    const { data } = await req('GET', '/api/student/topics', null, studentToken);
    const slugs = Object.keys(data.topics);
    assert(slugs.length > 0, 'has at least one topic');
    const topic = Object.values(data.topics)[0];
    assertEqual(topic.stage, 'ic', 'stage=ic');
    assertEqual(topic.status, 'draft', 'status=draft');
  });

  // Get the actual slug from workflow
  let actualSlug = null;
  await test('slug is stored correctly in workflow', async () => {
    const { data } = await req('GET', '/api/student/topics', null, studentToken);
    const entry = Object.values(data.topics).find(t => t.title === TEST_TITLE);
    assert(entry, 'found topic by title');
    actualSlug = entry.slug;
    assert(actualSlug, 'has slug');
  });

  await test('POST /api/student/topic/:slug/submit — marks topic as submitted', async () => {
    const { status, data } = await req('POST', `/api/student/topic/${actualSlug}/submit`,
      {}, studentToken);
    assertEqual(status, 200, 'status');
    assert(data.ok, 'ok');
    // Verify
    const { data: td } = await req('GET', '/api/student/topics', null, studentToken);
    assertEqual(td.topics[actualSlug].status, 'submitted', 'status=submitted');
  });

  await test('POST /api/student/topic/:slug/open — does not change status from submitted', async () => {
    // Topic is submitted — open should not change it (only clears needs_revision)
    const { status } = await req('POST', `/api/student/topic/${actualSlug}/open`,
      {}, studentToken);
    assertEqual(status, 200, 'status');
    const { data } = await req('GET', '/api/student/topics', null, studentToken);
    assertEqual(data.topics[actualSlug].status, 'submitted', 'still submitted');
  });

  await test('POST /api/student/topic/:slug/open — clears needs_revision to draft', async () => {
    // Manually set needs_revision via admin sendback, then open
    await req('POST', '/api/admin/workflow/advance',
      { name: TEST_STUDENT, slug: actualSlug, action: 'sendback', notes: 'Test notes' },
      adminToken);
    let { data } = await req('GET', '/api/student/topics', null, studentToken);
    assertEqual(data.topics[actualSlug].status, 'needs_revision', 'set to needs_revision');

    await req('POST', `/api/student/topic/${actualSlug}/open`, {}, studentToken);
    ({ data } = await req('GET', '/api/student/topics', null, studentToken));
    assertEqual(data.topics[actualSlug].status, 'draft', 'cleared to draft after open');
  });

  await test('POST /api/student/topic/:slug/submit — 404 for unknown slug', async () => {
    const { status } = await req('POST', '/api/student/topic/no_such_slug_xyz/submit',
      {}, studentToken);
    assertEqual(status, 404, 'status');
  });

  // ══════════════════════════════════════════════════════════════
  await section('7. Admin Workflow Management');
  // ══════════════════════════════════════════════════════════════

  await test('GET /api/admin/workflow — returns workflow object', async () => {
    const { status, data } = await req('GET', '/api/admin/workflow', null, adminToken);
    assertEqual(status, 200, 'status');
    assert(typeof data === 'object', 'is object');
    assert(data[TEST_STUDENT], 'test student present');
  });

  // Submit the topic first so it can be advanced
  await req('POST', `/api/student/topic/${actualSlug}/submit`, {}, studentToken);

  await test('POST /api/admin/workflow/advance — advances ic→at stage', async () => {
    const { status, data } = await req('POST', '/api/admin/workflow/advance',
      { name: TEST_STUDENT, slug: actualSlug, action: 'advance' }, adminToken);
    assertEqual(status, 200, 'status');
    assert(data.ok, 'ok');
    assertEqual(data.topic.stage, 'at', 'stage=at');
    assertEqual(data.topic.status, 'draft', 'status=draft');
  });

  await test('POST /api/admin/workflow/advance — advances at→hw stage', async () => {
    const { status, data } = await req('POST', '/api/admin/workflow/advance',
      { name: TEST_STUDENT, slug: actualSlug, action: 'advance' }, adminToken);
    assertEqual(status, 200, 'status');
    assertEqual(data.topic.stage, 'hw', 'stage=hw');
  });

  await test('POST /api/admin/workflow/advance — sendback sets needs_revision + notes', async () => {
    const { status, data } = await req('POST', '/api/admin/workflow/advance',
      { name: TEST_STUDENT, slug: actualSlug, action: 'sendback', notes: 'Fix the sim' },
      adminToken);
    assertEqual(status, 200, 'status');
    assertEqual(data.topic.status, 'needs_revision', 'status=needs_revision');
    assertEqual(data.topic.revision_notes, 'Fix the sim', 'notes stored');
  });

  await test('POST /api/admin/workflow/advance — 404 for unknown student/slug', async () => {
    const { status } = await req('POST', '/api/admin/workflow/advance',
      { name: 'no_such_xyz', slug: 'no_such_xyz', action: 'advance' }, adminToken);
    assertEqual(status, 404, 'status');
  });

  await test('POST /api/admin/workflow/advance — missing required fields returns 400', async () => {
    const { status } = await req('POST', '/api/admin/workflow/advance',
      { name: TEST_STUDENT }, adminToken);
    assertEqual(status, 400, 'status');
  });

  // ══════════════════════════════════════════════════════════════
  await section('8. Sim Settings (Admin)');
  // ══════════════════════════════════════════════════════════════

  await test('GET /api/sim/settings — returns settings object', async () => {
    const { status, data } = await req('GET', '/api/sim/settings', null, adminToken);
    assertEqual(status, 200, 'status');
    assert(data.model, 'has model');
    assert(data.students, 'has students');
  });

  await test('POST /api/sim/settings — unknown model key returns 400', async () => {
    const { status } = await req('POST', '/api/sim/settings',
      { model: 'gpt4_xyz' }, adminToken);
    assertEqual(status, 400, 'status');
  });

  await test('POST /api/sim/settings — valid model update succeeds', async () => {
    const currentSettings = (await req('GET', '/api/sim/settings', null, adminToken)).data;
    const newModel = currentSettings.model === 'haiku' ? 'sonnet' : 'haiku';
    const { status, data } = await req('POST', '/api/sim/settings', { model: newModel }, adminToken);
    assertEqual(status, 200, 'status');
    assert(data.ok, 'ok');
    // Restore
    await req('POST', '/api/sim/settings', { model: currentSettings.model }, adminToken);
  });

  await test('POST /api/sim/settings — empty password returns 400', async () => {
    const { status } = await req('POST', '/api/sim/settings', { password: '' }, adminToken);
    assertEqual(status, 400, 'status');
  });

  await test('GET /api/sim/daily — returns object', async () => {
    const { status, data } = await req('GET', '/api/sim/daily', null, adminToken);
    assertEqual(status, 200, 'status');
    assert(typeof data === 'object', 'is object');
  });

  await test('GET /api/sim/log — returns array', async () => {
    const { status, data } = await req('GET', '/api/sim/log', null, adminToken);
    assertEqual(status, 200, 'status');
    assert(Array.isArray(data), 'is array');
  });

  // ══════════════════════════════════════════════════════════════
  await section('9. Bug Reports');
  // ══════════════════════════════════════════════════════════════

  let bugReportId = null;

  await test('POST /api/bug-report — student submits report', async () => {
    const { status, data } = await req('POST', '/api/bug-report',
      { description: '[TEST] Button did not respond', page: 'workspace' }, simToken);
    assertEqual(status, 200, 'status');
    assert(data.ok, 'ok');
    assert(data.id, 'has id');
    bugReportId = data.id;
  });

  await test('POST /api/bug-report — with valid snapshot (data URL)', async () => {
    const snap = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const { status, data } = await req('POST', '/api/bug-report',
      { description: '[TEST] With snapshot', snapshot: snap, page: 'workspace' }, simToken);
    assertEqual(status, 200, 'status');
    assert(data.ok, 'ok');
  });

  await test('POST /api/bug-report — missing description returns 400', async () => {
    const { status } = await req('POST', '/api/bug-report',
      { description: '' }, simToken);
    assertEqual(status, 400, 'status');
  });

  await test('POST /api/bug-report — invalid snapshot (not data URL) returns 400', async () => {
    const { status } = await req('POST', '/api/bug-report',
      { description: '[TEST] Bad snap', snapshot: 'http://evil.com/img.png' }, simToken);
    assertEqual(status, 400, 'status');
  });

  await test('GET /api/admin/bug-reports — returns array including test report', async () => {
    const { status, data } = await req('GET', '/api/admin/bug-reports', null, adminToken);
    assertEqual(status, 200, 'status');
    assert(Array.isArray(data), 'is array');
    assert(data.some(r => r.id === bugReportId), 'test report present');
  });

  await test('POST /api/admin/bug-reports — admin logs bug directly', async () => {
    const { status, data } = await req('POST', '/api/admin/bug-reports',
      { description: '[TEST] Admin-observed bug' }, adminToken);
    assertEqual(status, 200, 'status');
    assert(data.ok, 'ok');
    assert(data.id, 'has id');
  });

  await test('PATCH /api/admin/bug-reports/:id — marks resolved', async () => {
    const { status, data } = await req('PATCH', `/api/admin/bug-reports/${bugReportId}`,
      { status: 'resolved', admin_notes: 'Fixed in test run' }, adminToken);
    assertEqual(status, 200, 'status');
    assert(data.ok, 'ok');
    // Verify
    const { data: reports } = await req('GET', '/api/admin/bug-reports', null, adminToken);
    const r = reports.find(r => r.id === bugReportId);
    assertEqual(r.status, 'resolved', 'status=resolved');
    assertEqual(r.admin_notes, 'Fixed in test run', 'notes saved');
  });

  await test('PATCH /api/admin/bug-reports/:id — 404 for unknown id', async () => {
    const { status } = await req('PATCH', '/api/admin/bug-reports/no-such-id-xyz',
      { status: 'resolved' }, adminToken);
    assertEqual(status, 404, 'status');
  });

  // ══════════════════════════════════════════════════════════════
  await section('10. AT Fetch-URL Security');
  // ══════════════════════════════════════════════════════════════

  await test('POST /api/at/fetch-url — unapproved domain returns 403', async () => {
    const { status, data } = await req('POST', '/api/at/fetch-url',
      { url: 'https://evil-site-xyz.com/page' }, simToken);
    assertEqual(status, 403, 'status');
    assertIncludes(data.error + data.message, 'pproved', 'error mentions approval');
  });

  await test('POST /api/at/fetch-url — RFC1918 address blocked', async () => {
    const { status } = await req('POST', '/api/at/fetch-url',
      { url: 'http://192.168.1.1/admin' }, simToken);
    assertEqual(status, 403, 'status');
  });

  await test('POST /api/at/fetch-url — loopback address blocked', async () => {
    const { status } = await req('POST', '/api/at/fetch-url',
      { url: 'http://127.0.0.1:3000/api/sim/settings' }, simToken);
    assertEqual(status, 403, 'status');
  });

  await test('POST /api/at/fetch-url — localhost blocked', async () => {
    const { status } = await req('POST', '/api/at/fetch-url',
      { url: 'http://localhost/etc/passwd' }, simToken);
    assertEqual(status, 403, 'status');
  });

  await test('POST /api/at/fetch-url — missing url returns 400', async () => {
    const { status } = await req('POST', '/api/at/fetch-url', {}, simToken);
    assertEqual(status, 400, 'status');
  });

  // ══════════════════════════════════════════════════════════════
  await section('11. Lit Sources');
  // ══════════════════════════════════════════════════════════════

  let originalDomains = [];

  await test('GET /api/lit-sources — public, returns approved_domains array', async () => {
    const { status, data } = await req('GET', '/api/lit-sources');
    assertEqual(status, 200, 'status');
    assert(Array.isArray(data.approved_domains), 'is array');
    originalDomains = data.approved_domains;
  });

  await test('POST /api/admin/lit-sources — updates domain list', async () => {
    const newList = [...originalDomains, 'test-domain-xyz.edu'];
    const { status, data } = await req('POST', '/api/admin/lit-sources',
      { approved_domains: newList }, adminToken);
    assertEqual(status, 200, 'status');
    assert(data.approved_domains.includes('test-domain-xyz.edu'), 'new domain present');
    // Restore
    await req('POST', '/api/admin/lit-sources',
      { approved_domains: originalDomains }, adminToken);
  });

  await test('POST /api/admin/lit-sources — strips invalid domain formats', async () => {
    const { data } = await req('POST', '/api/admin/lit-sources',
      { approved_domains: ['valid.com', 'INVALID SPACES', 'also-valid.org', '../etc'] },
      adminToken);
    assert(data.approved_domains.includes('valid.com'), 'valid.com kept');
    assert(data.approved_domains.includes('also-valid.org'), 'also-valid.org kept');
    assert(!data.approved_domains.includes('INVALID SPACES'), 'spaces rejected');
    assert(!data.approved_domains.some(d => d.includes('..')), 'traversal rejected');
    // Restore
    await req('POST', '/api/admin/lit-sources',
      { approved_domains: originalDomains }, adminToken);
  });

  await test('POST /api/admin/lit-sources — non-array body returns 400', async () => {
    const { status } = await req('POST', '/api/admin/lit-sources',
      { approved_domains: 'not-an-array' }, adminToken);
    assertEqual(status, 400, 'status');
  });

  // ══════════════════════════════════════════════════════════════
  await section('12. Concept Resources');
  // ══════════════════════════════════════════════════════════════

  await test('GET /api/resources/:slug — public, returns resources array', async () => {
    const { status, data } = await req('GET', '/api/resources/em_waves');
    assertEqual(status, 200, 'status');
    assert(Array.isArray(data.resources), 'resources is array');
  });

  await test('GET /api/resources/:slug — unknown concept returns empty array', async () => {
    const { status, data } = await req('GET', '/api/resources/no_such_concept_xyz');
    assertEqual(status, 200, 'status');
    assertEqual(data.resources.length, 0, 'empty array');
  });

  await test('GET /api/resources/file/:slug/:filename — path traversal blocked', async () => {
    const { status } = await req('GET', '/api/resources/file/em_waves/../../../etc/passwd');
    // Either 400 or 404 is acceptable — must not serve the file
    assert(status === 400 || status === 404, `status should be 400 or 404, got ${status}`);
  });

  await test('DELETE /api/admin/resources/:slug/:filename — path traversal blocked', async () => {
    const { status } = await req('DELETE',
      '/api/admin/resources/em_waves/../../state/sim-settings.json',
      null, adminToken);
    // 400 or 404 are both acceptable — must not delete the file
    assert(status === 400 || status === 404, `status should be 400 or 404, got ${status}`);
  });

  // ══════════════════════════════════════════════════════════════
  await section('13. Public Endpoints');
  // ══════════════════════════════════════════════════════════════

  await test('GET /api/h-index — no auth required, returns authors array', async () => {
    const { status, data } = await req('GET', '/api/h-index');
    assertEqual(status, 200, 'status');
    assert(Array.isArray(data.authors), 'authors is array');
  });

  await test('API key NOT present in any test response', async () => {
    const apiKey = process.env.ANTHROPIC_API_KEY || '';
    if (!apiKey) {
      // Can't test if key isn't in environment during test run
      return;
    }
    // Check a representative set of public + student responses
    const urls = [
      ['/api/students/list',    null,           null],
      ['/api/sim/settings',     null,           adminToken],
      ['/api/admin/workflow',   null,           adminToken],
      ['/api/admin/bug-reports', null,          adminToken],
    ];
    for (const [url, body, token] of urls) {
      const { data } = await req('GET', url, body, token);
      assert(!JSON.stringify(data).includes(apiKey),
        `API key found in ${url} response`);
    }
  });

  // ══════════════════════════════════════════════════════════════
  await section('14. Admin Route Protection Robustness');
  // ══════════════════════════════════════════════════════════════

  await test('Admin routes reject student token', async () => {
    const { status } = await req('GET', '/api/sim/settings', null, studentToken);
    assertEqual(status, 401, 'status — student token rejected for admin route');
  });

  await test('Admin routes reject sim token', async () => {
    const { status } = await req('GET', '/api/admin/workflow', null, simToken);
    assertEqual(status, 401, 'status — sim token rejected for admin route');
  });

  await test('Student routes reject admin token (different middleware)', async () => {
    // Admin token is not a valid student token
    const { status } = await req('GET', '/api/student/topics', null, adminToken);
    assertEqual(status, 401, 'status — admin token rejected for student route');
  });

  // ══════════════════════════════════════════════════════════════
  await section('15. HW Question Bank');
  // ══════════════════════════════════════════════════════════════

  let testQId = null;

  await test('GET /api/admin/hw/questions — no auth → 401', async () => {
    const { status } = await req('GET', '/api/admin/hw/questions');
    assertEqual(status, 401, 'status');
  });

  await test('POST /api/hw/submit — no token → 401', async () => {
    const { status } = await req('POST', '/api/hw/submit', { concept_slug: 'x', question: { stem: 'x', parts: [] } });
    assertEqual(status, 401, 'status');
  });

  await test('POST /api/hw/submit — missing concept_slug → 400', async () => {
    const { status } = await req('POST', '/api/hw/submit',
      { question: { stem: 'A ball falls.', parts: [{ label: 'a', prompt: 'Why?', answer: 'Gravity.' }] } },
      studentToken);
    assertEqual(status, 400, 'status');
  });

  await test('POST /api/hw/submit — missing answer → 400', async () => {
    const { status } = await req('POST', '/api/hw/submit',
      { concept_slug: TEST_SLUG, question: { stem: 'A ball falls.', parts: [{ label: 'a', prompt: 'Why?', answer: '' }] } },
      studentToken);
    assertEqual(status, 400, 'status');
  });

  await test('POST /api/hw/submit — invalid figure → 400', async () => {
    const { status } = await req('POST', '/api/hw/submit',
      { concept_slug: TEST_SLUG, question: { stem: 'Q.', parts: [{ label: 'a', prompt: 'P?', answer: 'A.' }] },
        figure_dataurl: 'not-a-data-url' }, studentToken);
    assertEqual(status, 400, 'status');
  });

  await test('POST /api/hw/submit — valid question submitted', async () => {
    const { status, data } = await req('POST', '/api/hw/submit', {
      concept_slug: TEST_SLUG,
      module: '[TEST]',
      title: '[TEST] Question',
      question: {
        stem: '[TEST] A particle moves through a magnetic field.',
        parts: [
          { label: 'a', prompt: 'What is the direction of the force?', answer: 'Perpendicular to both v and B.' },
          { label: 'b', prompt: 'What is the magnitude?', answer: 'F = qvB sin θ' }
        ],
        difficulty: 'medium',
        tags: ['magnetism', 'force']
      }
    }, studentToken);
    assertEqual(status, 200, 'status');
    assert(data.ok, 'ok');
    assert(data.id, 'has id');
    testQId = data.id;
  });

  await test('GET /api/admin/hw/questions — returns submitted question', async () => {
    const { status, data } = await req('GET', '/api/admin/hw/questions', null, adminToken);
    assertEqual(status, 200, 'status');
    assert(Array.isArray(data.questions), 'questions is array');
    assert(data.questions.some(q => q.id === testQId), 'test question present');
  });

  await test('GET /api/admin/hw/questions?concept= — filters correctly', async () => {
    const { data } = await req('GET', `/api/admin/hw/questions?concept=${TEST_SLUG}`, null, adminToken);
    assert(data.questions.every(q => q.concept_slug === TEST_SLUG), 'all match concept');
  });

  await test('GET /api/admin/hw/questions?status=submitted — filters by status', async () => {
    const { data } = await req('GET', `/api/admin/hw/questions?status=submitted`, null, adminToken);
    assert(data.questions.every(q => q.status === 'submitted'), 'all submitted');
  });

  await test('PATCH /api/admin/hw/questions/:id — approve', async () => {
    const { status, data } = await req('PATCH', `/api/admin/hw/questions/${testQId}`,
      { status: 'approved', admin_notes: 'Good question.' }, adminToken);
    assertEqual(status, 200, 'status');
    assert(data.ok, 'ok');
  });

  await test('PATCH /api/admin/hw/questions/:id — status persisted', async () => {
    const { data } = await req('GET', `/api/admin/hw/questions?concept=${TEST_SLUG}`, null, adminToken);
    const q = data.questions.find(q => q.id === testQId);
    assertEqual(q?.status, 'approved', 'status is approved');
    assertEqual(q?.admin_notes, 'Good question.', 'notes persisted');
  });

  await test('PATCH /api/admin/hw/questions/:id — invalid status → 400', async () => {
    const { status } = await req('PATCH', `/api/admin/hw/questions/${testQId}`,
      { status: 'unknown_status' }, adminToken);
    assertEqual(status, 400, 'status');
  });

  await test('PATCH /api/admin/hw/questions/:id — 404 for unknown id', async () => {
    const { status } = await req('PATCH', `/api/admin/hw/questions/no-such-id-xyz`,
      { status: 'approved' }, adminToken);
    assertEqual(status, 404, 'status');
  });

  await test('GET /api/admin/hw/export/:slug — approved questions text dump', async () => {
    const { status, data } = await req('GET', `/api/admin/hw/export/${TEST_SLUG}`, null, adminToken);
    assertEqual(status, 200, 'status');
    assert(data.count >= 1, 'count >= 1');
    assert(typeof data.text === 'string', 'text is string');
    assert(data.text.includes('[TEST]'), 'text contains question content');
  });

  await test('GET /api/admin/hw/export/:slug — empty for concept with no approved Qs', async () => {
    const { status, data } = await req('GET', '/api/admin/hw/export/no_such_concept_xyz', null, adminToken);
    assertEqual(status, 200, 'status');
    assertEqual(data.count, 0, 'count is 0');
    assertEqual(data.text, '', 'text is empty');
  });

  await test('POST /api/hw/chat — no token → 401', async () => {
    const { status } = await req('POST', '/api/hw/chat', { messages: [{ role: 'user', content: 'hi' }] });
    assertEqual(status, 401, 'status');
  });

  await test('POST /api/hw/chat — missing messages → 400', async () => {
    const { status } = await req('POST', '/api/hw/chat', { messages: [] }, simToken);
    assertEqual(status, 400, 'status');
  });

  // ══════════════════════════════════════════════════════════════
  // 16. DRAFT SAVE / RESTORE
  // ══════════════════════════════════════════════════════════════
  section('16. Draft Save / Restore');

  await test('POST /api/student/draft/:slug — no token → 401', async () => {
    const { status } = await req('POST', '/api/student/draft/test_concept', { html: '<p>hi</p>' });
    assertEqual(status, 401, 'status');
  });

  await test('GET /api/student/draft/:slug — no token → 401', async () => {
    const { status } = await req('GET', '/api/student/draft/test_concept');
    assertEqual(status, 401, 'status');
  });

  await test('POST /api/student/draft/:slug — saves draft', async () => {
    const html = '<html><body><script type="application/json" id="ic-source-data">{"title":"test"}</script></body></html>';
    const { status } = await req('POST', '/api/student/draft/test_draft_slug', { html }, studentToken);
    assertEqual(status, 200, 'status');
  });

  await test('GET /api/student/draft/:slug — restores own draft', async () => {
    const { status, data } = await req('GET', '/api/student/draft/test_draft_slug', null, studentToken);
    assertEqual(status, 200, 'status');
    assert(typeof data === 'string' && data.includes('ic-source-data'), 'contains draft content');
  });

  await test('GET /api/student/draft/:slug — 404 for nonexistent slug', async () => {
    const { status } = await req('GET', '/api/student/draft/no_such_slug_xyz', null, studentToken);
    assertEqual(status, 404, 'status');
  });

  await test('GET /api/admin/draft/:studentName/:slug — no token → 401', async () => {
    const { status } = await req('GET', `/api/admin/draft/${TEST_STUDENT}/test_draft_slug`);
    assertEqual(status, 401, 'status');
  });

  await test('GET /api/admin/draft/:studentName/:slug — admin can read any draft', async () => {
    const { status, data } = await req('GET', `/api/admin/draft/${TEST_STUDENT}/test_draft_slug`, null, adminToken);
    assertEqual(status, 200, 'status');
    assert(typeof data === 'string' && data.includes('ic-source-data'), 'admin sees draft content');
  });

  await test('GET /api/admin/draft/:studentName/:slug — 404 for missing draft', async () => {
    const { status } = await req('GET', `/api/admin/draft/${TEST_STUDENT}/no_such_slug_xyz`, null, adminToken);
    assertEqual(status, 404, 'status');
  });

  // Cleanup test draft file
  function cleanupTestDraft() {
    try {
      const draftsDir = require('path').join(__dirname, '..', 'state', 'drafts');
      const safeName = TEST_STUDENT.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_');
      const fname = `${safeName}__test_draft_slug.html`;
      require('fs').unlinkSync(require('path').join(draftsDir, fname));
    } catch {}
  }

  // Cleanup test questions from questions.json
  function cleanupTestQuestions() {
    try {
      const qPath = require('path').join(__dirname, '..', 'state', 'questions.json');
      const qs = JSON.parse(require('fs').readFileSync(qPath, 'utf8'));
      const filtered = qs.filter(q => q.module !== '[TEST]' && !q.title?.startsWith('[TEST]'));
      require('fs').writeFileSync(qPath, JSON.stringify(filtered, null, 2));
    } catch {}
  }

  // ══════════════════════════════════════════════════════════════
  // CLEANUP
  // ══════════════════════════════════════════════════════════════

  console.log(`\n${D('Cleaning up test data…')}`);
  cleanupTestStudent();
  cleanupTestWorkflow();
  cleanupTestBugs();
  cleanupTestQuestions();
  cleanupTestDraft();

  // Remove test student also via API for clean server state
  await req('POST', '/api/sim/students/remove', { name: TEST_STUDENT }, adminToken).catch(() => {});

  // ══════════════════════════════════════════════════════════════
  // SUMMARY
  // ══════════════════════════════════════════════════════════════

  const total = passed + failed + skipped;
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`${B('Results:')} ${G(passed + ' passed')}  ${failed > 0 ? R(failed + ' failed') : D('0 failed')}  ${skipped > 0 ? Y(skipped + ' skipped') : D('0 skipped')}  ${D('/ ' + total + ' total')}`);

  if (failures.length > 0) {
    console.log(`\n${R('Failed tests:')}`);
    failures.forEach(f => {
      console.log(`  ${R('✗')} [${f.section}] ${f.name}`);
      console.log(`      ${D(f.error)}`);
    });
  }

  if (failed === 0) {
    console.log(`\n${G('All tests passed. ✓')}`);
  } else {
    console.log(`\n${R(failed + ' test(s) failed.')}`);
  }

  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(R('\nUnhandled error in test runner:'), err);
  process.exit(1);
});
