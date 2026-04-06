# Advanced Physics Wiki — System Overview (Technical Reference)

## Architecture

Single-process Node.js server (`server.js`) serving static HTML/JS files and a REST API. No database — all state is flat JSON files in `state/`. All student-facing pages are vanilla JS with no framework.

```
Browser (student/teacher)
    ↕ HTTP + SSE
server.js (Express, port 3000)
    ↕ fs read/write
state/*.json          — mutable runtime state
contributions.json    — published IC registry (also in git)
ics/**/*.html         — approved IC/AT/HW HTML files (also in git)
    ↕ git push
GitHub Pages          — public wiki hosting
    ↕ Anthropic API
Claude (Sonnet/Haiku) — AI features
    ↕ Google Drive API
Drive Inbox           — submission review queue
```

---

## Key files

| File | Purpose |
|---|---|
| `server.js` | All server logic — ~2000 lines |
| `ic_editor.html` | IC / AT / HW editor (mode-switched via URL params) |
| `workspace.html` | Student portal — topic list, stage routing |
| `admin.html` | Teacher inbox, pipeline, question bank, settings |
| `index.html` | Concept navigator (D3 force graph) |
| `concept.html` | Three-tab IC/AT/HW viewer |
| `at_workspace.html` | Full AT investigation workspace (5 tools + Socratic chat) |
| `hw_workspace.html` | Homework question authoring with AI |
| `student.html` | Login page |
| `contributions.json` | Registry of all published entries (ic/ic-draft/at/hw) |
| `state/sim-settings.json` | Students list, admin password, AI model, flags |
| `state/workflow.json` | Per-student per-concept stage and status |
| `state/questions.json` | All submitted HW questions with approval status |
| `state/drafts/` | Server-side draft snapshots (seeded on IC approval) |
| `modules/*.json` | Concept graph definitions (nodes, edges, descriptions) |

---

## URL scheme

| URL param | Mode | File opened |
|---|---|---|
| `ic_editor.html?concept=slug` | IC writing | ic_editor.html |
| `ic_editor.html?at=slug` | AT review (simple) | ic_editor.html |
| `ic_editor.html?hw=slug` | HW writing | ic_editor.html |
| `at_workspace.html?concept=slug` | Full AT investigation | at_workspace.html |
| `hw_workspace.html?concept=slug` | HW authoring | hw_workspace.html |
| `concept.html?id=slug` | Concept viewer | concept.html |

---

## Auth model

Three independent in-memory session maps, each keyed by a UUID token:

- `adminSessions` — one session per admin login, token in `Authorization: Bearer` header
- `studentSessions` — per student login, token stored as `student-session-token` in localStorage
- `simSessions` — created simultaneously with student login, token stored as `sim-session-token`

Student login creates **both** tokens. The sim token is used for AI endpoints (rate-limited separately). Student token is used for draft/workflow endpoints.

Middleware: `requireAdmin`, `requireStudentToken`, `requireSimToken`.

---

## Contribution pipeline detail

### IC approval (`POST /api/publish`, `decision: 'approve'`, `resolvedFileType: 'ic'`)
1. Parse `adv-physics-stage`, `adv-physics-slug`, `adv-physics-student` meta tags from HTML
2. Write HTML to `ics/{slug}/{label}.html`
3. Upsert `type:'ic-draft'` entry in `contributions.json`
4. Seed student's draft file: copy IC HTML to `state/drafts/{name}__{slug}.html`
5. Advance workflow: `stage: 'at', status: 'draft'`
6. Git add + commit + push (synchronous)
7. Auto-dismiss file from inbox (add to `state/dismissed.json`)

### AT approval (`resolvedFileType: 'at'`)
1. Write HTML to `ics/{slug}/at_{label}.html`
2. Upsert `type:'at'` entry in `contributions.json` (URL = GitHub Pages path)
3. Advance workflow: `stage: 'hw', status: 'draft'`
4. Git add + commit + push
5. Auto-dismiss

### HW approval via Drive inbox (`resolvedFileType: 'hw'`)
1. Write HTML to `ics/{slug}/hw_{label}.html`
2. Flip `ic-draft` → `ic` in `contributions.json`
3. Add `type:'hw'` entry (URL = `/api/public/hw-page/{slug}`)
4. Advance workflow: `stage: 'complete', status: 'complete'`
5. Git push

### HW approval via Question Bank (`PATCH /api/admin/hw/questions/:id`)
1. Update `state/questions.json` status → `'approved'`
2. Flip `ic-draft` → `ic` in `contributions.json`
3. Add `type:'hw'` entry in `contributions.json`
4. Advance workflow to complete
5. Respond immediately (HTTP 200)
6. `setImmediate()`: git add + commit + push in background

---

## IC context bundle (`at-ic-{slug}` in localStorage)

Carries IC data from the AT editor into the AT workspace and HW workspace:

```json
{
  "conceptSlug": "time_dilation",
  "conceptTitle": "Time Dilation",
  "icUrl": "https://ryankcampbell.github.io/adv-physics-wiki/ics/time_dilation/sadie_park.html",
  "rq": "Why does a moving clock tick slower?",
  "explainer": "...",
  "module": "Special Relativity",
  "simCaption": "..."
}
```

**Important:** field is `rq` not `researchQuestion`. Server reads `ctx.rq` in both `/api/at/chat` and `/api/hw/chat`.

Set in: `ic_editor.html` initMode() AT branch (setTimeout 800ms after lockICFields), and `launchATWorkspace()`.

---

## Slug / concept_id matching

The navigator, concept viewer, and contributions.json all use the same concept id (`slug`). This must match the `id` field in the module JSON.

**Critical:** `startTopicFromNavigator()` in `index.html` passes `concept_id: slug` to `/api/student/topic/start`. The server uses this directly. Without it, the server calls `slugify(title)` which prepends `the_` for titles starting with "The", breaking the match.

The workspace modal (`workspace.html`) also always passes `concept_id` from the module JSON.

---

## Reference panel local path conversion

Both `ic_editor.html` (AT mode) and `at_workspace.html` convert GitHub Pages URLs to local server paths before setting iframe src:

```javascript
const localUrl = url.replace(/^https?:\/\/[^/]+\/adv-physics-wiki/, '');
```

The server serves all static files via `express.static(__dirname)`, so `ics/{slug}/{file}.html` is always available instantly at `/ics/{slug}/{file}.html` without CDN delay.

---

## AI endpoints

| Endpoint | Auth | Model | Purpose |
|---|---|---|---|
| `POST /api/sim/generate` | simToken | Haiku (configurable) | Generate sim HTML from description |
| `POST /api/sim/edit` | simToken | Sonnet | Edit existing sim |
| `POST /api/at/chat` | simToken | Sonnet | Socratic AT chat |
| `POST /api/hw/chat` | simToken | Sonnet | HW authoring chat |
| `POST /api/at/case-builder` | simToken | Sonnet | AT case builder tool |
| `POST /api/at/lit-search` | simToken | Sonnet | AT literature review tool |
| Various other AT tools | simToken | Sonnet | Statistical spread, measurement table, claim audit |

All AI endpoints stream responses via SSE (`text/event-stream`).

---

## Rate limiting

AT and HW chat turns are limited per student per day:

- Key format: `{name}_at_YYYY-MM-DD` and `{name}_hw_YYYY-MM-DD` in `state/daily-limits.json`
- Default limit: 20 turns/day (configurable per student in `sim-settings.json`)
- Reset at midnight (date-keyed)

---

## State files reference

| File | Contents | Pushed to git? |
|---|---|---|
| `contributions.json` | Published IC registry | Yes |
| `state/workflow.json` | Student stage/status per concept | No |
| `state/questions.json` | HW questions + answers + approval | No |
| `state/sim-settings.json` | Students, passwords, admin pw, flags | No |
| `state/drafts/` | Server-side HTML snapshots | No |
| `state/daily-limits.json` | AI turn counts per student per day | No |
| `state/dismissed.json` | Drive inbox dismissed file IDs | No |
| `state/seen_files.json` | Drive files already fetched | No |
| `state/state.json` | IC revision feedback (legacy fallback) | No |
| `state/sim-log.json` | AI usage log | No |

---

## Adding a new student

Edit `state/sim-settings.json`:

```json
"students": {
  "new student name": {
    "limit": 20,
    "password": "abc123",
    "locked": false
  }
}
```

Name must be lowercase. Password is case-sensitive. No server restart needed.

---

## Module JSON format

```json
{
  "module": "Special Relativity",
  "concepts": [
    {
      "id": "time_dilation",
      "name": "Time Dilation",
      "description": "...",
      "prerequisites": ["lorentz_factor"],
      "resources": [...]
    }
  ],
  "questions": [...],
  "edges": [{ "from": "lorentz_factor", "to": "time_dilation" }]
}
```

The `id` field must match `concept_id` in `contributions.json` and the key in `state/workflow.json`. This is enforced by always passing `concept_id` from the module JSON when starting a new topic.
