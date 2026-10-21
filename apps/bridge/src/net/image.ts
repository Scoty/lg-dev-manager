/** Image type from the bytes themselves (servers like raw.githubusercontent.com send text/plain). */
export function sniffImage(data: Buffer): string | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  // SVG: an optional XML declaration, comments and doctype, then <svg. Skipped with indexOf, not one regex — a
  // backtracking pattern over `<!---->…` from a hostile icon took exponential time and froze the bridge.
  let head = data.subarray(0, 1024).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  const skipPast = (end: string) => {
    const at = head.indexOf(end);
    if (at < 0) return false;
    head = head.slice(at + end.length).trimStart();
    return true;
  };
  if (head.startsWith('<?xml') && !skipPast('>')) return null;
  while (head.startsWith('<!--')) if (!skipPast('-->')) return null;
  if (/^<!DOCTYPE svg/i.test(head) && !skipPast('>')) return null;
  return /^<svg[\s>]/i.test(head) ? 'image/svg+xml' : null;
}
