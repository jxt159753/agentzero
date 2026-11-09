import { randomBytes } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { lockActor } from '../../apps/api/src/core.js';
import { agent, identity, resetLedgerTestData, testPools } from './ledger-fixtures.js';

const pools = testPools();
beforeEach(() => resetLedgerTestData(pools.migration));
afterAll(async () => { await pools.runtime.end(); await pools.migration.end(); });

describe('actor identity row locks', () => {
  it.each(['users', 'agents'] as const)('%s permits foreign-key checks while blocking status changes and deletion', async table => {
    const owner = await identity(pools.runtime);
    const target = await agent(pools.runtime, owner);
    const id = table === 'users' ? target.actor.ownerUserId : target.id;
    const actorTx = await pools.runtime.connect();
    const contender = await pools.migration.connect();
    try {
      await actorTx.query('BEGIN');
      await lockActor(actorTx, target.actor);
      await contender.query('BEGIN');
      await contender.query("SET LOCAL lock_timeout = '250ms'");
      // A real FK insert needs KEY SHARE on the identity row held by lockActor.
      const reference = table === 'users'
        ? contender.query("INSERT INTO user_sessions(user_id,token_hash,csrf_token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')", [id, randomBytes(32), randomBytes(32)])
        : contender.query("INSERT INTO agent_keys(agent_id,label,secret_hash) VALUES($1,'lock regression',$2)", [id, randomBytes(32)]);
      await expect(reference).resolves.toMatchObject({ rowCount: 1 });
      await contender.query('ROLLBACK');

      const changeStatus = table === 'users'
        ? "UPDATE users SET status='suspended' WHERE id=$1"
        : "UPDATE agents SET status='paused' WHERE id=$1";
      for (const mutation of [changeStatus, `DELETE FROM ${table} WHERE id=$1`]) {
        await contender.query('BEGIN');
        await contender.query("SET LOCAL lock_timeout = '250ms'");
        await expect(contender.query(mutation, [id])).rejects.toMatchObject({ code: '55P03' });
        await contender.query('ROLLBACK');
      }
    } finally {
      await Promise.all([actorTx, contender].map(async tx => {
        try { await tx.query('ROLLBACK'); } finally { tx.release(); }
      }));
    }
  });
});
