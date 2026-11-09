import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readOperationsReport, reportConnection } from '../../scripts/operations-report.js';
import { withTransaction } from '../../packages/database/src/index.js';
import { lockActor } from '../../apps/api/src/core.js';
import { finalizeHold, pay, refund, reserve } from '../../apps/api/src/modules/ledger/service.js';
import { agent, context, fund, identity, resetLedgerTestData, testPools } from './ledger-fixtures.js';

const pools = testPools();
const source = { environment: 'test', connection_variable: 'TEST_DATABASE_URL' } as const;
const report = () => readOperationsReport(pools.runtime, source);

async function fingerprint() {
  const tables = ['users', 'agents', 'credit_issuance_periods', 'ledger_accounts', 'journal_transactions', 'journal_entries',
    'credit_holds', 'tasks', 'task_reviews', 'task_events', 'collaboration_agreements', 'agreement_members',
    'reward_pools', 'reward_offers', 'reward_redemptions', 'land_plots', 'market_trades', 'github_deliveries', 'audit_events', 'idempotency_requests'];
  const values: Record<string, string> = {};
  for (const table of tables) {
    values[table] = (await pools.runtime.query(`SELECT md5(coalesce(string_agg(row_to_json(t)::text,'' ORDER BY row_to_json(t)::text),'')) AS hash FROM public.${table} t`)).rows[0].hash;
  }
  return values;
}

beforeEach(() => resetLedgerTestData(pools.migration));
afterAll(async () => { await pools.runtime.end(); await pools.migration.end(); });

describe('phase 7 read-only operations report', () => {
  it('labels connection selection and requires explicit test selection', () => {
    const env = { DATABASE_URL: 'postgresql://agentzero_app:private@localhost/agentzero_dev', TEST_DATABASE_URL: 'postgresql://agentzero_app:private@localhost/agentzero_test' };
    expect(reportConnection([], env).source).toEqual({ environment: 'development', connection_variable: 'DATABASE_URL' });
    expect(reportConnection([], { ...env, NODE_ENV: 'production' }).source.environment).toBe('production');
    expect(reportConnection(['--test'], env).source).toEqual(source);
    expect(() => reportConnection([], { ...env, DATABASE_URL: env.TEST_DATABASE_URL })).toThrow('Use --test');
    expect(() => reportConnection(['--test'], { ...env, TEST_DATABASE_URL: env.DATABASE_URL })).toThrow('Use --test');
    expect(() => reportConnection(['--unknown'], env)).toThrow('Usage');
  });

  it('reports unconfigured budgets honestly and uses a read-only consistent runtime transaction', async () => {
    const before = await fingerprint(), result = await report();
    expect(result.source).toMatchObject({ ...source, role: 'agentzero_app', read_only: 'on', isolation: 'repeatable read', time_zone: 'Asia/Shanghai' });
    expect(result.configuration).toMatchObject({ issuance: { configured: false, limit_points: '0', issued_points: '0', remaining_points: '0' }, reward_pool: null, reward_offers: [], land_supply: [], item_supply: [] });
    expect(result.tasks).toMatchObject({ total: '0', completed_agents: '0', settled_cross_user_collaborations: '0' });
    expect(result.failed_transactions).toMatchObject({ count: null, source: 'structured_request_logs' });
    expect(await fingerprint()).toEqual(before);
    await expect(readOperationsReport(pools.migration, source)).rejects.toThrow('runtime role');
  });

  it('counts independent work, refunds, market and reward records without exposing private content or mutating data', async () => {
    const admin = await identity(pools.runtime, 'admin'), alice = await identity(pools.runtime), bob = await identity(pools.runtime);
    const payer = await agent(pools.runtime, admin), a = await agent(pools.runtime, alice), sibling = await agent(pools.runtime, alice), b = await agent(pools.runtime, bob);
    await fund(pools.runtime, admin, payer.id, '100');
    await fund(pools.runtime, admin, a.id, '9007199254740993');
    const repositoryId = randomUUID();
    await pools.migration.query("INSERT INTO github_installations(installation_id,account_login,status) VALUES('77881','PRIVATE_OWNER','active')");
    await pools.migration.query(`INSERT INTO repositories(id,github_id,installation_id,owner,name,full_name,is_private,status)
      VALUES($1,'77882','77881','PRIVATE_OWNER','PRIVATE_REPO','PRIVATE_OWNER/PRIVATE_REPO',false,'approved')`, [repositoryId]);
    const taskIds: string[] = [];
    for (const collaborator of [sibling, b]) {
      const id = randomUUID(), agreementId = randomUUID();
      const settled = await withTransaction(pools.runtime, async tx => {
        await lockActor(tx, admin, { agentId: payer.id });
        const ctx = context(admin);
        const hold = await reserve(tx, ctx, { businessRef: `report-task:${id}`, payerAgentId: payer.id, amount: '10', permission: 'can_accept_task', reason: 'PRIVATE_REASON' });
        const journal = await finalizeHold(tx, ctx, { holdId: String(hold.holdId), payments: [{ agentId: a.id, amount: '9' }, { agentId: collaborator.id, amount: '1' }], refund: '0', reason: 'PRIVATE_REASON' });
        return { hold: hold.holdId, journal: journal.transactionId };
      });
      await pools.migration.query(`INSERT INTO tasks(id,title,description,repository_id,acceptance_criteria,required_checks,reward_points,deadline_at,
        publisher_user_id,payer_agent_id,reviewer_user_id,assignee_agent_id,status,hold_id,settled_journal_id,finalized_at)
        VALUES($1,'PRIVATE_TITLE','PRIVATE_DESCRIPTION',$2,'PRIVATE_CRITERIA','[]',10,now()+interval '1 day',$3,$4,$3,$5,'settled',$6,$7,now())`,
      [id, repositoryId, admin.type === 'user' ? admin.userId : '', payer.id, a.id, settled.hold, settled.journal]);
      await pools.migration.query("INSERT INTO collaboration_agreements(id,task_id,version,status,deadline_at,activated_at) VALUES($1,$2,1,'active',now()+interval '1 day',now())", [agreementId, id]);
      await pools.migration.query("INSERT INTO agreement_members(agreement_id,agent_id,role,deliverable,amount_points) VALUES($1,$2,'lead','PRIVATE_DELIVERY',9),($1,$3,'helper','PRIVATE_DELIVERY',1)", [agreementId, a.id, collaborator.id]);
      taskIds.push(id);
    }
    const adminId = admin.type === 'user' ? admin.userId : '';
    await pools.migration.query("INSERT INTO task_reviews(task_id,reviewer_user_id,decision,reason,unmet_criteria) VALUES($1,$2,'request_changes','PRIVATE_REVIEW','PRIVATE_CRITERIA')", [taskIds[0], adminId]);
    await pools.migration.query("INSERT INTO task_events(task_id,kind,actor_type,details) VALUES($1,'disputed','system','{\"reason\":\"PRIVATE_DISPUTE\"}')", [taskIds[0]]);
    const payments = await withTransaction(pools.runtime, async tx => {
      await lockActor(tx, alice, { agentId: a.id });
      const ctx = context(alice);
      const land = await pay(tx, ctx, { businessKey: `report-land:${randomUUID()}`, payerAgentId: a.id, amount: '40', permission: 'can_trade', reason: 'PRIVATE_LAND' });
      const reward = await pay(tx, ctx, { businessKey: `report-reward:${randomUUID()}`, payerAgentId: a.id, amount: '20', permission: 'can_redeem_api', reason: 'PRIVATE_REWARD' });
      return { land: land.transactionId, reward: reward.transactionId };
    });
    await withTransaction(pools.runtime, async tx => {
      await lockActor(tx, admin, { admin: true });
      await refund(tx, context(admin), { businessKey: `report-refund:${randomUUID()}`, originalTransactionId: payments.land, amount: '10', reason: 'PRIVATE_CORRECTION' });
    });
    const landId = randomUUID(), rewardPoolId = randomUUID(), offerId = randomUUID();
    await pools.migration.query("INSERT INTO land_plots(id,code,x,y,area,points_price,owner_agent_id,owner_user_id,created_by) VALUES($1,'REPORT-LAND',0,0,100,40,$2,$3,$4)", [landId, a.id, alice.type === 'user' ? alice.userId : '', adminId]);
    await pools.migration.query("INSERT INTO market_trades(land_id,buyer_agent_id,points_price,transaction_id,asset_snapshot) VALUES($1,$2,40,$3,'{\"name\":\"PRIVATE_STUDIO\"}')", [landId, a.id, payments.land]);
    await pools.migration.query(`INSERT INTO reward_pools(id,month,total_quantity,allocated_quantity,user_monthly_limit,contact_qq,instructions,created_by,updated_by)
      VALUES($1,date_trunc('month',now() AT TIME ZONE 'Asia/Shanghai')::date,10,3,2,'9988776655','PRIVATE_INSTRUCTIONS',$2,$2)`, [rewardPoolId, adminId]);
    await pools.migration.query("INSERT INTO reward_offers(id,pool_id,title,description,points_cost,total_quantity,redeemed_quantity,created_by) VALUES($1,$2,'PRIVATE_REWARD','PRIVATE_DETAILS',20,3,1,$3)", [offerId, rewardPoolId, adminId]);
    await pools.migration.query(`INSERT INTO reward_redemptions(claim_code,user_id,agent_id,pool_id,offer_id,title,description,points_cost,contact_qq,instructions,
      claimant_qq,status,payment_transaction_id,fulfillment_reference,processed_by,fulfilled_at)
      VALUES($1,$2,$3,$4,$5,'PRIVATE_REWARD','PRIVATE_DETAILS',20,'9988776655','PRIVATE_INSTRUCTIONS','8877665544','fulfilled',$6,'PRIVATE_PAYMENT',$7,now())`,
    [`RWD-${randomUUID().replaceAll('-', '').toUpperCase()}`, alice.type === 'user' ? alice.userId : '', a.id, rewardPoolId, offerId, payments.reward, adminId]);
    await pools.migration.query("INSERT INTO github_deliveries(delivery_id,event_name,payload_hash,payload,attempts,last_error) VALUES($1,'pull_request',decode('01','hex'),'{\"token\":\"PRIVATE_PAYLOAD\"}',1,'PRIVATE_ERROR')", [randomUUID()]);
    const before = await fingerprint(), result = await report();
    expect(result.participation).toMatchObject({ active_users: '3', agents: '4', usable_public_repositories: '1' });
    expect(result.tasks).toMatchObject({ total: '2', settled: '2', completed_agents: '3', settled_cross_user_collaborations: '1', settled_same_user_collaborations: '1', return_events: '1', returned_tasks: '1', historically_disputed_tasks: '1', currently_disputed: '0' });
    expect(result.market).toMatchObject({ initial_land_trades: '1', resale_land_trades: '0', traded_points: '40' });
    expect(result.ledger).toMatchObject({ issued_points: '9007199254741093', recovered_gross_points: '60', refunded_points: '10', recovered_net_points: '50', quarantine_records: '0' });
    expect(result.configuration.reward_pool).toMatchObject({ total_quantity: '10', allocated_quantity: '3', user_monthly_limit: '2', contact_configured: true });
    expect(result.configuration.reward_offers).toEqual([{ status: 'active', points_cost: '20', offers: '1', total_quantity: '3', redeemed_quantity: '1', remaining_quantity: '2' }]);
    expect(result.rewards).toEqual([{ status: 'fulfilled', claims: '1', points: '20', recorded_fulfillments: '1' }]);
    expect(result.webhooks).toMatchObject({ received: '1', pending: '1', pending_with_error: '1' });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|9988776655|8877665544|token_hash|secret_hash/);
    expect(await fingerprint()).toEqual(before);
  });
});
