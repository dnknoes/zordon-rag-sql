import type { LlmAdapter } from '../types';

// Deterministic OFFLINE LLM stub. It lets the whole pipeline (plan -> generate
// -> validate -> repair) run with no external model, so the bundled demo/eval
// are reproducible. It routes on the question embedded in the prompt and returns
// a canned plan (JSON mode) or SQL (default) for the synthetic schema.
//
// A real deployment injects `createOllamaAdapter()` instead; the engine is
// identical either way.

interface Canned {
  plan: Record<string, unknown>;
  sql: string;
}

function plan(tables: string[], intent: string, timeWindow: string | null, riskFlags: string[] = []): Record<string, unknown> {
  return {
    intent,
    entities: [],
    metrics: [],
    dimensions: [],
    timeWindow,
    grain: null,
    filters: [],
    tables,
    joins: [],
    dialect: 'mysql',
    riskFlags,
  };
}

const CANNED: Record<string, Canned> = {
  work_orders: {
    plan: plan(['demo_work_orders'], 'list open high-priority work orders', 'last 7 days'),
    sql: [
      'SELECT wo.work_order_id, wo.status, wo.priority, wo.created_at',
      'FROM demo_work_orders wo',
      "WHERE wo.status = 'open' AND wo.priority = 'high' AND wo.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)",
      'ORDER BY wo.created_at DESC',
      'LIMIT 100;',
    ].join('\n'),
  },
  defects: {
    plan: plan(['demo_defects', 'demo_work_orders', 'demo_locations'], 'defect counts by location', 'last 30 days'),
    sql: [
      'SELECT loc.location_name, COUNT(*) AS defect_count',
      'FROM demo_defects d',
      'JOIN demo_work_orders wo ON d.work_order_id = wo.work_order_id',
      'JOIN demo_locations loc ON wo.location_id = loc.location_id',
      "WHERE d.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)",
      'GROUP BY loc.location_name',
      'ORDER BY defect_count DESC',
      'LIMIT 25;',
    ].join('\n'),
  },
  inspections: {
    plan: plan(['demo_inspections', 'demo_work_orders', 'demo_assets'], 'completed inspections for an asset', 'last 24 hours'),
    sql: [
      'SELECT ins.inspection_id, ins.inspection_result, ins.inspected_at',
      'FROM demo_inspections ins',
      'JOIN demo_work_orders wo ON ins.work_order_id = wo.work_order_id',
      'JOIN demo_assets a ON wo.asset_id = a.asset_id',
      "WHERE a.asset_name = 'A-100' AND ins.inspection_result = 'completed' AND ins.inspected_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)",
      'ORDER BY ins.inspected_at DESC',
      'LIMIT 100;',
    ].join('\n'),
  },
  events: {
    plan: plan(['demo_work_order_events'], 'work order events by type', 'last 7 days', ['high-volume event table']),
    sql: [
      'SELECT e.event_type, COUNT(*) AS event_count',
      'FROM demo_work_order_events e',
      'WHERE e.event_timestamp >= DATE_SUB(NOW(), INTERVAL 7 DAY)',
      'GROUP BY e.event_type',
      'ORDER BY event_count DESC',
      'LIMIT 50;',
    ].join('\n'),
  },
  write: {
    // A write request. The engine must NEVER emit this; generation neutralizes
    // it to the safe read-only fallback.
    plan: plan([], 'unsupported write request', null),
    sql: "DELETE FROM demo_work_orders WHERE status = 'completed';",
  },
  generic: {
    plan: plan(['demo_work_orders'], 'recent work orders', null),
    sql: [
      'SELECT wo.work_order_id, wo.status, wo.created_at',
      'FROM demo_work_orders wo',
      'ORDER BY wo.created_at DESC',
      'LIMIT 50;',
    ].join('\n'),
  },
};

function detectIntent(prompt: string): keyof typeof CANNED {
  const m = prompt.match(/Question:\s*(.+)/i);
  const q = (m ? m[1] : prompt).toLowerCase();
  if (/\b(delete|drop|truncate|update|insert|remove all)\b/.test(q)) return 'write';
  if (/event/.test(q)) return 'events';
  if (/defect/.test(q)) return 'defects';
  if (/inspection/.test(q)) return 'inspections';
  if (/work[\s-]?order|high[\s-]?priority|\bopen\b/.test(q)) return 'work_orders';
  return 'generic';
}

export function createMockLlm(): LlmAdapter {
  return {
    async generate(req) {
      const canned = CANNED[detectIntent(req.prompt)];
      return { text: req.format === 'json' ? JSON.stringify(canned.plan) : canned.sql };
    },
  };
}
