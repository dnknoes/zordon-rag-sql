import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { beforeAll, describe, expect, it } from 'vitest';

import { guardSqlString } from '../src/validate/guards';
import { fuzzyScore } from '../src/retrieval/fuzzy';
import { requireLimitForNonAggregations } from '../src/validate/rules/requireLimit';
import { validateSqlDetailed } from '../src/validate/validate';
import { loadNormalizedSchema } from '../src/schema/loader';
import type { NormalizedSchema, QueryPlan } from '../src/types';

const SCHEMA_DIR = path.join(process.cwd(), 'examples', 'synthetic-schema');

describe('guardSqlString', () => {
  it('accepts a read-only SELECT', () => {
    expect(() => guardSqlString('SELECT a FROM t LIMIT 10;')).not.toThrow();
  });
  it('rejects write statements', () => {
    expect(() => guardSqlString("DELETE FROM t;")).toThrow();
    expect(() => guardSqlString('DROP TABLE t;')).toThrow();
  });
  it('rejects SELECT *', () => {
    expect(() => guardSqlString('SELECT * FROM t LIMIT 1;')).toThrow();
  });
  it('rejects multiple statements', () => {
    expect(() => guardSqlString('SELECT 1; SELECT 2;')).toThrow();
  });
  it('ignores keywords inside string literals', () => {
    expect(() => guardSqlString("SELECT a FROM t WHERE note = 'please delete later' LIMIT 1;")).not.toThrow();
  });
});

describe('fuzzyScore', () => {
  it('is 1 for identical token sets and 0 for disjoint', () => {
    expect(fuzzyScore('open work orders', 'work orders open')).toBe(1);
    expect(fuzzyScore('alpha beta', 'gamma delta')).toBe(0);
  });
});

describe('requireLimitForNonAggregations', () => {
  it('requires LIMIT on non-aggregations', () => {
    expect(() => requireLimitForNonAggregations('SELECT a FROM t', 500)).toThrow();
  });
  it('exempts aggregations', () => {
    expect(() => requireLimitForNonAggregations('SELECT COUNT(*) FROM t GROUP BY x', 500)).not.toThrow();
  });
});

describe('validateSqlDetailed', () => {
  let schema: NormalizedSchema;
  beforeAll(async () => {
    schema = await loadNormalizedSchema(SCHEMA_DIR);
  });

  const plan = (tables: string[]): QueryPlan => ({
    intent: 't',
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
  });

  it('accepts a valid, FK-backed, bounded query', () => {
    const sql = [
      'SELECT wo.work_order_id, wo.status',
      'FROM demo_work_orders wo',
      "WHERE wo.status = 'open'",
      'LIMIT 50;',
    ].join('\n');
    const res = validateSqlDetailed({ schema, plan: plan(['demo_work_orders']), sql });
    expect(res.ok).toBe(true);
  });

  it('rejects a join with no FK evidence', () => {
    const sql = [
      'SELECT a.asset_id',
      'FROM demo_assets a',
      'JOIN demo_technicians t ON a.asset_id = t.technician_id',
      'LIMIT 10;',
    ].join('\n');
    const res = validateSqlDetailed({ schema, plan: plan(['demo_assets', 'demo_technicians']), sql });
    expect(res.ok).toBe(false);
  });

  it('requires a time filter on the high-risk events table', () => {
    const sql = 'SELECT e.event_type FROM demo_work_order_events e GROUP BY e.event_type;';
    const res = validateSqlDetailed({ schema, plan: plan(['demo_work_order_events']), sql });
    expect(res.ok).toBe(false);
  });
});

describe('aliasStore (Laplace smoothing + clarification gate)', () => {
  beforeAll(() => {
    process.env.ZORDON_DATA_DIR = path.join(os.tmpdir(), `zordon-alias-test-${Date.now()}`);
  });

  it('ranks by smoothed confirmations and gates ambiguity', async () => {
    const alias = await import('../src/domain/aliasStore');
    await fs.rm(process.env.ZORDON_DATA_DIR!, { recursive: true, force: true });

    const present = [{ canonical: 'demo.demo_assets' }, { canonical: 'demo.demo_work_orders' }];
    // confirm "assets" 10 times, "work_orders" 0 times
    for (let i = 0; i < 10; i += 1) {
      await alias.recordChoice('wo', 'table', {}, { canonical: 'demo.demo_assets' }, present);
    }
    await alias.compact();

    const ranked = await alias.lookupCandidates('wo', 'table', {});
    expect(ranked[0].canonical).toBe('demo.demo_assets');
    expect(ranked[0].probability).toBeCloseTo(11 / 12, 5);
    // runner-up (1/12 ≈ 0.083) is still above the 0.05 floor → clarify
    expect(alias.needsClarification(ranked)).toBe(true);

    // decisively dominant leader, negligible runner-up → no clarify
    expect(
      alias.needsClarification([
        { canonical: 'a', probability: 0.999, confirmations: 99, rejections: 0, meta: {} },
        { canonical: 'b', probability: 0.001, confirmations: 0, rejections: 0, meta: {} },
      ]),
    ).toBe(false);

    // two near-tied candidates → clarify
    expect(
      alias.needsClarification([
        { canonical: 'a', probability: 0.55, confirmations: 1, rejections: 0, meta: {} },
        { canonical: 'b', probability: 0.45, confirmations: 1, rejections: 0, meta: {} },
      ]),
    ).toBe(true);
  });
});
