import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { IdParams,PageQuery,Month,UserStatusChange,IssuanceLimit,Issue,Recycle,AdminWalletAdjustment,type AdminWalletAdjustmentInput,type AdminWalletDto } from '@agentzero/contracts';
import { withTransaction } from '@agentzero/database';
import { AppError,audit,decodeCursor,lockActor,paginated,principal } from '../../core.js';
import { command,requireUser,type ApiContext } from '../../http.js';
import { adminAdjustWallet,economySnapshot,issue,reconcile,recycle,setIssuanceLimit } from '../ledger/service.js';
type Page={cursor?:string;limit?:number};
const userFields='id,github_user_id,github_login,display_name,avatar_url,status,role,created_at,updated_at';
export async function registerOperations(app:FastifyInstance,ctx:ApiContext) {
  app.get<{Params:{id:string}}>('/api/v1/operations/:id',{schema:{params:IdParams}},async request=>withTransaction(ctx.pool,async tx=>{
    await lockActor(tx,request.actor,{allowPaused:true});
    const operation=(await tx.query("SELECT id,principal_key,response_status,response_body,resource_type,resource_id FROM idempotency_requests WHERE id=$1 AND status='completed'",[request.params.id])).rows[0];
    if(!operation) throw new AppError('ACCESS_DENIED',403);
    if(operation.principal_key!==principal(request.actor)) {
      if(request.actor.type!=='user' || !operation.principal_key.startsWith('agent:')) throw new AppError('ACCESS_DENIED',403);
      await lockActor(tx,request.actor,{agentId:operation.principal_key.slice(6),allowPaused:true});
    }
    return {id:operation.id,status:operation.response_status,result:operation.response_body,resource_type:operation.resource_type,resource_id:operation.resource_id};
  }));
  app.get<{Querystring:Page & {status?:string;q?:string}}>('/api/v1/admin/users',{schema:{querystring:Type.Intersect([PageQuery,Type.Object({status:Type.Optional(Type.Union([Type.Literal('pending'),Type.Literal('active'),Type.Literal('suspended')])),q:Type.Optional(Type.String({maxLength:100}))})])}},async request=>withTransaction(ctx.pool,async tx=>{
    await lockActor(tx,request.actor,{admin:true});
    const c=decodeCursor(request.query.cursor),n=Number(request.query.limit??30);
    const q=request.query.q?.trim(),search=q?`%${q.replace(/[\\%_]/g,'\\$&')}%`:null;
    return paginated((await tx.query(`SELECT ${userFields} FROM users WHERE ($1::text IS NULL OR status=$1) AND ($2::timestamptz IS NULL OR (created_at,id)<($2,$3::uuid))
      AND ($5::text IS NULL OR github_login ILIKE $5 OR display_name ILIKE $5 OR id::text=$6)
      ORDER BY created_at DESC,id DESC LIMIT $4`,[request.query.status??null,c?.[0]??null,c?.[1]??null,n+1,search,q?.toLowerCase()??null])).rows,n);
  }));
  app.get<{Params:{id:string}}>('/api/v1/admin/users/:id',{schema:{params:IdParams}},async request=>withTransaction(ctx.pool,async tx=>{
    await lockActor(tx,request.actor,{admin:true});
    const user=(await tx.query(`SELECT ${userFields} FROM users WHERE id=$1`,[request.params.id])).rows[0];
    if(!user) throw new AppError('NOT_FOUND',404);
    return user;
  }));
  app.patch<{Params:{id:string};Body:{status:string;reason:string}}>('/api/v1/admin/users/:id',{schema:{params:IdParams,body:UserStatusChange}},async(request,reply)=>{
    const actor=requireUser(request),id=request.params.id;
    if(id===actor.userId && request.body.status!=='active') throw new AppError('ACCESS_DENIED',403,'不能停用当前管理账号');
    return command(ctx,request,reply,{admin:true,userIds:[id]},async tx=>{
      const user=(await tx.query(`UPDATE users SET status=$2,updated_at=clock_timestamp() WHERE id=$1 RETURNING ${userFields}`,[id,request.body.status])).rows[0];
      if(!user) throw new AppError('NOT_FOUND',404);
      await audit(tx,actor,'user.status_changed','user',id,request.id,{status:request.body.status,reason:request.body.reason});
      return {status:200,body:user,resourceType:'user',resourceId:id};
    });
  });
  app.get<{Params:{id:string}}>('/api/v1/admin/users/:id/wallets',{schema:{params:IdParams}},async request=>withTransaction(ctx.pool,async tx=>{
    const id=request.params.id.toLowerCase();
    await lockActor(tx,request.actor,{admin:true,userIds:[id]});
    if(!(await tx.query('SELECT id FROM users WHERE id=$1',[id])).rowCount) throw new AppError('NOT_FOUND',404);
    const wallets=(await tx.query<AdminWalletDto>(`SELECT 'user' AS type,u.id,u.display_name AS name,u.status,NULL::text AS deleted_at,
        a.balance::text AS available,r.balance::text AS reserved FROM users u
        JOIN ledger_accounts a ON a.user_id=u.id AND a.bucket='USER_AVAILABLE'
        JOIN ledger_accounts r ON r.user_id=u.id AND r.bucket='USER_RESERVED' WHERE u.id=$1
      UNION ALL SELECT 'agent',ag.id,ag.name,ag.status,ag.deleted_at::text,a.balance::text,r.balance::text FROM agents ag
        JOIN ledger_accounts a ON a.agent_id=ag.id AND a.bucket='AVAILABLE'
        JOIN ledger_accounts r ON r.agent_id=ag.id AND r.bucket='RESERVED' WHERE ag.owner_user_id=$1
      ORDER BY type DESC,name,id`,[id])).rows;
    const reward=(await tx.query("SELECT balance::text FROM ledger_accounts WHERE system_key='REWARD_POOL'")).rows[0];
    return {user_id:id,wallets,reward_pool_points:reward.balance};
  }));
  app.post<{Body:AdminWalletAdjustmentInput}>('/api/v1/admin/wallet-adjustments',{schema:{body:AdminWalletAdjustment}},async(request,reply)=>{
    const actor=requireUser(request),wallet={...request.body.wallet,id:request.body.wallet.id.toLowerCase()};
    // Resolve the immutable owner before command() locks both users in UUID order.
    const owner=wallet.type==='user'?wallet.id:(await ctx.pool.query<{owner_user_id:string}>('SELECT owner_user_id FROM agents WHERE id=$1',[wallet.id])).rows[0]?.owner_user_id;
    return command(ctx,request,reply,{admin:true,userIds:owner?[owner]:[]},async tx=>{
      if(!owner) throw new AppError('NOT_FOUND',404);
      const result=await adminAdjustWallet(tx,{actor,requestId:request.id},{wallet,ownerUserId:owner,direction:request.body.direction,
        amount:request.body.amount,reason:request.body.reason.trim(),businessKey:`admin-adjustment:${actor.userId}:${request.body.business_id.toLowerCase()}`});
      return {status:201,body:{transaction_id:result.transactionId,business_key:result.businessKey,wallet:result.wallet,
        owner_user_id:result.owner_user_id,direction:result.direction,amount:result.amount,reason:result.reason,created:result.created},resourceType:'journal',resourceId:result.transactionId};
    });
  });
  app.get<{Params:{month:string}}>('/api/v1/admin/issuance-periods/:month',{schema:{params:Type.Object({month:Month})}},async request=>withTransaction(ctx.pool,async tx=>{
    await lockActor(tx,request.actor,{admin:true});
    return (await tx.query('SELECT period::text,limit_points,issued_points FROM credit_issuance_periods WHERE period=$1',[request.params.month])).rows[0]??{period:request.params.month,limit_points:'0',issued_points:'0'};
  }));
  app.put<{Params:{month:string};Body:{limit_points:string;reason:string}}>('/api/v1/admin/issuance-periods/:month',{schema:{params:Type.Object({month:Month}),body:IssuanceLimit}},async(request,reply)=>{
    requireUser(request);
    return command(ctx,request,reply,{admin:true},async tx=>{
      const result=await setIssuanceLimit(tx,{actor:request.actor,requestId:request.id},{month:request.params.month.slice(0,7),limitPoints:request.body.limit_points,reason:request.body.reason});
      return {status:200,body:{period:result.period,limit_points:result.limitPoints,issued_points:result.issuedPoints}};
    });
  });
  app.post<{Body:{month:string;amount:string;reason:string;business_id:string}}>('/api/v1/admin/issuances',{schema:{body:Issue}},async(request,reply)=>{
    requireUser(request);
    return command(ctx,request,reply,{admin:true},async tx=>{
      const result=await issue(tx,{actor:request.actor,requestId:request.id},{month:request.body.month.slice(0,7),amount:request.body.amount,reason:request.body.reason,businessKey:`issuance:${request.body.business_id}`});
      return {status:201,body:{id:result.transactionId,transaction_id:result.transactionId,business_key:result.businessKey,amount:result.amount,period:result.period,created:result.created},resourceType:'journal',resourceId:result.transactionId};
    });
  });
  app.get('/api/v1/admin/economy',async request=>withTransaction(ctx.pool,async tx=>{
    await lockActor(tx,request.actor,{admin:true});
    return economySnapshot(tx);
  }));
  app.post<{Body:{amount:string;reason:string;business_id:string}}>('/api/v1/admin/recycles',{schema:{body:Recycle}},async(request,reply)=>{
    requireUser(request);
    return command(ctx,request,reply,{admin:true},async tx=>{
      const result=await recycle(tx,{actor:request.actor,requestId:request.id},{amount:request.body.amount,reason:request.body.reason,businessKey:`recycle:${request.body.business_id}`});
      return {status:201,body:{transaction_id:result.transactionId,business_key:result.businessKey,amount:result.amount,created:result.created},resourceType:'journal',resourceId:result.transactionId};
    });
  });
  const filterSchema=Type.Intersect([PageQuery,Type.Object({account_id:Type.Optional(Type.String({format:'uuid'})),agent_id:Type.Optional(Type.String({format:'uuid'})),user_id:Type.Optional(Type.String({format:'uuid'})),business_key:Type.Optional(Type.String({maxLength:240}))})]);
  type Filters=Page & {account_id?:string;agent_id?:string;user_id?:string;business_key?:string};
  app.get<{Querystring:Filters}>('/api/v1/admin/ledger',{schema:{querystring:filterSchema}},async request=>withTransaction(ctx.pool,async tx=>{
    await lockActor(tx,request.actor,{admin:true});
    const c=decodeCursor(request.query.cursor),n=Number(request.query.limit??30),q=request.query;
    return paginated((await tx.query(`SELECT j.id,j.kind,j.business_key,j.reason,j.created_at,j.business_date,j.actor_type,j.actor_user_id,j.actor_agent_id,j.represented_agent_id,j.credential_id,j.payer_agent_id,j.spend_points,
      (SELECT jsonb_agg(jsonb_build_object('account_id',e.account_id,'side',e.side,'amount',e.amount::text) ORDER BY e.line_no) FROM journal_entries e WHERE e.transaction_id=j.id) AS entries
      FROM journal_transactions j WHERE ($1::text IS NULL OR j.business_key=$1)
      AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM journal_entries e WHERE e.transaction_id=j.id AND e.account_id=$2))
      AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM journal_entries e JOIN ledger_accounts a ON a.id=e.account_id WHERE e.transaction_id=j.id AND a.agent_id=$3))
      AND ($4::uuid IS NULL OR j.actor_user_id=$4 OR EXISTS(SELECT 1 FROM journal_entries e JOIN ledger_accounts a ON a.id=e.account_id LEFT JOIN agents ag ON ag.id=a.agent_id WHERE e.transaction_id=j.id AND (ag.owner_user_id=$4 OR a.user_id=$4)))
      AND ($5::timestamptz IS NULL OR (j.created_at,j.id)<($5,$6::uuid)) ORDER BY j.created_at DESC,j.id DESC LIMIT $7`,[q.business_key??null,q.account_id??null,q.agent_id??null,q.user_id??null,c?.[0]??null,c?.[1]??null,n+1])).rows,n);
  }));
  app.get<{Querystring:Filters}>('/api/v1/admin/audit-events',{schema:{querystring:filterSchema}},async request=>withTransaction(ctx.pool,async tx=>{
    await lockActor(tx,request.actor,{admin:true});
    const c=decodeCursor(request.query.cursor),n=Number(request.query.limit??30),q=request.query;
    return paginated((await tx.query(`SELECT a.* FROM audit_events a
      WHERE ($1::uuid IS NULL OR a.actor_user_id=$1 OR (a.target_type='user' AND a.target_id=$1::text)
        OR (a.target_type='journal' AND EXISTS(SELECT 1 FROM journal_entries e JOIN ledger_accounts w ON w.id=e.account_id WHERE e.transaction_id::text=a.target_id AND w.user_id=$1))
        OR EXISTS(SELECT 1 FROM agents ag WHERE ag.owner_user_id=$1 AND ag.id IN(a.actor_agent_id,a.represented_agent_id)))
      AND ($2::text IS NULL OR a.business_key=$2)
      AND ($3::timestamptz IS NULL OR (a.created_at,a.id)<($3,$4::uuid))
      AND ($6::uuid IS NULL OR a.actor_agent_id=$6 OR a.represented_agent_id=$6 OR (a.target_type='agent' AND a.target_id=$6::text))
      AND ($7::uuid IS NULL OR (a.target_type='account' AND a.target_id=$7::text) OR (a.target_type='journal' AND EXISTS(SELECT 1 FROM journal_entries e WHERE e.transaction_id::text=a.target_id AND e.account_id=$7)))
      ORDER BY a.created_at DESC,a.id DESC LIMIT $5`,[q.user_id??null,q.business_key??null,c?.[0]??null,c?.[1]??null,n+1,q.agent_id??null,q.account_id??null])).rows,n);
  }));
  app.post('/api/v1/admin/reconciliation',async(request,reply)=>{
    requireUser(request);
    return command(ctx,request,reply,{admin:true},async tx=>({status:200,body:await reconcile(tx,{actor:request.actor,requestId:request.id})}));
  });
}
