import type { NormalizedSchema } from '../types';

/**
 * Foreign-key graph expansion: from seed tables, return every table reachable
 * within `maxHops` over the undirected FK relationship graph. Supplies join
 * evidence to retrieval so the planner only proposes joins with real FK backing.
 */
export function expandViaFkGraph(schema: NormalizedSchema, seedTables: string[], maxHops: number): string[] {
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    const k = a.toLowerCase();
    if (!adj.has(k)) adj.set(k, new Set());
    adj.get(k)!.add(b.toLowerCase());
  };
  for (const r of schema.relationships) {
    link(r.from.table, r.to.table);
    link(r.to.table, r.from.table);
  }

  const visited = new Set<string>();
  let frontier = seedTables.map((t) => t.toLowerCase());
  let hops = 0;
  while (frontier.length > 0 && hops < maxHops) {
    const next: string[] = [];
    for (const t of frontier) {
      if (visited.has(t)) continue;
      visited.add(t);
      for (const n of adj.get(t) ?? []) if (!visited.has(n)) next.push(n);
    }
    frontier = next;
    hops += 1;
  }
  return [...visited];
}
