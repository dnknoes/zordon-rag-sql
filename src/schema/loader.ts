import { promises as fs } from 'fs';
import path from 'path';
import type { ColumnCard, IndexHint, NormalizedSchema, Relationship, TableCard } from '../types';

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/**
 * Load a normalized schema from a directory of JSON card files
 * (tables.json / columns.json / relationships.json / indexes.json).
 * In a real deployment these are generated from authoritative schema exports;
 * here they are fully synthetic fixtures.
 */
export async function loadNormalizedSchema(schemaDir: string): Promise<NormalizedSchema> {
  const [tables, columns, relationships, indexes] = await Promise.all([
    readJson<TableCard[]>(path.join(schemaDir, 'tables.json'), []),
    readJson<ColumnCard[]>(path.join(schemaDir, 'columns.json'), []),
    readJson<Relationship[]>(path.join(schemaDir, 'relationships.json'), []),
    readJson<IndexHint[]>(path.join(schemaDir, 'indexes.json'), []),
  ]);
  return { tables, columns, relationships, indexes };
}
