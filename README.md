# LG Dev Manager

Manage LG webOS TVs from your browser — rooted (Homebrew Channel) or in Developer Mode. Install apps from the
webOS Homebrew repository or from an IPK file, update them, browse the TV's files, open a shell, take screenshots,
renew the Dev Mode session and dig into logs and the luna bus.

**Open it:** https://lg.scoty.uk — then run the bridge on your computer (one command, below).

A web rebuild of [webosbrew/dev-manager-desktop](https://github.com/webosbrew/dev-manager-desktop), styled after
[Adminator](https://github.com/puikinsh/adminator-admin-dashboard).

### Add a TV, install an app and update it

![Adding the Living Room TV with the wizard, installing Moonfin 2.8.2 from an IPK file and updating it to 2.9.0 from the Homebrew repository](docs/demo-basic.webp)

### Debug tools on a rooted TV

![Switching to the Bedroom TV and going through the system log, log levels, kernel log, crash reports and the luna monitor](docs/demo-advanced.webp)

## Get started

1. Install [Node.js](https://nodejs.org) 22 or newer.
2. In a terminal, start the bridge:

   ```bash
   npx lg-dev-manager-bridge@latest
   ```

   It prints a **pairing token**. Keep the terminal open while you use the app (Ctrl+C stops it).
3. Open **https://lg.scoty.uk**, or the local page the bridge serves at **http://localhost:5199** — they are the
   same app. On the **Bridge** page, paste the token.
4. On **Devices → Add a TV**, pick your TV from the scan. Rooted TVs log in as root (Homebrew Channel's SSH server);
   other TVs use the Developer Mode app and its passphrase.

On macOS, the first time the bridge looks for your TV, the system asks whether your terminal may find devices on the
local network — choose **Allow**. Phones and tablets aren't supported: the bridge has to run on the same computer
as the browser.

Which page to use is up to you. **lg.scoty.uk** always has the latest version and needs nothing installed besides the
bridge. **http://localhost:5199** is served from your computer by the bridge itself, so it works even when the
website can't be reached. Each keeps its own list of TVs (browsers store them per site); use **Export backup** / **Import backup** on
the Devices page to move them.

## How it works

Browsers can't open SSH connections, so the app comes in two parts:

```
 Browser (lg.scoty.uk or localhost:5199)        Your computer                      Your TV
 ┌──────────────────────────────────┐   WebSocket   ┌────────────────────┐   SSH / SFTP   ┌──────────────┐
 │ Web app — your TVs, keys and     │ ────────────▶ │ Bridge             │ ─────────────▶ │ webOS        │
 │ passwords are stored only here   │  127.0.0.1    │ (npx …, Node.js)   │                │ (port 22 or  │
 └──────────────────────────────────┘  + token      └────────────────────┘                │  9922)       │
                                                                                          └──────────────┘
```

- **The web app** is a static site. Saved TVs — names, addresses, keys and passwords — live only in your browser's
  storage. They are never sent to the website; each request sends them to your own bridge, and only to it.
- **The bridge** is a small Node.js program that does the SSH, SFTP and HTTP work the browser can't. It listens on
  `127.0.0.1` only (nothing else on your network can reach it), accepts only the app's own pages, needs the pairing
  token, and keeps nothing on disk except that token. It offers fixed operations — list apps, install, read a log —
  never a general "connect anywhere" tunnel.
- **Homebrew repository and Litefin releases** are fetched by the bridge, so the site itself talks to no one but your
  bridge. Downloads are checked against their published SHA-256 whenever one is published.

The bridge tells the site its version; when a newer one is out, the app says so. Update by running
`npx lg-dev-manager-bridge@latest` again.

## What it does

- **Devices** — network scan, add rooted or Developer Mode TVs (key fetched from the TV's key server, or a new key
  made for it), edit, test, export / import.
- **Apps** — installed apps with update badges; install IPK files (drag and drop); the webOS **Homebrew repository**
  with search, details, install and update; the **Litefin repo** with every webOS build of the latest releases.
- **Files** — browse, upload, download, preview, rename, delete over SFTP.
- **Terminal** — full shell in tabs, plus a simple mode for TVs without a terminal.
- **Device info** — model, webOS and firmware, Homebrew Channel status and update, screenshots, Dev Mode session
  countdown and renewal.
- **Debug** — live system log and kernel log, PmLog levels, crash reports, luna bus monitor (rooted TVs).
- **Console** — every command the bridge runs on the TV, live, with the option to type your own.

Light and dark themes, a command palette (⌘K / Ctrl K), and no analytics or tracking.

## Run the bridge from the source code

Prefer not to use npx? Run it from a clone — it's the same bridge, and it serves the local page too:

```bash
git clone https://github.com/Scoty/lg-dev-manager.git
cd lg-dev-manager
corepack enable      # once, to get pnpm
pnpm install
pnpm build
pnpm bridge          # same as: node apps/bridge/dist/cli.js
```

This needs Node.js 24 (see `.nvmrc`). To update: `git pull`, `pnpm install`, `pnpm build`, then `pnpm bridge`.

Bridge options (`npx lg-dev-manager-bridge --help`):

| Option | |
|---|---|
| `--port <n>` | Port to listen on (default 5199) |
| `--no-ui` | Don't serve the local page |
| `--allow-origin <url>` | Also accept another origin, e.g. a self-hosted copy of the web app |
| `--reset-token` | Make a new pairing token (un-pairs every browser) |

## Development

```bash
pnpm install
pnpm dev            # web app (Vite, http://localhost:5173) + bridge with --dev
pnpm test           # unit and integration tests (against a mock TV)
pnpm e2e            # Playwright: built app + real bridge + mock TVs + fake Homebrew repo
pnpm dev:rig        # the same rig to try by hand: http://127.0.0.1:5299, token e2e-token
pnpm lint && pnpm typecheck
```

`tools/mock-tv` fakes webOS TVs (SSH, luna-send, key server, logs) so everything can be tested without a TV.
Contributors, human or AI: read [AGENTS.md](AGENTS.md) and [PLAN.md](PLAN.md) first.

## License

[Apache-2.0](LICENSE). You may use, change and share the app and its code freely, including commercially, as long
as you keep the license and the [NOTICE](NOTICE) file that credits its authors — this project, the original
[dev-manager-desktop](https://github.com/webosbrew/dev-manager-desktop) by the webOS Homebrew team, and Adminator.

Not affiliated with LG Electronics. webOS and LG are trademarks of LG Electronics.
