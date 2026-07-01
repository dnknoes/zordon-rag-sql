import type { QueryPlan } from '../../types';
import { assertMysqlOnlySql } from '../../sql/dialect';

/**
 * Single-dialect enforcement: both the plan's declared dialect and the SQL text
 * must conform to the one supported dialect (MySQL).
 */
export function enforceMysqlOnly(plan: QueryPlan, sql: string): void {
  if (plan.dialect !== 'mysql') throw new Error(`unsupported dialect in plan: ${plan.dialect}`);
  assertMysqlOnlySql(sql);
}
