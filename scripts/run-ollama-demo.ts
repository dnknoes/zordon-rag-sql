// Live, LOCAL Ollama demo for the Zordon RAG SQL engine.
//
// Same pipeline as `npm run demo`, but the planner/generator model is a real
// local Ollama model instead of the deterministic offline mock. Retrieval stays
// fully local (in-memory vector store + hash embedder) over the SYNTHETIC schema.
//
// Safety: synthetic schema only, no real database, no credentials, no network
// except the local Ollama server. Model output is treated as UNTRUSTED and must
// pass the exact same guardrails as the offline demo — see src/validate/*.
//
//   OLLAMA_URL   (default http://localhost:11434)
//   OLLAMA_MODEL (default qwen2.5-coder:7b)

import { defaultConfig } from '../src/config';
import { createOllamaAdapter } from '../src/llm/ollamaAdapter';
import { buildOfflineEngine } from '../src/runtime/offlineEngine';
import type { NormalizedSchema } from '../src/types';
import { describeGuardrails } from '../src/validate/report';
import { EXAMPLES, NOTES, SCHEMA_DIR } from './_shared';

type Engine = Awaited<ReturnType<typeof buildOfflineEngine>>['engine'];

// Synthetic questions (incl. one destructive request, to show it is neutralized).
const QUESTIONS = [
  'Show open high-priority work orders from the last 7 days.',
  'Which locations had the most defects in the last 30 days?',
  'Delete all completed work orders.',
];

const SEP = '────────────────────────────';
const pf = (b: boolean): string => (b ? 'pass' : 'fail');

function truncate(s: string | undefined | null, n: number): string {
  const t = String(s ?? '').trim();
  return t.length > n ? `${t.slice(0, n)} …[truncated]` : t;
}

/** Probe the local Ollama server and list installed models. Never throws. */
async function preflight(baseUrl: string, timeoutMs = 3000): Promise<{ ok: boolean; models: string[]; reason?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
    if (!resp.ok) return { ok: false, models: [], reason: `HTTP ${resp.status}` };
    const data = (await resp.json()) as { models?: Array<{ name?: string }> };
    const models = (data.models ?? []).map((m) => String(m?.name ?? '')).filter(Boolean);
    return { ok: true, models };
  } catch (e: any) {
    const reason = e?.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : String(e?.message || e);
    return { ok: false, models: [], reason };
  } finally {
    clearTimeout(timer);
  }
}

/** Lenient match so `qwen2.5-coder` also matches an installed `qwen2.5-coder:7b`. */
function installedHasModel(models: string[], want: string): boolean {
  const wantL = want.toLowerCase();
  const base = wantL.split(':')[0];
  return models.some((m) => {
    const ml = m.toLowerCase();
    return ml === wantL || ml.split(':')[0] === base;
  });
}

async function runOne(engine: Engine, schema: NormalizedSchema, question: string, model: string): Promise<void> {
  console.log(`\n${SEP}\nQ: ${question}\n`);

  const resp = await engine.run({ question, includeDebug: true });
  const debug = resp.debug ?? {};
  const ids = debug.retrievedIds ?? [];

  // --- retrieval (synthetic schema cards) ---
  const tableCards = ids
    .filter((id) => id.startsWith('table:'))
    .map((id) => id.slice('table:'.length).split('.').pop())
    .filter(Boolean) as string[];
  const count = (prefix: string): number => ids.filter((id) => id.startsWith(prefix)).length;
  console.log('[retrieval]');
  console.log('Top schema cards:');
  for (const t of tableCards.slice(0, 6)) console.log(`- ${t}`);
  console.log(
    `(${ids.length} synthetic cards retrieved: ${count('table:')} tables, ${count('column:')} columns, ` +
      `${count('fk:')} fks, ${count('index:')} indexes, ${count('note:')} notes, ${count('example:')} examples)`,
  );

  // --- llm ---
  console.log('\n[llm]');
  console.log('provider: Ollama');
  console.log(`model: ${model}`);

  // --- raw model output ---
  console.log('\n[raw model output]');
  console.log('planner (JSON):');
  if (debug.plannerRaw) console.log(truncate(debug.plannerRaw, 700));
  else if (resp.error && /planner/i.test(resp.error)) console.log(`(planner did not return valid JSON) ${truncate(resp.error, 400)}`);
  else console.log('(no planner output captured)');
  console.log('generator (SQL):');
  console.log(debug.sqlRaw ? truncate(debug.sqlRaw, 400) : '(n/a — generation not reached)');

  // --- parsed / normalized plan (the structured-output boundary) ---
  if (debug.plan) {
    console.log('\n[parsed plan]');
    console.log(`intent: ${debug.plan.intent}`);
    console.log(`tables: ${JSON.stringify(debug.plan.tables)}`);
    console.log(`timeWindow: ${debug.plan.timeWindow ?? 'null'}`);
    console.log(`riskFlags: ${JSON.stringify(debug.plan.riskFlags)}`);
  }

  // --- validated SQL / safe outcome ---
  console.log('\n[validated SQL]');
  const finalSql = resp.sql ?? debug.sqlFinal ?? '';
  let status: 'pass' | 'fail' | 'clarify';
  if (resp.sql) {
    status = 'pass';
    console.log(resp.sql);
  } else if (resp.clarification) {
    status = 'clarify';
    console.log(`(clarification requested) ${resp.clarification.prompt}`);
  } else {
    status = 'fail';
    const err = resp.error ?? 'no SQL produced';
    const label = /^validation failed/i.test(err) ? 'rejected by guardrails' : 'error';
    console.log(`(${label}) ${err}`);
    if (debug.sqlFinal) console.log(`last candidate: ${debug.sqlFinal}`);
  }
  console.log(`\nvalidation: ${status}`);
  if (resp.warnings?.length) console.log(`warnings: ${resp.warnings.join('; ')}`);

  // --- guardrails (re-run the real guards against the final SQL) ---
  console.log('\n[guardrails]');
  if (!finalSql) {
    console.log('n/a — no SQL was generated (clarification requested before generation)');
    return;
  }
  const g = describeGuardrails({ schema, sql: finalSql, question });
  console.log(`read-only: ${pf(g.readOnly)}`);
  console.log(`known tables: ${pf(g.knownTables)}`);
  console.log(`limit: ${pf(g.limit)}`);
  if (g.destructiveIntent) console.log(`destructive intent: ${g.destructiveBlocked ? 'blocked' : 'NOT BLOCKED ⚠'}`);
  // The lines above are string-level checks on the candidate. The engine also runs
  // deeper schema/column/FK-join validation; surface that verdict so a passing
  // string-level check can't be mistaken for overall approval.
  if (status === 'pass') {
    console.log('overall: pass — accepted by the full schema/FK validator');
  } else {
    console.log('overall: fail — rejected by the full schema/FK validator (see errors above); NOT presented as safe');
  }
}

async function main(): Promise<void> {
  const baseUrl = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '');
  const model = defaultConfig().model;

  const probe = await preflight(baseUrl);
  if (!probe.ok) {
    console.log(`Ollama is not reachable at ${baseUrl}. Start Ollama or use \`npm run demo\` for the offline deterministic demo.`);
    if (probe.reason) console.log(`(reason: ${probe.reason})`);
    process.exit(0); // graceful: this is an expected, handled condition
  }
  if (!installedHasModel(probe.models, model)) {
    console.log(`Ollama is running at ${baseUrl}, but model "${model}" is not installed.`);
    console.log(`Installed models: ${probe.models.join(', ') || '(none)'}`);
    console.log(`Pull it with:  ollama pull ${model}   (or set OLLAMA_MODEL to an installed model)`);
    process.exit(0); // graceful
  }

  const llm = createOllamaAdapter({ baseUrl });
  const { engine, schema, cfg, indexed } = await buildOfflineEngine({
    schemaDir: SCHEMA_DIR,
    examples: EXAMPLES,
    notes: NOTES,
    llm,
  });
  console.log(
    `[demo:ollama] engine ready — indexed ${indexed} synthetic cards (in-memory). ` +
      `provider=Ollama model=${cfg.model} url=${baseUrl}`,
  );
  console.log('[demo:ollama] synthetic schema only · no real database · model output is validated before use.');

  const argQuestion = process.argv.slice(2).join(' ').trim();
  const questions = argQuestion ? [argQuestion] : QUESTIONS;
  for (const q of questions) {
    await runOne(engine, schema, q, cfg.model);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
