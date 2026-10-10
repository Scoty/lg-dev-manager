import { parseArgs } from './config.js';
import { startServer } from './server.js';
import { PUBLIC_WEB_ORIGIN } from '@lgdm/protocol';
import { BRIDGE_VERSION } from './version.js';
import { isStandalone, licenseText } from './standalone.js';
import { openInBrowser } from './open.js';

const HELP = `lg-dev-manager-bridge ${BRIDGE_VERSION}

Usage: lg-dev-manager-bridge [options]

  --port <n>            Port to listen on (default 5199, env LGDM_PORT)
  --allow-origin <url>  Extra web origin allowed to connect (repeatable, env LGDM_ALLOW_ORIGINS)
  --web-root <dir>      Serve the web UI from this folder instead of the bundled one (env LGDM_WEB_ROOT)
  --no-ui               Don't serve the local page; use https://lg.scoty.uk only
  --reset-token         Generate a new pairing token (un-pairs existing browsers)
  --no-open             The app only: don't open ${PUBLIC_WEB_ORIGIN} in the browser on start
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
  await startServer(config);

  const shown = config.host;
  console.log(`\n  LG Dev Manager bridge ${BRIDGE_VERSION}`);
  console.log(`  Listening on   http://${shown}:${config.port} (this computer only)`);
  console.log(`  Open           ${PUBLIC_WEB_ORIGIN}${config.webRoot ? `  or the local page http://localhost:${config.port}/` : ''}`);
  console.log(`  Pairing token  ${config.token}`);
  console.log(`  Allowed origins ${config.allowedOrigins.join(', ')}\n`);

  // The standalone app is usually started with a double-click, so it opens the site itself and says how to stop.
  if (isStandalone()) {
    console.log('  Keep this window open while you use the app. Close it (or press Ctrl+C) to stop the bridge.\n');
    if (!argv.includes('--no-open')) openInBrowser(PUBLIC_WEB_ORIGIN);
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
