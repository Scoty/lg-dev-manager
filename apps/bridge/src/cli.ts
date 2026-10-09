import { parseArgs } from './config.js';
import { startServer } from './server.js';
import { BRIDGE_VERSION } from './version.js';

const HELP = `lg-dev-manager-bridge ${BRIDGE_VERSION}

Usage: lg-dev-manager-bridge [options]

  --port <n>            Port to listen on (default 5199, env LGDM_PORT)
  --allow-origin <url>  Extra web origin allowed to connect (repeatable, env LGDM_ALLOW_ORIGINS)
  --web-root <dir>      Serve the built web UI from this folder (env LGDM_WEB_ROOT)
  --reset-token         Generate a new pairing token (un-pairs existing browsers)
  --version             Print the version
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
  const config = parseArgs(argv);
  await startServer(config);

  const shown = config.host;
  console.log(`\n  LG Dev Manager bridge ${BRIDGE_VERSION}`);
  console.log(`  Listening on   http://${shown}:${config.port}`);
  if (config.webRoot) console.log(`  Web UI         http://${shown}:${config.port}/`);
  console.log(`  Pairing token  ${config.token}`);
  console.log(`  Allowed origins ${config.allowedOrigins.join(', ')}\n`);
}

main().catch((e: Error) => {
  console.error(`[bridge] failed to start: ${e.message}`);
  process.exit(1);
});
