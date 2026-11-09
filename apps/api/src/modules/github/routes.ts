import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { IdParams } from '@agentzero/contracts';
import { withTransaction } from '@agentzero/database';
import { AppError,audit,lockActor } from '../../core.js';
import { command,replayCommand,requireUser,type ApiContext } from '../../http.js';
import type { GitHubRepositoryProvider } from './provider.js';
import { admitRepository, installationRevision, persistGithubDelivery, verifyWebhookSignature } from './service.js';
import { registerRepositoryRequests } from './repository-requests.js';

const InstallationId=Type.String({pattern:'^[1-9][0-9]{0,19}$'});
const RepoName=Type.String({pattern:'^[A-Za-z0-9_.-]+$',maxLength:100,minLength:1});
export async function registerGithubWebhook(app:FastifyInstance,ctx:ApiContext) {
  await app.register(async webhook=>{
    webhook.removeContentTypeParser('application/json');
    webhook.addContentTypeParser('application/json',{parseAs:'buffer'},(_request,body,done)=>done(null,body));
    webhook.post('/api/v1/github/webhook',{bodyLimit:26_214_400},async(request,reply)=>{
      const raw=request.body as Buffer;
      verifyWebhookSignature(raw,request.headers['x-hub-signature-256'],ctx.config.githubWebhookSecret);
      const deliveryId=request.headers['x-github-delivery'],eventName=request.headers['x-github-event'];
      if(typeof deliveryId!=='string' || !/^[a-zA-Z0-9-]{8,128}$/.test(deliveryId) || typeof eventName!=='string' || !/^[a-z_]{1,80}$/.test(eventName)) throw new AppError('INVALID_REQUEST',400);
      let payload;
      try {payload=JSON.parse(raw.toString('utf8'));} catch {throw new AppError('INVALID_REQUEST',400);}
      if(!payload || typeof payload!=='object' || Array.isArray(payload)) throw new AppError('INVALID_REQUEST',400);
      const result=await withTransaction(ctx.pool,tx=>persistGithubDelivery(tx,{deliveryId,eventName,payload,raw}));
      return reply.code(202).send({accepted:true,...result});
    });
  });
}

export async function registerGithub(app:FastifyInstance,ctx:ApiContext,provider:GitHubRepositoryProvider) {
  app.get('/api/v1/repositories',async request=>withTransaction(ctx.pool,async tx=>{
    const {user}=await lockActor(tx,request.actor,{allowPaused:true});
    return {items:(await tx.query(`SELECT r.*,i.status AS installation_status FROM repositories r JOIN github_installations i USING(installation_id)
      WHERE $1 OR (r.status='approved' AND NOT r.is_private AND i.status='active') ORDER BY r.full_name,r.id`,[user?.role==='admin' && request.actor.type==='user'])).rows};
  }));
  app.get('/api/v1/admin/github/installations',async request=>withTransaction(ctx.pool,async tx=>{
    await lockActor(tx,request.actor,{admin:true});
    return {items:(await tx.query('SELECT * FROM github_installations ORDER BY created_at DESC')).rows};
  }));
  app.post<{Body:{installation_id:string}}>('/api/v1/admin/github/installations',{schema:{body:Type.Object({installation_id:InstallationId},{additionalProperties:false})}},async(request,reply)=>{
    requireUser(request);
    if(await replayCommand(ctx,request,reply,{admin:true})) return reply;
    const before=await withTransaction(ctx.pool,async tx=>{
      await lockActor(tx,request.actor,{admin:true});
      return (await tx.query('SELECT updated_at::text AS revision FROM github_installations WHERE installation_id=$1',[request.body.installation_id])).rows[0]?.revision??null;
    });
    const installation=await provider.getInstallation({installationId:request.body.installation_id});
    return command(ctx,request,reply,{admin:true},async tx=>{
      const current=(await tx.query('SELECT updated_at::text AS revision FROM github_installations WHERE installation_id=$1 FOR UPDATE',[request.body.installation_id])).rows[0]?.revision??null;
      if(current!==before) throw new AppError('REPOSITORY_CHANGED',409);
      const row=(await tx.query(`INSERT INTO github_installations(installation_id,account_login,status) VALUES($1,$2,$3)
        ON CONFLICT(installation_id) DO UPDATE SET account_login=excluded.account_login,status=excluded.status,updated_at=clock_timestamp() RETURNING *`,[installation.installationId,installation.accountLogin,installation.status])).rows[0];
      await audit(tx,request.actor,'github.installation_verified','github_installation',installation.installationId,request.id,{status:installation.status});
      return {status:200,body:row};
    });
  });
  app.post<{Body:{installation_id:string;owner:string;name:string}}>('/api/v1/admin/repositories',{schema:{body:Type.Object({installation_id:InstallationId,owner:RepoName,name:RepoName},{additionalProperties:false})}},async(request,reply)=>{
    requireUser(request);
    if(await replayCommand(ctx,request,reply,{admin:true})) return reply;
    const before=await withTransaction(ctx.pool,async tx=>{
      await lockActor(tx,request.actor,{admin:true});
      return installationRevision(tx,request.body.installation_id);
    });
    const input=request.body;
    const repo=await provider.getRepository({installationId:input.installation_id,owner:input.owner,name:input.name});
    return command(ctx,request,reply,{admin:true},async tx=>{
      const row=await admitRepository(tx,{actor:request.actor,requestId:request.id,installationId:input.installation_id,installationRevision:before,repository:repo});
      return {status:201,body:row,resourceType:'repository',resourceId:row.id};
    });
  });
  app.patch<{Params:{id:string};Body:{status:'approved'|'disabled'}}>('/api/v1/admin/repositories/:id',{schema:{params:IdParams,body:Type.Object({status:Type.Union([Type.Literal('approved'),Type.Literal('disabled')])},{additionalProperties:false})}},async(request,reply)=>{
    requireUser(request);
    if(await replayCommand(ctx,request,reply,{admin:true})) return reply;
    const before=await withTransaction(ctx.pool,async tx=>{
      await lockActor(tx,request.actor,{admin:true});
      const row=(await tx.query('SELECT *,updated_at::text AS revision FROM repositories WHERE id=$1',[request.params.id])).rows[0];
      if(!row) throw new AppError('NOT_FOUND',404);
      return row;
    });
    if(request.body.status==='approved') {
      const repo=await provider.getRepository({installationId:before.installation_id,owner:before.owner,name:before.name});
      if(repo.repositoryId!==before.github_id || repo.isPrivate) throw new AppError('REPOSITORY_UNAVAILABLE',409);
    }
    return command(ctx,request,reply,{admin:true},async tx=>{
      const installation=(await tx.query('SELECT status FROM github_installations WHERE installation_id=$1 FOR SHARE',[before.installation_id])).rows[0];
      const current=(await tx.query('SELECT *,updated_at::text AS revision FROM repositories WHERE id=$1 FOR UPDATE',[request.params.id])).rows[0];
      if(current.installation_id!==before.installation_id || current.revision!==before.revision) throw new AppError('REPOSITORY_CHANGED',409);
      if(request.body.status==='approved' && (installation?.status!=='active' || current.is_private)) throw new AppError('REPOSITORY_UNAVAILABLE',409);
      const row=(await tx.query('UPDATE repositories SET status=$2,updated_at=clock_timestamp() WHERE id=$1 RETURNING *',[request.params.id,request.body.status])).rows[0];
      if(row.status==='approved') await tx.query('INSERT INTO contribution_history_scans(repository_id) VALUES($1) ON CONFLICT DO NOTHING',[row.id]);
      await audit(tx,request.actor,'github.repository_status','repository',row.id,request.id,{status:row.status});
      return {status:200,body:row,resourceType:'repository',resourceId:row.id};
    });
  });
  app.get('/api/v1/admin/github/deliveries',async request=>withTransaction(ctx.pool,async tx=>{
    await lockActor(tx,request.actor,{admin:true});
    return {items:(await tx.query('SELECT delivery_id,event_name,status,attempts,last_error,created_at,processed_at FROM github_deliveries ORDER BY created_at DESC LIMIT 100')).rows};
  }));
  await registerRepositoryRequests(app,ctx,provider);
}
