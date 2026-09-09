---
name: pre-pr-ui-audit
description: This skill should be used before opening or marking ready a PR that changes UI in changemaker-gcp, and when the user says "audit the pages I touched", "run the WCAG checks", "check mobile responsiveness", "will this come back from QA", "did I miss any accessibility issues", or when a ticket has returned from QA for contrast, truncation, clipping, keyboard, or responsive defects. Resolves the surfaces a diff actually touches, drives them into the overlay and seeded-data states a route sweep never reaches, and runs axe plus the geometric probes axe cannot express.
version: 1.0.0
metadata:
  author: Jack Felke
  tags:
    - accessibility
    - wcag
    - responsive
    - changemaker
    - pre-pr
---

# Pre-PR UI Audit

The gate that runs on the surfaces a diff touched, before the PR is called ready.

`wcag-aa-authoring` and its six companion skills decide **what correct looks like** while
code is being written. This skill is the **verification pass afterwards**: what did this
diff actually put on screen, and does it hold up at every width and in every state.

## The failure this exists to prevent

Six changemaker-gcp tickets came back from QA in two days. Every one was functionally
complete. Every one had shipped through `tests/e2e/accessibility/admin-shell.a11y.spec.ts`
— 19 hardcoded routes × {375, 1440}, `page.goto` then axe — reporting **zero violations**.

Josh, on the pattern: *"a lot of your tickets came back for pre-existing issues unrelated
to the specific ask."*

The gate was green because it was blind in four independent ways, and roughly half the
findings were of a kind **axe has no rule for at all**:

| Blind spot | What shipped |
|---|---|
| Static route list, no platform-admin routes | Create Workspace step-indicator pills at 3.68:1 |
| `goto` only — never clicks | the dialog those pills live in never rendered |
| Never seeds data | Submissions count badge at 1.72:1 — only paints when the queue is non-empty |
| Only 375 and 1440 | DS-13606 correct at 767px, broken at 768px |
| **axe cannot detect clipping** | clamped H1, hover-only breadcrumb, text cut mid-glyph, table past its pane |

Read `references/blind-spots.md` for the full mapping of each returned ticket to the
specific hole it came through. That file is the argument for every design choice below.

## Run it

```bash
~/.claude/skills/pre-pr-ui-audit/scripts/run-audit.sh \
  --repo ~/ADR/changemaker-gcp --base origin/main --ticket DS-13650
```

That resolves the surfaces, installs `probes.ts` and a ticket-named spec into
`tests/e2e/accessibility/`, and runs the `accessibility` Playwright project. Add
`--resolve-only` to inspect the surface list without running.

**Check the base first.** A stale local `main` is the fastest way to a wrong answer — a base
185 commits behind resolves a two-file ticket to 122 routes. The driver fetches and warns
above 300 changed files; if it warns, fix the base rather than reading the output.

### Which server gets audited

Every worktree runs its own dev server on its own port, so there is no safe default. The
driver resolves the URL in this order:

1. `--base-url`, then `$BASE_URL`
2. `NEXT_PUBLIC_APP_URL` or `NEXTAUTH_URL` from the worktree's `.env.local` / `.env`
3. `PORT` from the same file

**Do not trust `BASE_URL` inside a worktree `.env`** — it is routinely stale at `:3000`
while `NEXT_PUBLIC_APP_URL` carries the real port (DS-13560's env holds `3561` and `3000`
simultaneously). The driver reads the two that track the dev port and ignores the one that
does not.

It then proves the process listening on that port is running from **this** checkout, by
resolving the listener's PID to its cwd, and refuses if it is not. Auditing another
worktree's build and filing the result under this ticket is the same class of error the
whole gate exists to prevent, so the driver stops rather than falls back to `:3000`.

`AUDIT_CHANNEL=chrome` runs against installed Chrome instead of a Playwright-managed
Chromium — useful when `playwright install` is a multi-hundred-MB download that fails.
These probes are DOM geometry plus axe; any Chromium-family engine gives the same answer.

The spec also refuses to measure a page that did not render. An error boundary or a
sign-in redirect still produces a DOM that axe and the probes will happily measure, and a
clean result on an error page reads exactly like a clean result on the real one. The first
live run reported a "clipped text" finding against a Prisma error string; it now reports
`[coverage] page is showing an error, not the surface` instead.

## How a surface is derived

A surface is not a URL. It is **URL × role × width × interaction × data**. A route-list
sweep covers the first and part of the third, which is why it was green.

`scripts/resolve-surfaces.mjs` builds a reverse import graph over `app/`, `components/`,
`lib/`, `hooks/` and walks up from each changed file to the route files that render it,
recording the shortest hop count.

- **depth 0** — the route's own file changed. Audit it.
- **depth 1** — the route directly renders what changed. Audit it.
- **depth ≥ 2** — transitive. Real, but a reviewer cannot be held to 117 of them.

Widths come from the diff's own Tailwind prefixes. A diff containing `md:grid-cols-1`
changes behaviour at exactly 768 and nowhere else, so the manifest asks for **767 and 768**.
320 (WCAG 1.4.10 reflow floor), 375 and 1440 are always included.

Two flags decide whether loading the URL is enough:

- **`opens`** — the diff contains a Dialog/Sheet/Popover/DropdownMenu. Loading the route
  does not audit it; the overlay must be opened and re-probed.
- **`seeds`** — the diff contains a data-gated branch (`count > 0 &&`, `.length === 0 ?`).
  The empty tree and the populated tree are different pages. The spec **fails** on a seeded
  surface unless `AUDIT_SEEDED=1`, rather than passing quietly.

When shared primitives change (`components/ui/**`, `globals.css`, layout, navigation), the
manifest reports **blast radius** instead of a route list, because auditing every reachable
route is theatre. Audit each changed primitive across its own states, then one
representative route per role.

Nothing is dropped silently: surfaces past `--max` land in `dropped`, changed UI files with
no route owner land in `orphans`. Both must be spoken about in the PR.

## What the probes catch that axe cannot

`scripts/probes.ts` measures geometry and reports numbers, not guesses:

| Probe | Catches |
|---|---|
| `text-clipped-no-affordance` | text cut mid-glyph, no ellipsis, no scrollbar |
| `ellipsis-hover-only` | truncated text whose full value lives only in `title` — no touch equivalent |
| `heading-clamped` | an H1 that `line-clamp` is truncating: the page's own identifier, lost |
| `element-outside-clipper` | a chip painted over a title, a table past its pane |
| `scroll-region-not-focusable` | a scroll container no keyboard user can scroll |
| `text-overlaps-text` | a label rendering through a ring stroke |
| `page-horizontal-scroll` | two-dimensional scrolling (1.4.10) |
| `target-too-small` | targets under 24×24 (2.5.8) |

Contrast stays with axe — **except** that `axe.incomplete` for `color-contrast` is surfaced
as a failure, not discarded. axe reports gradient-backed and translucent-backed text as
*incomplete*, never as a violation, so dropping incompletes is how six sub-AA elements
passed a green run. The repo already has a gradient-aware walker at
`tests/e2e/mobile/accessibility/challenge-contrast.spec.ts` (DS-13183); use it rather than
writing a second one.

## Chaining the audit across surfaces

For more than a handful of surfaces, run `workflows/audit-surfaces.js` — one agent per
surface, each finding then verified by an agent prompted to **refute** it, then a single
report. Read the manifest and pass `surfaces` through `args` (workflow scripts have no
filesystem access):

```
Workflow({ scriptPath: "~/.claude/skills/pre-pr-ui-audit/workflows/audit-surfaces.js",
           args: { surfaces: [...], repo: "/Users/jackfelke/ADR/changemaker-gcp", ticket: "DS-13650" } })
```

The refutation pass is not ceremony. A false finding sent to a developer costs more than one
caught in QA, so verifiers default to refuted when uncertain and re-measure on the live page.

## Reading the result

**A green run is coverage of what was driven, never a conformance claim.** Write what ran,
what passed, and what is still open — the same rule `wcag-aa-authoring` and the ezeOrder
suite state, for the same reason: automation catches roughly a third of failures.

State explicitly in the PR body: surfaces audited, states driven, widths, what was
`dropped`, what was `orphan`, and any seeded or overlay state that could not be reached. A
gap not mentioned reads as coverage. `pr-evidence` owns the shape of that section.

Preexisting defects still get reported, labelled as preexisting. Whether they belong in this
PR or a follow-up ticket is a scope call — but discovering one and not saying so is how it
comes back with your ticket number on it.

## Additional Resources

- **`references/blind-spots.md`** — each returned ticket mapped to the hole it came through, and why axe could not have caught it
- **`references/surface-states.md`** — driving overlays and seeded data; the changemaker-gcp roles, credentials and factories
- **`scripts/resolve-surfaces.mjs`** — diff → surface manifest (`--repo --base [--head] [--max] [--out]`)
- **`scripts/probes.ts`** — the geometric probes; copied into the repo by the driver
- **`scripts/touched-surfaces.a11y.spec.ts`** — the spec template that stays in the PR
- **`workflows/audit-surfaces.js`** — fan-out audit with adversarial verification
