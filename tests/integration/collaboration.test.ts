import { randomBytes,randomUUID } from 'node:crypto';
import { afterAll,beforeAll,beforeEach,describe,expect,it } from 'vitest';
import { withTransaction } from '../../packages/database/src/index.js';
import type { Actor } from '../../packages/contracts/src/index.js';
import { buildApp } from '../../apps/api/src/app.js';
import { tokenHash } from '../../apps/api/src/core.js';
import type { GitHubRepositoryProvider,PullRequestEvidence } from '../../apps/api/src/modules/github/provider.js';
import { getWallet,reconcile } from '../../apps/api/src/modules/ledger/service.js';
import { agent,fund,identity,resetLedgerTestData,testPools } from './ledger-fixtures.js';

const pools=testPools(),origin='http://localhost:5173',sha='a'.repeat(40);
type UserActor=Extract<Actor,{type:'user'}>;
type Session={actor:UserActor;cookie:string;csrf:string;githubId:string};
type TestAgent=Awaited<ReturnType<typeof agent>>;
let app:Awaited<ReturnType<typeof buildApp>>;
let admin:Session,publisher:Session,worker:Session,reviewer:Session,helper:Session;
let payer:TestAgent,lead:TestAgent,collaborator:TestAgent,sibling:TestAgent;
let repositoryId:string,evidence:PullRequestEvidence;
const provider:GitHubRepositoryProvider={
  async getInstallation({installationId}) {return {installationId,accountLogin:'collab',status:'active'};},
  async getRepository({owner,name}) {return {repositoryId:'990001',owner,name,fullName:`${owner}/${name}`,isPrivate:false};},
  async getPullRequest({number}) {return {...evidence,number};},
};
async function session(role:'admin'|'member'='member'):Promise<Session> {
  const actor=await identity(pools.runtime,role) as UserActor;
  const token=randomBytes(32).toString('base64url'),csrf=randomBytes(32).toString('base64url');
  await pools.runtime.query('UPDATE user_sessions SET token_hash=$2,csrf_token_hash=$3 WHERE id=$1',[actor.sessionId,tokenHash(token),tokenHash(csrf)]);
  const githubId=(await pools.runtime.query('SELECT github_user_id::text AS id FROM users WHERE id=$1',[actor.userId])).rows[0].id;
  return {actor,cookie:`az_session=${token}; az_csrf=${csrf}`,csrf,githubId};
}
const request=(s:Session,url:string,payload:Record<string,unknown>,key:string=randomUUID())=>app.inject({method:'POST',url,headers:{cookie:s.cookie,origin,'x-csrf-token':s.csrf,'idempotency-key':key},payload});
async function detail(id:string,s=publisher) {
  const result=await app.inject({url:`/api/v1/tasks/${id}`,headers:{cookie:s.cookie}});
  expect(result.statusCode,result.body).toBe(200);return result.json();
}
async function action(id:string,path:string,s:Session,body:Record<string,unknown>={}) {
  return request(s,`/api/v1/tasks/${id}/${path}`,{version:(await detail(id,s)).version,...body});
}
async function ok(id:string,path:string,s:Session,body:Record<string,unknown>={}) {
  const result=await action(id,path,s,body);expect(result.statusCode,result.body).toBeLessThan(300);return result.json();
}
const wallet=(id:string)=>withTransaction(pools.runtime,tx=>getWallet(tx,id));
const conserving=async()=>expect((await withTransaction(pools.runtime,tx=>reconcile(tx))).ok).toBe(true);
const split=(second=collaborator)=>[
  {agent_id:lead.id,role:'主开发',deliverable:'实现 PR',amount_points:'70'},
  {agent_id:second.id,role:'测试',deliverable:'测试记录与回归结果',amount_points:'30'},
];
async function task() {
  const create=await request(publisher,'/api/v1/tasks',{title:'协作闭环',description:'两位 Agent 完成修复与测试',repository_id:repositoryId,acceptance_criteria:'通过 CI',required_checks:['CI'],reward_points:'100',deadline_at:new Date(Date.now()+86400_000).toISOString(),reviewer_user_id:reviewer.actor.userId,payer_agent_id:payer.id});
  expect(create.statusCode,create.body).toBe(201);
  const id=create.json().id as string;
  await ok(id,'publish',publisher);await ok(id,'accept',worker,{agent_id:lead.id});return id;
}
async function propose(id:string,members=split(),deadline=new Date(Date.now()+2*86400_000).toISOString()) {
  await ok(id,'agreements',worker,{members,deadline_at:deadline});return (await detail(id)).agreements[0];
}
async function activate(id:string) {
  const agreement=await propose(id);
  await ok(id,`agreements/${agreement.id}/accept`,publisher,{as_publisher:true});
  await ok(id,`agreements/${agreement.id}/accept`,helper,{agent_id:collaborator.id});return agreement.id as string;
}
async function submit(id:string) {await ok(id,'deliveries',worker,{pr_number:31,head_sha:sha});}
async function settle(id:string) {await ok(id,'reviews',reviewer,{decision:'accept',reason:'协议内成果和测试已满足'});}
beforeAll(async()=>{
  app=await buildApp({pool:pools.runtime,repositoryGithub:provider,config:{databaseUrl:process.env.TEST_DATABASE_URL!,publicOrigin:origin,githubClientId:'test',githubClientSecret:'test',bootstrapAdminGithubId:'',production:false,host:'127.0.0.1',port:3000}});await app.ready();
});
beforeEach(async()=>{
  await resetLedgerTestData(pools.migration);
  admin=await session('admin');publisher=await session();worker=await session();reviewer=await session();helper=await session();
  payer=await agent(pools.runtime,publisher.actor);lead=await agent(pools.runtime,worker.actor);collaborator=await agent(pools.runtime,helper.actor);sibling=await agent(pools.runtime,worker.actor);
  await fund(pools.runtime,admin.actor,payer.id,'1000');repositoryId=randomUUID();
  await pools.migration.query("INSERT INTO github_installations(installation_id,account_login,status) VALUES('9900','collab','active')");
  await pools.migration.query("INSERT INTO repositories(id,github_id,installation_id,owner,name,full_name,is_private,status) VALUES($1,'990001','9900','collab','work','collab/work',false,'approved')",[repositoryId]);
  evidence={repositoryId:'990001',number:31,headSha:sha,authorGithubId:worker.githubId,merged:true,url:'https://github.com/collab/work/pull/31',checks:[{name:'CI',status:'completed',conclusion:'success'}],fetchedAt:new Date().toISOString()};
});
afterAll(async()=>{await app?.close();await pools.runtime.end();await pools.migration.end();});

describe('phase 3 collaboration contracts on PostgreSQL',()=>{
  it('rejects direct-ID invitations to a deleted Agent without creating an agreement, while paused invitees remain eligible',async()=>{
    const id=await task(),before=await detail(id);
    const deleted=await app.inject({method:'DELETE',url:`/api/v1/agents/${collaborator.id}`,
      headers:{cookie:helper.cookie,origin,'x-csrf-token':helper.csrf,'idempotency-key':randomUUID()},payload:{version:'1'}});
    expect(deleted.statusCode,deleted.body).toBe(200);
    const rejected=await action(id,'agreements',worker,{members:split(),deadline_at:new Date(Date.now()+86400_000).toISOString()});
    expect(rejected.statusCode,rejected.body).toBe(400);
    expect(rejected.json().error.code).toBe('INVALID_AGREEMENT');
    expect((await pools.runtime.query('SELECT count(*)::int n FROM collaboration_agreements WHERE task_id=$1',[id])).rows[0].n).toBe(0);
    expect((await pools.runtime.query('SELECT count(*)::int n FROM agreement_members WHERE agent_id=$1',[collaborator.id])).rows[0].n).toBe(0);
    expect((await detail(id)).version).toBe(before.version);
    await pools.runtime.query("UPDATE agents SET status='paused' WHERE id=$1",[sibling.id]);
    expect((await propose(id,split(sibling))).status).toBe('pending');
  });
  it('pending invitation is discoverable but cannot submit, change the deadline or take a share of the old contract',async()=>{
    const id=await task(),before=await detail(id),agreement=await propose(id);
    const pending=await detail(id,helper);
    expect(pending.active_agreement_id).toBeNull();expect(pending.deadline_at).toBe(before.deadline_at);
    expect(pending.participants).toHaveLength(1);expect(pending.agreements[0].can_accept).toBe(true);
    const mine=await app.inject({url:'/api/v1/tasks?mine=true',headers:{cookie:helper.cookie}});
    expect(mine.json().items.map((row:{id:string})=>row.id)).toContain(id);
    expect((await action(id,'contributions',helper,{agent_id:collaborator.id,kind:'note',body:'尚未生效'})).statusCode).toBe(403);
    await submit(id);await settle(id);
    expect(await wallet(lead.id)).toMatchObject({available:'100'});expect(await wallet(collaborator.id)).toMatchObject({available:'0'});
    expect((await detail(id)).agreements.find((row:{id:string})=>row.id===agreement.id).status).toBe('superseded');await conserving();
  });
  it('all parties accept one version, contributors record results, and acceptance pays wallets directly exactly once',async()=>{
    const id=await task(),agreement=await propose(id);
    await ok(id,`agreements/${agreement.id}/accept`,helper,{agent_id:collaborator.id});
    expect((await detail(id)).active_agreement_id).toBeNull();
    await ok(id,`agreements/${agreement.id}/accept`,publisher,{as_publisher:true});
    const active=await detail(id);expect(active.active_agreement_id).toBe(agreement.id);expect(active.participants).toHaveLength(2);
    await ok(id,'contributions',helper,{agent_id:collaborator.id,kind:'test',body:'CI 及错误路径已验证',url:'https://github.com/collab/work/actions/runs/1'});
    expect((await detail(id)).contributions[0]).toMatchObject({agent_id:collaborator.id,agreement_id:agreement.id});
    await submit(id);await settle(id);await settle(id);
    expect(await wallet(lead.id)).toMatchObject({available:'70'});expect(await wallet(collaborator.id)).toMatchObject({available:'30'});expect(await wallet(payer.id)).toMatchObject({available:'900',reserved:'0'});
    expect((await pools.runtime.query("SELECT count(*)::int n FROM journal_transactions j JOIN tasks t ON j.business_key='hold:'||t.hold_id||':finalize' WHERE t.id=$1",[id])).rows[0].n).toBe(1);await conserving();
  });
  it('rejects invalid sums, duplicate members, nesting, a fourth member, reviewer ownership and unauthorized confirmation',async()=>{
    const id=await task(),reviewerAgent=await agent(pools.runtime,reviewer.actor);
    for(const members of [[...split(),...split()],split().map(m=>({...m,amount_points:'40'})),[split()[0]!,{...split()[1]!,agent_id:lead.id}],split(reviewerAgent)]) {
      expect([400,409]).toContain((await action(id,'agreements',worker,{members,deadline_at:new Date(Date.now()+86400_000).toISOString()})).statusCode);
    }
    const agreement=await propose(id);
    expect((await action(id,`agreements/${agreement.id}/accept`,reviewer,{agent_id:collaborator.id})).statusCode).toBe(403);
    await pools.runtime.query('UPDATE agent_policies SET can_collaborate=false WHERE agent_id=$1',[collaborator.id]);
    expect((await action(id,`agreements/${agreement.id}/accept`,helper,{agent_id:collaborator.id})).statusCode).toBe(403);
    await pools.runtime.query('UPDATE agent_policies SET can_collaborate=true WHERE agent_id=$1',[collaborator.id]);
    await ok(id,`agreements/${agreement.id}/accept`,helper,{agent_id:collaborator.id});await ok(id,`agreements/${agreement.id}/accept`,publisher,{as_publisher:true});
    expect((await action(id,'agreements',helper,{members:split(),deadline_at:new Date(Date.now()+86400_000).toISOString()})).statusCode).toBe(403);
    expect(await wallet(payer.id)).toMatchObject({reserved:'100'});await conserving();
  });
  it('a replacement retains the effective agreement until removed and new members plus publisher agree; rejection preserves it',async()=>{
    const id=await task(),old=await activate(id),replacement=await propose(id,split(sibling));
    await ok(id,`agreements/${replacement.id}/accept`,worker,{agent_id:sibling.id});await ok(id,`agreements/${replacement.id}/accept`,publisher,{as_publisher:true});
    expect((await detail(id)).active_agreement_id).toBe(old);
    await ok(id,`agreements/${replacement.id}/reject`,helper,{agent_id:collaborator.id,reason:'尚未同意退出报酬'});
    expect((await detail(id)).active_agreement_id).toBe(old);
    const next=await propose(id,split(sibling));
    await ok(id,`agreements/${next.id}/accept`,worker,{agent_id:sibling.id});await ok(id,`agreements/${next.id}/accept`,publisher,{as_publisher:true});
    await pools.runtime.query("UPDATE agents SET status='paused' WHERE id=$1",[collaborator.id]);
    await pools.runtime.query('UPDATE agent_policies SET can_collaborate=false WHERE agent_id=$1',[collaborator.id]);
    await ok(id,`agreements/${next.id}/accept`,helper,{agent_id:collaborator.id});
    const current=await detail(id);expect(current.active_agreement_id).toBe(next.id);expect(current.participants.every((p:{shared_owner:boolean})=>p.shared_owner)).toBe(true);
    expect((await action(id,'contributions',helper,{agent_id:collaborator.id,kind:'note',body:'已退出'})).statusCode).toBe(403);
    await submit(id);await settle(id);expect(await wallet(sibling.id)).toMatchObject({available:'30'});expect(await wallet(collaborator.id)).toMatchObject({available:'0'});await conserving();
  });
  it('three members, including common owners, confirm each Agent explicitly and payment is conserved',async()=>{
    const id=await task(),members=[{...split()[0]!,amount_points:'60'},{...split()[1]!,amount_points:'25'},{agent_id:sibling.id,role:'文档',deliverable:'操作说明',amount_points:'15'}],agreement=await propose(id,members);
    await ok(id,`agreements/${agreement.id}/accept`,publisher,{as_publisher:true});await ok(id,`agreements/${agreement.id}/accept`,helper,{agent_id:collaborator.id});
    expect((await detail(id)).active_agreement_id).toBeNull();
    await ok(id,`agreements/${agreement.id}/accept`,worker,{agent_id:sibling.id});await submit(id);await settle(id);
    expect(await wallet(lead.id)).toMatchObject({available:'60'});expect(await wallet(collaborator.id)).toMatchObject({available:'25'});expect(await wallet(sibling.id)).toMatchObject({available:'15'});await conserving();
  });
  it('activation rechecks permissions after earlier consent and cannot extend a contract that has already expired',async()=>{
    const id=await task(),agreement=await propose(id);
    await ok(id,`agreements/${agreement.id}/accept`,helper,{agent_id:collaborator.id});
    await pools.runtime.query('UPDATE agent_policies SET can_collaborate=false WHERE agent_id=$1',[collaborator.id]);
    expect((await action(id,`agreements/${agreement.id}/accept`,publisher,{as_publisher:true})).statusCode).toBe(403);
    expect((await detail(id)).active_agreement_id).toBeNull();
    await pools.runtime.query('UPDATE agent_policies SET can_collaborate=true WHERE agent_id=$1',[collaborator.id]);
    await pools.migration.query("UPDATE tasks SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1",[id]);
    expect((await action(id,`agreements/${agreement.id}/accept`,publisher,{as_publisher:true})).statusCode).toBe(409);
    expect((await detail(id)).active_agreement_id).toBeNull();expect(await wallet(payer.id)).toMatchObject({reserved:'100'});await conserving();
  });
  it('partial cancellation names every effective payee and waits for every confirmation',async()=>{
    const id=await task();await activate(id);
    expect((await action(id,'cancellation-proposals',publisher,{payment_points:'40',refund_points:'60',reason:'缺少各成员分配'})).statusCode).toBe(400);
    await ok(id,'cancellation-proposals',publisher,{payment_points:'40',refund_points:'60',payments:[{agent_id:lead.id,amount_points:'30'},{agent_id:collaborator.id,amount_points:'10'}],reason:'停止并支付已完成部分'});
    const proposal=(await detail(id)).cancellation_proposals[0];
    await ok(id,`cancellation-proposals/${proposal.id}/accept`,worker,{agent_id:lead.id});
    expect((await detail(id)).status).toBe('in_progress');expect(await wallet(payer.id)).toMatchObject({reserved:'100'});
    await pools.runtime.query("UPDATE agents SET status='paused' WHERE id=$1",[collaborator.id]);
    await ok(id,`cancellation-proposals/${proposal.id}/accept`,helper,{agent_id:collaborator.id});
    expect((await detail(id)).status).toBe('cancelled');expect(await wallet(lead.id)).toMatchObject({available:'30'});expect(await wallet(collaborator.id)).toMatchObject({available:'10'});expect(await wallet(payer.id)).toMatchObject({available:'960',reserved:'0'});await conserving();
  });
  it('administrator settlement follows the active split and conflicts include every collaborator',async()=>{
    const id=await task();await activate(id);await submit(id);await ok(id,'disputes',helper,{reason:'需要核对协作证据'});
    await pools.migration.query("UPDATE users SET role='admin' WHERE id=$1",[helper.actor.userId]);
    let current=await detail(id);
    const payload={version:current.version,outcome:'cancelled',payment_points:'40',refund_points:'60',payments:[{agent_id:lead.id,amount_points:'30'},{agent_id:collaborator.id,amount_points:'10'}],reason:'裁定部分工作'};
    expect((await request(helper,`/api/v1/admin/tasks/${id}/resolve`,payload)).statusCode).toBe(409);
    current=await detail(id);
    expect((await request(admin,`/api/v1/admin/tasks/${id}/resolve`,{...payload,version:current.version,outcome:'settled',payment_points:'100',refund_points:'0',payments:[{agent_id:lead.id,amount_points:'100'},{agent_id:collaborator.id,amount_points:'0'}]})).statusCode).toBe(400);
    const resolved=await request(admin,`/api/v1/admin/tasks/${id}/resolve`,{...payload,version:current.version});expect(resolved.statusCode,resolved.body).toBe(200);
    expect(await wallet(collaborator.id)).toMatchObject({available:'10'});await conserving();
  });
  it('concurrent confirmations use task versions and replay the same accepted command without duplicate activation',async()=>{
    const id=await task(),agreement=await propose(id),version=(await detail(id)).version;
    const responses=await Promise.all([request(publisher,`/api/v1/tasks/${id}/agreements/${agreement.id}/accept`,{version,as_publisher:true}),request(helper,`/api/v1/tasks/${id}/agreements/${agreement.id}/accept`,{version,agent_id:collaborator.id})]);
    expect(responses.filter(r=>r.statusCode===200)).toHaveLength(1);expect(responses.filter(r=>r.statusCode===409)).toHaveLength(1);
    const pending=(await detail(id)).agreements[0].confirmations.find((c:{accepted_at:string|null})=>!c.accepted_at),s=pending.subject_key==='publisher'?publisher:helper;
    const key=randomUUID(),body={version:(await detail(id)).version,...(pending.subject_key==='publisher'?{as_publisher:true}:{agent_id:collaborator.id})};
    const first=await request(s,`/api/v1/tasks/${id}/agreements/${agreement.id}/accept`,body,key),replayed=await request(s,`/api/v1/tasks/${id}/agreements/${agreement.id}/accept`,body,key);
    expect(first.statusCode,first.body).toBe(200);expect(replayed.json()).toEqual(first.json());expect((await detail(id)).agreements.filter((a:{status:string})=>a.status==='active')).toHaveLength(1);await conserving();
  });
  it('a settlement failure rolls back all member credits, PR reward and receipt, and the same request can recover',async()=>{
    const id=await task();await activate(id);await submit(id);
    await pools.migration.query(`CREATE FUNCTION public.reject_test_collaboration() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='settled' THEN RAISE EXCEPTION 'isolated collaboration failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_test_collaboration BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION public.reject_test_collaboration()`);
    const key=randomUUID(),body={version:(await detail(id)).version,decision:'accept',reason:'验收完成'};
    try {
      expect((await request(reviewer,`/api/v1/tasks/${id}/reviews`,body,key)).statusCode).toBe(500);
      expect(await wallet(lead.id)).toMatchObject({available:'0'});expect(await wallet(collaborator.id)).toMatchObject({available:'0'});expect(await wallet(payer.id)).toMatchObject({reserved:'100'});
      expect((await pools.runtime.query('SELECT count(*)::int n FROM idempotency_requests WHERE idempotency_key=$1',[key])).rows[0].n).toBe(0);await conserving();
    } finally {await pools.migration.query('DROP TRIGGER reject_test_collaboration ON tasks; DROP FUNCTION public.reject_test_collaboration()');}
    const recovered=await request(reviewer,`/api/v1/tasks/${id}/reviews`,body,key);expect(recovered.statusCode,recovered.body).toBe(200);expect(await wallet(collaborator.id)).toMatchObject({available:'30'});await conserving();
  });
});
