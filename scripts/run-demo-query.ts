import { buildOfflineEngine } from '../src/runtime/offlineEngine';
import { EXAMPLES, NOTES, SCHEMA_DIR } from './_shared';

const SAMPLES = [
  'Show open high-priority work orders from the last 7 days.',
  'Which locations had the most defects in the last 30 days?',
  "List completed inspections for asset 'A-100' in the last 24 hours.",
  'Count work order events by event_type in the last 7 days.',
  'Delete all completed work orders.',
];

async function main(): Promise<void> {
  const argQuestion = process.argv.slice(2).join(' ').trim();
  const debug = Boolean(process.env.DEBUG);

  const { engine, indexed } = await buildOfflineEngine({ schemaDir: SCHEMA_DIR, examples: EXAMPLES, notes: NOTES });
  console.log(`[demo] offline engine ready — indexed ${indexed} synthetic cards (in-memory).`);

  const questions = argQuestion ? [argQuestion] : SAMPLES;
  for (const q of questions) {
    const resp = await engine.run({ question: q, includeDebug: debug });
    console.log(`\n──────────────────────────────────────────\nQ: ${q}`);
    if (resp.sql) {
      console.log('SQL:\n' + resp.sql);
      if (resp.warnings?.length) console.log('warnings: ' + resp.warnings.join(', '));
    } else if (resp.clarification) {
      console.log('CLARIFY: ' + resp.clarification.prompt);
    } else {
      console.log('ERROR: ' + resp.error);
    }
    if (debug && resp.debug) {
      console.log('debug.retrievedIds:', (resp.debug.retrievedIds || []).slice(0, 8));
      console.log('debug.plan.tables:', resp.debug.plan?.tables);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
