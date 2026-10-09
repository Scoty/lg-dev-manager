import { parseArgs } from './config.js';
import { startServer } from './server.js';
import { BRIDGE_VERSION } from './version.js';

const HELP = `lg-dev-manager-bridge ${BRIDGE_VERSION}

Usage: lg-dev-manager-bridge [options]

  --port <n>            Port to listen on (default 5199, env LGDM_PORT)
  --host <addr>         Address to bind (default 127.0.0.1, env LGDM_HOST).
                        Use 0.0.0.0 only on a trusted network (e.g. a NAS).
  --allow-origin <url>  Extra web origin allowed to connect (repeatable, env LGDM_ALLOW_ORIGINS)
  --web-root <dir>      Serve the built web UI from this folder (env LGDM_WEB_ROOT)
  --reset-token         Generate a new pairing token (un-pairs existing browsers)
  --help                Show this help
`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help')) {
    process.stdout.write(HELP);
    return;
  }
  const config = parseArgs(argv);
  await startServer(config);

  const shown = config.host === '0.0.0.0' ? 'localhost' : config.host;
  console.log(`\n  LG Dev Manager bridge ${BRIDGE_VERSION}`);
  console.log(`  Listening on   http://${shown}:${config.port}`);
  if (config.webRoot) console.log(`  Web UI         http://${shown}:${config.port}/`);
  console.log(`  Pairing token  ${config.token}`);
  console.log(`  Allowed origins ${config.allowedOrigins.join(', ')}\n`);
  if (config.host !== '127.0.0.1' && config.host !== 'localhost' && config.host !== '::1') {
    console.warn('  ⚠  Bound to a non-loopback address. Anyone on this network with the token can control your TVs.\n');
  }
}

main().catch((e: Error) => {
  console.error(`[bridge] failed to start: ${e.message}`);
  process.exit(1);
});
