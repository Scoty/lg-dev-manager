import { startMockTv } from './index.js';

// Fixed ports so the UI can be pointed at it during development.
//   MOCK_ROOT=1        rooted TV: user root, password "alpine", Homebrew Channel installed
//   MOCK_HBCHANNEL=1   Dev Mode TV that also has Homebrew Channel
//   MOCK_NO_SFTP=1     no SFTP subsystem (bridge falls back to cat over exec)
const rooted = process.env.MOCK_ROOT === '1';
const tv = await startMockTv({
  username: rooted ? 'root' : 'prisoner',
  password: rooted ? (process.env.MOCK_PASSWORD ?? 'alpine') : undefined,
  hbchannel: rooted || process.env.MOCK_HBCHANNEL === '1',
  sftp: process.env.MOCK_NO_SFTP !== '1',
  host: process.env.MOCK_HOST ?? '127.0.0.1',
  sshPort: Number(process.env.MOCK_SSH_PORT ?? (rooted ? 2222 : 9922)),
  keyServerPort: Number(process.env.MOCK_KEY_PORT ?? (rooted ? 0 : 9991)),
  passphrase: process.env.MOCK_PASSPHRASE ?? 'A1B2C3',
});
console.log(`\n  Mock webOS TV (${rooted ? 'rooted' : 'Dev Mode'})`);
console.log(`  Host           ${tv.host}`);
console.log(`  SSH            port ${tv.sshPort}, user ${tv.username}${tv.password ? `, password ${tv.password}` : ''}`);
if (!rooted) {
  console.log(`  Key server     port ${tv.keyServerPort}`);
  console.log(`  Passphrase     ${tv.passphrase}`);
}
console.log(`  Apps           ${tv.state.apps.map((a) => a.id).join(', ')}\n`);
