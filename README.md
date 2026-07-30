# archura-flow

Capture an authenticated web app as a screen graph, responsive screenshot
corpus, standalone HTML snapshots, and an interactive coverage ledger.

## Setup

```sh
npm install
npx playwright install chromium
```

## Manual capture

```sh
npm run capture -- app.example.com
```

The browser uses `profiles/<domain>/`, so a manual login survives restarts.
Press `Ctrl+Shift+S` on every state worth keeping. Each press writes a screen
even when it matches an earlier capture. Stop with `Ctrl+C`, then open
`out/<domain>/index.html`.

Useful options:

```text
--viewport-only       screenshot only the visible viewport
--cdp-port <number>   CDP port for an agent (default: 9222)
```

To drive the same browser from Playwright MCP, start archura-flow and configure
the MCP browser with:

```sh
--cdp-endpoint http://127.0.0.1:9222
```

The agent uses the same capture contract as a person: send `Ctrl+Shift+S`.

## Capturing from your own Chrome

To capture a tab you are already logged into, in your everyday Chrome profile,
install the companion extension instead of launching a browser:

```sh
npm run extension:install
```

One shortcut binds a recording to that exact tab and each later press captures
another screen. See [EXTENSION.md](EXTENSION.md) for setup, permissions, and
recovery. Manual capture only — the explorer stays in the app-launched profile.

## Automatic exploration

Use only with a disposable audit account. The explorer mutates data, but skips
external navigation, logout/sign-out, destructive account/workspace actions,
subscription cancellation, payment submission, file uploads, and ambiguous
high-risk controls.

```sh
npm run capture -- app.example.com --explore --budget 1000
```

Options:

```text
--budget <number>     global navigation/click/replay budget (default: 1000)
--depth <number>      maximum nested click depth (default: 3)
--delay <ms>          delay between navigations (default: 1000)
--headless            useful for disposable local/CI targets
```

Coverage means every harvested element is assigned `visited`, `duplicate`, or
`skipped` with a reason. It does not mean every state was safe to visit.
