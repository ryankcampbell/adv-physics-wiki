# Advanced Physics Wiki — Teacher Daily Operations Guide

## Starting the server

Open a terminal in the project folder and run:

```bash
node server.js
```

The server starts on port 3000. Students connect via `http://[your laptop's IP]:3000`.

To find your IP on a Mac: System Settings → Network → Wi-Fi → details, or run `ipconfig getifaddr en0` in terminal.

**The server must stay running all class.** Don't close the terminal or let your laptop sleep while students are working. If you need to restart it, run `node server.js` again — all state is saved to disk and resumes correctly.

---

## The admin panel

Go to `http://localhost:3000/admin.html` and log in with your admin password.

The admin panel has four sections:

### Drive Inbox
Where student submissions appear. Each card shows the student name, concept, stage (IC / AT), and submission time.

- **Approve → AT** — approves an IC, advances student to AT stage, dismisses from inbox
- **Approve → HW** — approves an AT, advances student to HW stage, dismisses from inbox
- **Request Revision** — sends the submission back with your notes; student sees them in their editor
- **View** — opens the submitted HTML in a new tab so you can read it before deciding

After approving, the student's workspace card updates automatically (they may need to refresh).

### Student Pipeline
A live view of where every student is in the workflow. Useful for a quick status check during class. Updates after every approve/reject action.

### Question Bank
Where approved HW questions accumulate. You can:
- Read each question and answer key
- **Approve** — publishes the IC to the wiki (node turns green on navigator), marks student complete
- **Reject** — sends it back for revision (student gets a note)
- **Export** — downloads a clean text dump of all approved questions for a concept (useful for making exams)

### Settings
- Toggle **Simple AT / Full AT mode** — simple sends students directly to the AT editor; full sends them to the 5-tool AT investigation workspace first
- Change the AI model used for simulation building (Haiku is faster and cheaper; Sonnet is smarter)
- Change your admin password

---

## Typical class day

**Before class:**
1. Start the server (`node server.js`)
2. Open admin panel, check Drive Inbox for overnight submissions
3. Open the Concept Navigator (`http://localhost:3000/index.html`) — green nodes = published ICs

**During class:**
- Students work independently; you circulate
- Check the Drive Inbox periodically — new submissions show up in real time
- Approve or request revision as you read
- If a student is stuck, check their card in the Student Pipeline to see their stage/status

**After class:**
- Process any remaining inbox items
- Approve pending Question Bank items if you haven't already
- The server can keep running overnight if submissions are expected

---

## Approving an IC — what to look for

A good IC has:
- A specific, answerable research question (not "what is time dilation?" but "why does a moving clock tick slower than a stationary one?")
- An explainer written for a classmate — not copied from a source, not overly formal
- A simulation that actually responds to inputs and illustrates the concept
- At least one real citation (not just Wikipedia)
- Two limiting cases that make physical sense (e.g. v→0 recovers Newtonian result)

Common revision reasons:
- Explainer reads like a Wikipedia summary — ask them to rewrite in their own voice
- Simulation doesn't connect to the concept — ask them to describe what they want it to show
- Research question is too broad — ask them to narrow it
- No citations — require at least one primary or secondary source

---

## Approving an AT — what to look for

A good AT report:
- Actually interacted with the simulation (not just read the IC)
- Found at least one genuine edge case or issue
- Limiting case verification matches what the sim actually shows
- Verdict is justified (a "pass" with no findings is a weak AT)

You can request revision if the AT feels superficial — the student can re-open the AT editor and resubmit.

---

## Approving a HW question — what to look for

A good HW question:
- Is solvable with the physics from the IC (not requiring outside knowledge)
- Has a clear stem and specific part prompts
- Has a correct, worked answer key
- Is at an appropriate difficulty level (medium = one or two non-trivial steps)

The Question Bank export (per-concept text dump) is useful for building problem sets and exams.

---

## If something goes wrong

**Server won't start:** Check that port 3000 isn't already in use (`lsof -i :3000`). Kill any stale process and restart.

**Drive Inbox is empty but student says they submitted:** Check `state/seen_files.json` — if the file ID is in there but not in dismissed.json, it may be a filtering issue. Ask student to resubmit.

**GitHub push fails:** The IC is still saved locally in `ics/`. The push will retry next time any IC/AT is approved. You can also push manually: `git push` in the project terminal.

**Student can't log in:** Check `state/sim-settings.json` — verify their name matches exactly (case-insensitive, but spacing matters).

**A student's workflow is stuck:** Edit `state/workflow.json` directly to fix stage/status. The server reads it fresh on every request so no restart needed.

**Student accidentally cleared their browser:** Their server-side draft is still in `state/drafts/` — they can reopen their editor and it will restore from there.

---

## End of unit

When the unit is complete:
- Export question banks for each concept from the Question Bank panel
- Back up the `state/` folder and `ics/` folder
- The navigator shows a green node for every published concept — screenshot for records
- See `docs/may_launch.md` for the full reset procedure before a new cohort
