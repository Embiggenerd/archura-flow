# Implementation plan

Build order for the one version in DESIGN.md. Phases are construction sequence,
not release slices — nothing ships until it all works. Each phase has a verify
step against a free target; go.outseta.com is touched by none of them.

## Stack & layout (proposed)

Node + Playwright, plain ESM `.mjs`, no build step, no TypeScript — same idiom as
shurale/archura-editor scripts. Only dependency: `playwright`.

```
archura-flow/
  package.json
  DESIGN.md  PLAN.md
  src/
    capture.mjs     # entry: node src/capture.mjs <domain> [--explore] [--budget N]
    snapshot.mjs    # self-contained HTML + 3-viewport screenshots
    identity.mjs    # screen signature (isolated so the heuristic can change)
    explore.mjs     # auto-explorer: links + clicks + recovery
    ledger.mjs      # element harvest + bucketing
  viewer/
    index.html      # template; each run copies it to out/<domain>/index.html
  out/<domain>/     # gitignored except notes.json; committed selectively per audit
    index.html  data.js   # double-clickable viewer + bundled corpus
    screens.json  journeys/*.json  ledger.json  notes.json
    shots/<screen-id>-{desktop,tablet,mobile}.png
    html/<screen-id>.html
  profiles/<domain>/  # persistent browser profile, gitignored
```

## Phase 1 — manual capture mode (end-to-end skeleton)

`node src/capture.mjs <domain>` launches headed Chromium via
`launchPersistentContext(profiles/<domain>)` with viewport **1440×900**,
navigates to the domain, and idles. Igor logs in by hand; session persists
across runs.

Viewport constants (capture.mjs / snapshot.mjs): desktop `1440×900`, tablet
`768×1024`, mobile `390×844`. Launch uses desktop; every capture restores to
desktop after the tablet/mobile passes.

- Combo listener injected into every page (`addInitScript` + `exposeBinding`);
  default `Ctrl+Shift+S`, constant at top of capture.mjs. Track the active page
  via `context.on('page')` + focus events so the combo works in any tab.
- Action journal (the passive layer, same injection channel): document-level
  capture listeners stream every click / Enter / navigation with an element
  label ("click on 'Add plan'") to the wrapper. Entries label the journey edge
  between combo presses and mark elements visited in the ledger. Replaces
  Playwright tracing, which labels API-driven actions only — it would not have
  labeled manual clicks.
- On combo: snapshot pipeline —
  1. serialized live DOM (post-JS), with property-only state materialized into
     attributes first (`value`, `checked`, `selected`, `open`) — plain
     serialization silently drops it. Stylesheets: same-origin read via
     `document.styleSheets`; cross-origin fetched Node-side via
     `context.request` (shares browser cookies, immune to CORS); `url(...)` and
     `@import` inside CSS rebased to absolute. Fonts and images stay as absolute
     network URLs — named tradeoff: full visual fidelity needs network, but DOM
     + CSS are complete offline;
  2. desktop 1440×900 screenshot **before any resize**, then viewport override to
     768×1024 / 390×844, screenshot each, restore to 1440×900. Full-page
     (entire scroll height) by default with a max-height cap for infinite feeds;
     viewport-only as a flag. Named limit: lazy-loaded below-fold content is
     captured only if it loaded (explorer does a scroll-to-bottom pass first;
     manual mode relies on Igor);
  3. append node to `screens.json`, append step to the session's
     `journeys/<timestamp>.json` (press order = journey order; the edge between
     consecutive presses carries the action-journal entries in between).
- Console feedback on each capture (`✓ screen 7: /plans "Add plan modal"`).

This phase is three subsystems; if it slips, cut along the existing module
lines with staged verifies — capture skeleton (browser + combo + files written)
→ snapshot quality (inliner + viewports) → journal edges. Still one phase.

**Verify:** run against a free target; capture 3+ screens including one open
modal. Files exist, HTML snapshot opens standalone in a browser and looks right,
mobile PNG shows a genuinely reflowed layout, journey JSON ordering matches press
order. Also run Scribe free tier once on the same journey and compare (DESIGN
requirement).

## Phase 2 — screen identity

Proposed heuristic (isolated in identity.mjs, expected to be tuned):
**normalized URL + hash of a DOM skeleton.** URL normalization: fragment
stripped, query params sorted, path/query values that are numeric or UUID-like
replaced with `:id` — so two records' detail pages share one URL key. The
normalized form is an **identity key only** — never passed to `page.goto` or
stored as `state.root`. Skeleton:
visible elements serialized as a `tag.sorted-classes` tree, depth-capped, with
text content, ids, and numeric class fragments stripped — but **runtime state
kept**: `checked`, `selected`, `disabled`, `open`, input value-emptiness, and
`aria-expanded/pressed/checked/invalid` are part of each element's token, so a
toggled checkbox or a validation state hashes differently. Exact hash match =
same screen. Named limit: text-only DOM changes (counters, status copy) do not
create new screen nodes — intentional, so the graph does not explode; tune only
if a real audit needs those states.

- Dedup applies to **explorer** captures only: known signature → increment
  `seenCount`, no new node.
- **Manual combo presses always create a node** — a press is a human declaring
  "this is a screen" (DESIGN's curated-capture contract). A repeat signature is
  recorded as `sameAs: <screen-id>` on the new node, never suppressed.

**Verify:** explorer visits the same page twice → one node. Page vs page+modal →
two nodes. Two records' detail pages (numeric ids in path) → one node. Two
manual combo presses on the same page → two nodes, the second carrying `sameAs`.

## Phase 3 — viewer

Canonical template at `viewer/index.html`. Each run writes into `out/<domain>/`:
`data.js` (`window.DATA = {…}` bundling screens/journeys/ledger/notes) and a
copy of the viewer as `index.html` that loads sibling `./data.js` via a script
tag — `fetch` of JSON is blocked under `file://` but script tags are not, so
double-clicking `out/<domain>/index.html` opens that domain's corpus. No domain
picker; one output folder = one audit. Reuse outseta-graph viewer patterns.

- Journey view: horizontal screenshot strip, labeled arrows between steps.
- Graph view: screens as nodes, link/click edges.
- Per-node notes: textarea, localStorage autosave, "Export notes.json" button.

**Verify:** open `out/<domain>/index.html` on Phase 1 output; add notes, export,
reload → notes persist; journey order and labels match what was done.

## Phase 4 — auto-explorer: links

`--explore` flag. BFS from the start URL, scoped to the audit host,
bounded by **one global action budget** (`--budget`, default 1000) counting
every navigation, click, and replay step across Phases 4 and 5 — the single
termination knob for unbounded domains. Each new-signature page goes through
the same snapshot pipeline. Every discovered `a[href]` lands in the ledger:
visited / duplicate / skipped(external | destructive-floor | budget-exhausted).

Scope boundary (not a security boundary — keeps BFS from wandering): parse every
candidate and every post-navigation URL with the URL API; allow only `http:` /
`https:`; host must equal the base host or be a proper subdomain
(`host === base || host.endsWith('.' + base)` — never a string-suffix check);
re-validate the final URL after redirects; off-scope → `skipped(external)`.

- Pacing: configurable delay between navigations (default ~1s).

**Verify:** capped run (~30 pages) on a free target. Spot-check graph edges
against reality; ledger has **zero unaccounted links**; re-run is idempotent
(signatures dedupe); a planted off-host link and a cross-host redirect are both
bucketed external.

## Phase 5 — auto-explorer: clicks

The hard phase. Harvest per screen — every element a user could operate:
`a[href]`, `button`, `[role=button]`, all `input` types, `select`, `textarea`,
`[contenteditable]`, `summary`, `[onclick]`, and custom controls reachable via
`tabindex`. Fill-before-submit policy: deterministic dummy values by field type
(text `"test"`, email `audit@example.com`, number `1`, date today) so form
saves actually fire; file inputs are bucketed skipped(file-upload).

A screen state is **an actual absolute root URL plus the action path that
produced it** (`https://app.example.com/records/123` + [{ key, label, … }]) —
this is what makes nested same-URL states (controls *inside* an opened modal)
reachable. `state.root` is the real navigable URL (origin + path + query as
seen in the browser) — **never** the Phase 2 `:id`-substituted form; that
normalization is identity-only and lives in `signature`. Each path step
identifies the control by **ledger `key`** (durable); `label` is display-only;
`role` / `name` are fallbacks when the DOM path shifts. Exploration is BFS
over states: click one element → settle → signature → if new, capture, record
the labeled edge, and **enqueue the new state for its own harvest** → recover
by re-navigating `state.root` and replaying the path by key (then role/name) →
next element.
Settle = no network activity for 500ms AND no DOM mutations for 500ms, 5s max
wait; fallback if flaky on a target: fixed 1500ms delay (all constants in
explore.mjs). The depth cap (default 3 actions deep) and the global `--budget`
bound traversal; elements left unexplored by either stop are bucketed
skipped(max-depth) / skipped(budget-exhausted). **The coverage guarantee is
"every harvested element accounted for" (bucketed), not "everything
auto-visited"** — skipped buckets are the viewer-surfaced to-do list for
manual passes.

- Do-not-click floor — classification inspects more than the control's own
  text/aria: surrounding dialog/heading text, ancestor labels, the enclosing
  form's action URL and field types (a form with card-number/CVC fields is
  payment no matter what its button says; "Confirm" inside a dialog that
  mentions delete is destructive). Floor terms: logout, sign out, delete
  account/workspace, cancel subscription, payment/checkout submission.
  **Uncertain cases are never clicked** — bucketed skipped(needs-manual) for
  Igor to handle in manual mode. Patterns live in one place in explore.mjs.
- Server-side mutations persist across replays (expected — audit account is
  disposable). Replay assumes the app renders the same controls for the same
  data; when a path fails to replay, the state is marked unstable and its
  elements bucketed skipped(unreplayable) — coverage stays honest instead of
  silently complete.
- Element identity for the ledger: tag + trimmed text + DOM path index, scoped
  to its screen state.

**Verify:** free target with CRUD (todo-style app or the archura app). Explorer
clicks +/- controls; new states (modals, added rows) appear as nodes; controls
*inside* an opened modal get exercised via path replay (nested state, depth 2);
a form save fires with dummy values; ledger has zero unaccounted elements; the
do-not-click floor is demonstrably skipped (plant a logout link).

## Phase 6 — agent driving

- Launch arg exposes `--remote-debugging-port` on the persistent context;
  README snippet documents attaching Playwright MCP via `--cdp-endpoint`.
- Agent triggers capture with a synthetic `Ctrl+Shift+S` — no new API.

**Verify:** from a Claude Code session, attach, navigate to a page, fire the
combo → node appears in screens.json with all four files.

## Explicit outs / revisit triggers

- Signature heuristic too coarse or too fine on the first real audit → tune
  identity.mjs only; data model unchanged.
- Settle detection flaky on SPAs → fall back to fixed post-click delay.
- Stylesheet inlining fails on some app → keep raw HTML + separate CSS files
  per screen instead of inlining (viewer unaffected; snapshot less portable).
- Replay cost blows up on deep or flaky flows → lower the depth cap; anything
  deeper becomes manual-mode work (Igor stages it, presses the combo).
- Action-path replay too unreliable on a target → add combo-style manual
  takeover mid-explore (Igor stages the state, explorer resumes from it).

## Appendix — pinned JSON shapes

Minimal contracts so Phase 1 and the viewer can't drift apart. Changes are
additive only; consumers tolerate unknown fields.

`screens.json`:

```json
{ "screens": [ {
  "id": "s7",
  "signature": "app.example.com/plans::a1b2c3",
  "url": "https://app.example.com/plans",
  "title": "Plans",
  "source": "combo",
  "sameAs": "s3",
  "state": {
    "root": "https://app.example.com/plans",
    "path": [ {
      "key": "button|Add plan|body>main>div[2]>button[0]",
      "label": "click on 'Add plan'",
      "role": "button",
      "name": "Add plan"
    } ]
  },
  "shots": { "desktop": "shots/s7-desktop.png",
             "tablet": "shots/s7-tablet.png",
             "mobile": "shots/s7-mobile.png" },
  "html": "html/s7.html",
  "capturedAt": "2026-07-29T18:00:00Z"
} ] }
```

`source`: `"combo" | "explorer"`. `sameAs`: optional, combo repeat of a known
signature. `url` / `state.root`: actual absolute URLs as seen in the browser
(navigable — used for replay). `signature`: identity key only (Phase 2
normalized URL + skeleton hash); never navigate to it. `state.path`: `[]` for
plain pages; otherwise replay steps addressed by ledger `key` (required), with
`label` for humans and `role`/`name` as DOM-shift fallbacks.

`journeys/<timestamp>.json`:

```json
{ "steps": [ {
  "screen": "s7",
  "edge": [ { "type": "click",
              "key": "button|Add plan|body>main>div[2]>button[0]",
              "label": "click on 'Add plan'",
              "url": "https://app.example.com/plans",
              "at": "2026-07-29T18:00:00Z" } ]
} ] }
```

`edge`: action-journal entries since the previous step (empty for the first).
`type`: `"click" | "enter" | "nav"`. `key`: same ledger identity when known.

`ledger.json`:

```json
{ "elements": [ {
  "key": "button|Add plan|body>main>div[2]>button[0]",
  "screen": "s7",
  "bucket": "skipped",
  "reason": "needs-manual",
  "href": null
} ] }
```

`key`: `tag|trimmed-text|dom-path`, scoped to its screen. `bucket`:
`"visited" | "duplicate" | "skipped"`. `reason` (skipped only):
`"external" | "destructive-floor" | "needs-manual" | "file-upload" |
"max-depth" | "budget-exhausted" | "unreplayable"`. `href`: links only,
known pre-click.

`notes.json`: `{ "<screen-id>": "free text" }`.

## Order of operations when Igor says go

1. Scaffold (package.json, .gitignore, playwright install) → propose initial
   commit for approval.
2. Phases 1→6 in order; each phase's verify run happens before the next starts.
3. Free target throughout; Outseta trial starts only after Phase 5 verifies.
