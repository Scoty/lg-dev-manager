import { startMockTv } from './index.js';

// Fixed ports so the UI can be pointed at it during development.
const tv = await startMockTv({
  sshPort: Number(process.env.MOCK_SSH_PORT ?? 9922),
  keyServerPort: Number(process.env.MOCK_KEY_PORT ?? 9991),
  passphrase: process.env.MOCK_PASSPHRASE ?? 'A1B2C3',
});
console.log(`\n  Mock webOS TV (Dev Mode)`);
console.log(`  Host           ${tv.host}`);
console.log(`  SSH            port ${tv.sshPort}, user ${tv.username}`);
console.log(`  Key server     port ${tv.keyServerPort}`);
console.log(`  Passphrase     ${tv.passphrase}\n`);
