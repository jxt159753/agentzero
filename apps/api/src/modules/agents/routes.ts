import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { CreateAgent,PatchAgent,DeleteAgent,CreateKey,Policy,IdParams,KeyParams,PageQuery,AgentResponse,WalletResponse,KeyResponse,parseAmount,type PolicyInput } from '@agentzero/contracts';
import { withTransaction } from '@agentzero/database';
import { AppError,audit,decodeCursor,lockActor,paginated,tokenHash } from '../../core.js';
import { command,requireUser,type ApiContext } from '../../http.js';
import { getWallet } from '../ledger/service.js';
import { createAgent,deleteAgent } from './service.js';

export async function registerAgents(app:FastifyInstance,ctx:ApiContext) {
  app.get<{Querystring:{cursor?:string;limit?:number}}>('/api/v1/agents',{schema:{querystring:PageQuery}},async request=>{
    const actor=requireUser(request),cursor=decodeCursor(request.query.cursor),limit=Number(request.query.limit??30);
    return withTransaction(ctx.pool,async tx=>{
      await lockActor(tx,actor);
      const rows=(await tx.query(`SELECT id,owner_user_id,name,status,version,deleted_at,created_at,updated_at FROM agents WHERE owner_user_id=$1 AND deleted_at IS NULL AND ($2::timestamptz IS NULL OR (created_at,id)<($2,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT $4`,[actor.userId,cursor?.[0]??null,cursor?.[1]??null,limit+1])).rows;
      return paginated(rows,limit);
    });
  });
  app.post<{Body:{name:string}}>('/api/v1/agents',{schema:{body:CreateAgent,response:{201:AgentResponse}}},async(request,reply)=>{
    const actor=requireUser(request);
    return command(ctx,request,reply,{},async tx=>{
      const agent=await createAgent(tx,actor,request.body.name,request.id,ctx.config.maxAgentsPerUser);
      return {status:201,body:agent,resourceType:'agent',resourceId:agent.id};
    });
  });
  app.get<{Params:{id:string}}>('/api/v1/agents/:id',{schema:{params:IdParams,response:{200:AgentResponse}}},async request=>withTransaction(ctx.pool,async tx=>{
    const {agent}=await lockActor(tx,request.actor,{agentId:request.params.id,allowPaused:true,allowDeleted:true});
    return agent;
  }));
  app.patch<{Params:{id:string};Body:{name?:string;status?:'active'|'paused'}}>('/api/v1/agents/:id',{schema:{params:IdParams,body:PatchAgent,response:{200:AgentResponse}}},async(request,reply)=>{
    const actor=requireUser(request),id=request.params.id;
    return command(ctx,request,reply,{agentId:id,allowPaused:true},async tx=>{
      const agent=(await tx.query('UPDATE agents SET name=COALESCE($2,name),status=COALESCE($3,status),version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *',[id,request.body.name?.trim()??null,request.body.status??null])).rows[0];
      await audit(tx,{...actor,representedAgentId:id},'agent.updated','agent',id,request.id,{name:agent.name,status:agent.status});
      return {status:200,body:agent,resourceType:'agent',resourceId:id};
    });
  });
  app.delete<{Params:{id:string};Body:{version:string}}>('/api/v1/agents/:id',{schema:{params:IdParams,body:DeleteAgent}},async(request,reply)=>{
    const actor=requireUser(request),id=request.params.id;
    parseAmount(request.body.version,true);
    return command(ctx,request,reply,{agentId:id,allowPaused:true,allowDeleted:true},tx=>deleteAgent(tx,actor,id,request.body.version,request.id));
  });
  app.get<{Params:{id:string}}>('/api/v1/agents/:id/policy',{schema:{params:IdParams}},async request=>withTransaction(ctx.pool,async tx=>{
    await lockActor(tx,request.actor,{agentId:request.params.id,allowPaused:true});
    return (await tx.query('SELECT * FROM agent_policies WHERE agent_id=$1',[request.params.id])).rows[0];
  }));
  app.put<{Params:{id:string};Body:PolicyInput}>('/api/v1/agents/:id/policy',{schema:{params:IdParams,body:Policy}},async(request,reply)=>{
    const actor=requireUser(request),id=request.params.id,b=request.body;
    parseAmount(b.single_spend_limit);parseAmount(b.daily_spend_limit);parseAmount(b.version,true);
    return command(ctx,request,reply,{agentId:id,allowPaused:true},async tx=>{
      const row=(await tx.query(`UPDATE agent_policies SET can_accept_task=$3,can_collaborate=$4,can_trade=$5,can_redeem_api=$6,single_spend_limit=$7,daily_spend_limit=$8,version=version+1,updated_at=clock_timestamp() WHERE agent_id=$1 AND version=$2 RETURNING *`,[id,b.version,b.can_accept_task,b.can_collaborate,b.can_trade,b.can_redeem_api,b.single_spend_limit,b.daily_spend_limit])).rows[0];
      if(!row) throw new AppError('POLICY_VERSION_CONFLICT',409,'策略已被修改，请刷新后重试');
      await audit(tx,{...actor,representedAgentId:id},'policy.updated','agent',id,request.id,{...b,version:row.version});
      return {status:200,body:row,resourceType:'agent',resourceId:id};
    });
  });
  app.get<{Params:{id:string};Querystring:{cursor?:string;limit?:number}}>('/api/v1/agents/:id/keys',{schema:{params:IdParams,querystring:PageQuery}},async request=>{
    requireUser(request);
    return withTransaction(ctx.pool,async tx=>{
      await lockActor(tx,request.actor,{agentId:request.params.id,allowPaused:true});
      const cursor=decodeCursor(request.query.cursor),limit=Number(request.query.limit??30);
      return paginated((await tx.query('SELECT id,label,expires_at,revoked_at,created_at FROM agent_keys WHERE agent_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT $4',[request.params.id,cursor?.[0]??null,cursor?.[1]??null,limit+1])).rows,limit);
    });
  });
  app.post<{Params:{id:string};Body:{label:string}}>('/api/v1/agents/:id/keys',{schema:{params:IdParams,body:CreateKey,response:{201:KeyResponse}}},async(request,reply)=>{
    const actor=requireUser(request),agentId=request.params.id;
    return command(ctx,request,reply,{agentId,allowPaused:true},async tx=>{
      const id=randomUUID(),secret=`azk_${id}.${randomBytes(32).toString('base64url')}`;
      const row=(await tx.query('INSERT INTO agent_keys(id,agent_id,label,secret_hash) VALUES($1,$2,$3,$4) RETURNING id,label,expires_at,revoked_at,created_at',[id,agentId,request.body.label.trim(),tokenHash(secret)])).rows[0];
      await audit(tx,{...actor,representedAgentId:agentId},'key.created','key',id,request.id,{label:row.label});
      return {status:201,body:{...row,secret,secret_shown:true},resourceType:'key',resourceId:id};
    });
  });
  app.post<{Params:{id:string;keyId:string}}>('/api/v1/agents/:id/keys/:keyId/revoke',{schema:{params:KeyParams,body:Type.Optional(Type.Object({},{additionalProperties:false}))}},async(request,reply)=>{
    const actor=requireUser(request),{id:agentId,keyId}=request.params;
    return command(ctx,request,reply,{agentId,allowPaused:true},async tx=>{
      const key=(await tx.query('SELECT id,label,expires_at,revoked_at,created_at FROM agent_keys WHERE id=$1 AND agent_id=$2 FOR UPDATE',[keyId,agentId])).rows[0];
      if(!key) throw new AppError('ACCESS_DENIED',403);
      if(!key.revoked_at) {
        key.revoked_at=(await tx.query('UPDATE agent_keys SET revoked_at=clock_timestamp() WHERE id=$1 RETURNING revoked_at',[keyId])).rows[0].revoked_at;
        await audit(tx,{...actor,representedAgentId:agentId},'key.revoked','key',keyId,request.id,{});
      }
      return {status:200,body:key,resourceType:'key',resourceId:keyId};
    });
  });
  app.get<{Params:{id:string}}>('/api/v1/agents/:id/wallet',{schema:{params:IdParams,response:{200:WalletResponse}}},async request=>withTransaction(ctx.pool,async tx=>{
    await lockActor(tx,request.actor,{agentId:request.params.id,allowPaused:true,allowDeleted:true});
    const w=await getWallet(tx,request.params.id);
    return {available:w.available,reserved:w.reserved,daily_spent:w.todaySpent,held:w.outstandingHeld,daily_usage:w.dailyUsed,business_date:w.businessDate};
  }));
  app.get<{Params:{id:string};Querystring:{cursor?:string;limit?:number}}>('/api/v1/agents/:id/transactions',{schema:{params:IdParams,querystring:PageQuery}},async request=>withTransaction(ctx.pool,async tx=>{
    await lockActor(tx,request.actor,{agentId:request.params.id,allowPaused:true,allowDeleted:true});
    const cursor=decodeCursor(request.query.cursor),limit=Number(request.query.limit??30);
    const rows=(await tx.query(`SELECT j.id,j.kind,j.business_key,j.reason,j.created_at,j.business_date,
      abs(sum(CASE e.side WHEN 'debit' THEN e.amount ELSE -e.amount END))::text AS amount,
      CASE WHEN sum(CASE e.side WHEN 'debit' THEN e.amount ELSE -e.amount END)>0 THEN 'debit' WHEN sum(CASE e.side WHEN 'debit' THEN e.amount ELSE -e.amount END)<0 THEN 'credit' ELSE 'mixed' END AS side,
      jsonb_agg(jsonb_build_object('bucket',a.bucket,'side',e.side,'amount',e.amount::text) ORDER BY e.line_no) AS entries
      FROM journal_transactions j JOIN journal_entries e ON e.transaction_id=j.id JOIN ledger_accounts a ON a.id=e.account_id
      WHERE a.agent_id=$1 AND ($2::timestamptz IS NULL OR (j.created_at,j.id)<($2,$3::uuid)) GROUP BY j.id ORDER BY j.created_at DESC,j.id DESC LIMIT $4`,[request.params.id,cursor?.[0]??null,cursor?.[1]??null,limit+1])).rows;
    return paginated(rows,limit);
  }));
}
