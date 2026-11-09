import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Tx } from '@agentzero/database';
import type { Actor } from '@agentzero/contracts';
import { AppError, audit } from '../../core.js';
import type { GitHubRepository } from './provider.js';

export async function installationRevision(tx: Tx, installationId: string): Promise<string> {
  const row = (await tx.query("SELECT updated_at::text AS revision FROM github_installations WHERE installation_id=$1 AND status='active'", [installationId])).rows[0];
  if (!row) throw new AppError('REPOSITORY_UNAVAILABLE', 409);
  return row.revision;
}

// Call after remote membership verification; the installation revision closes the revocation race.
export async function admitRepository(tx: Tx, input: {
  actor: Actor; requestId: string; installationId: string; installationRevision: string; repository: GitHubRepository;
}) {
  const installation = (await tx.query("SELECT updated_at::text AS revision FROM github_installations WHERE installation_id=$1 AND status='active' FOR SHARE", [input.installationId])).rows[0];
  const repo = input.repository;
  if (!installation || installation.revision !== input.installationRevision || repo.isPrivate) throw new AppError('REPOSITORY_UNAVAILABLE', 409);
  const row = (await tx.query(`INSERT INTO repositories(github_id,installation_id,owner,name,full_name,is_private,status) VALUES($1,$2,$3,$4,$5,false,'approved')
    ON CONFLICT(github_id) DO UPDATE SET installation_id=excluded.installation_id,owner=excluded.owner,name=excluded.name,full_name=excluded.full_name,is_private=false,status='approved',updated_at=clock_timestamp() RETURNING *`,
  [repo.repositoryId, input.installationId, repo.owner, repo.name, repo.fullName])).rows[0];
  await tx.query('INSERT INTO contribution_history_scans(repository_id) VALUES($1) ON CONFLICT DO NOTHING', [row.id]);
  await audit(tx, input.actor, 'github.repository_approved', 'repository', row.id, input.requestId, { github_id: row.github_id, installation_id: input.installationId });
  return row;
}

export function verifyWebhookSignature(body:Buffer,signature:unknown,secret:string|undefined):void {
  if(!secret) throw new AppError('GITHUB_NOT_CONFIGURED',503);
  if(typeof signature!=='string' || !/^sha256=[0-9a-f]{64}$/.test(signature)) throw new AppError('WEBHOOK_SIGNATURE_INVALID',401);
  const expected=createHmac('sha256',secret).update(body).digest();
  if(!timingSafeEqual(expected,Buffer.from(signature.slice(7),'hex'))) throw new AppError('WEBHOOK_SIGNATURE_INVALID',401);
}

export async function assertRepositoryAvailable(tx:Tx,repositoryId:string) {
  const repo=(await tx.query(`SELECT r.* FROM repositories r JOIN github_installations i USING(installation_id)
    WHERE r.id=$1 AND r.status='approved' AND NOT r.is_private AND i.status='active' FOR SHARE OF r,i`,[repositoryId])).rows[0];
  if(!repo) throw new AppError('REPOSITORY_UNAVAILABLE',409,'仓库未准入或 GitHub 安装不可用');
  return repo;
}

export async function persistGithubDelivery(tx:Tx,input:{deliveryId:string;eventName:string;payload:Record<string,any>;raw:Buffer}) {
  const {deliveryId,eventName,payload}=input;
  const payloadHash=createHash('sha256').update(input.raw).digest();
  const inserted=await tx.query(`INSERT INTO github_deliveries(delivery_id,event_name,payload_hash,payload) VALUES($1,$2,$3,$4)
    ON CONFLICT(delivery_id) DO NOTHING RETURNING delivery_id`,[deliveryId,eventName,payloadHash,JSON.stringify(payload)]);
  if(!inserted.rowCount) {
    const prior=(await tx.query('SELECT event_name,payload_hash FROM github_deliveries WHERE delivery_id=$1',[deliveryId])).rows[0];
    if(prior.event_name!==eventName || !timingSafeEqual(prior.payload_hash,payloadHash)) throw new AppError('IDEMPOTENCY_CONFLICT',409);
    return {duplicate:true};
  }
  // Revocation is applied before acknowledging delivery, independent of the background worker.
  const installationId=String(payload.installation?.id??'');
  if(eventName==='installation' && ['deleted','suspend'].includes(payload.action)) {
    const status=payload.action==='deleted'?'deleted':'suspended';
    await tx.query(`INSERT INTO github_installations(installation_id,account_login,status) VALUES($1,$2,$3)
      ON CONFLICT(installation_id) DO UPDATE SET status=excluded.status,updated_at=clock_timestamp()`,[installationId,String(payload.installation?.account?.login??'unknown'),status]);
    await audit(tx,{type:'system'},'github.installation_revoked','github_installation',installationId,deliveryId,{status});
  }
  if(eventName==='installation_repositories' && payload.action==='removed') {
    await tx.query('UPDATE github_installations SET updated_at=clock_timestamp() WHERE installation_id=$1',[installationId]);
    const ids=(Array.isArray(payload.repositories_removed)?payload.repositories_removed:[]).map((r:any)=>String(r.id));
    await tx.query("UPDATE repositories SET status='disabled',updated_at=clock_timestamp() WHERE installation_id=$1 AND github_id=ANY($2::text[])",[installationId,ids]);
  }
  if(eventName==='repository' && ['privatized','deleted','archived','transferred','renamed'].includes(payload.action)) {
    await tx.query("UPDATE repositories SET status='disabled',is_private=CASE WHEN $3 THEN true ELSE is_private END,updated_at=clock_timestamp() WHERE installation_id=$1 AND github_id=$2",[installationId,String(payload.repository?.id??''),payload.action==='privatized']);
  }
  return {duplicate:false};
}
