import { promises as fs } from 'fs';
import { buildOfflineEngine } from '../src/runtime/offlineEngine';
import { loadNormalizedSchema } from '../src/schema/loader';
import { requireTimeFilterIfEventLike } from '../src/validate/rules/requireTimeFilter';
import type { QueryPlan } from '../src/types';
import { EXAMPLES, GOLDEN_PATH, NOTES, SCHEMA_DIR } from './_shared';

interface GoldenCase {
  id: string;
  question: string;
  expects: 'sql' | 'ask' | 'reject';
  strict?: boolean;
  requires_time_filter?: boolean;
  must_use_tables?: string[];
  must_not_use_tables?: string[];
  must_include?: string[];
  must_not_include?: string[];
}

function extractTables(sql: string): string[] {
  const noStrings = sql.replace(/'(?:[^']|'')*'/g, "''");
  const out: string[] = [];
  const re = /\b(?:from|join)\s+([A-Za-z0-9_.]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(noStrings))) out.push(m[1].split('.').pop()!.toLowerCase());
  return [...new Set(out)];
}

function compileRegex(pattern: string): RegExp {
  if (pattern.startsWith('(?i)')) return new RegExp(pattern.slice(4), 'i');
  return new RegExp(pattern);
}

function assertRegexList(sql: string, patterns: string[], shouldMatch: boolean, id: string): void {
  for (const p of patterns) {
    const matched = compileRegex(p).test(sql);
    if (matched !== shouldMatch) {
      throw new Error(`${id}: pattern ${JSON.stringify(p)} ${shouldMatch ? 'should match' : 'should NOT match'}`);
    }
  }
}

async function main(): Promise<void> {
  const { engine } = await buildOfflineEngine({ schemaDir: SCHEMA_DIR, examples: EXAMPLES, notes: NOTES });
  const schema = await loadNormalizedSchema(SCHEMA_DIR);
  const cases: GoldenCase[] = JSON.parse(await fs.readFile(GOLDEN_PATH, 'utf8'));

  let passed = 0;
  const failures: string[] = [];

  for (const c of cases) {
    try {
      const resp = await engine.run({ question: c.question, strict: c.strict ?? true });
      const kind: 'sql' | 'ask' | 'reject' = resp.sql ? 'sql' : resp.clarification ? 'ask' : 'reject';
      if (kind !== c.expects) {
        throw new Error(`expected "${c.expects}", got "${kind}"${resp.error ? ` (${resp.error})` : ''}`);
      }

      if (kind === 'sql') {
        const sql = resp.sql!;
        assertRegexList(sql, c.must_include || [], true, c.id);
        assertRegexList(sql, c.must_not_include || [], false, c.id);

        const tables = extractTables(sql);
        for (const t of c.must_use_tables || []) {
          if (!tables.includes(t.toLowerCase())) throw new Error(`${c.id}: expected to use table "${t}" (used: ${tables.join(', ') || 'none'})`);
        }
        for (const t of c.must_not_use_tables || []) {
          if (tables.includes(t.toLowerCase())) throw new Error(`${c.id}: must NOT use table "${t}"`);
        }

        if (c.requires_time_filter) {
          const stubPlan: QueryPlan = {
            intent: '',
            entities: [],
            metrics: [],
            dimensions: [],
            timeWindow: null,
            grain: null,
            filters: [],
            tables,
            joins: [],
            dialect: 'mysql',
            riskFlags: [],
          };
          requireTimeFilterIfEventLike({ schema, plan: stubPlan, sql }); // throws if missing
        }
      }

      passed += 1;
      console.log(`PASS  ${c.id}`);
    } catch (e: any) {
      failures.push(String(e?.message || e));
      console.log(`FAIL  ${c.id} — ${e?.message || e}`);
    }
  }

  console.log(`\n${passed}/${cases.length} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
