import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

// Persistent, learning alias memory. Records past disambiguation choices as an
// append-only event log, compacts them into a snapshot, and ranks candidate
// canonical entities for an alias using Laplace-smoothed confirmation counts.
// Fully generic + OS-neutral (no domain-specific scope/key names).

export type AliasScope = Record<string, string | undefined>;

export interface RankedCandidate {
  canonical: string;
  probability: number;
  confirmations: number;
  rejections: number;
  last_confirmed_at?: string;
  meta: Record<string, unknown>;
}

interface SnapshotCandidate {
  confirmations: number;
  rejections: number;
  last_confirmed_at?: string;
  [k: string]: unknown;
}
interface SnapshotEntry {
  entity_type: string;
  scope: AliasScope;
  candidates: Record<string, SnapshotCandidate>;
}
interface AliasSnapshot {
  aliases: Record<string, SnapshotEntry>;
}
interface AliasEvent {
  timestamp: string;
  alias: string;
  entity_type: string;
  scope: AliasScope;
  selected: Record<string, unknown>;
  presented_candidates: Record<string, unknown>[];
}

const BOOKKEEPING = new Set(['confirmations', 'rejections', 'last_confirmed_at']);
const ID_FIELDS = ['canonical', 'id', 'name'];

let cache: AliasSnapshot | null = null;

function baseDir(): string {
  return process.env.ZORDON_DATA_DIR || path.join(os.homedir(), '.zordon', 'aliases');
}
const eventsPath = (): string => path.join(baseDir(), 'alias-events.jsonl');
const snapshotPath = (): string => path.join(baseDir(), 'alias-snapshot.json');

function candidateKey(obj: Record<string, unknown>): string {
  for (const f of ID_FIELDS) {
    if (obj[f] != null) return String(obj[f]);
  }
  return JSON.stringify(obj);
}

/** Read (and cache) the compacted snapshot; never creates directories. */
export async function loadSnapshot(): Promise<AliasSnapshot> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(snapshotPath(), 'utf8');
    const parsed = JSON.parse(raw);
    cache = parsed && typeof parsed === 'object' && parsed.aliases ? (parsed as AliasSnapshot) : { aliases: {} };
  } catch {
    cache = { aliases: {} };
  }
  return cache;
}

function scopeMatches(stored: AliasScope, lookup: AliasScope): boolean {
  for (const [k, v] of Object.entries(lookup)) {
    if (v === undefined) continue;
    if (k in stored && String(stored[k]) !== String(v)) return false;
  }
  return true;
}

/** Ranked candidates for an alias, filtered by entity type + scope. */
export async function lookupCandidates(alias: string, entityType: string, scope: AliasScope): Promise<RankedCandidate[]> {
  const snap = await loadSnapshot();
  const entry = snap.aliases[alias.toLowerCase()];
  if (!entry || entry.entity_type !== entityType || !scopeMatches(entry.scope, scope)) return [];

  const cands = Object.entries(entry.candidates);
  const n = cands.length;
  const totalConf = cands.reduce((s, [, c]) => s + (c.confirmations || 0), 0);
  const denom = totalConf + n;

  return cands
    .map(([canonical, c]) => {
      const meta: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(c)) if (!BOOKKEEPING.has(k)) meta[k] = v;
      return {
        canonical,
        probability: denom === 0 ? 1 / Math.max(1, n) : (c.confirmations + 1) / denom,
        confirmations: c.confirmations || 0,
        rejections: c.rejections || 0,
        last_confirmed_at: c.last_confirmed_at,
        meta,
      };
    })
    .sort((a, b) => b.probability - a.probability);
}

/** Ask for clarification unless the leader is decisively ahead. */
export function needsClarification(candidates: RankedCandidate[]): boolean {
  if (candidates.length < 2) return false;
  const [top, runner] = candidates;
  return top.probability - runner.probability < 0.5 || runner.probability >= 0.05;
}

/** Append a confirmed disambiguation choice to the event log. */
export async function recordChoice(
  alias: string,
  entityType: string,
  scope: AliasScope,
  selected: Record<string, unknown>,
  presentedCandidates: Record<string, unknown>[],
): Promise<void> {
  await fs.mkdir(baseDir(), { recursive: true });
  const event: AliasEvent = {
    timestamp: new Date().toISOString(),
    alias: alias.toLowerCase(),
    entity_type: entityType,
    scope: { ...scope },
    selected: { ...selected },
    presented_candidates: presentedCandidates.map((c) => ({ ...c })),
  };
  await fs.appendFile(eventsPath(), JSON.stringify(event) + os.EOL, 'utf8');
  cache = null; // invalidate
}

/** Fold the event log into a fresh snapshot (atomic write). */
export async function compact(): Promise<void> {
  await fs.mkdir(baseDir(), { recursive: true });
  let raw = '';
  try {
    raw = await fs.readFile(eventsPath(), 'utf8');
  } catch {
    await writeSnapshotAtomic({ aliases: {} });
    return;
  }

  const snap: AliasSnapshot = { aliases: {} };
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev: AliasEvent;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!ev.alias || !ev.entity_type) continue;

    const aliasKey = ev.alias.toLowerCase();
    if (!snap.aliases[aliasKey]) snap.aliases[aliasKey] = { entity_type: ev.entity_type, scope: ev.scope || {}, candidates: {} };
    const entry = snap.aliases[aliasKey];

    const ensure = (obj: Record<string, unknown>): SnapshotCandidate => {
      const key = candidateKey(obj);
      if (!entry.candidates[key]) entry.candidates[key] = { confirmations: 0, rejections: 0 };
      const bucket = entry.candidates[key];
      for (const [k, v] of Object.entries(obj)) if (!BOOKKEEPING.has(k)) bucket[k] = v;
      return bucket;
    };

    for (const cand of ev.presented_candidates || []) ensure(cand);
    const selectedKey = candidateKey(ev.selected);
    const selectedBucket = ensure(ev.selected);
    selectedBucket.confirmations += 1;
    selectedBucket.last_confirmed_at = ev.timestamp;
    for (const cand of ev.presented_candidates || []) {
      if (candidateKey(cand) !== selectedKey) entry.candidates[candidateKey(cand)].rejections += 1;
    }
  }

  await writeSnapshotAtomic(snap);
}

async function writeSnapshotAtomic(snap: AliasSnapshot): Promise<void> {
  const tmp = snapshotPath() + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(snap, null, 2), 'utf8');
  await fs.rename(tmp, snapshotPath());
  cache = snap;
}
