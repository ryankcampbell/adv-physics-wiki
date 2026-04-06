# May Launch Checklist

Use this before the first day of class with a real cohort. Work through it top to bottom.

---

## 1. Reset pilot state

The `state/` folder contains Sadie Park's test data. Clear it out:

```bash
# From the project root:

# Clear workflow (all student progress)
echo '{}' > state/workflow.json

# Clear questions bank
echo '[]' > state/questions.json

# Clear daily AI turn counts
echo '{}' > state/daily-limits.json

# Clear dismissed Drive inbox items
echo '[]' > state/dismissed.json

# Clear seen Drive files (so inbox re-scans from scratch)
echo '[]' > state/seen_files.json

# Clear AI usage log
echo '[]' > state/sim-log.json

# Clear server-side drafts
rm -f state/drafts/*.html

# Clear IC revision state
echo '[]' > state/state.json
```

---

## 2. Reset contributions.json

Remove all pilot entries. Keep only the ones you want to pre-populate as examples (or start fresh):

```bash
echo '[]' > contributions.json
```

If you want to keep any published ICs as reference examples, leave their `type:'ic'` entries in. Remove all `type:'ic-draft'`, `type:'at'`, and `type:'hw'` entries.

---

## 3. Enroll your students

Edit `state/sim-settings.json`. Add every student under `"students"`:

```json
{
  "adminPassword": "your-secure-password",
  "model": "haiku",
  "fullATEnabled": false,
  "students": {
    "firstname lastname": { "limit": 20, "password": "word1word2", "locked": false },
    "firstname lastname": { "limit": 20, "password": "word1word2", "locked": false }
  }
}
```

**Tips:**
- Names must be lowercase, spelled exactly as they'll type them at login
- Passwords: use two-word combos (memorable, not personal). Avoid special characters
- Limit 20 is generous for a class period — lower if you want to pace AI usage
- `locked: false` — set to `true` to temporarily block a student from AI features without removing them

Distribute passwords privately (slip of paper, not email).

---

## 4. Set your admin password

Change `adminPassword` in `state/sim-settings.json` to something you'll actually remember and that students won't guess. This is what you type to log into the admin panel.

---

## 5. Decide on AT mode

In `state/sim-settings.json`, set `fullATEnabled`:

- `false` — **Simple AT** (recommended for first run): students go directly to the AT editor, fill in limiting cases and a verdict. Takes ~20-30 min.
- `true` — **Full AT**: students pick 3 investigation tools (case builder, lit review, claim audit, etc.) and work through a Socratic chat before writing their summary. Takes a full class period.

You can toggle this mid-unit from the admin Settings panel.

---

## 6. Check your module JSONs

Open `modules/special_relativity.json` (and any other modules you'll use). Verify:

- [ ] Every concept your students will write an IC on has an `id` that matches what you'll assign
- [ ] Prerequisites are accurate (they affect the navigator layout)
- [ ] Descriptions are current (students see these in the concept detail panel)
- [ ] Resources list is populated for the concepts you're assigning (students see these in the navigator)

---

## 7. Clean up ics/ folder (optional)

If you want a clean slate on GitHub Pages too:

```bash
git rm -r ics/
mkdir ics
git add ics/
git commit -m "Reset ics/ for new cohort"
git push
```

Or leave the pilot ICs — they'll appear on the navigator as published concepts, which can actually be useful as examples.

---

## 8. Verify Google Drive auth

The Drive inbox requires valid service account credentials. Test it:

1. Start the server: `node server.js`
2. Log into admin panel at `http://localhost:3000/admin.html`
3. Check the Drive Inbox tab — it should either show files or show "No new submissions"
4. If it shows an auth error, re-check `credentials.json` and that your service account still has access to the Drive folder

The Drive folder ID is hardcoded in `server.js` — search for `DRIVE_FOLDER_ID` if you need to update it.

---

## 9. Verify GitHub push works

```bash
git push
```

If it fails, check that `GITHUB_TOKEN` is set in your environment:

```bash
export GITHUB_TOKEN=your_token_here
```

Add this to your shell profile (`~/.zshrc` or `~/.bash_profile`) so it persists. The token needs `repo` scope on `github.com/ryankcampbell/adv-physics-wiki`.

---

## 10. Test the student flow yourself

Before class, log in as a test student and run through:

- [ ] Log in at the student page
- [ ] Create a new topic from the navigator
- [ ] Open the IC editor — verify it loads correctly
- [ ] Build a small simulation with the AI sim builder
- [ ] Submit to Drive
- [ ] In admin panel: verify the submission appears in the inbox
- [ ] Approve it — verify student workspace advances to AT stage
- [ ] Open the AT editor — verify IC content pre-fills and reference panel loads
- [ ] Submit AT, approve in admin, verify HW stage
- [ ] Open HW workspace — verify AI chat has context (research question shows up)
- [ ] Submit a question, approve in Question Bank — verify node turns green on navigator

---

## 11. Prepare for day one

- [ ] Print student login credentials (name + password)
- [ ] Have the URL ready to share: `http://[your IP]:3000`
- [ ] Test the URL from a student device on the school network before class
- [ ] Have a backup plan if Wi-Fi is flaky (hotspot from your phone)
- [ ] Brief students on the IC→AT→HW flow (see `docs/for_students.md` — consider printing it or making it a handout)
- [ ] Decide which concept(s) to assign for the first IC

---

## 12. Day-of startup

```bash
# In terminal, from the project folder:
node server.js
```

Leave this terminal open all class. Open the admin panel in your browser at `http://localhost:3000/admin.html`.

That's it. You're live.

---

## Rollback / if something goes wrong

All state is in `state/` — it's just JSON. You can edit any file directly while the server is running (changes take effect on next request, no restart needed).

Git history is your safety net for `contributions.json` and `ics/`. If something gets corrupted:

```bash
git checkout contributions.json   # restore last committed version
```

For `state/` files (not in git), keep a manual backup copy before class:

```bash
cp -r state/ state_backup_$(date +%Y%m%d)/
```
