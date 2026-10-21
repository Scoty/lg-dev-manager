import { parseArgs } from './config.js';
import { startServer } from './server.js';
import { PUBLIC_WEB_ORIGIN } from '@lgdm/protocol';
import { BRIDGE_VERSION } from './version.js';
import { isStandalone, licenseText } from './standalone.js';
import { openInBrowser } from './open.js';
import { oneTimePairRedirect, pairLink } from './pairing.js';

const HELP = `lg-dev-manager-bridge ${BRIDGE_VERSION}

Usage: lg-dev-manager-bridge [options]

  --port <n>            Port to listen on (default 5199, env LGDM_PORT)
  --allow-origin <url>  Extra web origin allowed to connect (repeatable, env LGDM_ALLOW_ORIGINS)
  --web-root <dir>      Serve the web UI from this folder instead of the bundled one (env LGDM_WEB_ROOT)
  --no-ui               Don't serve the local page; use https://lg.scoty.uk only
  --listen <address>    LAN mode: listen on this address, e.g. 0.0.0.0, so other devices on your network can open
                        the bridge (env LGDM_LISTEN; needs --public-url). Default: this computer only
  --public-url <url>    LAN mode: the address you open the bridge at, e.g. http://nas.local:5199 (repeatable,
                        env LGDM_PUBLIC_URL, comma-separated). Requests for other addresses are refused
  --cf-access-team <t>  LAN mode behind a Cloudflare Tunnel: let in requests that passed Cloudflare Access for team <t>
  --cf-access-aud <tag> ... and this Access application (its audience tag); also LGDM_CF_ACCESS_TEAM / _AUD
  --cf-access-allow <e> ... for these emails / service-token client ids only (repeatable; LGDM_CF_ACCESS_ALLOW)
  --store               Keep the TVs (with their logins), custom repositories and screenshots in the bridge's
                        data folder, shared by every paired browser (env LGDM_STORE=1; on in the Docker image).
                        Browsers never get the logins back
  --reset-token         Generate a new pairing token (un-pairs existing browsers)
  --no-open             The app only: don't open ${PUBLIC_WEB_ORIGIN} in the browser on start (the local page still works)
  --version             Print the version
  --license             Print the licenses of this program and what it includes
  --help                Show this help
`;

// A bug in one connection's handling must not take the bridge (and every other tab's work) down.
process.on('uncaughtException', (e) => console.error(`[bridge] unexpected error: ${e instanceof Error ? e.message : String(e)}`));
process.on('unhandledRejection', (e) => console.error(`[bridge] unexpected error: ${e instanceof Error ? e.message : String(e)}`));

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help')) {
    process.stdout.write(HELP);
    return;
  }
  if (argv.includes('--version')) {
    process.stdout.write(`${BRIDGE_VERSION}\n`);
    return;
  }
  if (argv.includes('--license')) {
    process.stdout.write(licenseText());
    return;
  }
  const config = parseArgs(argv);
  const server = await startServer(config);
  // `docker stop` sends SIGTERM, and Node running as PID 1 in a container ignores it without a handler (the stop would
  // then wait ten seconds and kill it). Close and exit at once; there's nothing to save.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      server.close();
      process.exit(0);
    });
  }

  const local = `http://localhost:${config.port}`;
  console.log(`\n  LG Dev Manager bridge ${BRIDGE_VERSION}`);
  if (config.storeDir) console.log(`  Storage        TVs, logins, repositories and screenshots in ${config.storeDir} (readable by this user only)`);
  if (config.lan) {
    console.log(`  Listening on   ${config.host}:${config.port} — shared on your local network (LAN mode)`);
    console.log(`  Open           ${config.lan.publicUrls.join('  or  ')}`);
    console.log(`  Pairing token  ${config.token}`);
    console.log('  Pair a browser by opening (once per browser, keep these links to yourself):');
    for (const u of config.lan.publicUrls) console.log(`                 ${pairLink(u, config.token)}`);
    console.log(`  Allowed origins ${config.allowedOrigins.join(', ')}`);
    if (config.lan.cfAccess) {
      console.log(`  Cloudflare     Access team ${config.lan.cfAccess.teamDomain}, only for ${config.lan.cfAccess.allow.join(', ')}`);
      console.log('  Devices on your local network are let in, and requests through Cloudflare with a valid Access login.');
      console.log('  Cloudflare Access is the only login: keep its policy to your own accounts, with two-factor sign-in.');
    } else {
      console.log('  Only devices on your local network are let in. Never make the bridge reachable from the internet.');
    }
    if (config.lan.publicUrls.some((u) => u.startsWith('http:'))) {
      console.log('  Plain HTTP: TV keys and passwords you use travel unencrypted on your network. Put the bridge');
      console.log('  behind your own HTTPS reverse proxy if you don\'t trust everything on it.\n');
    } else console.log('');
  } else {
    console.log(`  Listening on   http://${config.host}:${config.port} (this computer only)`);
    // The local page first: it matches this bridge's version and works offline. lg.scoty.uk is the same app.
    console.log(`  Open           ${config.webRoot ? `${local}/  (the local page)  or  ${PUBLIC_WEB_ORIGIN}` : PUBLIC_WEB_ORIGIN}`);
    console.log(`  Pairing token  ${config.token}`);
    if (config.webRoot) console.log(`  Pair link      ${pairLink(local, config.token)}`);
    console.log(`  Allowed origins ${config.allowedOrigins.join(', ')}\n`);
  }

  // The standalone app is usually started with a double-click, so it opens the site itself — already paired — and
  // says how to stop.
  if (isStandalone()) {
    console.log('  Keep this window open while you use the app. Close it (or press Ctrl+C) to stop the bridge.\n');
    // Through a one-time redirect, so the token never appears in a command line (pairing.ts).
    const nonce = oneTimePairRedirect(pairLink(PUBLIC_WEB_ORIGIN, config.token, config.port));
    if (!argv.includes('--no-open')) openInBrowser(`http://localhost:${config.port}/pair/${nonce}`);
  }
}

main().catch((e: NodeJS.ErrnoException) => {
  console.error(
    e.code === 'EADDRINUSE'
      ? `[bridge] failed to start: port ${/:(\d+)$/.exec(e.message)?.[1] ?? ''} is already in use. Is the bridge already running in another window? Close that one, or start this one with --port <another port>.`
      : `[bridge] failed to start: ${e.message}`,
  );
  // A window opened by a double-click would vanish with the message; keep it until the user has read it.
  if (isStandalone() && process.stdin.isTTY) {
    console.error('\nPress Enter to close this window.');
    process.stdin.once('data', () => process.exit(1));
    return;
  }
  process.exit(1);
});
