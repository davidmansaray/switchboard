import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DbOrTx } from './client';
import { evidenceChunks } from './schema';

export type EvidenceSource = 'email' | 'note' | 'transcript' | 'document';

/** One chunk per source item (the fixtures are short); idempotent per source. */
export async function indexEvidence(
  db: DbOrTx,
  input: { hireId: string; sourceType: EvidenceSource; sourceId: string; content: string },
): Promise<string> {
  const [row] = await db
    .insert(evidenceChunks)
    .values(input)
    .onConflictDoUpdate({ target: [evidenceChunks.sourceType, evidenceChunks.sourceId], set: { content: input.content } })
    .returning({ id: evidenceChunks.id });
  return row!.id;
}

export type EvidenceHit = { id: string; sourceType: EvidenceSource; sourceId: string; content: string; score: number };

/**
 * Hybrid-ready search scoped to one hire. Full-text rank (websearch syntax, OR'ed terms)
 * plus a trigram fallback; vector similarity joins in when embeddings are enabled.
 */
export async function searchEvidence(
  db: DbOrTx,
  input: { hireId: string; query: string; sourceTypes?: EvidenceSource[]; limit?: number; embedding?: number[] },
): Promise<EvidenceHit[]> {
  const terms = input.query
    .toLowerCase()
    .replace(/[^a-z0-9£%\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2);
  const tsq = terms.length ? terms.join(' or ') : input.query;
  const vec = input.embedding ? `[${input.embedding.join(',')}]` : null;
  const rows = await db
    .select({
      id: evidenceChunks.id,
      sourceType: evidenceChunks.sourceType,
      sourceId: evidenceChunks.sourceId,
      content: evidenceChunks.content,
      score: sql<number>`(
        ts_rank(${evidenceChunks.tsv}, websearch_to_tsquery('english', ${tsq}))
        + 0.1 * similarity(${evidenceChunks.content}, ${input.query})
        + ${vec ? sql`coalesce(1 - (${evidenceChunks.embedding} <=> ${vec}::vector), 0)` : sql`0`}
      )::float`,
    })
    .from(evidenceChunks)
    .where(
      and(
        eq(evidenceChunks.hireId, input.hireId),
        input.sourceTypes?.length ? inArray(evidenceChunks.sourceType, input.sourceTypes) : undefined,
      ),
    )
    .orderBy(sql`5 desc`)
    .limit(input.limit ?? 5);
  return rows.filter((r) => r.score > 0);
}
