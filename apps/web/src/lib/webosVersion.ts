/**
 * The name LG uses for a webOS version. Since 2022 TVs are sold as "webOS 22", "webOS 23"… while the system still
 * reports its internal version: 7.x is webOS 22, 8.x webOS 23, … 11.x webOS 26. Older versions (1–6) were sold under
 * their own numbers, so they are shown as they are.
 */
export function webosName(osVersion: string | undefined): string | undefined {
  if (!osVersion) return undefined;
  const major = Number(/^(\d+)\./.exec(osVersion)?.[1]);
  return major >= 7 ? `${major + 15} (${osVersion})` : osVersion;
}
