# Security policy

LG Dev Manager runs a bridge on your computer or home server that can log in to your TVs, so security problems
matter. Thanks for reporting them responsibly.

## Reporting a problem

Report it privately through GitHub: **[Report a vulnerability](https://github.com/Scoty/lg-dev-manager/security/advisories/new)**.
Please don't open a public issue, discussion or pull request for it.

Useful to include: the version (web app and bridge — bottom right of every page), how you run the bridge (the app,
npx, Docker or the source code), your operating system and browser, and the steps to reproduce. Never include your
real pairing token or pairing link, TV passwords or keys.

You'll get an answer within a few days. Please allow up to 90 days for a fix before publishing details; problems that
put users at risk right now are fixed and disclosed sooner.

## What's in scope

- The bridge (`lg-dev-manager-bridge` on npm, the app from the GitHub releases and the Docker image
  `ghcr.io/scoty/lg-dev-manager`): anything that lets another website, program or computer use it — getting past the pairing token, the origin check or the `127.0.0.1`-only
  listener, reaching hosts other than your TVs, reading files on your computer, or crashing it remotely. In LAN mode
  (the bridge shared on your network, e.g. in Docker): getting in from outside your local network, or around the
  host, origin and rate-limit checks. Someone on your own network reading plain-HTTP traffic is a known limit (use an
  HTTPS reverse proxy). With Cloudflare Access mode (`LGDM_CF_ACCESS_*`): getting in through Cloudflare without a
  valid Access token for an allowed person, or connecting from another page than the Cloudflare hostname's. Known
  limits there: the bridge has no login of its own, so Access (and the pairing token) is all that protects it;
  Cloudflare sees the decrypted traffic; a stolen Access session works until it expires; whoever controls the Cloudflare
  account can add a sign-in method; WARP private-network routing counts as the local network. With bridge storage (`--store`, on in Docker): getting a stored TV login back out of the bridge
  (including having it send a stored password to another SSH server), or reading its data folder without access to
  the server. Known limits: a paired browser is fully trusted — it can run any command on your TVs, and on a rooted TV
  it could replace the TV's own SSH server with one that records the password, so prefer key logins; the data folder
  is protected by file permissions only (on Windows, by your profile folder's permissions).
- The web app (the local page, https://lg.scoty.uk and the page a shared bridge serves): script injection, leaking
  your saved TVs, keys or passwords to anyone but your own bridge, or tricking you into actions on a TV.
- The release and publishing workflows.

## Not in scope

- Rooting, Homebrew Channel and apps from the Homebrew repository: report those to the
  [webOS Homebrew project](https://www.webosbrew.org/).
- Anything that needs someone who already controls your computer or your TV.
- The app not being signed by Apple or Microsoft: that is known (see the README).

## Supported versions

Only the latest release gets fixes. The site always runs it; update the bridge when the app says a new one is out.
