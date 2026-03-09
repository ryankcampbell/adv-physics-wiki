# End-to-End Test Plan — AT/HW Feature

**Prerequisites:** Server running on port 3000 (`./admin.sh`).
Demo sim file: `demo_student_submission/time_dilation_sim.html`

---

## Test A — Navigator (node colors + detail panel)

Open: `http://localhost:3000/index.html`

| Node | Expected color | Detail panel check |
|---|---|---|
| Rel. Velocity Addition | Orange | "Submitted — awaiting review" + **Run AT →** button (dark red) |
| Length Contraction | Red | "Needs revision" + Revise button |
| Spacetime Diagrams | Green | IC entry listed + **"View IC / AT / HW →"** link |
| Four Vectors | Blue | "No contribution yet" + Claim button |
| Time Dilation | Purple | "Draft in progress" or "No contribution yet" |

---

## Test B — IC Editor (all 3 modes)

### IC mode
`http://localhost:3000/ic_editor.html?concept=time_dilation&name=Time+Dilation`

- [ ] Navy header bar
- [ ] Right panel shows live preview
- [ ] Fill in Research Question: `"Why do moving clocks tick slower?"`
- [ ] Drag `demo_student_submission/time_dilation_sim.html` from Finder onto the **Simulation** drop zone → sim embeds and appears in live preview
- [ ] Type in Explainer → "Saved" badge appears (auto-save working)
- [ ] Click **↓ Save Draft** → downloads a `.json` file
- [ ] Refresh the page → draft reloads automatically

### AT mode
`http://localhost:3000/ic_editor.html?at=spacetime_diagrams`

- [ ] Dark **red** header: "AT: Spacetime Diagrams"
- [ ] Left panel: reviewer name field + challenge blocks section
- [ ] Right panel labeled "Reference IC" — loads `ics/spacetime_diagrams/index.html` in iframe
- [ ] Click **+ Add Challenge** → red-bordered challenge block appears with Type / Claim / Steps to Reproduce / Expected Correction fields
- [ ] Verdict dropdown visible at bottom
- [ ] Draft saves independently (key: `at-draft-spacetime_diagrams`)

### HW mode
`http://localhost:3000/ic_editor.html?hw=spacetime_diagrams`

- [ ] Dark **teal** header: "HW: Spacetime Diagrams"
- [ ] Right panel shows same reference IC
- [ ] Click **+ Add Question** → teal-bordered question block appears with Difficulty / Aspect / Question / Model Answer fields
- [ ] Draft saves independently (key: `hw-draft-spacetime_diagrams`)

---

## Test C — Concept Viewer

### Certified concept with IC
`http://localhost:3000/concept.html?id=spacetime_diagrams`

- [ ] Header shows "Spacetime Diagrams" as concept title
- [ ] Tab bar shows **IC Contributions (1)** | Adversarial Tests (0) | HW Questions (0)
- [ ] IC tab active by default
- [ ] Sidebar shows "S. Park & A. Rodriguez" entry
- [ ] Clicking the entry loads the IC in the right-hand iframe
- [ ] AT tab → empty state message (no AT yet)
- [ ] HW tab → empty state message (no HW yet)

### Concept with no submissions
`http://localhost:3000/concept.html?id=time_dilation`

- [ ] Title shows "Time Dilation"
- [ ] All 3 tabs show empty state

### Bad/missing concept ID
`http://localhost:3000/concept.html`

- [ ] Shows "No concept specified" error with link back to Navigator

---

## Test D — Admin Dashboard

Open: `http://localhost:3000/admin.html`

### Drive Inbox
- [ ] Server badge shows **green "Server online"**
- [ ] If Drive has files: each row shows colored type badge — **IC** (blue) / **AT** (red) / **HW** (teal)
- [ ] Preview button on an AT file → AT action bar appears above iframe (dark red bar with concept selector, feedback textarea, Uphold and Dismiss buttons)
- [ ] Preview button on an IC or HW file → AT action bar is hidden

### Concept States table
- [ ] Table has **7 columns**: Concept / IC Status / **AT Status** / **HW Status** / Claimed By / Adversarial Team / Notes
- [ ] `Rel. Velocity Addition` row: IC Status = submitted, AT Status = "—" (editable)
- [ ] `Length Contraction` row: IC Status = needs_revision, feedback field populated
- [ ] AT Status and HW Status selects are always enabled (not disabled for certified concepts)

### AT Uphold workflow (requires an AT file in Drive inbox)
1. Publish an AT file for a concept (or use an existing one)
2. Preview it → AT action bar appears
3. Select the IC concept from the dropdown
4. Type feedback: `"Limiting case at β=0 shows γ=0 instead of 1 — fix the denominator"`
5. Click **Uphold — IC Needs Revision**
6. [ ] Status shows "Pushing…" then "✓ IC sent for revision"
7. [ ] Modal closes after ~2 seconds
8. [ ] Concept States table refreshes: that concept's IC Status = needs_revision, feedback populated
9. [ ] On the Navigator: that concept's node turns red

### Push State
- [ ] Make a manual change to any IC Status dropdown
- [ ] Click **↑ Push state.json to GitHub**
- [ ] Status shows "✓ Pushed — navigator updates in ~60s"
- [ ] Revert the change and push again to restore

---

## Test E — Full Publish Workflow (requires Google Drive + GitHub)

1. Open IC Editor in IC mode for `time_dilation`
2. Fill in all 7 sections; drag in the demo sim
3. Click **Submit to Drive** → sign in with Google → file uploads
4. In admin dashboard, Drive Inbox refreshes → `time_dilation_*.html` appears with blue **IC** badge
5. Select concept = "Time Dilation", confirm label, click **Publish →**
6. [ ] Button turns green "✓ Published"
7. [ ] Node on Navigator turns orange within 60s
8. [ ] `concept.html?id=time_dilation` → IC tab shows the new entry

Repeat for AT mode:
9. Open `ic_editor.html?at=time_dilation`, fill in a challenge, submit
10. Admin inbox: red **AT** badge appears
11. Preview → AT action bar → Uphold or Dismiss
12. [ ] Node turns red (uphold) or stays orange (dismiss)

Repeat for HW mode:
13. Open `ic_editor.html?hw=time_dilation`, add 2 questions, submit
14. Admin inbox: teal **HW** badge appears
15. Publish → label e.g. `hw_johnson`
16. [ ] `concept.html?id=time_dilation` → HW tab now shows the entry

---

## Known Caveats

- The Concept Viewer iframes load from GitHub Pages URLs (stored in `contributions.json`), not localhost — internet connection required for iframe content to appear.
- AT uphold requires the concept to be loaded in the current module in the admin dashboard (module must be selected before upholding).
- GitHub Pages CDN lag: after any git push, allow 1–5 min before testing on the live site. Use incognito to avoid cache.
