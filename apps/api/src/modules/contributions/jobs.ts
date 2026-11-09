import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction, type Tx } from '@agentzero/database';
import { AppError } from '../../core.js';
import type { GitHubContributionKind, GitHubRepositoryProvider } from '../github/provider.js';
import { assertRepositoryAvailable } from '../github/service.js';
import { payContribution } from './service.js';

const githubId = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
  ? String(value) : typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? value : null;

/** Only authenticated, persisted webhook deliveries reach this function. */
export async function enqueueContributionEvents(tx: Tx, deliveryId: string, eventName: string, payload: Record<string, any>) {
  let kind: GitHubContributionKind, objectIds: string[];
  if (eventName === 'push' && !payload.deleted) {
    kind = 'commit';
    objectIds = [...new Set<string>((Array.isArray(payload.commits) ? payload.commits : [])
      .map((commit: any) => commit?.id).filter((id: unknown) => typeof id === 'string' && /^[0-9a-f]{40}$/.test(id)))];
  } else if (eventName === 'pull_request' && payload.action === 'opened') {
    kind = 'pull_request';
    const number = githubId(payload.pull_request?.number);
    objectIds = number ? [number] : [];
  } else if (eventName === 'issues' && payload.action === 'opened' && !payload.issue?.pull_request) {
    kind = 'issue';
    const number = githubId(payload.issue?.number);
    objectIds = number ? [number] : [];
  } else return;
  if (!objectIds.length) return;
  const repositoryGithubId = githubId(payload.repository?.id), installationId = githubId(payload.installation?.id);
  if (!repositoryGithubId || !installationId) return;
  const repository = (await tx.query(`SELECT r.id FROM repositories r JOIN github_installations i USING(installation_id)
    WHERE r.github_id=$1 AND r.installation_id=$2 AND r.status='approved' AND NOT r.is_private AND i.status='active'`,
  [repositoryGithubId, installationId])).rows[0];
  if (!repository) return;
  await tx.query(`INSERT INTO contribution_events(repository_id,installation_id,delivery_id,kind,object_id)
    SELECT $1,$2,$3,$4,object_id FROM unnest($5::text[]) object_id ON CONFLICT(repository_id,kind,object_id) DO NOTHING`,
  [repository.id, installationId, deliveryId, kind, objectIds]);
}

interface Event {
  id: string; repository_id: string; installation_id: string; kind: GitHubContributionKind; object_id: string; lease_id: string;
  is_historical: boolean;
}
const skippedCodes = new Set(['CONTRIBUTION_DISABLED', 'CONTRIBUTION_AUTHOR_UNLINKED', 'CONTRIBUTION_USER_UNAVAILABLE',
  'CONTRIBUTION_RECEIVER_UNSET', 'CONTRIBUTION_BINDING_MISMATCH', 'CONTRIBUTION_IDENTITY_MISMATCH',
  'REPOSITORY_UNAVAILABLE', 'ACCOUNT_PENDING', 'ACCOUNT_SUSPENDED', 'AGENT_PAUSED', 'AGENT_DELETED', 'ACCESS_DENIED']);
const historicalWaitCodes = new Set(['CONTRIBUTION_DISABLED', 'CONTRIBUTION_USER_UNAVAILABLE', 'CONTRIBUTION_RECEIVER_UNSET',
  'REPOSITORY_UNAVAILABLE', 'ACCOUNT_PENDING', 'ACCOUNT_SUSPENDED', 'AGENT_PAUSED', 'AGENT_DELETED', 'ACCESS_DENIED']);

async function finishEvent(tx: Tx, event: Event, status: 'processed' | 'skipped', code: string | null = null) {
  await tx.query(`UPDATE contribution_events SET status=$3,last_error=$4,lease_id=NULL,processed_at=clock_timestamp()
    WHERE id=$1 AND lease_id=$2 AND status='pending'`, [event.id, event.lease_id, status, code]);
}

export async function processContributionEvents(pool: Pool, provider: GitHubRepositoryProvider): Promise<number> {
  if (!provider.getContribution) return 0;
  let processed = 0;
  for (let count = 0; count < 25; count++) {
    const event = await withTransaction(pool, async tx => {
      const row = (await tx.query<Event>(`SELECT id,repository_id,installation_id,kind,object_id,lease_id,is_historical FROM contribution_events
        WHERE status='pending' AND next_attempt_at<=clock_timestamp() ORDER BY next_attempt_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`)).rows[0];
      if (!row) return null;
      row.lease_id = randomUUID();
      await tx.query(`UPDATE contribution_events SET attempts=attempts+1,lease_id=$2,next_attempt_at=clock_timestamp()+interval '5 minutes' WHERE id=$1`, [row.id, row.lease_id]);
      return row;
    });
    if (!event) break;
    try {
      const repo = (await pool.query(`SELECT r.github_id,r.owner,r.name,r.installation_id FROM repositories r JOIN github_installations i USING(installation_id)
        WHERE r.id=$1 AND (r.installation_id=$2 OR $3) AND r.status='approved' AND NOT r.is_private AND i.status='active'`,
      [event.repository_id, event.installation_id, event.is_historical])).rows[0];
      if (!repo) throw new AppError('REPOSITORY_UNAVAILABLE', 409);
      const evidence = await provider.getContribution({ installationId: repo.installation_id, repositoryId: repo.github_id,
        owner: repo.owner, name: repo.name, kind: event.kind, objectId: event.object_id });
      if (evidence.kind !== event.kind || evidence.objectId !== event.object_id || evidence.repositoryId !== repo.github_id) throw new AppError('CONTRIBUTION_BINDING_MISMATCH', 409);
      if (!evidence.authorGithubId) throw new AppError('CONTRIBUTION_AUTHOR_UNLINKED', 409);
      const completed = await withTransaction(pool, async tx => {
        const current = (await tx.query("SELECT id FROM contribution_events WHERE id=$1 AND lease_id=$2 AND status='pending' FOR UPDATE", [event.id, event.lease_id])).rows[0];
        if (!current) return false;
        // User locks serialize preference edits before choosing the receiving Agent.
        const user = (await tx.query("SELECT id FROM users WHERE github_user_id=$1 AND status='active' FOR UPDATE", [evidence.authorGithubId])).rows[0];
        if (!user) throw new AppError('CONTRIBUTION_USER_UNAVAILABLE', 409);
        const receiver = (await tx.query('SELECT agent_id FROM contribution_reward_preferences WHERE user_id=$1', [user.id])).rows[0];
        if (!receiver?.agent_id) throw new AppError('CONTRIBUTION_RECEIVER_UNSET', 409);
        await tx.query('SELECT id FROM agents WHERE id=$1 FOR UPDATE', [receiver.agent_id]);
        const preference = (await tx.query('SELECT agent_id FROM contribution_reward_preferences WHERE user_id=$1 FOR SHARE', [user.id])).rows[0];
        if (!preference?.agent_id) throw new AppError('CONTRIBUTION_RECEIVER_UNSET', 409);
        const repository = await assertRepositoryAvailable(tx, event.repository_id);
        if (repository.installation_id !== repo.installation_id || repository.github_id !== repo.github_id || repository.owner !== repo.owner || repository.name !== repo.name) throw new AppError('REPOSITORY_UNAVAILABLE', 409);
        if (event.is_historical && event.installation_id !== repo.installation_id) {
          await tx.query('UPDATE contribution_events SET installation_id=$2 WHERE id=$1', [event.id, repo.installation_id]);
        }
        await payContribution(tx, { actor: { type: 'system' }, requestId: event.id, userId: user.id,
          agentId: preference.agent_id, repositoryId: event.repository_id, evidence });
        await finishEvent(tx, event, 'processed');
        return true;
      });
      if (completed) processed++;
    } catch (error) {
      const rawCode = (error as { code?: unknown }).code;
      const code = typeof rawCode === 'string' && /^[A-Z0-9_]{1,80}$/.test(rawCode) ? rawCode : 'PROCESSING_FAILED';
      await withTransaction(pool, async tx => {
        // A history scan may have adopted this webhook event while its API read was in flight.
        const current = (await tx.query(`SELECT is_historical FROM contribution_events
          WHERE id=$1 AND lease_id=$2 AND status='pending' FOR UPDATE`, [event.id, event.lease_id])).rows[0];
        if (!current) return;
        if (skippedCodes.has(code) && !(current.is_historical && historicalWaitCodes.has(code))) await finishEvent(tx, event, 'skipped', code);
        else await tx.query(`UPDATE contribution_events SET lease_id=NULL,last_error=$3,
          next_attempt_at=clock_timestamp()+LEAST(300,5*power(2,LEAST(attempts,6))) * interval '1 second'
          WHERE id=$1 AND lease_id=$2 AND status='pending'`, [event.id, event.lease_id, code]);
      });
    }
  }
  return processed;
}
