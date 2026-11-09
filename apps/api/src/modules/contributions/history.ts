import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction } from '@agentzero/database';
import { AppError } from '../../core.js';
import type { GitHubContributionHistoryCursor, GitHubRepositoryProvider } from '../github/provider.js';
import { assertRepositoryAvailable } from '../github/service.js';

interface Scan {
  repository_id: string; cursor: GitHubContributionHistoryCursor | null; lease_id: string;
  installation_id: string; github_id: string; owner: string; name: string;
}

/** Discover one page per tick; the cursor and queued objects commit together. */
export async function processContributionHistory(pool: Pool, provider: GitHubRepositoryProvider): Promise<number> {
  if (!provider.listContributionHistory || !provider.getContribution) return 0;
  const scan = await withTransaction(pool, async tx => {
    const row = (await tx.query<Scan>(`SELECT h.repository_id,h.cursor,h.lease_id,r.installation_id,r.github_id,r.owner,r.name
      FROM contribution_history_scans h JOIN repositories r ON r.id=h.repository_id JOIN github_installations i USING(installation_id)
      WHERE h.status='pending' AND h.next_attempt_at<=clock_timestamp()
        AND r.status='approved' AND NOT r.is_private AND i.status='active'
      ORDER BY h.next_attempt_at,h.repository_id LIMIT 1 FOR UPDATE OF h SKIP LOCKED`)).rows[0];
    if (!row) return null;
    row.lease_id = randomUUID();
    await tx.query(`UPDATE contribution_history_scans SET attempts=attempts+1,lease_id=$2,
      next_attempt_at=clock_timestamp()+interval '5 minutes' WHERE repository_id=$1`, [row.repository_id, row.lease_id]);
    return row;
  });
  if (!scan) return 0;
  try {
    const page = await provider.listContributionHistory({ installationId: scan.installation_id, repositoryId: scan.github_id,
      owner: scan.owner, name: scan.name, cursor: scan.cursor });
    return await withTransaction(pool, async tx => {
      const current = (await tx.query(`SELECT repository_id FROM contribution_history_scans
        WHERE repository_id=$1 AND lease_id=$2 AND status='pending' FOR UPDATE`, [scan.repository_id, scan.lease_id])).rows[0];
      if (!current) return 0;
      const repo = await assertRepositoryAvailable(tx, scan.repository_id);
      if (repo.installation_id !== scan.installation_id || repo.github_id !== scan.github_id || repo.owner !== scan.owner || repo.name !== scan.name) {
        throw new AppError('REPOSITORY_UNAVAILABLE', 409);
      }
      // The same object may occur on several branches, in a webhook, or in a manual claim.
      // Keep the original delivery reference and never reset a processed/pending event.
      await tx.query(`INSERT INTO contribution_events(repository_id,installation_id,kind,object_id,is_historical)
        SELECT DISTINCT $1::uuid,$2::text,kind,object_id,true FROM jsonb_to_recordset($3::jsonb) AS objects(kind text,object_id text)
        ON CONFLICT(repository_id,kind,object_id) DO UPDATE SET is_historical=true,
          installation_id=excluded.installation_id,
          status=CASE WHEN contribution_events.status='skipped' THEN 'pending' ELSE contribution_events.status END,
          next_attempt_at=CASE WHEN contribution_events.status='skipped' THEN clock_timestamp() ELSE contribution_events.next_attempt_at END,
          last_error=CASE WHEN contribution_events.status='skipped' THEN NULL ELSE contribution_events.last_error END,
          processed_at=CASE WHEN contribution_events.status='skipped' THEN NULL ELSE contribution_events.processed_at END`,
      [scan.repository_id, scan.installation_id, JSON.stringify(page.items.map(item => ({ kind: item.kind, object_id: item.objectId })))]);
      await tx.query(`UPDATE contribution_history_scans SET cursor=$3,status=$4,lease_id=NULL,last_error=NULL,attempts=0,
        next_attempt_at=clock_timestamp(),completed_at=CASE WHEN $4='completed' THEN clock_timestamp() ELSE NULL END
        WHERE repository_id=$1 AND lease_id=$2`,
      [scan.repository_id, scan.lease_id, page.nextCursor === null ? null : JSON.stringify(page.nextCursor), page.nextCursor === null ? 'completed' : 'pending']);
      return 1;
    });
  } catch (error) {
    const rawCode = (error as { code?: unknown }).code;
    const code = typeof rawCode === 'string' && /^[A-Z0-9_]{1,80}$/.test(rawCode) ? rawCode : 'PROCESSING_FAILED';
    await pool.query(`UPDATE contribution_history_scans SET lease_id=NULL,last_error=$3,
      next_attempt_at=clock_timestamp()+LEAST(300,5*power(2,LEAST(attempts,6))) * interval '1 second'
      WHERE repository_id=$1 AND lease_id=$2 AND status='pending'`, [scan.repository_id, scan.lease_id, code]);
    return 0;
  }
}
