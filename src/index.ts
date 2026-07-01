import * as aliasStore from './domain/aliasStore';
import { resolveEntitiesDetailed } from './entities/resolve';
import { planQuery } from './planner/plan';
import { retrieveContext } from './retrieval/retrieve';
import { generateSql } from './sql/generate';
import { repairSqlOnce } from './sql/repair';
import type {
  Config,
  DebugInfo,
  Embedder,
  LlmAdapter,
  NormalizedSchema,
  Request,
  ResolvedEntity,
  Response,
  VectorStore,
} from './types';
import { validateSqlDetailed, type ValidationResult } from './validate/validate';

export * from './types';

export interface ZordonDeps {
  llm: LlmAdapter;
  store: VectorStore;
  embedder: Embedder;
  schema: NormalizedSchema;
  cfg: Config;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compose the full read-only NL-to-SQL pipeline into a single `run(request)`.
 * The pipeline never throws to the caller: every failure becomes a structured
 * Response (sql | clarification | error).
 */
export function createZordon(deps: ZordonDeps): { cfg: Config; run(req: Request): Promise<Response> } {
  const { cfg } = deps;

  async function run(req: Request): Promise<Response> {
    const debug: DebugInfo = {};
    let entities: ResolvedEntity[] | undefined;
    let retrievedIds: string[] | undefined;

    try {
      const strict = req.strict ?? true;
      const dialect = req.dialect || cfg.dialectDefault;
      let question = req.question;

      // --- Stage 1: evidence-based alias resolution (never guesses) ---
      try {
        const snap: any = await aliasStore.loadSnapshot();
        for (const aliasKey of Object.keys(snap.aliases || {})) {
          const re = new RegExp(`\\b${escapeRegex(aliasKey)}\\b`, 'i');
          if (!re.test(question)) continue;
          const entry = snap.aliases[aliasKey];
          const cands = await aliasStore.lookupCandidates(aliasKey, entry.entity_type, entry.scope || {});
          if (!cands.length) continue;

          const choice = req.aliasChoices?.[aliasKey];
          if (aliasStore.needsClarification(cands) && choice == null) {
            return {
              clarification: {
                prompt: `"${aliasKey}" is ambiguous — which did you mean?`,
                alias: aliasKey,
                options: cands.map((c) => ({
                  label: String((c.meta as any)?.label ?? c.canonical),
                  canonical: c.canonical,
                  probability: c.probability,
                })),
              },
            };
          }

          let canonical = cands[0].canonical;
          if (choice != null) {
            const asIndex = Number(choice);
            if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= cands.length) {
              canonical = cands[asIndex - 1].canonical;
            } else {
              const match = cands.find((c) => c.canonical === choice);
              if (match) canonical = match.canonical;
            }
          }
          question = question.replace(new RegExp(`\\b${escapeRegex(aliasKey)}\\b`, 'gi'), canonical);
        }
      } catch {
        /* alias layer is optional; ignore its failures */
      }

      // --- Stage 2: retrieval ---
      const retrieved = await retrieveContext({ cfg, question, store: deps.store, embedder: deps.embedder, schema: deps.schema });
      retrievedIds = retrieved.ids;

      // weak-grounding fail-safe (strict)
      if (strict) {
        const tableCards = retrieved.docs.filter((d) => d.metadata?.type === 'table_card').length;
        const columnCards = retrieved.docs.filter((d) => d.metadata?.type === 'column_card').length;
        if (retrieved.docs.length < 3 || tableCards < 1 || columnCards < 1) {
          return {
            clarification: {
              prompt: 'Not enough schema grounding for this question — please name the specific table or entity.',
              options: [],
              reason: 'weak-retrieval',
            },
          };
        }
      }

      // --- Stage 3: entity resolution ---
      // Interactive clarification is driven by the evidence-based alias store
      // (Stage 1). Entity-resolution near-ties are common for multi-table
      // analytical queries, so they are surfaced as a warning rather than a hard
      // stop. (A single-entity strict mode could promote this to a clarification.)
      const resolved = resolveEntitiesDetailed({ schema: deps.schema, retrieved, question, ambiguityDelta: 0.03 });
      entities = resolved.entities;
      const warnings: string[] = [];
      if (resolved.ambiguity) {
        warnings.push(
          `possible ambiguity: "${resolved.ambiguity.top.id}" vs "${resolved.ambiguity.runnerUp.id}" (used top match)`,
        );
      }

      // --- Stage 4: plan ---
      const plan = await planQuery({ llm: deps.llm, cfg, schema: deps.schema, dialect, question, entities: resolved.entities, retrieved });
      debug.plannerRaw = plan._raw;

      // --- Stage 5: generate ---
      const sql = await generateSql({ llm: deps.llm, cfg, schema: deps.schema, plan, retrieved, question, debug });

      // --- Stage 6: validate (+ one repair pass) ---
      const userNoTime = /\ball[- ]time\b|no time (filter|bound)|any time/i.test(question);
      let result: ValidationResult = validateSqlDetailed({
        schema: deps.schema,
        plan,
        sql,
        strict,
        defaultLimit: 500,
        userRequestedNoTimeFilter: userNoTime,
      });

      if (!result.ok) {
        const priorErrors = result.errors;
        try {
          const repaired = await repairSqlOnce({
            llm: deps.llm,
            cfg,
            schema: deps.schema,
            plan,
            retrieved,
            originalSql: sql,
            validatorErrors: priorErrors,
          });
          const revalidated = validateSqlDetailed({
            schema: deps.schema,
            plan,
            sql: repaired,
            strict,
            defaultLimit: 500,
            userRequestedNoTimeFilter: userNoTime,
          });
          result = revalidated.ok ? revalidated : { ok: false, errors: revalidated.errors };
        } catch (e: any) {
          result = { ok: false, errors: [...priorErrors, String(e?.message || e)] };
        }
      }

      const resp: Response = {};
      const allWarnings = [...warnings, ...plan.riskFlags];
      if (result.ok) {
        resp.sql = result.sql;
        if (allWarnings.length) resp.warnings = allWarnings;
      } else {
        resp.error = `validation failed: ${result.errors.join('; ')}`;
        if (allWarnings.length) resp.warnings = allWarnings;
      }
      if (req.includeDebug) {
        debug.entities = entities;
        debug.plan = plan;
        debug.retrievedIds = retrievedIds;
        debug.retrievalUsedEmbeddings = true;
        debug.embedModel = cfg.embedModel;
        resp.debug = debug;
      }
      return resp;
    } catch (e: any) {
      const resp: Response = { error: String(e?.message || e) };
      if (req.includeDebug) resp.debug = { entities, retrievedIds };
      return resp;
    }
  }

  return { cfg, run };
}
