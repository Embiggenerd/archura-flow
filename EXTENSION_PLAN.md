# Chrome extension capture — implementation plan

Plan date: 2026-07-30.

This plan adds human-driven capture from an already-open, already-authenticated
Chrome tab. It extends the implementation in `PLAN.md`; it does not replace the
existing app-launched browser or automatic explorer.

## Outcome

From an ordinary Chrome tab, such as a logged-in YouTube page:

1. The operator presses one configurable shortcut.
2. If the tab is not recording, Chrome starts the local archura-flow companion,
   binds the session to that exact tab, and captures the first screen.
3. Clicks, Enter presses, and top-level navigation are journaled as graph edges.
4. Each later press of the same shortcut captures another screen node.
5. The extension badge and popup show recording/capture/error state.
6. The popup can open the live flow viewer or stop recording.
7. The completed corpus remains the same JSON + PNG + HTML format already used
   by the static viewer.

No password, cookie database, or Chrome profile data is copied into archura-flow.
The attached tab stays inside the operator's existing Chrome profile.

## Decisions

### Use a small Archura extension, not the stock Playwright picker

The official Playwright extension proves that an extension can expose existing
authenticated tabs through `chrome.debugger`, but its normal connection flow
opens a tab picker and its direct Playwright `Browser` adapter is implemented in
private Playwright relay modules. Depending on those private modules or turning
archura-flow into an MCP client would add a brittle integration boundary.

Attaching Playwright to the operator's already-running daily Chrome over a
remote-debugging port is not a viable simpler route. Chrome 136 and later ignore
`--remote-debugging-port` and `--remote-debugging-pipe` for the default Chrome
data directory; they require a non-standard `--user-data-dir`. That is still
appropriate for the existing isolated audit profile, but it cannot attach to
the operator's current logged-in tab.

The Archura extension will use Chrome's public APIs directly:

- `chrome.commands` identifies the exact tab receiving the shortcut.
- `chrome.runtime.connectNative` starts and communicates with the local Node
  companion.
- `chrome.debugger` supplies the CDP operations needed by the existing capture
  pipeline: JavaScript evaluation, event bindings, device emulation, stylesheet
  text, and screenshots.

The native host never sends arbitrary CDP commands to the extension. CDP method
names live in extension code and are limited to the capture operations in this
plan; the Native Messaging protocol carries capture data and session commands,
not a general-purpose browser-control channel.

The Manifest V3 permission floor is `activeTab`, `debugger`, `nativeMessaging`,
and `storage`. V1 requests no broad `host_permissions`. The manifest includes a
fixed public key so the unpacked extension id is stable and can be pinned in the
Native Messaging host's `allowed_origins`.

References:

- [Chrome Commands API](https://developer.chrome.com/docs/extensions/reference/api/commands)
- [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Chrome debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger)
- [Chrome 136 remote-debugging change](https://developer.chrome.com/blog/remote-debugging-port)
- [Playwright extension source](https://github.com/microsoft/playwright/tree/main/packages/extension)

### One active recording

V1 supports one recording tab at a time.

- Shortcut on an unattached tab: start a session and capture `s1`.
- Shortcut on the attached tab: capture the next node.
- Shortcut on a different tab while recording: do not silently switch targets;
  show an error badge and direct the operator to stop or switch from the popup.
- Closing the attached tab finalizes the session.

This avoids mixing two applications into one journey and keeps session state
small.

### Manual capture only in the daily Chrome profile

The extension does not expose automatic exploration. The existing
`--explore` mode continues to use a dedicated, app-launched audit profile.
Automatic clicking in a daily authenticated Chrome profile is outside this
plan because the explorer intentionally mutates application data.

### Preserve the existing corpus

The pinned `screens.json`, `journeys/*.json`, `ledger.json`, `notes.json`,
HTML, and screenshot contracts remain valid. Extension capture adds only
optional metadata:

```json
{
  "driver": "chrome-extension",
  "tab": { "id": 42, "windowId": 7 },
  "viewports": {
    "desktop": { "width": 1378, "height": 812, "source": "live" },
    "tablet": { "width": 768, "height": 1024 },
    "mobile": { "width": 390, "height": 844 }
  },
  "snapshotWarnings": []
}
```

The desktop screenshot uses the tab's actual live viewport. HTML serialization
and identity are collected before any emulation. Tablet and mobile use the
existing fixed dimensions. `Emulation.clearDeviceMetricsOverride` restores the
tab after capture.

## Proposed layout

```text
archura-flow/
  extension/
    manifest.json
    service-worker.js
    cdp.js
    browser-scripts.js       # environment-neutral page functions; Node imports it too
    popup.html
    popup.js
    popup.css
    icons/
  scripts/
    install-native-host.mjs
    uninstall-native-host.mjs
  src/
    capture.mjs             # existing app-launched entry
    capture-session.mjs     # shared journal/run/capture orchestration
    extension-capture.mjs   # assembles a capture sent by the extension
    native-host.mjs         # Chrome Native Messaging process
    native-protocol.mjs     # framed JSON reader/writer + message validation
    live-viewer.mjs         # loopback viewer server
    snapshot.mjs
    identity.mjs
    ledger.mjs
  test/
    extension/
    native-host.test.mjs
    extension-capture.test.mjs
```

No bundler is required. The extension is plain Manifest V3 JavaScript, matching
the repository's current no-build Node style.

## Native protocol

Chrome Native Messaging uses length-prefixed JSON on stdin/stdout. The host
must reserve stdout for protocol frames and send diagnostics to stderr.

The extension keeps one long-lived `connectNative` port. Large artifacts are
sent in chunks so full-page PNGs and large DOMs never approach Chrome's
per-message limit.

Extension to host:

```text
hello             protocol version + extension version
session.start     tab metadata, URL, title, live viewport, optional output to resume
journal.append    session epoch + monotonically sequenced action entries
capture.begin     request id, URL/title/viewports/warnings
capture.chunk     request id, artifact name, chunk index, base64 payload
capture.commit    skeleton, harvested elements, capture metadata
session.stop      finalize reason
viewer.open       request the current live-viewer URL
```

Host to extension:

```text
ready             negotiated protocol version
session.started   session id, session epoch, and output name
capture.done      screen id and sameAs, when applicable
viewer.url        loopback URL
state             current host/session state
error             request id, stable error code, human-readable message
```

Every message after `session.started` carries its session id and epoch. A host
restart creates a new epoch even when it resumes the same output directory.

Each capture is transactional. Artifacts are written under a temporary capture
directory and moved into `html/` and `shots/` only after `capture.commit`.
Startup removes abandoned temporary captures. A failed capture therefore never
creates a half-valid screen node. Artifact names come from a fixed allowlist
(`html`, `desktop`, `tablet`, `mobile`); message data can never supply a file
path.

## Phase 0 — prove the platform boundary

Build the smallest unpacked extension and native host spike before refactoring
the working capture pipeline.

- Register a development Native Messaging host with a stable unpacked extension
  id derived from the manifest's fixed public key.
- Bind a configurable command, defaulting to:
  - macOS: `Command+Shift+Y`
  - Windows/Linux: `Ctrl+Shift+Y`
- On the command, obtain the callback's exact `tab.id`.
- Start the host with `connectNative` and round-trip a `hello` message.
- Attach `chrome.debugger` to the selected tab.
- Run `Runtime.evaluate`, capture one PNG with `Page.captureScreenshot`, apply
  and clear temporary tablet/mobile metrics overrides, and detach.
- Exercise the actual difficult screenshot combinations:
  - full-page capture with `captureBeyondViewport` under tablet emulation;
  - full-page capture under mobile emulation;
  - a clipped capture of a page taller than the existing 12,000px cap.
- Observe Chrome's debugger notification UI during attach. Record whether it
  changes the content viewport and verify the user-controlled cancel/detach
  path reported through `chrome.debugger.onDetach`.

**Verify:** on a disposable local page and then a logged-in, non-sensitive
Chrome tab, one shortcut starts the host and captures the selected tab without
opening another browser window. The tab id is unchanged. Emulation does not
leave additional viewport, scroll, or focus changes while attached, and the
pre-attach viewport is restored after detach. The full-page and 12,000px-clipped
images have the expected dimensions and no blank or duplicated regions.
Pressing Chrome's debugger cancel control finalizes the spike as a normal
operator stop, not an application error.

**Stop condition:** if Chrome Stable cannot reliably clear emulation or retrieve
full-page screenshots through `chrome.debugger`, keep extension mode
viewport-only. Do not introduce a private Playwright relay merely to preserve
multi-viewport capture.

## Phase 1 — extract shared capture logic

Separate orchestration from the Playwright transport without changing output.

- Move run ownership, journal buffering, serialized capture queue, and console
  result formatting from `capture.mjs` into `capture-session.mjs`.
- Move page-executed functions for DOM state materialization, screen skeleton,
  and element harvesting into `extension/browser-scripts.js`. Keep the module
  free of Chrome and Node globals so the extension can import it directly and
  Node can import the same file without a build/copy step.
- Define every shared page function as a closure-free, stringifiable function
  with exactly one JSON-serializable argument. The Playwright adapter calls
  `page.evaluate(fn, argument)`; the CDP adapter evaluates the same function
  source with the same argument. Function bodies must not reference imports,
  module constants, or transport globals.
- Keep thin Playwright wrappers that call those functions through
  `page.evaluate`.
- Let `capture-session.mjs` accept already-collected extension artifacts as a
  second input path; it remains the sole writer of screen, journey, and ledger
  records.
- Preserve `captureScreen` behavior:
  - manual captures always create a node;
  - repeat signatures receive `sameAs`;
  - journal entries since the preceding capture label the new edge;
  - the viewer corpus is regenerated only after a successful commit.

**Verify:** the existing `npm test` suite passes unchanged before adding
extension-specific assertions. A three-screen Playwright capture produces a
byte-for-byte equivalent JSON shape, aside from timestamps and newly optional
metadata.

## Phase 2 — native host and installation

Implement the local companion as a small stdio process.

- `native-protocol.mjs`:
  - parse fragmented and coalesced length-prefixed input;
  - enforce maximum message/chunk sizes;
  - validate message type, protocol version, request id, session id, and epoch;
  - serialize responses without allowing logs onto stdout.
- `native-host.mjs`:
  - create or resume the current in-process `CaptureSession`;
  - receive journal events and capture artifacts;
  - assemble and commit captures;
  - start the live viewer lazily;
  - finalize cleanly on `session.stop`, tab close, SIGTERM, or stdin EOF.
- `install-native-host.mjs`:
  - derive absolute paths instead of embedding a developer's home directory;
  - write the Chrome Native Messaging manifest for `com.archura.flow`;
  - restrict `allowed_origins` to the fixed Archura extension id;
  - verify Node, manifest, executable permissions, and a protocol self-test;
  - print the exact unpacked-extension directory and Chrome setup steps.
- Target macOS + Chrome Stable first. Keep OS-specific manifest path resolution
  isolated so Windows/Linux installers can be added without changing the host.

The installer writes outside the repository and must be run explicitly by the
developer; tests and ordinary `npm install` never mutate Chrome configuration.

**Verify:** protocol unit tests cover split frames, multiple frames, Unicode,
oversized chunks, malformed JSON, stdout contamination, host EOF, and
unsupported versions. An install/self-test starts the registered host from
Chrome and receives `ready`.

## Phase 3 — exact-tab recording and action journal

Implement the Manifest V3 service worker state machine.

States:

```text
idle -> starting -> recording -> capturing -> recording
                   recording -> stopped
any state -> error -> idle/retry
```

- The command handler receives the selected tab and owns all start/capture
  decisions.
- Attach the debugger once per recording, enable `Page` and `Runtime`, then:
  - add a `Runtime` binding for journal messages;
  - install the existing click/Enter listener with
    `Page.addScriptToEvaluateOnNewDocument`;
  - install it immediately in the current document;
  - translate main-frame navigation events into `nav` journal entries.
- Forward journal entries to the host immediately with monotonically increasing
  sequence numbers scoped to the session epoch returned by `session.started`.
  The host deduplicates only by `(epoch, sequence)` and rejects stale epochs.
- Parameterize the shared listener's in-page capture combo. The Playwright CLI
  keeps `Ctrl+Shift+S`; extension mode disables the in-page combo and accepts
  capture requests only from `chrome.commands`.
- Record frame identity on click/Enter entries when the listener can observe an
  iframe execution context; the existing `key`, label, URL, and timestamp
  remain unchanged. Cross-origin out-of-process iframe actions are not promised
  in V1.
- Handle `chrome.debugger.onDetach`, tab removal, service-worker restart, and
  native-port disconnect explicitly.
- Persist only the tab id, debugger session marker, output name, and journal
  epoch/sequence in `chrome.storage.session`. On worker restart, reconcile those
  identifiers with the native host before accepting another capture.
- Badge states:
  - `REC` green: recording;
  - `…` blue: capture in progress;
  - `!` red: error/detached;
  - empty: idle.

**Verify:** first shortcut on local fixture tab creates `s1`; click “Add plan,”
capture an open modal, navigate, and capture again. Journey order matches press
order and each edge contains only actions since the previous capture. Shortcut
on another tab does not change either tab or the current corpus.

## Phase 4 — extension snapshot pipeline

Collect a complete capture through CDP and send it to the host.

Order matters:

1. Read URL, title, scroll position, live viewport, and device scale factor.
2. Evaluate the shared identity skeleton and element harvester.
3. Serialize the live DOM with property-only state materialized.
4. Enable the CDP CSS domain and retrieve loaded stylesheet text, including
   cross-origin sheets, then rebase resource URLs using each sheet's source URL.
5. Capture the desktop image from the current live viewport before emulation.
6. Apply tablet metrics, capture, then mobile metrics and capture.
7. In `finally`, clear the metrics override and restore scroll/focus.
8. Stream HTML and three PNGs to the native host; commit only after every
   required artifact is acknowledged.

If a stylesheet cannot be read, preserve the HTML and capture but append a
structured `snapshotWarnings` entry. Failure to restore emulation is fatal:
stop recording, show the error badge, and instruct the operator to reload the
tab.

Only `http:` and `https:` tabs are supported. Chrome internal pages, the Chrome
Web Store, DevTools, discarded tabs, and tabs already owned by another debugger
produce explicit errors without starting a corpus.

**Verify:** capture a fixture with:

- an open dialog and populated input;
- checkbox/select/textarea property state;
- same-origin, cross-origin, imported, and inline CSS;
- responsive desktop/tablet/mobile layouts;
- a tall page that hits the existing screenshot cap;
- a same-origin iframe action;
- two identical manual captures (`sameAs`);
- an infinite-scroll simulation.

Reopen the HTML standalone, inspect all three PNG dimensions, confirm the live
tab returned to its original dimensions and scroll position, and confirm every
harvested element has a ledger row.

## Phase 5 — popup and live flow viewer

The popup is a control surface, not a second capture implementation.

- Show the bound tab title/URL, output name, screen count, last capture result,
  and current state.
- Actions:
  - Start / Capture now — calls the same service-worker function as the command;
  - Open flow;
  - Stop recording;
  - Retry attachment after a recoverable error.
- The native host binds an HTTP server to `127.0.0.1` on an ephemeral port and
  uses an unguessable session path.
- The server accepts only `GET`/`HEAD`, validates the loopback Host header, does
  not enable CORS, and serves no file path supplied by a request.
- Change the viewer template to detect HTTP serving, fetch `/api/data`, and poll
  while live. This is new viewer behavior; preserve the existing sibling
  `data.js` bootstrap as the `file://` path.
- A committed capture appears in the journey and graph within one polling
  interval. Notes continue to use localStorage/export.
- Stopping writes the final static viewer. A later `viewer.open` can start the
  native host in view-only mode for the last output. The extension stores only
  the last output name in `chrome.storage.local`; it never stores page content
  or authentication state.

**Verify:** keep the HTTP-served viewer open while capturing three states. Each
node and labeled edge appears without reload; graph and journey views agree.
Then stop recording and close Chrome. Open the modified viewer template through
`file://` with only its sibling `data.js`; confirm the same corpus renders and
notes remain intact. The live viewer must not be required for static output.

## Phase 6 — packaging, recovery, and documentation

- Add package scripts:

```text
npm run extension:install
npm run extension:uninstall
npm run extension:self-test
```

- Document load-unpacked setup, shortcut remapping at
  `chrome://extensions/shortcuts`, Native Messaging installation, permissions,
  popup states, output location, and recovery. Also document Chrome's visible
  debugger notification, that its cancel action stops recording, and any
  viewport effect measured in Phase 0.
- Include the upstream Apache-2.0 attribution for any Playwright-derived
  listener or protocol code actually copied. Do not vendor the full Playwright
  extension.
- Preserve the existing app-launched CLI and `--explore` documentation.
- Recovery behavior:
  - native host dies: badge error; next command starts a new host and resumes
    the same output with a new journey;
  - extension reloads: detach stale debugger state, query host state, require
    one command to re-arm;
  - Chrome restarts: prior corpus remains valid; recording does not silently
    resume;
  - capture interrupted: discard its temporary files and leave the prior graph
    untouched.

**Verify:** install, update, and uninstall from a clean Chrome Stable profile.
Uninstall removes only the Native Messaging manifest created by this project;
it does not remove captures, Chrome profile data, or unrelated extensions.

## Final acceptance run

Use the operator's already-authenticated YouTube tab only after all fixture
checks pass.

1. Record the tab's id, URL, viewport, scroll position, and logged-in identity.
2. Press the shortcut. Confirm no new Chrome process/window or login flow.
3. Confirm `s1` appears and the badge reads `REC`.
4. Open a non-destructive menu and capture it.
5. Navigate through two non-destructive YouTube surfaces and capture each.
6. Open the live viewer:
   - nodes match the four presses;
   - arrows carry the actual intervening click/navigation labels;
   - screenshots and HTML open;
   - notes persist/export.
7. Confirm Chrome is still logged in and no passwords/cookies were written to
   the output.
8. Confirm emulation restores the same attached-session viewport and scroll
   position after every capture. After stopping and detaching, confirm the
   original pre-attach viewport is restored.
9. Stop from the popup and confirm Chrome no longer reports a debugger attached.
10. Reopen the static flow viewer after Chrome and the host are closed.

## Explicit outs and revisit triggers

- Chrome Web Store publication and signing are out; V1 is load-unpacked.
- Windows/Linux Native Messaging installers are out until the macOS flow
  verifies.
- Incognito capture is out unless the operator explicitly enables the extension
  in incognito and a separate threat review is completed.
- Automatic exploration of a daily Chrome profile is out.
- Cross-origin iframe DOM serialization remains limited by the browser; journal
  events are not guaranteed for out-of-process frames, and a top-level HTML
  snapshot does not embed a live cross-origin frame document.
- If CDP CSS retrieval proves incomplete on a real target, record warnings and
  keep the existing network-dependent absolute stylesheet links; do not block
  screenshots or graph creation.
- If live multi-viewport emulation disrupts stateful media sites, add an
  extension preference for desktop-only capture. Do not attempt to clone the
  authenticated tab in V1.

## Completion criteria

The extension work is complete when:

- one shortcut starts archura-flow on the exact active authenticated tab;
- later presses create ordered screen nodes without a tab picker;
- clicks, Enter, and navigation become labeled graph edges;
- the live and static viewers render the same flow;
- the tab is restored after every capture;
- stop/detach and crash paths leave a valid corpus;
- the existing CLI/explorer test suite still passes;
- no Chrome credential or profile files are read or copied by archura-flow.
