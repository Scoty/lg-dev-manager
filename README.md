# LG Dev Manager (web)

Manage LG webOS TVs in **Developer Mode** or **rooted** from your browser — install apps, browse the
webOS Homebrew repository, manage files, open a shell, read logs and renew the Dev Mode session.

A web rebuild of [webosbrew/dev-manager-desktop](https://github.com/webosbrew/dev-manager-desktop),
styled after [Adminator](https://github.com/puikinsh/adminator-admin-dashboard).

**Use it:** https://lg.scoty.uk (public preview — see [PLAN.md](PLAN.md) for what's done and what's next).

## How it works

Browsers can't open SSH connections, so the app has two parts:

- **Web UI** — static site at lg.scoty.uk (or served by the bridge). Your saved TVs, keys and passwords are
  stored **only in your browser**; they're sent only to your own bridge when it connects to a TV.
- **Bridge** — a tiny local service that talks SSH/SFTP to the TV on the UI's behalf. It listens on
  `127.0.0.1:5199` by default, only accepts the UI's origin, requires a pairing token, and never stores device
  details.

## Development

Requires Node 22+ and pnpm.

```bash
pnpm install
pnpm dev:bridge   # prints a pairing token
pnpm dev:web      # http://localhost:5173 → Bridge page → paste the token
pnpm --filter @lgdm/mock-tv start   # optional: a fake Dev Mode TV on 127.0.0.1
pnpm test
```

Try the UI without a TV — mock Dev Mode and rooted TVs plus a bridge serving the built UI:

```bash
pnpm dev:rig      # open http://127.0.0.1:5299, pair with token e2e-token
                  # Dev Mode TV: 127.0.0.1, passphrase A1B2C3 · rooted TV: manual setup, port 2222, root / alpine
pnpm e2e          # the same rig, driven by Playwright
```

Serve the built UI from the bridge (offline use, or browsers that block `ws://localhost` from https):

```bash
pnpm build
node apps/bridge/dist/cli.js --web-root apps/web/dist   # open http://localhost:5199
```

Contributors (human or AI): read [AGENTS.md](AGENTS.md) first.

## Credits

See [NOTICE](NOTICE).
