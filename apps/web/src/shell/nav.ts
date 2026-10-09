import { REPO_URL } from '@lgdm/protocol';
import type { IconName } from './icons';

export interface NavChild {
  key: string;
  text: string;
  to: string;
}
export interface NavItem {
  key: string;
  text: string;
  icon: IconName;
  to?: string;
  href?: string;
  badge?: { kind: 'new' | 'hot' | 'pro'; text: string };
  children?: NavChild[];
}
export interface NavSection {
  label: string;
  items: NavItem[];
}

/** Single source of truth for the sidebar, breadcrumbs and command palette (mirrors Adminator's Shell.js NAV). */
export const NAV: NavSection[] = [
  {
    label: 'Device',
    items: [
      {
        key: 'apps',
        text: 'Apps',
        icon: 'apps',
        children: [
          { key: 'apps-installed', text: 'Installed', to: '/apps/installed' },
          { key: 'apps-homebrew', text: 'Homebrew repo', to: '/apps/homebrew' },
        ],
      },
      { key: 'files', text: 'Files', icon: 'files', to: '/files' },
      { key: 'terminal', text: 'Terminal', icon: 'terminal', to: '/terminal' },
      { key: 'info', text: 'Device info', icon: 'info', to: '/info' },
      {
        key: 'debug',
        text: 'Debug',
        icon: 'debug',
        children: [
          { key: 'debug-logs', text: 'System log', to: '/debug/logs' },
          { key: 'debug-pmlog', text: 'Log levels', to: '/debug/pmlog' },
          { key: 'debug-dmesg', text: 'Kernel log', to: '/debug/dmesg' },
          { key: 'debug-crashes', text: 'Crash reports', to: '/debug/crashes' },
          { key: 'debug-luna', text: 'Luna monitor', to: '/debug/luna' },
        ],
      },
    ],
  },
  {
    label: 'Setup',
    items: [
      { key: 'devices', text: 'Devices', icon: 'tv', to: '/devices' },
      { key: 'bridge', text: 'Bridge', icon: 'plug', to: '/bridge' },
    ],
  },
  {
    label: 'Links',
    items: [
      { key: 'homebrew-site', text: 'webOS Homebrew', icon: 'store', href: 'https://www.webosbrew.org/' },
      { key: 'source', text: 'Source code', icon: 'github', href: REPO_URL },
    ],
  },
];

/** Resolves breadcrumbs ("Device › Apps › Installed") for a route path. */
export function crumbsFor(pathname: string): string[] {
  if (pathname.startsWith('/devices/new')) return ['Setup', 'Devices', 'Add a TV'];
  for (const section of NAV) {
    for (const item of section.items) {
      if (item.to && pathname.startsWith(item.to)) return [section.label, item.text];
      for (const child of item.children ?? []) {
        if (pathname.startsWith(child.to)) return [section.label, item.text, child.text];
      }
    }
  }
  return ['LG Dev Manager'];
}
