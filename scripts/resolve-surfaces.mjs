#!/usr/bin/env node
/**
 * resolve-surfaces — turn a diff into the list of surfaces an audit must drive.
 *
 * A "surface" is not a URL. It is a URL x role x viewport x interaction x data
 * state. A route-list sweep sees only the first of those five, which is why the
 * changemaker-gcp admin-shell gate reported zero violations on the same build
 * that QA bounced for six defects. See references/blind-spots.md.
 *
 * Usage:
 *   node resolve-surfaces.mjs --repo <path> [--base main] [--out surfaces.json]
 *   node resolve-surfaces.mjs --repo . --base origin/main --json
 *
 * Emits a manifest: { widths, surfaces: [{ route, role, reason, opens, seeds }] }
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve as resolvePath, relative } from 'node:path'
import { globSync } from 'node:fs'

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : argv[i + 1]
}
const flag = (name) => argv.includes(`--${name}`)

const REPO = resolvePath(arg('repo', process.cwd()))
const BASE = arg('base', 'main')
// --head lets the resolver audit a branch or PR ref without checking it out.
// Omitted, it audits the working tree (committed + staged + unstaged), which is
// the pre-PR case this exists for.
const HEAD = arg('head', null)
const OUT = arg('out', null)

const git = (...args) =>
  execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

// ---------------------------------------------------------------------------
// 1. changed files — committed vs base, plus anything still in the tree
// ---------------------------------------------------------------------------

const RANGE = `${BASE}...${HEAD ?? 'HEAD'}`

function changedFiles() {
  const out = new Set()
  const add = (s) => s.split('\n').filter(Boolean).forEach((f) => out.add(f))
  try {
    add(git('diff', '--name-only', RANGE))
  } catch {
    // no merge base (fresh branch, shallow clone) — fall back to a plain diff
    add(git('diff', '--name-only', BASE))
  }
  if (!HEAD) {
    add(git('diff', '--name-only', 'HEAD')) // unstaged
    add(git('diff', '--name-only', '--cached')) // staged
  }
  return [...out]
}

function changedDiffText() {
  let text
  try {
    text = git('diff', RANGE)
  } catch {
    text = git('diff', BASE)
  }
  if (!HEAD) text += git('diff', 'HEAD') + git('diff', '--cached')
  return text
}

// ---------------------------------------------------------------------------
// 2. reverse import graph — who renders this component?
// ---------------------------------------------------------------------------

const SOURCE_DIRS = ['app', 'components', 'lib', 'hooks']
const SOURCE_RE = /\.(tsx?|jsx?)$/

/**
 * Read a source file from whichever tree is under audit. With --head the working
 * tree is irrelevant — reading it would build the import graph from the wrong
 * revision and silently mis-attribute components to routes.
 */
function readSource(file) {
  try {
    return HEAD ? git('show', `${HEAD}:${file}`) : readFileSync(join(REPO, file), 'utf8')
  } catch {
    return null
  }
}

function listSources() {
  const files = []
  for (const dir of SOURCE_DIRS) {
    if (!HEAD && !existsSync(join(REPO, dir))) continue
    let listing
    try {
      listing = HEAD
        ? git('ls-tree', '-r', '--name-only', HEAD, '--', dir)
        : git('ls-files', dir) // respects .gitignore, faster than a walk
    } catch {
      continue
    }
    for (const f of listing.split('\n')) {
      if (f && SOURCE_RE.test(f)) files.push(f)
    }
  }
  return files
}

const IMPORT_RE = /(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g

/** Resolve an import specifier to a repo-relative source file, or null. */
function resolveSpecifier(spec, fromFile, known) {
  let base
  if (spec.startsWith('@/')) base = spec.slice(2)
  else if (spec.startsWith('.')) base = relative(REPO, resolvePath(join(REPO, dirname(fromFile)), spec))
  else return null // node_modules

  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ]
  return candidates.find((c) => known.has(c)) ?? null
}

function buildReverseGraph(files) {
  const known = new Set(files)
  const importers = new Map() // importee -> Set(importer)
  for (const file of files) {
    const text = readSource(file)
    if (!text) continue
    IMPORT_RE.lastIndex = 0
    let m
    while ((m = IMPORT_RE.exec(text))) {
      const spec = m[1] ?? m[2]
      if (!spec) continue
      const target = resolveSpecifier(spec, file, known)
      if (!target) continue
      if (!importers.has(target)) importers.set(target, new Set())
      importers.get(target).add(file)
    }
  }
  return importers
}

const IS_ROUTE_FILE = (f) => /^app\/.*\/(page|layout|template)\.tsx?$/.test(f) || /^app\/(page|layout)\.tsx?$/.test(f)

/**
 * Walk up the import graph from a changed file to every route file that renders
 * it, recording the shortest hop count to each.
 *
 * Depth is what keeps the output honest. A change to `components/ui/button.tsx`
 * reaches every route in the app, and reporting all of them as equally
 * implicated is the same failure as reporting none: DS-13634 touched shared
 * design tokens and resolves to 134 routes. Depth 0 means the route's own file
 * changed; depth 1 means it directly renders what changed. Those are the ones a
 * reviewer can actually be held to.
 */
function ownersOf(file, importers) {
  const depths = new Map() // route file -> shortest depth
  const seen = new Map() // any file -> shortest depth reached
  const queue = [[file, 0]]
  while (queue.length) {
    const [cur, d] = queue.shift()
    if (seen.has(cur) && seen.get(cur) <= d) continue
    seen.set(cur, d)
    if (IS_ROUTE_FILE(cur)) {
      if (!depths.has(cur) || depths.get(cur) > d) depths.set(cur, d)
      continue // a route file does not propagate further up
    }
    for (const parent of importers.get(cur) ?? []) queue.push([parent, d + 1])
  }
  return depths
}

/**
 * Shared primitives and global style surfaces. A diff that touches these has an
 * app-wide blast radius by construction, and the audit strategy changes: drive
 * the primitive's own states plus one representative route per role, rather than
 * pretending to audit every route it reaches.
 */
const SHARED_SURFACE = [
  /^components\/ui\//,
  /^app\/globals\.css$/,
  /^tailwind\.config\./,
  /^components\/layout\//,
  /^components\/navigation\//,
]

// ---------------------------------------------------------------------------
// 3. route file -> URL path
// ---------------------------------------------------------------------------

function routeFor(file) {
  let p = file.replace(/^app/, '').replace(/\/(page|layout|template)\.tsx?$/, '')
  p = p
    .split('/')
    .filter((seg) => !/^\(.*\)$/.test(seg)) // route groups (authenticated) are not in the URL
    .filter((seg) => !seg.startsWith('@')) // parallel-route slots
    .join('/')
  return p === '' ? '/' : p
}

// ---------------------------------------------------------------------------
// 4. role — derived from the route prefix
// ---------------------------------------------------------------------------

function roleFor(route) {
  if (route.startsWith('/admin')) return 'platformAdmin' // platform console, NOT /w/:slug/admin
  if (/^\/w\/\[[^\]]+\]\/admin/.test(route)) return 'admin'
  if (/^\/w\/\[[^\]]+\]\/manager/.test(route)) return 'manager'
  if (/^\/w\/\[[^\]]+\]\/participant/.test(route)) return 'participant'
  if (/^\/w\/\[[^\]]+\]\/client/.test(route)) return 'client'
  if (route.startsWith('/auth') || route.startsWith('/workspaces')) return 'admin'
  return 'public'
}

// ---------------------------------------------------------------------------
// 5. widths — the diff's own responsive prefixes name the breakpoints at risk
// ---------------------------------------------------------------------------

/**
 * Tailwind's breakpoints. A class written `md:grid-cols-1` changes behaviour at
 * exactly 768 and nowhere else, so the pair (767, 768) is where a mistake in it
 * shows. DS-13606 was correct at 767 and broken at 768 — a sweep at 375/1440
 * could not have seen it.
 */
const BREAKPOINTS = { sm: 640, md: 768, lg: 1024, xl: 1280, '2xl': 1536 }
const FLOOR = 320 // WCAG 1.4.10 reflow floor
const PHONE = 375
const DESKTOP = 1440

function widthsFrom(diffText) {
  const widths = new Set([FLOOR, PHONE, DESKTOP])
  for (const [prefix, px] of Object.entries(BREAKPOINTS)) {
    // only count prefixes on ADDED lines, and only as a class prefix
    const re = new RegExp(`^\\+.*(?:["'\\s])${prefix}:[a-z-]`, 'm')
    if (re.test(diffText)) {
      widths.add(px - 1)
      widths.add(px)
    }
  }
  return [...widths].sort((a, b) => a - b)
}

// ---------------------------------------------------------------------------
// 6. interaction and data gates — the two states a goto-sweep never reaches
// ---------------------------------------------------------------------------

const OVERLAY_IMPORTS = /(Dialog|Sheet|Popover|DropdownMenu|Drawer|AlertDialog|Tooltip|HoverCard|Command|Select)\b/
const OVERLAY_TRIGGER = /(DialogTrigger|SheetTrigger|PopoverTrigger|DropdownMenuTrigger|AlertDialogTrigger)\b/

/** Conditional renders keyed on data — the badge that only paints when a count is non-zero. */
const DATA_GATE = [
  /\{\s*[\w.?]+\.length\s*>\s*0\s*&&/,
  /\{\s*[\w.?]+Count\s*>\s*0\s*&&/,
  /\{\s*[\w.?]+\s*>\s*0\s*&&/,
  /\{\s*[\w.?]+\?\.\w+\s*&&/,
  /length\s*===\s*0\s*\?/, // empty-state ternary: both arms need a look
]

function gatesFor(files) {
  const opens = new Set()
  const seeds = new Set()
  for (const f of files) {
    const text = readSource(f)
    if (!text) continue
    if (OVERLAY_TRIGGER.test(text) || OVERLAY_IMPORTS.test(text)) opens.add(f)
    if (DATA_GATE.some((re) => re.test(text))) seeds.add(f)
  }
  return { opens: [...opens], seeds: [...seeds] }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const changed = changedFiles().filter((f) => SOURCE_RE.test(f) && SOURCE_DIRS.some((d) => f.startsWith(`${d}/`)))
const diffText = changedDiffText()
const sources = listSources()
const importers = buildReverseGraph(sources)

const bySurface = new Map()
const orphans = []
const sharedChanges = changed.filter((f) => SHARED_SURFACE.some((re) => re.test(f)))

for (const file of changed) {
  const owners = ownersOf(file, importers)
  if (owners.size === 0) {
    orphans.push(file)
    continue
  }
  for (const [owner, depth] of owners) {
    const route = routeFor(owner)
    if (!bySurface.has(route)) {
      bySurface.set(route, { route, role: roleFor(route), reason: new Map(), depth: Infinity })
    }
    const s = bySurface.get(route)
    s.depth = Math.min(s.depth, depth)
    const prev = s.reason.get(file)
    if (prev === undefined || prev > depth) s.reason.set(file, depth)
  }
}

const widths = widthsFrom(diffText)

const all = [...bySurface.values()]
  .map((s) => {
    const reason = [...s.reason.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([file, depth]) => ({ file, depth }))
    const direct = reason.filter((r) => r.depth <= 1).map((r) => r.file)
    // Gates are read from the files that actually reach this route directly.
    // A gate three hops away belongs to whatever route owns that component.
    const { opens, seeds } = gatesFor(direct.length ? direct : reason.map((r) => r.file))
    return {
      route: s.route,
      role: s.role,
      depth: s.depth,
      tier: s.depth === 0 ? 'direct' : s.depth === 1 ? 'renders-changed' : 'transitive',
      widths,
      reason,
      // A surface with an overlay in its diff is NOT audited by loading the URL.
      // The audit must click the trigger and re-run every probe on the open overlay.
      opens,
      // A surface with a data-gated branch renders differently when empty. Both
      // arms need a pass; the populated one is the arm a goto-sweep never sees.
      seeds,
    }
  })
  .sort((a, b) => a.depth - b.depth || a.route.localeCompare(b.route))

const MAX = Number(arg('max', '25'))
const surfaces = all.slice(0, MAX)
const dropped = all.slice(MAX)

const manifest = {
  repo: REPO,
  base: BASE,
  head: HEAD ?? '(working tree)',
  generated: null, // stamped by the caller; kept null so runs are diffable
  widths,
  // An app-wide blast radius is a finding in itself, not a list to grind through.
  blastRadius: sharedChanges.length
    ? {
        shared: sharedChanges,
        note:
          'Shared primitives/tokens changed. Auditing every reachable route is theatre. ' +
          'Audit each changed primitive in isolation across its own states, then one ' +
          'representative route per role from the list below.',
      }
    : null,
  surfaceCount: all.length,
  surfaces,
  // Never silently truncate: a caller that thinks it covered everything is the
  // failure this whole tool exists to prevent.
  dropped: dropped.map((s) => ({ route: s.route, role: s.role, depth: s.depth })),
  orphans, // changed UI files with no route owner — resolve by hand, do not drop
}

const json = JSON.stringify(manifest, null, 2)
if (OUT) {
  writeFileSync(OUT, json)
  console.error(`wrote ${OUT}`)
}
if (flag('json') || !OUT) {
  console.log(json)
} else {
  if (manifest.blastRadius) {
    console.error(`BLAST RADIUS — shared surface changed:\n  ${sharedChanges.join('\n  ')}\n`)
  }
  for (const s of surfaces) {
    const tags = [s.opens.length && 'OPENS', s.seeds.length && 'SEEDS'].filter(Boolean).join(' ')
    console.error(`d${s.depth} ${s.role.padEnd(14)} ${s.route.padEnd(56)} ${tags}`)
  }
  console.error(`\n${all.length} surfaces (showing ${surfaces.length}), widths ${widths.join('/')}`)
  if (dropped.length) console.error(`${dropped.length} below the --max ${MAX} cut — listed in the manifest, not audited`)
  if (orphans.length) console.error(`${orphans.length} orphan file(s) with no route owner — resolve by hand`)
}
