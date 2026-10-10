# Security policy

LG Dev Manager runs a bridge on your computer that can log in to your TVs, so security problems matter. Thanks for
reporting them responsibly.

## Reporting a problem

Report it privately through GitHub: **[Report a vulnerability](https://github.com/Scoty/lg-dev-manager/security/advisories/new)**.
Please don't open a public issue, discussion or pull request for it.

Useful to include: the version (web app and bridge — bottom right of every page), how you run the bridge (the app,
npx or the source code), your operating system and browser, and the steps to reproduce. Never include your real pairing
token, TV passwords or keys.

You'll get an answer within a few days. Please allow up to 90 days for a fix before publishing details; problems that
put users at risk right now are fixed and disclosed sooner.

## What's in scope

- The bridge (`lg-dev-manager-bridge` on npm and the app from the GitHub releases): anything that lets another
  website, program or computer use it — getting past the pairing token, the origin check or the `127.0.0.1`-only
  listener, reaching hosts other than your TVs, reading files on your computer, or crashing it remotely.
- The web app (https://lg.scoty.uk and the local page): script injection, leaking your saved TVs, keys or passwords to
  anyone but your own bridge, or tricking you into actions on a TV.
- The release and publishing workflows.

## Not in scope

- Rooting, Homebrew Channel and apps from the Homebrew repository: report those to the
  [webOS Homebrew project](https://www.webosbrew.org/).
- Anything that needs someone who already controls your computer or your TV.
- The app not being signed by Apple or Microsoft: that is known (see the README).

## Supported versions

Only the latest release gets fixes. The site always runs it; update the bridge when the app says a new one is out.
