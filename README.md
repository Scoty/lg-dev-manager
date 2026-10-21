# LG Dev Manager

Manage LG webOS TVs from your browser — rooted (Homebrew Channel) or in Developer Mode. Install apps from the
webOS Homebrew repository or from an IPK file, update them, install any build of [Litefin](#litefin-in-one-click)
in one click, browse the TV's files, open a shell, take screenshots, renew the Dev Mode session and dig into logs and
the luna bus.

**Open it:** run the bridge — on your computer (one download or one command), or once on a NAS or home server with
Docker for every computer, phone and tablet on your network — then open the page it serves: http://localhost:5199 on
your computer, or the server's address. With the bridge on your computer, https://lg.scoty.uk works too; it's the same
app either way.

A web rebuild of [webosbrew/dev-manager-desktop](https://github.com/webosbrew/dev-manager-desktop), styled after
[Adminator](https://github.com/puikinsh/adminator-admin-dashboard).

> **Note:** LG Dev Manager is an independent, community project. It is not affiliated with, endorsed by or supported
> by LG Electronics. LG and webOS are trademarks of LG Electronics. Rooting a TV or using Developer Mode is at your own
> risk.

### Add a TV, install an app and update it

![Adding the Living Room TV with the wizard, installing Moonfin 2.8.2 from an IPK file and updating it to 2.9.0 from the Homebrew repository](docs/demo-basic.webp)

### Debug tools on a rooted TV

![Switching to the Bedroom TV and going through the system log, log levels, kernel log, crash reports and the luna monitor](docs/demo-advanced.webp)

## Get started

The app needs a small helper, **the bridge** (why: [How it works](#how-it-works)). It's the same bridge every time, so
pick whichever way suits you:

| | Runs on | Needs | How |
|---|---|---|---|
| **The app** | your computer | nothing | Download it from the [latest release](https://github.com/Scoty/lg-dev-manager/releases/latest) and open it |
| **npx** | your computer | Node.js 22.12+ | `npx lg-dev-manager-bridge@latest` in a terminal |
| **Docker** | a NAS or home server, for your whole network (phones and tablets too) | Docker (Linux) | [`docker compose up -d`](#docker) |
| **From the source code** | your computer | Node.js 22.12+ | [Clone, build and run](#run-from-source) |

### Option 1: the app — no Node.js needed

One file with everything inside. Download the one for your computer from the
[latest release](https://github.com/Scoty/lg-dev-manager/releases/latest):

| Computer | File |
|---|---|
| Windows | `lg-dev-manager-bridge-<version>-windows-x64.exe` — just run it (also works on Windows on ARM) |
| Mac with Apple Silicon (M1 and newer) | `…-macos-arm64.dmg` — open it, then double-click `lg-dev-manager-bridge` |
| Mac with Intel | `…-macos-x64.dmg` |
| Linux (x64 / ARM64) | `…-linux-x64.tar.gz` / `…-linux-arm64.tar.gz` — `tar -xzf …`, then `./lg-dev-manager-bridge` |

A window opens with the **pairing token** and the app's addresses, and the app opens https://lg.scoty.uk in your
browser, ready to pair with one click. Keep the window open while you use the app; closing it stops the bridge.

> **The first time:** the app isn't signed by Apple or Microsoft (that costs a yearly fee), so your computer asks
> before running it. **Windows**: "Windows protected your PC" → **More info** → **Run anyway**. **macOS**: "Apple
> could not verify…" → **Done**, then **System Settings → Privacy & Security** → **Open Anyway**. You only do this
> once. It's the same code as the npm package, built and tested by GitHub Actions in public. Each release lists
> SHA-256 checksums.

### Option 2: npx

**You need [Node.js](https://nodejs.org) 22.12 or newer** (any current LTS — 22 or 24). `node --version` shows
yours. In a terminal:

```bash
npx lg-dev-manager-bridge@latest
```

It prints a **pairing token**, a pairing link and both addresses of the app. Keep the terminal open while you use the
app (Ctrl+C stops it).

### Then, with the app or npx

1. Open the local page the bridge serves, **http://localhost:5199** — or **https://lg.scoty.uk**, the same app. On the
   **Bridge** page, paste the token (or open the pairing link the bridge printed).
2. On **Devices → Add a TV**, pick your TV from the scan. Rooted TVs log in as root (Homebrew Channel's SSH server);
   other TVs use the Developer Mode app and its passphrase.

On macOS, the first time the bridge looks for your TV, the system asks whether your terminal may find devices on the
local network — choose **Allow**. Phones and tablets can't run the bridge; to use the app on them, run the bridge on a
NAS or home server ([Docker](#docker)) and open the page it serves.

Which page to use is up to you:

1. **http://localhost:5199**, the local page, is served from your computer by the bridge itself. It always matches
   your bridge's version, and it works offline and even when the website can't be reached.
2. **https://lg.scoty.uk** always has the latest version of the app and needs nothing installed besides the bridge.

Each keeps its own list of TVs (browsers store them per site); use **Export backup** / **Import backup** on the Devices
page to move them, or start the bridge with [`--store`](#run-from-source) to keep them on the bridge for every page.

<a id="docker"></a>

## Run it on a NAS or home server (Docker)

Run the bridge once on a NAS or home server and use LG Dev Manager from every computer, phone and tablet on your
network — nothing to install anywhere else. The Docker image (`ghcr.io/scoty/lg-dev-manager`, Linux on amd64 or arm64)
serves the app itself, at the address you give it, and keeps your TVs for everyone:

- **One list of TVs for every browser.** The container stores your TVs — with their logins — the custom repositories
  and the screenshots in `/data`, so every browser and phone you pair sees the same ones, and changes show up
  everywhere at once. A TV's password or key goes to the bridge once and is never sent back to any browser, and the
  bridge only sends it to that TV (it checks the TV's SSH host key first). TVs you saved in a browser before can be
  moved there from the Devices page.
- **Paired with a link.** The container's log shows a pairing link for each address; open it in each browser that
  should use it and click **Pair**.
- **Phones and tablets** get pages that fit their screen and a terminal with the keys a phone keyboard lacks.

### Any Linux server

Save [`compose.yaml`](compose.yaml) on the server, set `LGDM_PUBLIC_URL` in it to the address (or addresses,
comma-separated) you'll open it at, then:

```bash
docker compose up -d
docker compose logs lg-dev-manager    # shows the pairing links
```

To update: `docker compose pull && docker compose up -d`. Your pairing and TVs stay as they are.

### Example: a Ugreen NAS

On a Ugreen NAS (UGOS Pro, e.g. the DXP2800), with the address you open it at being either the NAS's name or its IP:

1. In the **Files** app, create the folder `lg-dev-manager` in the `docker` shared folder (`/volume1/docker/lg-dev-manager`).
2. In the **Docker** app, open **Project → Create** (or create a stack in Dockhand or Portainer) and paste
   [`examples/ugreen-nas/compose.yaml`](examples/ugreen-nas/compose.yaml):

   ```yaml
   services:
     lg-dev-manager:
       image: ghcr.io/scoty/lg-dev-manager:2
       container_name: lg-dev-manager
       network_mode: host
       environment:
         # The addresses you open it at, separated by commas: the NAS's name and its IP address.
         LGDM_PUBLIC_URL: http://nasname.local:5199,http://192.0.2.10:5199
       volumes:
         - /volume1/docker/lg-dev-manager:/data
       restart: unless-stopped
       read_only: true
       cap_drop: [ALL]
       security_opt: [no-new-privileges:true]
   ```

3. Replace `nasname.local` and `192.0.2.10` with your NAS's name and IP address (your router's list of devices shows
   both; a fixed IP for the NAS helps).
4. Start it and open its log: it shows a pairing link for each address, e.g.
   `http://nasname.local:5199/#/pair?token=…`. Open one in each browser that should use the app.

If the log says the bridge can't write to `/data`, the folder isn't writable by the container's user (1000): over SSH,
`sudo chown 1000:1000 /volume1/docker/lg-dev-manager`, or set `user:` to your own ids (the example file explains). To
update, pull the image again and recreate the project (in Dockhand or Portainer: pull and redeploy the stack).

### Keep it on your network

> ⚠️ **Never make it reachable from the internet.** It controls your TVs: don't forward its port on your router, and
> don't put a Cloudflare Tunnel, a reverse proxy with a public hostname or any other tunnel or relay in front of it — if
> your server runs cloudflared or Nginx Proxy Manager for other apps, leave this one out. It only answers devices on your
> local network, and it uses plain HTTP — for encryption, put it behind your own HTTPS reverse proxy on your network and
> use the proxy's `https://` address as `LGDM_PUBLIC_URL`.

It uses host networking (`network_mode: host`), so the TV scan sees your network and the bridge sees who connects.
https://lg.scoty.uk can't use a bridge on another machine (browsers don't let an https page connect to it), so use the
page the container serves. Settings, all optional except the first:

| Variable | |
|---|---|
| `LGDM_PUBLIC_URL` | The addresses you open it at, comma-separated, e.g. `http://nasname.local:5199,http://192.0.2.10:5199`. Requests for any other address are refused |
| `LGDM_PORT` | Another port than 5199 |
| `LGDM_STORE` | `0` keeps the TVs in each browser instead of on the server |
| `LGDM_ALLOWED_NETWORKS` | Also let in devices on networks that aren't a private range, e.g. global IPv6 from another subnet: `2001:db8::/56` |
| `LGDM_TOKEN` | Your own pairing token (16+ characters); otherwise a random one is made and kept in `/data` |

The same works without Docker on any computer that stays on:
`npx lg-dev-manager-bridge@latest --listen 0.0.0.0 --public-url http://nasname.local:5199 --store`.

<a id="how-it-works"></a>

## How it works

Browsers can't open SSH connections, so the app comes in two parts:

```
 Browser                                         Your computer or a server         Your TV
 ┌──────────────────────────────────┐ WebSocket ┌────────────────────┐ SSH / SFTP ┌──────────────┐
 │ Web app: localhost:5199,         │ ────────▶ │ Bridge             │ ─────────▶ │ webOS        │
 │ lg.scoty.uk or a server          │  + token  │ (app, npx, Docker) │            │ (port 22 or  │
 └──────────────────────────────────┘           └────────────────────┘            │  9922)       │
                                                                                  └──────────────┘
```

- **The web app** is a static site, served by the bridge as the local page and at lg.scoty.uk. Saved TVs — names,
  addresses, keys and passwords — live in your browser's storage. They are never sent to the website; each request
  sends them to your own bridge, and only to it. (A bridge started with `--store`, like the Docker image, keeps them
  instead, for every browser paired with it, and never sends the logins back. It remembers each stored TV's SSH host
  key and sends a stored login only to the TV that has it.)
- **The bridge** is a small Node.js program that does the SSH, SFTP and HTTP work the browser can't. On your computer
  it listens on `127.0.0.1` only (nothing else on your network can reach it); in Docker (LAN mode) it answers only
  devices on your local network, at the addresses you set. Either way it accepts only the app's own pages and needs the
  pairing token. It keeps nothing on disk but that token — and, with `--store`, your TVs, repositories and screenshots.
  It offers fixed operations — list apps, install, read a log — never a general "connect anywhere" tunnel.
- **Homebrew repository and Litefin releases** are fetched by the bridge, so the site itself talks to no one but your
  bridge. Downloads are checked against their published SHA-256 whenever one is published.

The bridge tells the site its version; when a newer one is out, the app says so and how to update: download the
new app from the [releases](https://github.com/Scoty/lg-dev-manager/releases/latest), run
`npx lg-dev-manager-bridge@latest` again, or pull the new Docker image. Your pairing and TVs stay as they are.

## What it does

- **Devices** — network scan, add rooted or Developer Mode TVs (key fetched from the TV's key server, or a new key
  made for it), edit, test, export / import.
- **Apps** — installed apps with update badges; install IPK files (drag and drop); the webOS **Homebrew repository**
  with search, details, install and update; the **Litefin repo** with every webOS build of the latest releases
  (see [below](#litefin-in-one-click)); and **custom repositories** you add yourself (see [below](#custom-repositories)).
- **Files** — browse, upload, download, preview, rename, delete over SFTP.
- **Terminal** — full shell in tabs, plus a simple mode for TVs without a terminal.
- **Device info** — model, webOS and firmware, Homebrew Channel status and update, screenshots, Dev Mode session
  countdown and renewal.
- **Debug** — live system log and kernel log, PmLog levels, crash reports, luna bus monitor (rooted TVs).
- **Console** — every command the bridge runs on the TV, live, with the option to type your own.

Light and dark themes, a command palette (⌘K / Ctrl K), and no analytics or tracking.

<a id="custom-repositories"></a>

## Custom repositories

Besides the official webOS Homebrew repository you can add others under **Setup → Custom repos** — the same addresses
Homebrew Channel's "Add repository" takes: usually a `.json` file such as `apps.json` or `repo.json` (for example the
official non-free one, `https://repo.webosbrew.org/api/non-free/apps.json`), but also a GitHub link to that file, a
short link, a pastebin "raw" page or just the site the repository is on. The bridge checks that the address really is a
repository before it's added (and asks first if a short link leads to another site); each one then gets its own page
under **Apps**, with search, details and install.

> ⚠️ **Unofficial repositories can contain untested apps or malware.** Nobody reviews them — not LG, not the webOS
> Homebrew team — and on a rooted TV an app can do anything. Only add repositories from people you trust.

Custom repositories are kept like your TVs: in your browser (and in **Export backup** — importing a backup asks before
adding the repositories in it), or on the bridge for every paired browser when it stores them (`--store`, Docker). For
safety:

- the bridge fetches everything a custom repository points to — its list, manifests, icons, IPKs and every redirect —
  over **https** from the public internet only, never from your computer or local network;
- every install from a custom repository asks first, and says when it would replace an app with the same id (from the
  official repository or already on the TV); the bridge downloads the IPK itself (checking its SHA-256 when the
  repository gives one) instead of letting the TV fetch it, and refuses an IPK that holds anything but the app the
  repository lists;
- Homebrew Channel itself can only be installed or updated from the official repository;
- descriptions are shown as plain formatting only — repositories can't run scripts in the page.

<a id="litefin-in-one-click"></a>

## Litefin in one click

This app started with one itch. [Litefin](https://github.com/MoazSalem/litefin), a lightweight Jellyfin client for
LG TVs, publishes a separate IPK for each generation of webOS (Modern, Normal, Legacy, Ultra Legacy) on every
release, and the Homebrew repository carries only one of them. Updating used to mean opening the GitHub releases,
downloading the right IPK by hand and installing it through the desktop webOS Dev Manager.

**Apps → Litefin repo** does all of that in one click:

- It lists the last five Litefin releases with every webOS build side by side, read straight from GitHub by the
  bridge (pre-releases are skipped).
- It suggests the right build for the active TV from its webOS version, and shows which version is installed and
  whether a newer one is out.
- **Install** downloads that build, checks it against GitHub's SHA-256 when one is published, and installs it on the TV
  — through Homebrew Channel on a rooted TV, or the Developer Mode installer otherwise. All builds are the same app,
  so switching builds or versions simply replaces it.

<a id="run-from-source"></a>

## Run the bridge from the source code

Or run it from a clone. It's the same bridge, and it serves the local page (http://localhost:5199) too:

```bash
git clone https://github.com/Scoty/lg-dev-manager.git
cd lg-dev-manager
corepack enable      # once, to get pnpm
pnpm install
pnpm build
pnpm bridge          # same as: node apps/bridge/dist/cli.js
```

This needs Node.js 22.12 or newer, the same as npx (the project itself is developed on Node 24, see `.nvmrc`).
To update: `git pull`, `pnpm install`, `pnpm build`, then `pnpm bridge`.

Bridge options (`--help`; with the app, run it from a terminal: `lg-dev-manager-bridge --help`):

| Option | |
|---|---|
| `--port <n>` | Port to listen on (default 5199) |
| `--listen <address>` | Share it on your network, e.g. `0.0.0.0` (needs `--public-url`; [see Docker](#docker)) |
| `--public-url <url>` | The address you open a shared bridge at, e.g. `http://nasname.local:5199` (repeat it for more) |
| `--store` | Keep the TVs (with their logins), custom repositories and screenshots on the bridge, shared by every paired browser (on in Docker) |
| `--no-ui` | Don't serve the local page |
| `--allow-origin <url>` | Also accept another origin, e.g. a self-hosted copy of the web app |
| `--reset-token` | Make a new pairing token (un-pairs every browser) |
| `--no-open` | The app only: don't open lg.scoty.uk in the browser when it starts (the local page still works) |
| `--license` | Show the licenses of the bridge and everything it includes |

## Development

```bash
pnpm install
pnpm dev            # web app (Vite, http://localhost:5173) + bridge with --dev
pnpm test           # unit and integration tests (against a mock TV)
pnpm e2e            # Playwright: built app + real bridge + mock TVs + fake Homebrew repo
pnpm dev:rig        # the same rig to try by hand: http://127.0.0.1:5299, token e2e-token
pnpm lint && pnpm typecheck
pnpm app            # the standalone app for this computer → apps/bridge/release (after pnpm build)
```

`tools/mock-tv` fakes webOS TVs (SSH, luna-send, key server, logs) so everything can be tested without a TV.
Contributors, human or AI: read [AGENTS.md](AGENTS.md) and [PLAN.md](PLAN.md) first.

## Problems and ideas

[Open an issue](https://github.com/Scoty/lg-dev-manager/issues/new/choose): there are forms for bugs, connection
problems and feature requests that ask for what helps track a problem down. Security problems: please report them
privately (see the [security policy](https://github.com/Scoty/lg-dev-manager/security/policy)).

## License

[Apache-2.0](LICENSE). You may use, change and share the app and its code freely, including commercially, as long
as you keep the license and the [NOTICE](NOTICE) file that credits its authors — this project, the original
[dev-manager-desktop](https://github.com/webosbrew/dev-manager-desktop) by the webOS Homebrew team, and Adminator.

Not affiliated with or endorsed by LG Electronics. LG and webOS are trademarks of LG Electronics.
