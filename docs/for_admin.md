# Advanced Physics Wiki — For IT / Administration

## What is this system?

The Advanced Physics Wiki is a classroom tool that runs on the teacher's laptop during class. Students use it to write, review, and publish physics explanations (called Insight Cards) through a structured peer-review workflow. The final published cards form a class-built wiki visible on the concept navigator.

The system is **not a cloud service** — it runs entirely on one machine in the classroom and only needs internet access for two optional features (Google Drive file inbox and GitHub Pages publishing).

---

## Where does student data live?

| Data | Location | Notes |
|---|---|---|
| Student names and passwords | `state/sim-settings.json` on teacher's laptop | Passwords are plaintext short codes (not real passwords) |
| Student writing (drafts) | `state/drafts/` on teacher's laptop | Never leaves the machine unless teacher approves |
| Approved submissions | `ics/` folder, pushed to GitHub | Public GitHub repo — see below |
| Homework questions | `state/questions.json` on teacher's laptop | Not pushed to GitHub |
| Workflow progress | `state/workflow.json` on teacher's laptop | Not pushed to GitHub |

---

## What goes to GitHub?

When a teacher approves a student's Insight Card, the HTML file is pushed to a **public GitHub repository** (`github.com/ryankcampbell/adv-physics-wiki`). This means:

- Approved IC text, simulations, and citations are publicly visible
- Student **first and last name** appears in the published HTML as the author
- No other identifying information (no email, no school name, no grade) is embedded

**Action required before launch:** Confirm that posting student names publicly on GitHub is permitted under your school's student data policy. If not, students can use a chosen pen name — the name field in the IC editor can be set to anything, and the login name (used internally) can differ.

The GitHub repository is owned by the teacher (`ryankcampbell`) and can be made private if needed. If made private, GitHub Pages publishing will not work and the "View IC" links will 404 — but the local server still functions fully.

---

## What AI services are used?

The system uses the **Anthropic Claude API** (claude.ai) for three features:

1. **Simulation builder** — students describe a simulation in plain English and an AI generates interactive HTML
2. **AT Socratic chat** — an AI tutor challenges students' physics claims during adversarial testing
3. **HW problem AI** — an AI collaborates with students to draft homework questions

All AI calls go from the teacher's laptop directly to Anthropic's API. **No student writing is stored by Anthropic** beyond the duration of a single API call (Anthropic's zero-retention policy applies when using API keys, not the consumer Claude.ai product).

The API key is stored in the server's environment variables on the teacher's laptop and is never transmitted to students.

---

## Network requirements

The system needs outbound internet access for:
- Anthropic API (`api.anthropic.com`) — for AI features
- Google Drive API (`www.googleapis.com`) — for the Drive inbox (teacher's submission review)
- GitHub (`github.com`) — for publishing approved ICs to the public wiki

If any of these are blocked by your network, the corresponding feature will fail gracefully (AI features return an error message; Drive inbox won't show new submissions; GitHub push will fail silently but local data is preserved).

**The core student experience (writing, submitting, viewing the navigator) works entirely on the local network without any internet access.**

---

## How students connect

Students open a browser and navigate to `http://[teacher's laptop IP]:3000`. The teacher's laptop must be on the same network as student devices. The port (3000) may need to be allowed through the laptop's firewall.

No installation is required on student devices. Any modern browser works (Chrome, Firefox, Safari, Edge).

---

## Data retention and cleanup

At the end of a course:
- Run the reset procedure in `docs/may_launch.md` to clear all student state
- Optionally delete the `ics/` folder contents from GitHub to remove published student work
- Student passwords are stored in `state/sim-settings.json` — delete or update before a new cohort

---

## Who to contact

This system was built and is maintained by the teacher (Ryan Campbell). There is no vendor support. Source code is at `github.com/ryankcampbell/adv-physics-wiki`.
