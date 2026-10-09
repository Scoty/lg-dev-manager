# lg-dev-manager-bridge

The local bridge for **[LG Dev Manager](https://lg.scoty.uk)** — manage LG webOS TVs (rooted or in Developer
Mode) from your browser: install and update apps, the webOS Homebrew repository, files, a shell, logs and more.

Browsers can't speak SSH, so this small program does it for the web app, on your own computer.

```bash
npx lg-dev-manager-bridge@latest
```

Then open **https://lg.scoty.uk** (or the local copy at **http://localhost:5199**), go to **Bridge** and paste the
pairing token it printed. Needs Node.js 22 or newer.

## Safety

- Listens on `127.0.0.1` only; other devices on your network can't reach it.
- Accepts connections only from the app's own pages, and only with the pairing token (kept in
  `~/.lg-dev-manager/bridge.json`, readable only by you).
- Stores nothing else: your TVs' addresses, keys and passwords stay in your browser and are sent with each request.
- Offers fixed operations (list apps, install, read a log…), never a general network tunnel.

## Options

| Option | |
|---|---|
| `--port <n>` | Port to listen on (default 5199) |
| `--no-ui` | Don't serve the local page |
| `--web-root <dir>` | Serve the web app from another folder |
| `--allow-origin <url>` | Also accept another origin, e.g. a self-hosted copy of the web app |
| `--reset-token` | Make a new pairing token (un-pairs every browser) |
| `--version`, `--help` | |

Source, documentation and the from-source instructions: https://github.com/Scoty/lg-dev-manager

Apache-2.0 — see LICENSE and NOTICE (credits the original
[dev-manager-desktop](https://github.com/webosbrew/dev-manager-desktop) and Adminator).

Not affiliated with or endorsed by LG Electronics. LG and webOS are trademarks of LG Electronics.
