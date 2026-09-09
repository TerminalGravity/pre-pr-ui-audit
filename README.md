# pre-pr-ui-audit

A diff-driven WCAG 2.2 AA + reflow audit gate for
[`alldigitalrewards/changemaker-gcp`](https://github.com/alldigitalrewards/changemaker-gcp),
packaged as a Claude Code skill.

## Why

Six tickets came back from QA in two days, all functionally complete, all missing the same
two things: WCAG contrast and mobile responsiveness. Every one had shipped through an
in-repo axe gate that reported **zero violations**.

The gate scanned 19 hardcoded routes at 375px and 1440px, with `page.goto` and nothing else.
It was blind in five independent ways, and about half the returned findings were of a kind
**axe has no rule for at all** — a clamped `<h1>`, a breadcrumb whose full value only exists
in a hover `title`, text cut mid-glyph, a table running past its pane.

`references/blind-spots.md` maps each returned ticket to the specific hole it came through.

## What it does

1. **Resolves surfaces from the diff.** Builds a reverse import graph over `app/`,
   `components/`, `lib/`, `hooks/` and walks up from each changed file to the routes that
   render it, recording hop count. Depth 0–1 is what a reviewer can be held to.
2. **Derives widths from the diff.** A diff containing `md:grid-cols-1` changes behaviour at
   exactly 768, so the manifest asks for 767 **and** 768. Plus 320 (WCAG 1.4.10 floor), 375,
   1440.
3. **Drives the states a route sweep never reaches.** Opens overlays; refuses to pass a
   data-gated surface unless it was actually seeded.
4. **Runs axe *and* geometric probes.** Including `axe.incomplete` for `color-contrast`,
   which is where gradient-backed text hides.
5. **Fans out across surfaces** with an adversarial verification pass, via the Workflow
   script.

## Use

```bash
scripts/run-audit.sh --repo ~/ADR/changemaker-gcp --base origin/main --ticket DS-13650
```

Installs `probes.ts` and a ticket-named spec into the repo's
`tests/e2e/accessibility/` (the `accessibility` Playwright project matches
`**/*.a11y.spec.ts`), writes `.audit/surfaces.json`, and runs it. `--resolve-only` stops
after the manifest.

Inspect a surface list without touching the repo:

```bash
node scripts/resolve-surfaces.mjs --repo ~/ADR/changemaker-gcp --base origin/main
# audit a branch or merged PR without checking it out:
node scripts/resolve-surfaces.mjs --repo ~/ADR/changemaker-gcp --base 8916a032^1 --head 8916a032
```

**Check the base.** A local `main` 185 commits stale resolves a two-file ticket to 122
routes. The driver fetches and warns above 300 changed files.

**Ports are per-worktree.** The driver reads `NEXT_PUBLIC_APP_URL` / `NEXTAUTH_URL` from
the worktree's own `.env` — never the `BASE_URL` in that file, which is routinely stale at
`:3000` while the app serves on `:3561`. It then resolves the listening PID's cwd and
refuses if the server belongs to a different checkout, rather than auditing another
worktree's build under this ticket's name. Override with `--base-url`.

Add `AUDIT_CHANNEL=chrome` to run against installed Chrome and skip the Playwright browser
download.

## Self-test

`test/fixture.html` contains one known instance of every defect the probes look for, plus
clean controls that must not be reported.

```bash
npm install && npx playwright install chromium-headless-shell && npm test
```

A probe that cannot fire on a page built to trip it would ship as silent false assurance.

## Install as a skill

```bash
ln -s ~/Projects/pre-pr-ui-audit ~/.claude/skills/pre-pr-ui-audit
```

## Layout

```
SKILL.md                             when to run it, how to read the result
scripts/resolve-surfaces.mjs         diff -> surface manifest
scripts/probes.ts                    the geometric probes axe cannot express
scripts/touched-surfaces.a11y.spec.ts  spec template; stays in the PR
scripts/run-audit.sh                 driver
workflows/audit-surfaces.js          fan-out audit + adversarial verification
references/blind-spots.md            each returned ticket -> the hole it came through
references/surface-states.md         driving overlays and seeded data
test/                                probe self-test
```

## Scope

changemaker-gcp only — Next.js App Router, Tailwind, Playwright. The route derivation, role
mapping and login helpers are specific to it. `ezeorder-gui` has its own suite and skill.

## What this is not

A conformance claim. Automated coverage catches roughly a third of WCAG failures. A green
run means *the surfaces that were driven, in the states that were reached, at the widths
that were tested, showed no measured defect* — write that, not "WCAG AA compliant".
