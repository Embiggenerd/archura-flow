# Chrome extension capture

Capture screens from a tab you are already logged into, in your everyday Chrome
profile, without archura-flow launching a second browser.

The app-launched CLI in `README.md` is unchanged and still the right tool for
automatic exploration. This mode is manual capture only.

## What it does

One configurable shortcut binds a recording session to the exact tab that
received it. The first press starts the local companion process and captures
`s1`; every later press captures another screen node. Clicks, Enter presses, and
top-level navigations between presses become the labeled edges of the journey.

Output is the same corpus as the CLI — `screens.json`, `journeys/*.json`,
`ledger.json`, `notes.json`, `html/`, `shots/` — under `out/<domain>/`, readable
by the same viewer.

No password, cookie database, or Chrome profile file is read or copied. The tab
stays in your own profile.

## Install

```sh
npm run extension:install
```

The installer must be run explicitly; neither `npm install` nor the test suite
ever touches Chrome configuration. It writes exactly two files:

- `scripts/archura-flow-host`, a wrapper pinning the absolute path of the `node`
  that ran the installer (Chrome does not inherit your shell's PATH);
- `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.archura.flow.json`
  on macOS, or `~/.config/google-chrome/NativeMessagingHosts/` on Linux.

`allowed_origins` in that manifest is pinned to the one extension id derived
from the fixed public key in `extension/manifest.json`, so no other extension
can start the host.

Then load the extension:

1. Open `chrome://extensions` and turn on Developer mode.
2. "Load unpacked" and choose the `extension/` directory.
3. Confirm the id reads `lddeibbpklcgmddooalfkbkcilhcdban`. A different id means
   the manifest key changed — re-run the installer so the pin matches.
4. Set the shortcut at `chrome://extensions/shortcuts`. The default is
   `Command+Shift+Y` on macOS and `Ctrl+Shift+Y` elsewhere.

Verify the host without touching Chrome configuration:

```sh
npm run extension:self-test
```

Windows is not supported yet: it registers native messaging hosts through the
registry rather than a manifest file.

## Chrome's debugger banner

Capture uses `chrome.debugger`, so Chrome shows its own "archura-flow capture
started debugging this browser" notification while recording. This is expected
and not suppressible.

- It occupies part of the window, so the live viewport during recording is
  shorter than the same window's viewport before attaching. Screenshots record
  the viewport actually in effect.
- Its **Cancel** button detaches the debugger. archura-flow treats that as a
  normal operator stop, not an error: the session finalizes and the corpus stays
  valid.

## Permissions

`activeTab`, `debugger`, `nativeMessaging`, `storage`. There are no
`host_permissions`, so the extension has no standing access to any site; the
command grants access to the tab it was pressed on.

The native host never sends CDP commands. Every CDP method archura-flow can
issue is named in `extension/cdp.js`; the protocol carries capture data and
session commands only. Artifact names come from a fixed allowlist, so a message
can never supply a file path.

## Using it

Press the shortcut on any `http`/`https` tab.

| Badge | Meaning |
| --- | --- |
| *(empty)* | idle |
| `REC` green | recording |
| `…` blue | capture in progress |
| `!` red | error or unexpected detach |

The popup shows the bound tab, output name, screen count, and last capture, and
offers Start/Capture now, Open flow, Stop recording, and Retry after an error.

Only one tab records at a time. Pressing the shortcut on a different tab is an
error rather than a silent switch of target — stop first, then start on the
other tab.

"Open flow" serves the live corpus from `127.0.0.1` on an ephemeral port behind
an unguessable path, and the viewer polls it as captures land. Stopping writes
the ordinary static viewer, which opens from disk afterwards with no server.

**Notes taken in the live viewer do not follow the corpus to disk.** Notes are
stored in `localStorage`, which is per-origin, and the live viewer's
`http://127.0.0.1:<port>` origin is not the `file://` origin of the static
viewer. Use the viewer's **Export notes.json** button before you stop, and save
the download over `out/<domain>/notes.json`; notes stored there are bundled into
the corpus and appear in every later view.

## Recovery

- **Host dies** — badge shows the error. The next shortcut press starts a new
  host and resumes the same output directory with a new journey. Journal entries
  buffered since the last capture are lost with the host, so the first edge of
  the resumed journey may be missing labels for clicks made just before the
  crash. Screens already committed are untouched.
- **Extension reloads** — stale debugger state is detached; one press re-arms.
- **Chrome restarts** — the prior corpus stays valid. Recording never resumes
  silently.
- **Capture interrupted** — its temporary files are discarded and the previous
  graph is left exactly as it was. A failed capture never creates a partial
  screen node.

## Uninstall

```sh
npm run extension:uninstall
```

Removes the native messaging manifest **only if it points at this checkout**,
plus the generated wrapper. Captures under `out/`, Chrome profile data, and
other extensions are left alone. Remove the extension itself from
`chrome://extensions`.

## Known limits

- Cross-origin out-of-process iframes: journal events are not guaranteed, and a
  top-level HTML snapshot does not embed a live cross-origin frame document.
- Stylesheets that cannot be read are recorded in `snapshotWarnings` on the
  screen record rather than failing the capture.
- Incognito is out of scope pending a separate review.
- Automatic exploration is deliberately not exposed here; it mutates data and
  belongs in the disposable audit profile the CLI launches.
