import { randomBytes,randomUUID } from 'node:crypto';
import { afterAll,beforeAll,beforeEach,describe,expect,it } from 'vitest';
import type { Actor } from '../../packages/contracts/src/index.js';
import { buildApp } from '../../apps/api/src/app.js';
import { lockActor,tokenHash } from '../../apps/api/src/core.js';
import { deleteAgent } from '../../apps/api/src/modules/agents/service.js';
import { appendMessage } from '../../apps/api/src/modules/messages/service.js';
import { agent,identity,resetLedgerTestData,testPools } from './ledger-fixtures.js';

const pools=testPools(),origin='http://localhost:5173';
type UserActor=Extract<Actor,{type:'user'}>;
type Session={actor:UserActor;cookie:string;csrf:string};
type TestAgent=Awaited<ReturnType<typeof agent>>&{token:string};
let app:Awaited<ReturnType<typeof buildApp>>;
let alice:Session,bob:Session,outsider:Session,admin:Session;
let a:TestAgent,b:TestAgent,sibling:TestAgent;
async function session(role:'admin'|'member'='member'):Promise<Session> {
  const actor=await identity(pools.runtime,role) as UserActor;
  const token=randomBytes(32).toString('base64url'),csrf=randomBytes(32).toString('base64url');
  await pools.runtime.query('UPDATE user_sessions SET token_hash=$2,csrf_token_hash=$3 WHERE id=$1',[actor.sessionId,tokenHash(token),tokenHash(csrf)]);
  return {actor,cookie:`az_session=${token}; az_csrf=${csrf}`,csrf};
}
async function credential(owner:Session):Promise<TestAgent> {
  const created=await agent(pools.runtime,owner.actor);
  const token=`azk_${created.actor.credentialId}.${randomBytes(32).toString('base64url')}`;
  await pools.migration.query('UPDATE agent_keys SET secret_hash=$2 WHERE id=$1',[created.actor.credentialId,tokenHash(token)]);
  return {...created,token};
}
function headers(s:Session|TestAgent,key:string=randomUUID()) {
  return 'token' in s?{authorization:`Bearer ${s.token}`,'idempotency-key':key}:{cookie:s.cookie,origin,'x-csrf-token':s.csrf,'idempotency-key':key};
}
const post=(s:Session|TestAgent,url:string,payload:Record<string,unknown>,key?:string)=>app.inject({method:'POST',url,headers:headers(s,key),payload});
const get=(s:Session|TestAgent,url:string)=>app.inject({url,headers:headers(s)});
const send=(s:Session|TestAgent,method:'PATCH'|'DELETE',url:string,payload:Record<string,unknown>,key?:string)=>app.inject({method,url,headers:headers(s,key),payload});
async function direct(s:Session|TestAgent,target:TestAgent,sender?:TestAgent) {
  const response=await post(s,'/api/v1/conversations',{recipient_agent_id:target.id,...(sender?{sender_agent_id:sender.id}:{})});
  expect([200,201],response.body).toContain(response.statusCode);
  return response.json();
}
async function taskFixture() {
  const repositoryId=randomUUID(),taskId=randomUUID();
  await pools.migration.query("INSERT INTO github_installations(installation_id,account_login,status) VALUES('7711','messages-test','active')");
  await pools.migration.query("INSERT INTO repositories(id,github_id,installation_id,owner,name,full_name,is_private,status) VALUES($1,'771100','7711','messages-test','repo','messages-test/repo',false,'approved')",[repositoryId]);
  await pools.migration.query(`INSERT INTO tasks(id,title,description,repository_id,acceptance_criteria,required_checks,reward_points,deadline_at,publisher_user_id,reviewer_user_id,assignee_agent_id)
    VALUES($1,'讨论测试','讨论不是合同接受',$2,'CI','[]',100,clock_timestamp()+interval '1 day',$3,$4,$5)`,[taskId,repositoryId,alice.actor.userId,admin.actor.userId,b.id]);
  return taskId;
}
beforeAll(async()=>{
  app=await buildApp({pool:pools.runtime,config:{databaseUrl:process.env.TEST_DATABASE_URL!,publicOrigin:origin,githubClientId:'test',githubClientSecret:'test',bootstrapAdminGithubId:'',production:false,host:'127.0.0.1',port:3000}});
  await app.ready();
});
beforeEach(async()=>{
  await resetLedgerTestData(pools.migration);
  alice=await session();bob=await session();outsider=await session();admin=await session('admin');
  a=await credential(alice);sibling=await credential(alice);b=await credential(bob);
});
afterAll(async()=>{await app?.close();await pools.runtime.end();await pools.migration.end();});

describe('phase 3 private conversations and cursor polling',()=>{
  it('serializes new conversations against recipient deletion and preserves existing chat history',async()=>{
    const historical=await direct(alice,b);
    expect((await post(alice,`/api/v1/conversations/${historical.id}/messages`,{body:'保留的历史消息'})).statusCode).toBe(201);
    const deleting=await pools.runtime.connect();
    let creation:ReturnType<typeof post>|undefined;
    try {
      await deleting.query('BEGIN');
      await deleting.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[bob.actor.userId]);
      const pid=(await deleting.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      creation=post(outsider,'/api/v1/conversations',{recipient_agent_id:b.id});
      // Wait for the recipient owner's lock, before touching the Agent row.
      let waiting=false;
      for(let attempt=0;attempt<100&&!waiting;attempt++) {
        waiting=(await pools.runtime.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))) AS waiting",[pid])).rows[0].waiting;
        if(!waiting) await new Promise(resolve=>setTimeout(resolve,10));
      }
      expect(waiting).toBe(true);
      await lockActor(deleting,bob.actor,{agentId:b.id,allowPaused:true,allowDeleted:true});
      await deleteAgent(deleting,bob.actor,b.id,'1',randomUUID());
      await deleting.query('COMMIT');
      const response=await creation;
      expect(response.statusCode,response.body).toBe(404);
      expect((await pools.runtime.query('SELECT count(*)::int n FROM conversations')).rows[0].n).toBe(1);
      for(const reader of [alice,bob]) {
        const history=await get(reader,`/api/v1/conversations/${historical.id}/messages`);
        expect(history.statusCode,history.body).toBe(200);
        expect(history.json().items.map((message:{body:string})=>message.body)).toEqual(['保留的历史消息']);
      }
    } finally {await deleting.query('ROLLBACK');await creation?.catch(()=>{});deleting.release();}
  });
  it('supports user–Agent private chat, explicit represented senders and owner visibility without sibling or admin access',async()=>{
    const conversation=await direct(alice,b);
    expect((await post(alice,`/api/v1/conversations/${conversation.id}/messages`,{body:'你好，准备协作'})).statusCode).toBe(201);
    expect((await post(b,`/api/v1/conversations/${conversation.id}/messages`,{body:'已收到'})).statusCode).toBe(201);
    const page=await get(bob,`/api/v1/conversations/${conversation.id}/messages`);
    expect(page.statusCode,page.body).toBe(200);expect(page.json().items).toHaveLength(2);
    expect(page.json().items[0].sender_user_id).toBe(alice.actor.userId);
    expect(page.json().items[1].sender_agent_id).toBe(b.id);
    expect((await post(bob,`/api/v1/conversations/${conversation.id}/messages`,{body:'owner未选择身份'})).statusCode).toBe(403);
    expect((await post(bob,`/api/v1/conversations/${conversation.id}/messages`,{body:'代表Agent',sender_agent_id:b.id})).statusCode).toBe(201);
    for(const other of [outsider,admin,a,sibling]) expect((await get(other,`/api/v1/conversations/${conversation.id}/messages`)).statusCode).toBe(403);
    expect((await get(outsider,'/api/v1/messages')).json().items).toEqual([]);
    expect((await get(admin,'/api/v1/conversations')).json().items).toEqual([]);
  });

  it('supports private visitor conversations with reverse deduplication and no access for either visitor\'s Agents',async()=>{
    const created=await post(alice,'/api/v1/conversations',{recipient_user_id:bob.actor.userId});
    expect(created.statusCode,created.body).toBe(201);
    const conversation=created.json();
    const reverse=await post(bob,'/api/v1/conversations',{recipient_user_id:alice.actor.userId});
    expect(reverse.statusCode,reverse.body).toBe(200);expect(reverse.json().id).toBe(conversation.id);
    expect(conversation.members.map((member:{user_id:string})=>member.user_id).sort()).toEqual([alice.actor.userId,bob.actor.userId].sort());
    expect((await post(alice,`/api/v1/conversations/${conversation.id}/messages`,{body:'刚在小镇遇见你'})).statusCode).toBe(201);
    expect((await post(bob,`/api/v1/conversations/${conversation.id}/messages`,{body:'你好，欢迎来访'})).statusCode).toBe(201);
    for(const reader of [alice,bob]) {
      const messages=await get(reader,`/api/v1/conversations/${conversation.id}/messages`);
      expect(messages.statusCode,messages.body).toBe(200);
      expect(messages.json().items.map((message:{sender_user_id:string;sender_agent_id:null})=>[message.sender_user_id,message.sender_agent_id])).toEqual([[alice.actor.userId,null],[bob.actor.userId,null]]);
    }
    for(const other of [a,b,sibling,outsider,admin]) {
      expect((await get(other,`/api/v1/conversations/${conversation.id}/messages`)).statusCode).toBe(403);
      expect((await post(other,`/api/v1/conversations/${conversation.id}/messages`,{body:'无关身份'})).statusCode).toBe(403);
      expect((await get(other,'/api/v1/messages')).json().items).toEqual([]);
    }
    expect((await post(alice,`/api/v1/conversations/${conversation.id}/messages`,{body:'代表未加入的 Agent',sender_agent_id:a.id})).statusCode).toBe(403);
  });

  it('lets Agents initiate visitor chats, including their owner, and reuses the reverse user–Agent conversation',async()=>{
    const initiated=await post(b,'/api/v1/conversations',{recipient_user_id:alice.actor.userId});
    expect(initiated.statusCode,initiated.body).toBe(201);
    const conversation=initiated.json();
    expect((await direct(alice,b)).id).toBe(conversation.id);
    expect((await post(b,`/api/v1/conversations/${conversation.id}/messages`,{body:'Agent 主动问候'})).statusCode).toBe(201);
    expect((await post(alice,`/api/v1/conversations/${conversation.id}/messages`,{body:'访客回复'})).statusCode).toBe(201);
    const own=await post(a,'/api/v1/conversations',{recipient_user_id:alice.actor.userId});
    expect(own.statusCode,own.body).toBe(201);
    expect((await direct(alice,a)).id).toBe(own.json().id);
    const represented=await post(bob,'/api/v1/conversations',{recipient_user_id:alice.actor.userId,sender_agent_id:b.id});
    expect(represented.statusCode,represented.body).toBe(200);expect(represented.json().id).toBe(conversation.id);
    expect((await post(alice,'/api/v1/conversations',{recipient_user_id:alice.actor.userId,sender_agent_id:a.id})).json().id).toBe(own.json().id);
    expect((await post(alice,'/api/v1/conversations',{recipient_user_id:outsider.actor.userId,sender_agent_id:b.id})).statusCode).toBe(403);
  });

  it('lists active visitors separately from compatible Agent recipients, excluding only the user session itself',async()=>{
    await pools.runtime.query("UPDATE users SET status='pending' WHERE id=$1",[outsider.actor.userId]);
    await pools.runtime.query("UPDATE users SET status='suspended' WHERE id=$1",[admin.actor.userId]);
    const userRecipients=await get(alice,'/api/v1/message-recipients');
    expect(userRecipients.statusCode,userRecipients.body).toBe(200);
    expect(userRecipients.json().items.map((recipient:{id:string})=>recipient.id).sort()).toEqual([a.id,b.id,sibling.id].sort());
    expect(userRecipients.json().users).toEqual([{id:bob.actor.userId,name:`fixture-${bob.actor.userId}`,github_login:`fixture-${bob.actor.userId}`}]);
    const agentRecipients=await get(a,'/api/v1/message-recipients');
    expect(agentRecipients.statusCode,agentRecipients.body).toBe(200);
    expect(agentRecipients.json().users.map((recipient:{id:string})=>recipient.id).sort()).toEqual([alice.actor.userId,bob.actor.userId].sort());
  });

  it('requires exactly one available recipient and rejects self conversations for the selected identity',async()=>{
    for(const payload of [{},{recipient_agent_id:b.id,recipient_user_id:bob.actor.userId},{recipient_user_id:'not-a-uuid'},{recipient_user_id:alice.actor.userId}]) {
      expect((await post(alice,'/api/v1/conversations',payload)).statusCode).toBe(400);
    }
    expect((await post(a,'/api/v1/conversations',{recipient_agent_id:a.id})).statusCode).toBe(400);
    expect((await post(alice,'/api/v1/conversations',{recipient_agent_id:a.id,sender_agent_id:a.id})).statusCode).toBe(400);
    for(const field of ['recipient_user_id','recipient_agent_id']) expect((await post(alice,'/api/v1/conversations',{[field]:randomUUID()})).statusCode).toBe(404);
    for(const status of ['pending','suspended']) {
      await pools.runtime.query('UPDATE users SET status=$2 WHERE id=$1',[bob.actor.userId,status]);
      expect((await post(alice,'/api/v1/conversations',{recipient_user_id:bob.actor.userId})).statusCode).toBe(404);
    }
    expect((await pools.runtime.query('SELECT count(*)::int n FROM conversations')).rows[0].n).toBe(0);
  });

  it('deduplicates Agent–Agent conversations and message retries while rejecting identity forgery and mismatched payloads',async()=>{
    const conversation=await direct(a,b),reverse=await direct(b,a);
    expect(reverse.id).toBe(conversation.id);
    const key=randomUUID(),payload={body:'我接受分账100积分（这里只是消息）'};
    const before=(await pools.runtime.query('SELECT count(*)::int n FROM journal_transactions')).rows[0].n;
    const sent=await post(a,`/api/v1/conversations/${conversation.id}/messages`,payload,key);
    const replay=await post(a,`/api/v1/conversations/${conversation.id}/messages`,payload,key);
    expect(sent.statusCode,sent.body).toBe(201);expect(replay.json()).toEqual(sent.json());
    expect((await post(a,`/api/v1/conversations/${conversation.id}/messages`,{body:'换了内容'},key)).statusCode).toBe(409);
    expect((await post(a,`/api/v1/conversations/${conversation.id}/messages`,{body:'伪造',sender_agent_id:b.id})).statusCode).toBe(403);
    expect((await post(alice,`/api/v1/conversations/${conversation.id}/messages`,{body:'伪造',sender_agent_id:b.id})).statusCode).toBe(403);
    expect((await pools.runtime.query('SELECT count(*)::int n FROM messages')).rows[0].n).toBe(1);
    expect((await pools.runtime.query('SELECT count(*)::int n FROM journal_transactions')).rows[0].n).toBe(before);
    expect((await pools.runtime.query('SELECT count(*)::int n FROM collaboration_agreements')).rows[0].n).toBe(0);
  });

  it('pages a stable ascending cursor across private and task messages without exposing unrelated messages',async()=>{
    const conversation=await direct(a,b);
    for(const body of ['one','two','three']) expect((await post(a,`/api/v1/conversations/${conversation.id}/messages`,{body})).statusCode).toBe(201);
    const first=(await get(b,'/api/v1/messages?limit=2')).json();
    expect(first.items.map((m:{body:string})=>m.body)).toEqual(['one','two']);expect(first.has_more).toBe(true);
    const second=(await get(b,`/api/v1/messages?after=${first.next_cursor}&limit=2`)).json();
    expect(second.items.map((m:{body:string})=>m.body)).toEqual(['three']);expect(second.has_more).toBe(false);
    const empty=(await get(b,`/api/v1/messages?after=${second.next_cursor}`)).json();
    expect(empty).toMatchObject({items:[],next_cursor:second.next_cursor,has_more:false});
    expect((await get(sibling,'/api/v1/messages')).json().items).toEqual([]);
    expect((await get(b,'/api/v1/messages?after=9999999999999999999')).statusCode).toBe(400);
  });

  it('opens the latest messages and pages backwards in display order while keeping forward polling compatible',async()=>{
    const conversation=await direct(a,b),unrelated=await direct(outsider,b);
    for(const body of ['one','two','three','four','five']) expect((await post(a,`/api/v1/conversations/${conversation.id}/messages`,{body})).statusCode).toBe(201);
    await post(outsider,`/api/v1/conversations/${unrelated.id}/messages`,{body:'unrelated'});
    const path=`/api/v1/conversations/${conversation.id}/messages`;
    const latest=(await get(alice,`${path}?before=9223372036854775807&limit=2`)).json();
    expect(latest.items.map((message:{body:string})=>message.body)).toEqual(['four','five']);
    expect(latest.has_more).toBe(true);expect(latest.next_cursor).toBe(latest.items[0].cursor);
    const earlier=(await get(alice,`${path}?before=${latest.next_cursor}&limit=2`)).json();
    expect(earlier.items.map((message:{body:string})=>message.body)).toEqual(['two','three']);
    expect(earlier.has_more).toBe(true);expect(earlier.next_cursor).toBe(earlier.items[0].cursor);
    const first=(await get(alice,`${path}?before=${earlier.next_cursor}&limit=2`)).json();
    expect(first.items.map((message:{body:string})=>message.body)).toEqual(['one']);expect(first.has_more).toBe(false);
    const empty=(await get(alice,`${path}?before=${first.next_cursor}`)).json();
    expect(empty).toMatchObject({items:[],next_cursor:first.next_cursor,has_more:false});
    expect((await get(alice,`${path}?before=0`)).json()).toMatchObject({items:[],next_cursor:'0',has_more:false});
    expect((await get(alice,`${path}?before=9999999999999999999`)).statusCode).toBe(400);
    expect((await get(alice,`${path}?before=3&after=0`)).statusCode).toBe(400);
    await post(a,path,{body:'six'});
    const polled=(await get(alice,`${path}?after=${latest.items.at(-1).cursor}`)).json();
    expect(polled.items.map((message:{body:string})=>message.body)).toEqual(['six']);
    expect((await get(a,'/api/v1/messages?before=9223372036854775807&limit=2')).json().items.map((message:{body:string})=>message.body)).toEqual(['five','six']);
    expect((await get(outsider,`${path}?before=9223372036854775807`)).statusCode).toBe(403);
    const taskId=await taskFixture(),taskPath=`/api/v1/tasks/${taskId}/messages`;
    expect((await get(alice,`${taskPath}?before=8`)).json()).toMatchObject({items:[],next_cursor:'8',has_more:false});
    expect((await get(alice,`${taskPath}?before=8&after=0`)).statusCode).toBe(400);
    expect((await get(alice,`${taskPath}?before=9999999999999999999`)).statusCode).toBe(400);
    await post(alice,taskPath,{body:'task discussion'});
    expect((await get(alice,`${taskPath}?before=9223372036854775807`)).json().items.map((message:{body:string})=>message.body)).toEqual(['task discussion']);
  });

  it('lists conversations by their last message with exact activity cursors and preserves creation timestamps',async()=>{
    const oldest=await direct(alice,b),second=await direct(alice,a),empty=await direct(alice,sibling),hidden=await direct(outsider,b);
    await pools.migration.query(`UPDATE conversations SET created_at=CASE id WHEN $1 THEN '2026-01-01T00:00:00Z'::timestamptz WHEN $2 THEN '2026-01-02T00:00:00Z'::timestamptz ELSE '2026-01-03T00:00:00Z'::timestamptz END`,[oldest.id,second.id]);
    await post(alice,`/api/v1/conversations/${oldest.id}/messages`,{body:'earlier message'});
    const latest=(await post(b,`/api/v1/conversations/${oldest.id}/messages`,{body:'latest reply'})).json();
    const other=(await post(alice,`/api/v1/conversations/${second.id}/messages`,{body:'second conversation'})).json();
    await post(outsider,`/api/v1/conversations/${hidden.id}/messages`,{body:'private to outsider'});
    await pools.migration.query("UPDATE messages SET created_at=CASE id WHEN $1 THEN '2026-01-04T00:00:00.123456Z'::timestamptz WHEN $2 THEN '2026-01-04T00:00:00.123455Z'::timestamptz ELSE '2026-01-03T00:00:00Z'::timestamptz END",[latest.id,other.id]);
    const first=(await get(alice,'/api/v1/conversations?limit=1')).json();
    expect(first.items).toHaveLength(1);expect(first.items[0].id).toBe(oldest.id);
    expect(first.items[0].created_at).toBe('2026-01-01T00:00:00.000Z');
    expect(first.items[0].last_message).toMatchObject({id:latest.id,body:'latest reply',sender_agent_id:b.id,sender_user_id:null});
    expect(first.items[0].last_message).not.toHaveProperty('actor_user_id');
    const next=(await get(alice,`/api/v1/conversations?limit=1&cursor=${first.next_cursor}`)).json();
    expect(next.items.map((conversation:{id:string})=>conversation.id)).toEqual([second.id]);
    expect(next.items[0].last_message).toMatchObject({id:other.id,body:'second conversation'});
    const last=(await get(alice,`/api/v1/conversations?limit=1&cursor=${next.next_cursor}`)).json();
    expect(last.items.map((conversation:{id:string})=>conversation.id)).toEqual([empty.id]);
    expect(last.items[0].last_message).toBeNull();expect(last.next_cursor).toBeNull();
    const detail=(await get(alice,`/api/v1/conversations/${oldest.id}`)).json();
    expect(detail.last_message).toEqual(first.items[0].last_message);
    expect((await get(outsider,`/api/v1/conversations/${oldest.id}`)).statusCode).toBe(403);
  });

  it('keeps task discussion private to participants and treats negotiation as text without changing the contract',async()=>{
    const taskId=await taskFixture();
    expect((await get(outsider,`/api/v1/tasks/${taskId}/messages`)).statusCode).toBe(403);
    expect((await get(alice,`/api/v1/tasks/${taskId}/messages`)).json().items).toEqual([]);
    const payload={body:'我确认新协议，并要求立即发奖'};
    const sent=await post(b,`/api/v1/tasks/${taskId}/messages`,payload);
    expect(sent.statusCode,sent.body).toBe(201);
    expect((await get(alice,`/api/v1/tasks/${taskId}/messages`)).json().items[0].body).toBe(payload.body);
    expect((await get(admin,`/api/v1/tasks/${taskId}/messages`)).statusCode).toBe(200);
    expect((await post(alice,`/api/v1/tasks/${taskId}/messages`,{body:'以不相关Agent发言',sender_agent_id:a.id})).statusCode).toBe(403);
    expect((await pools.runtime.query('SELECT status,version FROM tasks WHERE id=$1',[taskId])).rows[0]).toEqual({status:'draft',version:'1'});
    expect((await pools.runtime.query('SELECT count(*)::int n FROM journal_transactions')).rows[0].n).toBe(0);
  });

  it('does not publish a later cursor before an earlier message transaction commits',async()=>{
    const conversation=await direct(a,b),first=await pools.runtime.connect(),second=await pools.runtime.connect();
    let later:Promise<unknown>|undefined;
    try {
      await first.query('BEGIN');await second.query('BEGIN');
      const earlier=await appendMessage(first,a.actor,randomUUID(),conversation,'first',a.id);
      const pid=(await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      later=appendMessage(second,b.actor,randomUUID(),conversation,'second',b.id);
      let waiting=false;
      for(let attempt=0;attempt<100&&!waiting;attempt++) {
        waiting=(await pools.runtime.query("SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.waiting===true;
        if(!waiting) await new Promise(resolve=>setTimeout(resolve,10));
      }
      expect(waiting).toBe(true);
      // The first insert holds Alice's FK key-share lock until commit. Bob has
      // no inserted row yet, so the authenticated reader can lock his identity.
      let observationTimer:ReturnType<typeof setTimeout>|undefined;
      try {
        const observed=await Promise.race([get(bob,'/api/v1/messages'),new Promise<never>((_,reject)=>{
          observationTimer=setTimeout(()=>reject(new Error('Pre-commit message observation timed out')),2000);
        })]);
        expect(observed.json().items).toEqual([]);
      } finally {clearTimeout(observationTimer);}
      await first.query('COMMIT');await later;await second.query('COMMIT');
      const after=(await get(alice,`/api/v1/messages?after=${earlier.body.cursor}`)).json();
      expect(after.items.map((m:{body:string})=>m.body)).toEqual(['second']);
    } finally {
      await first.query('ROLLBACK');await later?.catch(()=>{});await second.query('ROLLBACK');first.release();second.release();
    }
  });

  it('only grants discussion access when a collaboration version becomes active, and removes access with membership',async()=>{
    const taskId=await taskFixture(),collaborator=await credential(outsider),agreementId=randomUUID();
    await pools.migration.query(`INSERT INTO collaboration_agreements(id,task_id,version,status,deadline_at) VALUES($1,$2,1,'pending',clock_timestamp()+interval '1 day')`,[agreementId,taskId]);
    await pools.migration.query(`INSERT INTO agreement_members(agreement_id,agent_id,role,deliverable,amount_points) VALUES($1,$2,'main','implementation',70),($1,$3,'test','tests',30)`,[agreementId,b.id,collaborator.id]);
    expect((await post(b,`/api/v1/tasks/${taskId}/messages`,{body:'原成员讨论'})).statusCode).toBe(201);
    expect((await get(collaborator,`/api/v1/tasks/${taskId}/messages`)).statusCode).toBe(403);
    expect((await get(outsider,'/api/v1/messages')).json().items).toEqual([]);
    await pools.migration.query("UPDATE collaboration_agreements SET status='active',activated_at=clock_timestamp() WHERE id=$1",[agreementId]);
    const history=await get(collaborator,`/api/v1/tasks/${taskId}/messages`);
    expect(history.statusCode,history.body).toBe(200);expect(history.json().items).toHaveLength(1);
    expect((await post(outsider,`/api/v1/tasks/${taskId}/messages`,{body:'参与测试',sender_agent_id:collaborator.id})).statusCode).toBe(201);
    await pools.migration.query("UPDATE collaboration_agreements SET status='superseded' WHERE id=$1",[agreementId]);
    expect((await get(collaborator,`/api/v1/tasks/${taskId}/messages`)).statusCode).toBe(403);
    expect((await get(outsider,'/api/v1/messages')).json().items).toEqual([]);
  });

  it('enforces active sender authentication and message input bounds',async()=>{
    const conversation=await direct(a,b);
    expect((await post(a,`/api/v1/conversations/${conversation.id}/messages`,{body:'   '})).statusCode).toBe(400);
    expect((await post(a,`/api/v1/conversations/${conversation.id}/messages`,{body:'x'.repeat(8001)})).statusCode).toBe(400);
    await pools.runtime.query("UPDATE agents SET status='paused' WHERE id=$1",[a.id]);
    expect((await post(a,`/api/v1/conversations/${conversation.id}/messages`,{body:'暂停后'})).statusCode).toBe(403);
    expect((await get(alice,`/api/v1/conversations/${conversation.id}/messages`)).statusCode).toBe(200);
    await pools.runtime.query('UPDATE agent_keys SET revoked_at=clock_timestamp() WHERE id=$1',[b.actor.credentialId]);
    expect((await get(b,'/api/v1/messages')).statusCode).toBe(401);
    expect((await pools.runtime.query('SELECT count(*)::int n FROM messages')).rows[0].n).toBe(0);
  });
});

describe('group conversations with owner and admin roles',()=>{
  type Member={id:string;user_id:string|null;agent_id:string|null;role:'owner'|'admin'|'member'};
  const memberOf=(conversation:{members:Member[]},match:{user_id?:string;agent_id?:string})=>conversation.members.find(member=>match.user_id?member.user_id===match.user_id:member.agent_id===match.agent_id)!;

  it('creates user and Agent groups with a single owner and keeps outsiders out',async()=>{
    const created=await post(alice,'/api/v1/conversations/groups',{title:'群聊联调',member_agent_ids:[b.id]});
    expect(created.statusCode,created.body).toBe(201);
    const conversation=created.json();
    expect(conversation).toMatchObject({kind:'group',title:'群聊联调',task_id:null});
    expect(conversation.members.map((member:Member)=>member.role).sort()).toEqual(['member','owner']);
    expect(memberOf(conversation,{user_id:alice.actor.userId}).role).toBe('owner');
    expect(memberOf(conversation,{agent_id:b.id}).role).toBe('member');
    expect((await post(alice,`/api/v1/conversations/${conversation.id}/messages`,{body:'欢迎加入'})).statusCode).toBe(201);
    expect((await post(b,`/api/v1/conversations/${conversation.id}/messages`,{body:'收到'})).statusCode).toBe(201);
    for(const other of [outsider,admin,a,sibling]) expect((await get(other,`/api/v1/conversations/${conversation.id}/messages`)).statusCode).toBe(403);
    expect((await get(bob,'/api/v1/conversations')).json().items.map((item:{id:string})=>item.id)).toContain(conversation.id);
    expect((await get(bob,'/api/v1/messages')).json().items).toHaveLength(2);
    expect((await get(outsider,'/api/v1/messages')).json().items).toEqual([]);
    const byAgent=await post(a,'/api/v1/conversations/groups',{title:'Agent 群',member_user_ids:[bob.actor.userId]});
    expect(byAgent.statusCode,byAgent.body).toBe(201);
    expect(memberOf(byAgent.json(),{agent_id:a.id}).role).toBe('owner');
    expect(memberOf(byAgent.json(),{user_id:bob.actor.userId}).role).toBe('member');
  });

  it('lets only owners and admins invite members, promote roles and remove other members',async()=>{
    const conversation=(await post(alice,'/api/v1/conversations/groups',{title:'权限测试',member_agent_ids:[b.id]})).json();
    const owner=memberOf(conversation,{user_id:alice.actor.userId}),member=memberOf(conversation,{agent_id:b.id});
    expect((await post(b,`/api/v1/conversations/${conversation.id}/members`,{member_user_ids:[outsider.actor.userId]})).statusCode).toBe(403);
    expect((await send(alice,'PATCH',`/api/v1/conversations/${conversation.id}/members/${member.id}`,{role:'admin'})).statusCode).toBe(200);
    expect((await send(b,'PATCH',`/api/v1/conversations/${conversation.id}/members/${member.id}`,{role:'member'})).statusCode).toBe(403);
    const invited=await post(b,`/api/v1/conversations/${conversation.id}/members`,{member_user_ids:[outsider.actor.userId]});
    expect(invited.statusCode,invited.body).toBe(201);
    const outsiderMember=memberOf(invited.json(),{user_id:outsider.actor.userId});
    expect(outsiderMember.role).toBe('member');
    const repeated=await post(b,`/api/v1/conversations/${conversation.id}/members`,{member_user_ids:[outsider.actor.userId]});
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json().members.filter((entry:Member)=>entry.user_id===outsider.actor.userId)).toHaveLength(1);
    expect((await send(b,'DELETE',`/api/v1/conversations/${conversation.id}/members/${owner.id}`,{})).statusCode).toBe(403);
    expect((await send(alice,'PATCH',`/api/v1/conversations/${conversation.id}/members/${outsiderMember.id}`,{role:'admin'})).statusCode).toBe(200);
    expect((await send(b,'DELETE',`/api/v1/conversations/${conversation.id}/members/${outsiderMember.id}`,{})).statusCode).toBe(403);
    expect((await send(alice,'DELETE',`/api/v1/conversations/${conversation.id}/members/${outsiderMember.id}`,{})).statusCode).toBe(200);
    expect((await get(outsider,`/api/v1/conversations/${conversation.id}/messages`)).statusCode).toBe(403);
    expect((await send(alice,'PATCH',`/api/v1/conversations/${conversation.id}/members/${member.id}`,{role:'admin'})).statusCode).toBe(409);
  });

  it('renames for owners and admins, and lets members leave while history stays readable',async()=>{
    const conversation=(await post(alice,'/api/v1/conversations/groups',{title:'改名测试',member_agent_ids:[b.id]})).json();
    expect((await send(b,'PATCH',`/api/v1/conversations/${conversation.id}`,{title:'成员改名'})).statusCode).toBe(403);
    expect((await send(alice,'PATCH',`/api/v1/conversations/${conversation.id}`,{title:'成员改名'})).statusCode).toBe(200);
    expect((await get(alice,`/api/v1/conversations/${conversation.id}`)).json().title).toBe('成员改名');
    expect((await send(alice,'PATCH',`/api/v1/conversations/${conversation.id}`,{title:'成员改名'})).statusCode).toBe(409);
    expect((await post(alice,`/api/v1/conversations/${conversation.id}/messages`,{body:'保留历史'})).statusCode).toBe(201);
    expect((await post(alice,`/api/v1/conversations/${conversation.id}/leave`,{})).statusCode).toBe(400);
    expect((await post(b,`/api/v1/conversations/${conversation.id}/leave`,{})).statusCode).toBe(200);
    expect((await get(b,`/api/v1/conversations/${conversation.id}/messages`)).statusCode).toBe(403);
    expect((await get(alice,`/api/v1/conversations/${conversation.id}/messages`)).json().items.map((item:{body:string})=>item.body)).toEqual(['保留历史']);
    expect((await pools.runtime.query('SELECT count(*)::int n FROM conversation_members WHERE conversation_id=$1',[conversation.id])).rows[0].n).toBe(1);
  });

  it('validates invited identities, duplicate owners and replay-safe group creation',async()=>{
    expect((await post(alice,'/api/v1/conversations/groups',{title:' '})).statusCode).toBe(400);
    expect((await post(alice,'/api/v1/conversations/groups',{title:'无效成员',member_agent_ids:[randomUUID()]})).statusCode).toBe(404);
    expect((await post(alice,'/api/v1/conversations/groups',{title:'重复群主',member_user_ids:[alice.actor.userId]})).statusCode).toBe(400);
    expect((await post(alice,'/api/v1/conversations/groups',{title:'超限',member_agent_ids:Array.from({length:50},()=>randomUUID())})).statusCode).toBe(400);
    expect((await send(alice,'PATCH',`/api/v1/conversations/${randomUUID()}`,{title:'不存在'})).statusCode).toBe(403);
    const key=randomUUID(),payload={title:'幂等群',member_agent_ids:[b.id]};
    const first=await post(alice,'/api/v1/conversations/groups',payload,key);
    const replay=await post(alice,'/api/v1/conversations/groups',payload,key);
    expect(first.statusCode,first.body).toBe(201);
    expect(replay.json()).toEqual(first.json());
    expect((await pools.runtime.query('SELECT count(*)::int n FROM conversations')).rows[0].n).toBe(1);
  });
});
