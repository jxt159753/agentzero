import Fastify, { type FastifyError } from 'fastify';
import cookie from '@fastify/cookie';
import swagger from '@fastify/swagger';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { createPool,withTransaction } from '@agentzero/database';
import type { Config } from './config.js';
import { AppError,audit,lockActor } from './core.js';
import { authenticate,verifyCsrf,registerOAuth,githubProvider,identityView,clearSession,type GithubProvider } from './modules/identity/service.js';
import { registerAgents } from './modules/agents/routes.js';
import { registerAgentRegistrationApproval,registerPublicAgentRegistration } from './modules/agents/registration.js';
import { registerOperations } from './modules/operations/routes.js';
import { registerWallets } from './modules/wallets/routes.js';
import { requireUser } from './http.js';
import { githubRepositoryProvider,type GitHubRepositoryProvider } from './modules/github/provider.js';
import { registerGithub,registerGithubWebhook } from './modules/github/routes.js';
import { registerTasks } from './modules/tasks/routes.js';
import { registerCollaboration } from './modules/collaboration/routes.js';
import { registerMessages } from './modules/messages/routes.js';
import { registerRewards } from './modules/rewards/routes.js';
import { registerMarket } from './modules/market/routes.js';
import { initializeDefaultLandSupply } from './modules/market/default-land.js';
import { registerWorld } from './modules/world/routes.js';
import { registerContributions } from './modules/contributions/routes.js';
import { registerGameContent, registerGames } from './modules/games/routes.js';
import { startJobs } from './jobs.js';

export interface AppOptions { config:Config; pool?:Pool; github?:GithubProvider; repositoryGithub?:GitHubRepositoryProvider; logger?:boolean; serveWeb?:boolean; runJobs?:boolean }
export async function buildApp(options:AppOptions) {
  const {config}=options,pool=options.pool??createPool(config.databaseUrl);
  const repositoryGithub=options.repositoryGithub??githubRepositoryProvider(config);
  const app=Fastify({
    logger:options.logger?{redact:['req.headers.authorization','req.headers.cookie','res.headers.set-cookie'],serializers:{req:request=>({method:request.method,url:request.url?.split('?')[0],hostname:request.hostname})}}:false,
    bodyLimit:32768,
    ajv:{customOptions:{removeAdditional:false,coerceTypes:false}},
    requestIdHeader:false,
  });
  await app.register(cookie);
  await app.register(websocket, {
    options: { maxPayload: 1024 },
    preClose(done) {
      for (const client of this.websocketServer.clients) client.terminate();
      this.websocketServer.close(done);
    },
  });
  await app.register(swagger,{openapi:{info:{title:'AgentZero world, market, rewards, collaboration, tasks and ledger API',version:'6.0.0'}}});
  app.addHook('onSend',async(request,reply,payload)=>{
    reply.header('cache-control','no-store').header('x-content-type-options','nosniff').header('referrer-policy',request.routeOptions.url === '/game-content/:id/*' ? 'no-referrer' : 'same-origin').header('x-request-id',request.id);
    return payload;
  });
  app.setErrorHandler<FastifyError>((error,request,reply)=>{
    let code='INTERNAL_ERROR',status=500,message='服务暂时不可用';
    if(error instanceof AppError) {code=error.code;status=error.status;message=error.message;}
    else if(error.validation) {code='INVALID_REQUEST';status=400;message='请求字段不符合要求';}
    else if(error.message==='INVALID_AMOUNT') {code='INVALID_AMOUNT';status=400;message='积分必须是有效的非负整数字符串';}
    else if(error.code==='P0001' && error.message.includes('INSUFFICIENT_FUNDS')) {code='INSUFFICIENT_FUNDS';status=409;message='可用积分不足';}
    else if(error.code==='P0001' && error.message.includes('LEDGER_QUARANTINED')) {code='LEDGER_QUARANTINED';status=409;message='账本已隔离，请联系管理员核对';}
    else if(error.code==='23505' && error.message.includes('BUSINESS_KEY_CONFLICT')) {code='BUSINESS_CONFLICT';status=409;message='业务编号已用于另一项操作';}
    else if(error.code==='22003' || error.code==='23514' || error.code==='22P02') {code='INVALID_REQUEST';status=400;message='金额或状态不符合约束';}
    else if(error.statusCode===415 || error.statusCode===400) {code='INVALID_REQUEST';status=400;message='无效请求';}
    const context={error_code:code,request_id:request.id,route:request.routeOptions.url};
    if(status>=500) request.log.error({...context,cause_code:error.code,error_type:error.name},'Request failed');
    else request.log.info(context,'Request rejected');
    return reply.code(status).send({error:{code,message,request_id:request.id}});
  });
  app.get('/health',async()=>{await pool.query('SELECT 1');return {status:'ok'};});
  await registerOAuth(app,pool,config,options.github??githubProvider(config));
  await registerGithubWebhook(app,{pool,config});
  await registerPublicAgentRegistration(app,{pool,config});
  await registerGameContent(app,{pool,config});
  await app.register(async protectedApp=>{
    protectedApp.addHook('preHandler',async request=>{
      const auth=await authenticate(request,pool);
      verifyCsrf(request,auth,config);
      request.actor=auth.actor;
    });
    protectedApp.get('/api/v1/me',async request=>identityView(pool,request.actor));
    protectedApp.post('/api/v1/auth/logout',async(request,reply)=>{
      const actor=requireUser(request);
      await withTransaction(pool,async tx=>{
        await lockActor(tx,actor,{allowInactive:true});
        await tx.query('UPDATE user_sessions SET revoked_at=clock_timestamp() WHERE id=$1',[actor.sessionId]);
        await audit(tx,actor,'identity.logout','user',actor.userId,request.id,{});
      });
      clearSession(reply);
      return {ok:true};
    });
    protectedApp.get('/api/v1/admin/openapi',async request=>{
      await withTransaction(pool,tx=>lockActor(tx,request.actor,{admin:true}));
      return app.swagger();
    });
    await registerAgents(protectedApp,{pool,config});
    await registerAgentRegistrationApproval(protectedApp,{pool,config});
    await registerOperations(protectedApp,{pool,config});
    await registerWallets(protectedApp,{pool,config});
    await registerGithub(protectedApp,{pool,config},repositoryGithub);
    await registerTasks(protectedApp,{pool,config},repositoryGithub);
    await registerCollaboration(protectedApp,{pool,config});
    await registerMessages(protectedApp,{pool,config});
    await registerRewards(protectedApp,{pool,config});
    await registerMarket(protectedApp,{pool,config});
    await registerWorld(protectedApp,{pool,config});
    await registerGames(protectedApp,{pool,config});
    await registerContributions(protectedApp,{pool,config},repositoryGithub);
  });
  if(options.serveWeb) {
    await app.register(fastifyStatic,{root:fileURLToPath(new URL('../../web/dist/',import.meta.url)),wildcard:false});
  }
  // Fastify's default 404 logs the raw URL, including sensitive OAuth query values.
  app.setNotFoundHandler((request,reply)=>options.serveWeb && !request.url.startsWith('/api/')?reply.sendFile('index.html'):reply.code(404).send({error:{code:'NOT_FOUND',message:'接口不存在',request_id:request.id}}));
  let stopJobs:(()=>Promise<void>)|undefined;
  app.addHook('onReady', async () => { await withTransaction(pool, initializeDefaultLandSupply); });
  if(options.runJobs) app.addHook('onReady',async()=>{stopJobs=startJobs(pool,error=>app.log.error({error_code:(error as {code?:string}).code??'JOB_FAILED'},'Background task failed'),repositoryGithub);});
  app.addHook('onClose',async()=>{await stopJobs?.();if(!options.pool) await pool.end();});
  return app;
}
