# MTG Lab

A clean desktop app for Magic: The Gathering, built on the [Forge](https://github.com/Card-Forge/forge)
rules engine. It gives you a deck builder, games against the Forge AI, human-vs-human
play over your local network, and a headless AI-vs-AI simulator with real statistics —
all in one installable app that needs nothing else (Java and the full card database
are bundled).

## Features

- **Deck Builder** — search the full card pool, filter by color/type/format, manage multiple decks.
- **Play vs AI** — a local game against the Forge AI with a clean board UI.
- **Watch AI vs AI** — spectate two AIs play out a match.
- **WLAN Game** — play another person on your network; the host shares a LAN address, the guest joins by IP. Both pick their own deck.
- **Simulator Lab** — run N AI-vs-AI games of one deck vs another in parallel and get a full report: win rate with a 95% confidence interval, on-the-play/on-the-draw splits, game-length and mulligan distributions, and how games ended.

## Download & install

Grab the installer for your operating system from the project's **Releases** page:

| OS | File | How to install |
| --- | --- | --- |
| Windows | `MTG Lab-…-x64.exe` | Double-click — one-click installer, no admin needed. |
| macOS | `MTG Lab-…-arm64.pkg` | Double-click — installs to Applications. |
| Linux | `MTG Lab-…-x86_64.AppImage` | `chmod +x` it, then double-click to run (no install needed). |

Each file is fully self-contained — the Java runtime and the card database ship inside,
so there's nothing else to install.

### First-launch security prompt

The builds aren't code-signed yet, so the first time you open the app your OS shows a
one-time "unidentified developer" warning:

- **macOS** — right-click the app → **Open** → **Open**.
- **Windows** — on the SmartScreen dialog click **More info** → **Run anyway**.

### Your data is safe across updates

Your decks and username are stored in your OS user-data folder, separate from the app
itself. Installing a newer version over an old one keeps everything. A brand-new install
starts with two starter decks (Mono Red, Mono Green); your created decks are never
touched or reset by an update.

## Using the app

- On the home screen you're auto-assigned a username (e.g. `GoblinBrewer427`). Click **✎ Change** to set your own — it's remembered across updates.
- **Deck Builder** saves decks locally as you go.
- **WLAN Game**: the host clicks Create, shares the shown LAN IP; the guest enters that IP and connects. The host starts the match once the guest has joined.
- **Simulator Lab**: pick your deck and an opponent deck, choose how many games, and Run. Full AI games take a few seconds each but run in parallel across your CPU cores; a live progress bar shows an ETA.

## Build from source

Requirements: **Node 20+**, **JDK 21**, **Maven**, **git**.

```bash
git clone <this-repo> && cd MTG_Lab
./scripts/update-engine.sh     # fetches the Forge engine + builds the bridge (first time is slow)
cd app && npm install
npm run electron:start         # build the UI and launch the desktop app
```

The Forge engine itself is **not** committed — it's pulled from upstream by
`update-engine.sh` into `engine/forge/` (git-ignored). This keeps the repo small and
makes engine updates a one-command, no-merge operation.

### Common tasks

| Task | Command |
| --- | --- |
| Update to the latest Forge engine | `./scripts/update-engine.sh` |
| Build a one-click installer for this OS | `./scripts/build-app.sh` (auto-downloads a bundled JRE) |
| Build installers for all three OSes | push a `v*` tag → GitHub Actions (`.github/workflows/release.yml`) builds macOS/Windows/Linux and uploads them |

## How it works

- **`app/`** — the UI: React + Vite, packaged with Electron. `electron.cjs` spawns the bridge and serves card art from a local cache.
- **`bridge/`** — a small Java WebSocket server that wraps Forge running headless. The UI talks to it over `ws://localhost:8088`; the same server also handles WLAN play between two clients.
- **`engine/forge/`** — the Forge engine checkout (fetched, not committed). The bridge compiles against it and reads the card database from it at runtime.
- **`scripts/`** — `update-engine.sh` (engine sync), `fetch-jre.sh` (download a bundled JRE), `build-app.sh` (package an installer).

## License

This project builds on Forge, which is licensed under the GNU GPL v3. See the Forge
repository for its license terms.
