import { randomUUID } from 'node:crypto';
import { afterAll,beforeAll,beforeEach,describe,expect,it } from 'vitest';
import { buildApp } from '../../apps/api/src/app.js';
import { tokenHash } from '../../apps/api/src/core.js';
import { testPools,resetLedgerTestData,fund } from './ledger-fixtures.js';
import type { Actor } from '../../packages/contracts/src/index.js';

const pools=testPools();
let app:Awaited<ReturnType<typeof buildApp>>;
const origin='http://localhost:5173';
type Session={cookie:string;csrf:string;userId:string;sessionId:string};
async function start() {
  const response=await app.inject({method:'GET',url:'/api/v1/auth/github/start'});
  expect(response.statusCode).toBe(302);
  const url=new URL(response.headers.location!);
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('code_challenge')).toHaveLength(43);
  return {state:url.searchParams.get('state')!,cookie:`az_oauth=${response.cookies.find(c=>c.name==='az_oauth')!.value}`};
}
async function login(id:string):Promise<Session> {
  const started=await start();
  const response=await app.inject({method:'GET',url:`/api/v1/auth/github/callback?state=${started.state}&code=${id}`,headers:{cookie:started.cookie}});
  expect(response.statusCode,response.body).toBe(302);
  const session=response.cookies.find(c=>c.name==='az_session')!.value,csrf=response.cookies.find(c=>c.name==='az_csrf')!.value;
  const row=(await pools.runtime.query('SELECT id,user_id FROM user_sessions WHERE token_hash=$1',[tokenHash(session)])).rows[0];
  return {cookie:`az_session=${session}; az_csrf=${csrf}`,csrf,userId:row.user_id,sessionId:row.id};
}
const headers=(session:Session,key=randomUUID())=>({cookie:session.cookie,origin,'x-csrf-token':session.csrf,'idempotency-key':key});
async function activeMember(admin:Session,id:string) {
  const member=await login(id);
  const response=await app.inject({method:'PATCH',url:`/api/v1/admin/users/${member.userId}`,headers:headers(admin),payload:{status:'active',reason:'integration admission'}});
  expect(response.statusCode,response.body).toBe(200);
  return member;
}
async function createAgent(owner:Session) {
  const response=await app.inject({method:'POST',url:'/api/v1/agents',headers:headers(owner),payload:{name:'测试 Agent'}});
  expect(response.statusCode,response.body).toBe(201);
  return response.json() as {id:string;operation_id:string};
}

beforeAll(async()=>{
  app=await buildApp({pool:pools.runtime,config:{databaseUrl:process.env.TEST_DATABASE_URL!,publicOrigin:origin,githubClientId:'test-client',githubClientSecret:'test-client-secret',bootstrapAdminGithubId:'1',production:false,host:'127.0.0.1',port:3000},github:{exchange:async(code,verifier)=>{
    expect(verifier).toHaveLength(43);
    return {id:code,login:`user-${code}`,name:`User ${code}`,avatarUrl:null};
  }}});
  await app.ready();
});
beforeEach(()=>resetLedgerTestData(pools.migration));
afterAll(async()=>{await app?.close();await pools.runtime.end();await pools.migration.end();});

describe('identity, ownership and real HTTP contracts',()=>{
  it('T01 rejects forged, expired, wrong-browser and replayed OAuth states',async()=>{
    const s=await start();
    const callback=(state:string,cookie=s.cookie)=>app.inject({method:'GET',url:`/api/v1/auth/github/callback?state=${state}&code=2`,headers:{cookie}});
    expect((await callback('forged-state-that-is-long-enough')).statusCode).toBe(400);
    expect((await callback(s.state,'az_oauth=another-browser')).statusCode).toBe(400);
    expect((await pools.runtime.query('SELECT count(*)::int AS n FROM user_sessions')).rows[0].n).toBe(0);
    expect((await callback(s.state)).statusCode).toBe(302);
    expect((await callback(s.state)).statusCode).toBe(400);
    const expired=await start();
    await pools.migration.query("UPDATE oauth_login_states SET expires_at=clock_timestamp()-interval '1 second'");
    expect((await callback(expired.state,expired.cookie)).statusCode).toBe(400);
    await login('2');
    expect((await pools.runtime.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(1);
    expect((await pools.runtime.query('SELECT count(*)::int AS n FROM oauth_login_states')).rows[0].n).toBe(0);
  });
  it('pending cannot create; only configured numeric GitHub ID bootstraps admin',async()=>{
    const pending=await login('2');
    const denied=await app.inject({method:'POST',url:'/api/v1/agents',headers:headers(pending),payload:{name:'denied'}});
    expect(denied.json().error.code).toBe('ACCOUNT_PENDING');
    const me=await app.inject({url:'/api/v1/me',headers:{cookie:pending.cookie}});
    expect(me.json().user).toMatchObject({role:'member',status:'pending'});
    const admin=await login('1');
    expect((await app.inject({url:'/api/v1/me',headers:{cookie:admin.cookie}})).json().user).toMatchObject({role:'admin',status:'active'});
  });
  it('first-admin setup can promote an existing pending account but never reactivates a suspended admin',async()=>{
    await pools.migration.query("INSERT INTO users(github_user_id,github_login,display_name,status,role) VALUES(1,'user-1','Existing user','pending','member')");
    const first=await login('1');
    expect((await app.inject({url:'/api/v1/me',headers:{cookie:first.cookie}})).json().user).toMatchObject({role:'admin',status:'active'});
    expect((await pools.runtime.query("SELECT count(*)::int n FROM audit_events WHERE action='identity.admin_bootstrapped'")).rows[0].n).toBe(1);
    await pools.migration.query("UPDATE users SET status='suspended' WHERE id=$1",[first.userId]);
    const second=await login('1');
    expect((await app.inject({url:'/api/v1/me',headers:{cookie:second.cookie}})).json().user.status).toBe('suspended');
    expect((await pools.runtime.query("SELECT count(*)::int n FROM audit_events WHERE action='identity.admin_bootstrapped'")).rows[0].n).toBe(1);
  });
  it('T02 rejects cross-owner Agent, policy, wallet, key, operation and admin access',async()=>{
    const admin=await login('1'),a=await activeMember(admin,'2'),b=await activeMember(admin,'3'),ag=await createAgent(a);
    for(const suffix of ['', '/policy','/wallet','/keys','/transactions']) {
      const result=await app.inject({url:`/api/v1/agents/${ag.id}${suffix}`,headers:{cookie:b.cookie}});
      expect(result.statusCode,result.body).toBe(403);
    }
    const patch=await app.inject({method:'PATCH',url:`/api/v1/agents/${ag.id}`,headers:headers(b),payload:{name:'intrusion'}});
    expect(patch.statusCode).toBe(403);
    const key=await app.inject({method:'POST',url:`/api/v1/agents/${ag.id}/keys`,headers:headers(b),payload:{label:'intrusion'}});
    expect(key.statusCode).toBe(403);
    expect((await app.inject({url:`/api/v1/operations/${ag.operation_id}`,headers:{cookie:b.cookie}})).statusCode).toBe(403);
    expect((await app.inject({url:'/api/v1/admin/users',headers:{cookie:b.cookie}})).statusCode).toBe(403);
    expect((await app.inject({method:'POST',url:'/api/v1/admin/issuances',headers:headers(b),payload:{month:'2026-11-01',amount:'1',reason:'invalid',business_id:randomUUID()}})).statusCode).toBe(403);
    expect((await pools.runtime.query('SELECT count(*)::int n FROM agents')).rows[0].n).toBe(1);
  });
  it('CSRF, foreign Origin, expired session and logout are enforced',async()=>{
    const admin=await login('1');
    for(const invalid of [{cookie:admin.cookie},{...headers(admin),origin:'https://foreign.example'},{...headers(admin),'x-csrf-token':'wrong'}]) {
      const result=await app.inject({method:'POST',url:'/api/v1/agents',headers:invalid,payload:{name:'denied'}});
      expect(result.json().error.code).toBe('CSRF_INVALID');
      const report=await app.inject({method:'POST',url:'/api/v1/admin/reconciliation',headers:invalid,payload:{}});
      expect(report.json().error.code).toBe('CSRF_INVALID');
    }
    expect((await app.inject({method:'POST',url:'/api/v1/auth/logout',headers:headers(admin),payload:{}})).statusCode).toBe(200);
    expect((await app.inject({url:'/api/v1/me',headers:{cookie:admin.cookie}})).statusCode).toBe(401);
    const expired=await login('1');
    await pools.migration.query("UPDATE user_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[expired.sessionId]);
    expect((await app.inject({url:'/api/v1/me',headers:{cookie:expired.cookie}})).statusCode).toBe(401);
  });
  it('T04 keeps one key and no secret in durable receipts when first response is lost',async()=>{
    const admin=await login('1'),ag=await createAgent(admin),key=randomUUID();
    const create=()=>app.inject({method:'POST',url:`/api/v1/agents/${ag.id}/keys`,headers:headers(admin,key),payload:{label:'worker'}});
    const first=(await create()).json(),second=(await create()).json();
    expect(first.secret).toMatch(/^azk_/);expect(second.id).toBe(first.id);expect(second.secret).toBeUndefined();
    expect((await pools.runtime.query('SELECT count(*)::int n FROM agent_keys')).rows[0].n).toBe(1);
    const receipts=await pools.runtime.query('SELECT response_body FROM idempotency_requests');
    expect(JSON.stringify(receipts.rows)).not.toContain(first.secret);
    const operation=await app.inject({url:`/api/v1/operations/${first.operation_id}`,headers:{cookie:admin.cookie}});
    expect(operation.json().result.secret).toBeUndefined();
    const list=await app.inject({url:`/api/v1/agents/${ag.id}/keys`,headers:{cookie:admin.cookie}});
    expect(list.body).not.toContain('secret_hash');expect(list.body).not.toContain(first.secret);
    const conflict=await app.inject({method:'POST',url:`/api/v1/agents/${ag.id}/keys`,headers:headers(admin,key),payload:{label:'other'}});
    expect(conflict.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
    const bearer={authorization:`Bearer ${first.secret}`};
    expect((await app.inject({url:`/api/v1/agents/${ag.id}/wallet`,headers:bearer})).statusCode).toBe(200);
    expect((await app.inject({method:'POST',url:`/api/v1/agents/${ag.id}/keys`,headers:{...bearer,'idempotency-key':randomUUID()},payload:{label:'self elevate'}})).statusCode).toBe(403);
    const revoke=await app.inject({method:'POST',url:`/api/v1/agents/${ag.id}/keys/${first.id}/revoke`,headers:headers(admin),payload:{}});
    expect(revoke.statusCode,revoke.body).toBe(200);
    expect((await app.inject({url:'/api/v1/me',headers:bearer})).json().error.code).toBe('CREDENTIAL_REVOKED');
  });
  it('policy uses optimistic versions and rejects unsafe amounts, with zero defaults',async()=>{
    const admin=await login('1'),ag=await createAgent(admin);
    const initial=(await app.inject({url:`/api/v1/agents/${ag.id}/policy`,headers:{cookie:admin.cookie}})).json();
    expect(initial).toMatchObject({version:'1',single_spend_limit:'0',can_trade:false});
    const policy={version:'1',can_accept_task:true,can_collaborate:false,can_trade:false,can_redeem_api:false,single_spend_limit:'100',daily_spend_limit:'100'};
    const update=()=>app.inject({method:'PUT',url:`/api/v1/agents/${ag.id}/policy`,headers:headers(admin),payload:policy});
    expect((await update()).json().version).toBe('2');
    expect((await update()).json().error.code).toBe('POLICY_VERSION_CONFLICT');
    for(const amount of ['9223372036854775808',100]) {
      const invalid=await app.inject({method:'PUT',url:`/api/v1/agents/${ag.id}/policy`,headers:headers(admin),payload:{...policy,version:'2',single_spend_limit:amount}});
      expect(invalid.statusCode).toBe(400);
    }
  });
  it('T12 bigint survives PostgreSQL, wallet, policy and transaction JSON unchanged',async()=>{
    const admin=await login('1'),ag=await createAgent(admin),amount='9007199254740993';
    const actor:Actor={type:'user',userId:admin.userId,sessionId:admin.sessionId};
    await fund(pools.runtime,actor,ag.id,amount);
    const wallet=await app.inject({url:`/api/v1/agents/${ag.id}/wallet`,headers:{cookie:admin.cookie}});
    expect(wallet.json().available).toBe(amount);
    const transactions=await app.inject({url:`/api/v1/agents/${ag.id}/transactions`,headers:{cookie:admin.cookie}});
    expect(transactions.json().items[0].amount).toBe(amount);
    expect(transactions.json().items[0].entries[0].amount).toBe(amount);
    expect((await app.inject({method:'POST',url:'/api/v1/admin/reconciliation',headers:headers(admin),payload:{}})).json().ok).toBe(true);
  });
  it('HTTP issuance is budgeted, audited, paginated and replayable across request keys',async()=>{
    const admin=await login('1');
    const month=(await pools.runtime.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'Asia/Shanghai','YYYY-MM')||'-01' AS month")).rows[0].month;
    const budget=await app.inject({method:'PUT',url:`/api/v1/admin/issuance-periods/${month}`,headers:headers(admin),payload:{limit_points:'100',reason:'monthly cap'}});
    expect(budget.statusCode,budget.body).toBe(200);
    const payload={month,amount:'80',reason:'monthly issue',business_id:randomUUID()};
    const first=await app.inject({method:'POST',url:'/api/v1/admin/issuances',headers:headers(admin),payload});
    expect(first.statusCode,first.body).toBe(201);
    const replay=await app.inject({method:'POST',url:'/api/v1/admin/issuances',headers:headers(admin),payload});
    expect(replay.statusCode,replay.body).toBe(201);expect(replay.json().transaction_id).toBe(first.json().transaction_id);
    const budgetView=await app.inject({url:`/api/v1/admin/issuance-periods/${month}`,headers:{cookie:admin.cookie}});
    expect(budgetView.json().issued_points).toBe('80');
    const events=await app.inject({url:'/api/v1/admin/audit-events?limit=1',headers:{cookie:admin.cookie}});
    expect(events.json().items).toHaveLength(1);expect(events.json().next_cursor).toBeTruthy();
    const secondPage=await app.inject({url:`/api/v1/admin/audit-events?limit=1&cursor=${events.json().next_cursor}`,headers:{cookie:admin.cookie}});
    expect(secondPage.json().items[0].id).not.toBe(events.json().items[0].id);
  });
});
