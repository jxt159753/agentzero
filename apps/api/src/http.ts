import type { FastifyRequest, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import type { Actor } from '@agentzero/contracts';
import type { Config } from './config.js';
import { AppError, hash,lockActor,principal,safeEqual,runCommand, type CommandOptions, type CommandResult } from './core.js';
import { withTransaction,type Tx } from '@agentzero/database';
declare module 'fastify' { interface FastifyRequest { actor: Actor } }
export interface ApiContext { pool:Pool; config:Config }
export function requireUser(request:FastifyRequest) {
  if(request.actor.type!=='user') throw new AppError('ACCESS_DENIED',403);
  return request.actor;
}
// Read durable results before external API calls; a completed command does not depend on GitHub still being online.
export async function replayCommand(ctx:ApiContext,request:FastifyRequest,reply:FastifyReply,options:Partial<CommandOptions>={}):Promise<boolean> {
  const key=request.headers['idempotency-key'];
  if(typeof key!=='string' || !/^[\w.:-]{8,128}$/.test(key)) throw new AppError('INVALID_REQUEST',400,'请提供 8–128 位 Idempotency-Key');
  const prior=await withTransaction(ctx.pool,async tx=>{
    await lockActor(tx,request.actor,options);
    const row=(await tx.query(`SELECT request_hash,response_status,response_body FROM idempotency_requests
      WHERE principal_key=$1 AND route_key=$2 AND idempotency_key=$3 AND status='completed'`,[principal(request.actor),options.route??`${request.method}:${request.routeOptions.url}`,key])).rows[0];
    if(row && !safeEqual(row.request_hash,hash(options.payload??{params:request.params,body:request.body??null}))) throw new AppError('IDEMPOTENCY_CONFLICT',409);
    return row;
  });
  if(!prior) return false;
  reply.code(prior.response_status).send(prior.response_body);
  return true;
}
export async function command(ctx:ApiContext,request:FastifyRequest,reply:FastifyReply,options:Partial<CommandOptions>,fn:(tx:Tx,id:string)=>Promise<CommandResult>) {
  const key=request.headers['idempotency-key'];
  if(typeof key!=='string') throw new AppError('INVALID_REQUEST',400,'写操作需要 Idempotency-Key');
  const result=await runCommand(ctx.pool,request.actor,{route:`${request.method}:${request.routeOptions.url}`,key,payload:{params:request.params,body:request.body??null},requestId:request.id,...options},fn);
  return reply.code(result.status).send(result.body);
}
