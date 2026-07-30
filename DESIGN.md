# archura-flow

Human-driven capture of authenticated app surfaces → screen graph with a coverage
ledger → wireflow viewer with notes → implementation corpus consumable by models.

First target: the Outseta console audit during the 7-day trial. Generic by design —
nothing Outseta-specific in the data model; the same tool should later map any app
worth rebuilding on envelopment.

## Decisions (design conversation, 2026-07-29)

- **Two capture layers.** Passive base: an injected **action journal** — document-
  level listeners (same addInitScript + exposeBinding channel as the combo) stream
  every click / Enter / navigation with an element label ("click on 'Add plan'")
  to the wrapper. This replaces Playwright tracing, which labels API-driven
  actions only and would not have labeled manual clicks. The journal labels
  journey edges between combo presses and marks clicked elements visited in the
  ledger. Browser runs on a persistent profile dir (login survives restarts,
  includes IndexedDB unlike storageState). On the first journey, also run
  Scribe's free tier once and compare outputs before committing to the pipeline.
- **Key-combo curated capture (human-driven work).** A combo pressed in the page
  (listener injected via addInitScript + exposeBinding — runs via CDP, app CSP
  can't block it) creates a screen node: one self-contained HTML+CSS snapshot
  (captured at desktop, before any resize; inliner mechanism is a slice detail)
  plus screenshots at all three viewports. Combo press = human declaring "this is
  a screen" — graph nodes are curated, not heuristically deduped.
- **Dual driver, one browser.** Igor drives by hand in the headed window; an agent
  drives the same browser by attaching to a CDP endpoint the wrapper exposes
  (Playwright MCP `--cdp-endpoint`, or a thin connectOverCDP driver). One browser,
  one trace, either driver. The capture trigger is driver-agnostic: the combo is a
  page-level key listener, so an agent fires it with a synthetic keypress — no
  separate capture API. Agent pacing must be human-ish on go.outseta.com
  (Cloudflare scores machine-speed clicking). Later slice: ledger.json as the
  agent's work queue (visit unaccounted elements; skip buckets double as the
  do-not-click list) — needs the post-processor first.
- **Multi-viewport** (desktop 1440×900 / tablet 768×1024 / mobile 390×844):
  browser launches at desktop; captured live at combo time — desktop screenshot
  first, then resize in place to tablet and mobile and restore. Works for
  stateful screens (mid-flow modals) too, superseding the earlier replay-URLs
  approach. Costs a few seconds of jank per capture.
- **Data model**, three files per app:
  - `journeys/*.json` — ordered steps: screen id, screenshot, action taken, URL.
  - `screens.json` — screen nodes (each carries the HTML snapshot + 3
    screenshots). Manual combo presses always create a node (curated; repeats
    annotated `sameAs`, never suppressed). Explorer captures are deduped by
    signature — normalized URL + DOM-skeleton hash (PLAN Phase 2) — so the
    signature IS node identity for explorer captures.
  - `ledger.json` — every interactive element harvested from every DOM snapshot,
    each in exactly one bucket: **visited** / **duplicate** / **skipped** (with a
    named reason: destructive-floor, needs-manual, external, file-upload,
    max-depth, budget-exhausted, unreplayable). Coverage = zero **unaccounted**
    elements — accounted-for, not necessarily auto-visited; skipped buckets are
    the manual-pass to-do list.
    Links (`a[href]`) carry destinations pre-click; buttons/JS handlers are opaque
    until clicked — the ledger is what makes that honest.
- **Viewer:** each run writes `out/<domain>/index.html` (from `viewer/index.html`)
  plus sibling `data.js` so the corpus opens via `file://` double-click — one
  folder, one audit, no domain picker. Wireflow per journey (screenshot strips,
  labeled arrows) plus a screen-graph view; committed thumbnails; per-node notes
  editable in the page (localStorage autosave + export back to `notes.json` so
  notes are committable and model-readable). Same pattern as
  shurale/strategy/outseta-graph.
- **Corpus format:** plain JSON + PNG + HTML snapshots on disk. Model-agnostic on
  purpose — other models must be able to consume it for visual generation.

## V1 scope (decided 2026-07-29 — one version, no slicing)

Input: a domain (e.g. youtube.com). An authenticated explorer that, staying within
the audit host (exact host or proper subdomain; http/https only; re-check after
redirects — see PLAN Phase 4):

- **visits every link** (`a[href]`), and
- **clicks every interactive element that changes anything** — +/- add/remove
  controls, toggles, buttons, form saves — working from a known state: click one
  element, capture the result, recover (back / re-navigate), next element.
  Replay paths use ledger keys (not display labels); state roots are the actual
  absolute URLs captured at discovery time (navigable). Phase 2 URL normalization
  (`:id` substitution) is for identity/dedup only — never used as a goto target.
- **Do-not-click floor:** logout, account/workspace deletion, subscription
  cancellation, real payment submission, external links. Everything else is fair
  game — the audit account is disposable; data mutation is expected.

Per captured screen: self-contained HTML snapshot + screenshots at desktop
1440×900 / tablet 768×1024 / mobile 390×844 (viewport resize). Output: journey
graph rendered as a wireflow chart (nodes = screens, edges = links and click
actions) with per-page notes (localStorage autosave + export to notes.json).

- Login: manual handoff — headed browser on a persistent profile dir, Igor logs
  in once, session survives restarts. No site-specific auto-login.
- Human and agent driving (key combo capture, CDP attach) are part of the same
  version and pipeline, not a later layer.
- One global action budget (navigations + clicks + replays) required — unbounded
  domains like youtube.com never terminate. Exhaustion is recorded in the ledger
  (skipped: budget-exhausted), never silent.
- Because clicks create same-URL states (modals, inline forms), the URL +
  DOM-signature screen identity heuristic is required in V1, not deferrable.
- Never pointed at go.outseta.com until run against free targets first; the WAF
  rule (no headless, human-ish pacing) always applies there.
- Reuse patterns from shurale/archura-editor/scripts/outseta-{crawl,build-graph}.mjs
  and the outseta-graph viewer.

## Known limits (named, not silent)

- Hover/scroll-revealed DOM under-counts unless menus are expanded before
  snapshotting — the biggest practical source of misses.
- Element coverage ≠ state coverage (valid vs invalid "Save"); interesting states
  (validation errors, empty states, trial-expired, dunning) live on a manual
  checklist in the repo.
- Email-borne surfaces (lifecycle emails) need inbox capture, out of band.
- Tablet/mobile screenshots come from a live in-place resize; hover-revealed or
  resize-sensitive UI (open dropdowns, hover menus) may collapse during it — those
  states may end up desktop-only.
- Screen identity strips text content; counters and status-copy-only changes do
  not create new nodes (intentional — avoids graph explosion).

## Not yet decided

None — section closed 2026-07-29; all three former items are resolved in
PLAN.md: repo/package layout ("Stack & layout"), the trace.zip post-processor
(superseded by the action journal), and the screen-identity heuristic (Phase 2,
isolated in identity.mjs and expected to be tuned).

## Status

Design only. No implementation until Igor says go.
