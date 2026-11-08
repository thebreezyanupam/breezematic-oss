import path from 'node:path';
import { ROOT } from '../config.js';
import { cache } from '../cache.js';
import { out } from '../log.js';
import { table } from '../report.js';
import { formatBytes } from '../text.js';

export async function cacheStatsCommand(): Promise<number> {
  const stats = cache.stats();
  out(`cache root  ${path.relative(ROOT, cache.root) || '.'}`);
  if (stats.length === 0) {
    out('cache is empty');
    return 0;
  }
  out('');
  out(
    table(
      ['namespace', 'entries', 'size'],
      stats.map((entry) => [entry.namespace, String(entry.entries), formatBytes(entry.bytes)]),
    ),
  );
  const totalEntries = stats.reduce((sum, entry) => sum + entry.entries, 0);
  const totalBytes = stats.reduce((sum, entry) => sum + entry.bytes, 0);
  out('');
  out(`total       ${totalEntries} entries, ${formatBytes(totalBytes)}`);
  return 0;
}

export async function cacheClearCommand(namespace?: string): Promise<number> {
  const removed = cache.clear(namespace);
  out(`removed ${removed} file(s) from ${namespace ?? 'all namespaces'}`);
  return 0;
}
