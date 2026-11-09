import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { withTransaction } from '@agentzero/database';
import type { Actor } from '@agentzero/contracts';
import type { Config } from '../../config.js';
import { AppError, audit, lockActor, safeEqual, tokenHash } from '../../core.js';

export interface GithubIdentity { id: string; login: string; name: string; avatarUrl: string|null }
export interface GithubProvider { exchange(code: string, verifier: string): Promise<GithubIdentity> }
export function githubProvider(config: Config): GithubProvider {
  return { async exchange(code,verifier) {
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token',{
      method:'POST',headers:{accept:'application/json','content-type':'application/json'},
      body:JSON.stringify({client_id:config.githubClientId,client_secret:config.githubClientSecret,code,code_verifier:verifier,redirect_uri:`${config.publicOrigin}/api/v1/auth/github/callback`}),signal:AbortSignal.timeout(15000),
    });
    const token = await tokenResponse.json() as {access_token?:string};
    if (!tokenResponse.ok || !token.access_token) throw new AppError('OAUTH_INVALID',400,'GitHub 授权码兑换失败，请重新登录');
    const identityResponse = await fetch('https://api.github.com/user',{
      headers:{accept:'application/vnd.github+json',authorization:`Bearer ${token.access_token}`,'user-agent':'AgentZero','x-github-api-version':'2026-03-10'},signal:AbortSignal.timeout(15000),
    });
    const identity = await identityResponse.json() as {id:number;login:string;name?:string;avatar_url?:string};
    if (!identityResponse.ok || !Number.isSafeInteger(identity.id) || identity.id<=0 || typeof identity.login!=='string') throw new AppError('OAUTH_INVALID',400);
    return {id:String(identity.id),login:identity.login,name:identity.name||identity.login,avatarUrl:identity.avatar_url??null};
  }};
}

export interface Authenticated {actor: Actor; csrfHash?:Buffer}
export async function authenticate(request: FastifyRequest,pool: Pool): Promise<Authenticated> {
  const authorization = request.headers.authorization;
  if (authorization) {
    const match = /^Bearer (azk_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43}))$/.exec(authorization);
    if (!match) throw new AppError('UNAUTHENTICATED',401);
    const row = (await pool.query(`SELECT k.id,k.agent_id,k.secret_hash,k.revoked_at,k.expires_at,a.owner_user_id,a.deleted_at FROM agent_keys k JOIN agents a ON a.id=k.agent_id WHERE k.id=$1`,[match[2]])).rows[0];
    if (!row || !safeEqual(row.secret_hash,tokenHash(match[1]))) throw new AppError('UNAUTHENTICATED',401);
    if (row.revoked_at || row.deleted_at || new Date(row.expires_at).getTime()<=Date.now()) throw new AppError('CREDENTIAL_REVOKED',401);
    return {actor:{type:'agent',agentId:row.agent_id,ownerUserId:row.owner_user_id,credentialId:row.id}};
  }
  const sessionToken=request.cookies.az_session;
  if (!sessionToken) throw new AppError('UNAUTHENTICATED',401);
  const row = (await pool.query('SELECT id,user_id,csrf_token_hash FROM user_sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp()',[tokenHash(sessionToken)])).rows[0];
  if (!row) throw new AppError('UNAUTHENTICATED',401);
  return {actor:{type:'user',userId:row.user_id,sessionId:row.id},csrfHash:row.csrf_token_hash};
}
export function verifyCsrf(request:FastifyRequest,auth:Authenticated,config:Config) {
  if (auth.actor.type!=='user' || ['GET','HEAD','OPTIONS'].includes(request.method)) return;
  const token=request.headers['x-csrf-token'];
  if (request.headers.origin!==config.publicOrigin || typeof token!=='string' || !auth.csrfHash || !safeEqual(tokenHash(token),auth.csrfHash)) throw new AppError('CSRF_INVALID',403,'请求校验失效，请刷新后重试');
}
export function sessionCookies(reply:FastifyReply,config:Config,session:string,csrf:string) {
  const cookie={path:'/',secure:config.publicOrigin.startsWith('https:'),sameSite:'lax' as const,maxAge:7*86400};
  reply.setCookie('az_session',session,{...cookie,httpOnly:true}).setCookie('az_csrf',csrf,{...cookie,httpOnly:false});
}
export function clearSession(reply:FastifyReply) { reply.clearCookie('az_session',{path:'/'}).clearCookie('az_csrf',{path:'/'}); }

export async function registerOAuth(app:FastifyInstance,pool:Pool,config:Config,provider:GithubProvider) {
  app.get('/api/v1/auth/github/start',async (_request,reply)=>{
    if (!config.githubClientId || !config.githubClientSecret) throw new AppError('OAUTH_UNAVAILABLE',503,'尚未配置 GitHub App 登录');
    const state=randomBytes(32).toString('base64url'),binding=randomBytes(32).toString('base64url'),verifier=randomBytes(32).toString('base64url');
    await withTransaction(pool,async tx=>{
      await tx.query('DELETE FROM oauth_login_states WHERE expires_at<=clock_timestamp()');
      await tx.query("INSERT INTO oauth_login_states(id,state_hash,browser_binding_hash,code_verifier,expires_at) VALUES($1,$2,$3,$4,clock_timestamp()+interval '10 minutes')",[randomUUID(),tokenHash(state),tokenHash(binding),verifier]);
    });
    reply.setCookie('az_oauth',binding,{path:'/api/v1/auth/github',httpOnly:true,sameSite:'lax',secure:config.publicOrigin.startsWith('https:'),maxAge:600});
    const url=new URL('https://github.com/login/oauth/authorize');
    url.search=new URLSearchParams({client_id:config.githubClientId,redirect_uri:`${config.publicOrigin}/api/v1/auth/github/callback`,state,code_challenge:tokenHash(verifier).toString('base64url'),code_challenge_method:'S256'}).toString();
    return reply.redirect(url.toString());
  });
  app.get<{Querystring:{state:string;code?:string;error?:string}}>('/api/v1/auth/github/callback',{
    schema:{querystring:Type.Object({state:Type.String({minLength:20,maxLength:200}),code:Type.Optional(Type.String({minLength:1,maxLength:300})),error:Type.Optional(Type.String({maxLength:200}))})},
  },async(request,reply)=>{
    reply.clearCookie('az_oauth',{path:'/api/v1/auth/github'});
    const binding=request.cookies.az_oauth;
    if (!binding) throw new AppError('OAUTH_INVALID',400,'登录校验失效，请重新登录');
    // Atomic consume happens before external HTTP; no database lock is held over GitHub calls.
    const state=(await pool.query('DELETE FROM oauth_login_states WHERE state_hash=$1 AND browser_binding_hash=$2 AND expires_at>clock_timestamp() AND consumed_at IS NULL RETURNING code_verifier',[tokenHash(request.query.state),tokenHash(binding)])).rows[0];
    if (!state || request.query.error || !request.query.code) throw new AppError('OAUTH_INVALID',400,'登录校验失效，请重新登录');
    let identity:GithubIdentity;
    try { identity=await provider.exchange(request.query.code,state.code_verifier); }
    catch(error) { if (error instanceof AppError) throw error; throw new AppError('OAUTH_UNAVAILABLE',502,'GitHub 暂时不可用，请重新登录'); }
    if (!/^[1-9][0-9]*$/.test(identity.id)) throw new AppError('OAUTH_INVALID',400);
    const session=randomBytes(32).toString('base64url'),csrf=randomBytes(32).toString('base64url');
    await withTransaction(pool,async tx=>{
      let bootstrap=false;
      if(identity.id===config.bootstrapAdminGithubId) {
        await tx.query("SELECT pg_advisory_xact_lock(hashtext('agentzero:first-admin'))");
        bootstrap=!(await tx.query("SELECT 1 FROM users WHERE role='admin' LIMIT 1")).rowCount;
      }
      const user=(await tx.query(`INSERT INTO users(id,github_user_id,github_login,display_name,avatar_url,status,role)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(github_user_id) DO UPDATE SET github_login=excluded.github_login,display_name=excluded.display_name,avatar_url=excluded.avatar_url,
        status=CASE WHEN users.status='pending' AND users.role='member' AND excluded.role='admin' THEN 'active' ELSE users.status END,
        role=CASE WHEN users.status='pending' AND users.role='member' AND excluded.role='admin' THEN 'admin' ELSE users.role END,
        updated_at=clock_timestamp() RETURNING id,status,role`,[randomUUID(),identity.id,identity.login,identity.name,identity.avatarUrl,bootstrap?'active':'pending',bootstrap?'admin':'member'])).rows[0];
      await tx.query('SELECT ledger.open_user_account($1)', [user.id]);
      const sessionId=randomUUID();
      await tx.query("INSERT INTO user_sessions(id,user_id,token_hash,csrf_token_hash,expires_at) VALUES($1,$2,$3,$4,clock_timestamp()+interval '7 days')",[sessionId,user.id,tokenHash(session),tokenHash(csrf)]);
      if(bootstrap && user.role==='admin') await audit(tx,{type:'user',userId:user.id,sessionId},'identity.admin_bootstrapped','user',user.id,request.id,{reason:'Explicit BOOTSTRAP_ADMIN_GITHUB_ID configuration'});
      await audit(tx,{type:'user',userId:user.id,sessionId},'identity.login','user',user.id,request.id,{});
    });
    sessionCookies(reply,config,session,csrf);
    return reply.redirect(`${config.publicOrigin}/`);
  });
}

export async function identityView(pool:Pool,actor:Actor) {
  return withTransaction(pool,async tx=>{
    const {user}=await lockActor(tx,actor,{allowInactive:actor.type==='user',allowPaused:true});
    if (!user) throw new AppError('UNAUTHENTICATED',401);
    let policy;
    if(actor.type==='agent') policy=(await tx.query('SELECT can_accept_task,can_collaborate,can_trade,can_redeem_api,single_spend_limit,daily_spend_limit,version FROM agent_policies WHERE agent_id=$1',[actor.agentId])).rows[0];
    return {actor:actor.type==='user'?{type:'user',userId:actor.userId}:{type:'agent',agentId:actor.type==='agent'?actor.agentId:undefined},user:{id:user.id,github_login:user.github_login,display_name:user.display_name,avatar_url:user.avatar_url,status:user.status,role:user.role},...(policy?{policy}:{})};
  });
}
