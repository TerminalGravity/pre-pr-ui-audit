# Blind spots — what came back, and why the gate was green

Every finding below is from QA on 2026-09-08/09 against changemaker-gcp. Every one shipped
through `tests/e2e/accessibility/admin-shell.a11y.spec.ts`, which reported zero violations
on the same builds.

The shipped gate, in full:

```ts
const VIEWPORTS = [{ width: 375 }, { width: 1440 }]
function workspaceRoutes(challengeId) { return [ /* 19 hardcoded paths */ ] }
async function analyze(page, route) {
  await page.goto(route, { waitUntil: 'domcontentloaded' })
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()
  return results.violations
}
expect(failures).toEqual({})
```

Nineteen routes, two widths, no clicks, no seeding, `violations` only. Each omission
corresponds to findings that shipped.

---

## 1. The route list is static and hand-written

**DS-13634 Dev Action 1 — Create Workspace step-indicator pills.**
`bg-blue-600` + white = 3.68:1; `text-slate-500` on `bg-slate-100` = 4.35:1. Both under 4.5.

The component is `components/admin/platform-admin-workspace-dialog.tsx`, rendered from
`/admin/workspaces` — a **platform-admin** route. The gate's list contains only
`/w/{slug}/admin/*` and one `/manager/dashboard`. The route was never visited at all.

QA's own note: *"the platform-admin routes are not among the 40 scanned workspace/manager/
participant/public routes."*

**How the resolver closes it.** The route list is derived from the diff, so a changed file
under `components/admin/` resolves through the import graph to `/admin/workspaces` whether
or not anyone remembered to add it. Verified: running the resolver on PR #282's merge base
yields `/admin/workspaces` at depth 0.

---

## 2. `goto` only — the overlay never renders

Same finding as above, second cause. Even with `/admin/workspaces` in the list, the step
indicator lives inside a dialog that opens on a click. axe scans the DOM as loaded. The
pills were never in the tree when axe ran.

**How it closes.** `resolve-surfaces.mjs` flags a surface `opens` when the changed files
import a Dialog/Sheet/Popover/DropdownMenu/AlertDialog trigger. The spec then opens an
overlay and re-runs axe **and** the probes against the open state; if it cannot open one it
emits a `[coverage]` failure rather than passing.

Clicking is restricted to non-destructive triggers — an audit must not mutate the data it
is auditing.

---

## 3. No seeded data — the conditional branch never renders

**DS-13634 Dev Action 2 — manager-dashboard Submissions count badge.**
White 12px on `bg-amber-400` (#ffb900) = **1.72:1**. axe rates it serious at both 375 and
1440 — whenever it renders.

From `app/w/[slug]/admin/dashboard/activity-feed.tsx`, it renders only when the review queue
is non-empty. The gate ran against whatever the workspace happened to hold, which was empty.

QA: *"It renders only when the review queue is non-empty, so the PR's own 40-route
zero-violation scan never saw it."*

This is the most dangerous class, because the run is green *and* axe would have caught it.
Nothing about the output distinguishes "no violations" from "no content".

**How it closes.** A surface whose diff contains `count > 0 &&`, `.length > 0 &&`, or an
empty-state ternary is flagged `seeds`, and the spec **fails** it unless `AUDIT_SEEDED=1` is
set. Refusing to pass is the point.

---

## 4. Two widths, neither at a breakpoint boundary

**DS-13606 — the workspaces stat-tile grid.** `md:grid-cols-2` overrode `sm:grid-cols-3`,
stranding "Total Challenges" on its own row across 768–1023px. Correct at 767. Broken at
768. The gate tested 375 and 1440.

**DS-13586** — the boundary that mattered was 1023 vs 1024 (`lg`), where the table twin
takes over from the card list. QA measured 238px of overflow at 1024 before the fix.

**How it closes.** Widths come from the diff. Every Tailwind prefix on an added line
contributes `(breakpoint − 1, breakpoint)`. Validated: the resolver on PR #285's merge base
returns `320/375/639/640/1023/1024/1279/1280/1440` — including exactly the 1023/1024 pair QA
used.

---

## 5. axe has no rule for any of this

Half the returned findings are not expressible as axe rules. axe checks the accessibility
tree and computed colour. It does not measure whether text fits.

| Finding | Ticket | Why axe is silent |
|---|---|---|
| Challenge H1 `line-clamp-2` truncating at 375 and 768 | DS-13634 DA-4 | clamping is valid CSS; nothing in the a11y tree changes |
| Breadcrumb ellipsis, full value only in `title` | DS-13634 DA-3 | `title` satisfies accessible-name rules; that it needs hover is not modelled |
| Progress-ring COMPLETE label rendering through the stroke | DS-13634 DA-5 | overlapping boxes are not an axe concept |
| Bulk-invite preview text cut mid-glyph ("Participa\|"), 576px in a 473px box | DS-13630 DA-2 | overflow is not a violation |
| Catalog table ~17px past its pane, both actions clipped | DS-13586 | same |
| Workspace chip painted over the card title | DS-13560 | same |
| "2 customized" chip, "Settings" tab label clipped at 375 | DS-13634 A, C | same |

`scripts/probes.ts` measures each of these directly and reports the numbers, so a finding
can go into a ticket as measured fact.

### The one axe *does* have, that still got through

`scrollable-region-focusable` (DS-13630 DA-1) is a real axe rule and it fires correctly —
four `max-h-72 overflow-auto` containers, none focusable, none with a focusable child. It
never fired because the containers **only overflow once the preview has rows**, which is
blind spot 3 again. Rule coverage does not help when the state never renders.

---

## 6. `violations` only — `incomplete` was discarded

axe returns three buckets. Text over a `linear-gradient` lands in `incomplete`, never
`violations`, because axe cannot resolve a single backdrop pixel.

The repo learned this once already: DS-13183's
`tests/e2e/mobile/accessibility/challenge-contrast.spec.ts` exists because a 2026-07-28 QA
pass found six sub-AA elements a full axe run had waved through. Its comment says it
outright — *"structurally blind to them"*. The admin-shell gate written afterwards still
reads only `violations`.

**How it closes.** The spec surfaces `incomplete` for `color-contrast` as a failure naming
the nodes axe could not resolve, and points at the gradient walker for adjudication.

---

## What none of this fixes

Automated coverage catches roughly a third of WCAG failures. These probes raise the floor on
one specific, recurring, expensive class — they do not judge whether a label describes its
field, whether a heading reflects structure, or whether an error tells the user what to do.

A green run means *the surfaces that were driven, in the states that were reached, at the
widths that were tested, showed no measured defect.* Write that, not "WCAG AA compliant".
