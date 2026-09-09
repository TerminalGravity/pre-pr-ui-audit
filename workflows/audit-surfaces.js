export const meta = {
  name: 'audit-touched-surfaces',
  description: 'Audit every surface a diff touches for WCAG AA and reflow defects, then verify each finding adversarially',
  whenToUse:
    'Before marking a changemaker-gcp PR ready for review. Args: { surfaces: [...], repo: "<abs repo path>", ticket: "DS-xxxxx" } — pass the `surfaces` array from .audit/surfaces.json as a real JSON value, since workflow scripts have no filesystem access.',
  phases: [
    { title: 'Audit', detail: 'one agent per surface — drives states, runs axe + probes' },
    { title: 'Verify', detail: 'refute each finding against the live page before it is reported' },
    { title: 'Report', detail: 'dedupe, rank, write the dev-action list' },
  ],
}

// Workflow scripts run without filesystem or Node APIs, so the caller reads
// .audit/surfaces.json and passes the array through `args`.
const { surfaces, repo, ticket = 'AUDIT' } = args ?? {}
if (!Array.isArray(surfaces) || !repo) {
  throw new Error('args must carry { surfaces: [...], repo: "<abs path>" } — see meta.whenToUse')
}

// ---------------------------------------------------------------------------

const FINDINGS = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['probe', 'wcag', 'selector', 'width', 'state', 'measured', 'file', 'fix'],
        properties: {
          probe: { type: 'string', description: 'axe rule id, or the probe name' },
          wcag: { type: 'string', description: 'e.g. "1.4.3 Contrast (Minimum)"' },
          selector: { type: 'string' },
          width: { type: 'integer' },
          state: { type: 'string', description: 'default | overlay:<name> | seeded' },
          measured: { type: 'string', description: 'the numbers, e.g. "2.60:1, needs 4.5:1" or "576px in a 473px box"' },
          file: { type: 'string', description: 'source file and the class or line to change' },
          fix: { type: 'string', description: 'the concrete one-line change' },
          preexisting: { type: 'boolean', description: 'true if present on the base branch too' },
        },
      },
    },
  },
}

const VERDICT = {
  type: 'object',
  required: ['real', 'why'],
  properties: {
    real: { type: 'boolean' },
    why: { type: 'string' },
    correction: { type: 'string', description: 'if the measurement was wrong, the right one' },
  },
}

// ---------------------------------------------------------------------------

phase('Audit')

const auditPrompt = (s) => `
You are auditing ONE surface of ${repo} for WCAG 2.2 AA and reflow defects, as part of a
pre-PR gate. The goal is to find what a route-list axe sweep cannot: this exact class of
defect has been shipping past a green gate and coming back from QA.

Surface: ${s.route}   role: ${s.role}   widths: ${s.widths.join(', ')}
Changed files that reach it: ${s.reason.map((r) => r.file).join(', ')}
${s.opens.length ? `This surface contains an overlay (${s.opens.join(', ')}). Auditing it by loading the URL alone is not auditing it — open the dialog/menu/popover and probe the OPEN state.` : ''}
${s.seeds.length ? `This surface renders conditionally on data (${s.seeds.join(', ')}). The empty tree and the populated tree are different pages. Seed it with tests/helpers/factories and probe the populated one — a count badge that only paints when a queue is non-empty is exactly what the last gate missed.` : ''}

Run the installed spec for this surface and read its output:
  cd ${repo} && AUDIT_MANIFEST=.audit/surfaces.json pnpm playwright test --project=accessibility -g "${s.route}" --reporter=list

Then go beyond it. The spec is mechanical; you are not. At each width, look at the page
and judge whether it is actually usable — the probes measure geometry, they do not notice
that a layout is merely ugly or that an action is unreachable in practice.

For every defect, report the measurement, the source file and class, and the one-line fix.
Mark preexisting=true if it reproduces on the base branch — that changes who owns it, and
saying so is not an excuse to omit it.

Report ONLY defects you measured. An empty findings array is a fine answer and much better
than a plausible guess.`

const verifyPrompt = (f, s) => `
Try to REFUTE this accessibility finding on ${repo}. Default to refuted=true when uncertain —
a false finding sent to a developer costs more than a missed one caught in QA.

  ${f.probe} (${f.wcag}) on ${s.route} @${f.width}px, state=${f.state}
  ${f.selector}
  measured: ${f.measured}
  claimed fix: ${f.fix} in ${f.file}

Check specifically:
 1. Reproduce it. Load the surface at that exact width, drive it into state "${f.state}", and
    re-measure. Does the number hold?
 2. Is the element actually visible and reachable at that width, or is it display:none there?
 3. For contrast: is the backdrop what the tool thought? A gradient or translucent layer means
    axe reports *incomplete*, not a violation, and a naive reading inverts the verdict.
 4. Is the claimed fix real — does that class/line exist in ${f.file} on this branch?
 5. Is it in scope? Preexisting is still a finding, but it must be labelled honestly.

Return real=false with your reasoning if any of these fails.`

const audited = await pipeline(
  surfaces,
  (s) => agent(auditPrompt(s), { label: `audit:${s.route}`, phase: 'Audit', schema: FINDINGS }),
  (res, s) =>
    parallel(
      (res?.findings ?? []).map((f) => () =>
        agent(verifyPrompt(f, s), { label: `verify:${f.probe}@${f.width}`, phase: 'Verify', schema: VERDICT })
          .then((v) => ({ ...f, route: s.route, role: s.role, verdict: v }))
      )
    )
)

const confirmed = audited
  .flat()
  .filter(Boolean)
  .filter((f) => f.verdict?.real)

log(`${confirmed.length} confirmed across ${surfaces.length} surfaces`)

// ---------------------------------------------------------------------------

phase('Report')

if (confirmed.length === 0) {
  return {
    ticket,
    surfaces: surfaces.length,
    confirmed: [],
    report:
      `No confirmed WCAG/reflow defects across ${surfaces.length} touched surfaces. ` +
      `This is coverage of what was driven, not a conformance claim — surfaces marked ` +
      `seeds/opens are only covered if those states were actually reached.`,
  }
}

const report = await agent(
  `Write the accessibility section of the PR body for ${ticket} in ${repo}.

Confirmed findings (each already survived an adversarial refutation pass):
${JSON.stringify(confirmed, null, 2)}

Rules:
- Group by surface. Within a surface, order by severity: unreadable content first, then
  keyboard reachability, then contrast, then target size.
- Every item states the measurement, the file and class, and the one-line fix. No item may
  say "may" or "appears to".
- Separate the ones introduced by this PR from preexisting ones. Preexisting still gets
  listed, with a note on whether it is in scope or belongs in a follow-up ticket.
- End with what was NOT covered: surfaces below the manifest cut, orphan files with no route
  owner, and any surface whose seeded or overlay state could not be driven. Silence about a
  gap reads as coverage.
- Plain prose and a table. No preamble.`,
  { label: 'report', phase: 'Report' }
)

return { ticket, surfaces: surfaces.length, confirmed, report }
