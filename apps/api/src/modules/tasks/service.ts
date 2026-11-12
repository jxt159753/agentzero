import { randomUUID } from 'node:crypto';
import type { Actor, CreateTaskInput, TaskDto, TaskEventDto } from '@agentzero/contracts';
import { parseAmount } from '@agentzero/contracts';
import type { Tx } from '@agentzero/database';
import { AppError, audit, type CommandResult } from '../../core.js';
import { finalizeHold } from '../ledger/service.js';
import type { PullRequestEvidence } from '../github/provider.js';
import { collaborationDetail,mayConfirm,participantAgent,participantOwnerIds,settlementPayments,type Payment } from '../collaboration/service.js';

export type TaskRow = TaskDto & {
  assignee_owner_user_id:string|null; assignee_github_id:string|null; payer_owner_user_id:string|null;
  github_repository_id:string|null; installation_id:string|null; repository_owner:string|null; repository_slug:string|null;
  installation_status:string|null; repository_status:string|null; overdue:boolean;
  active_agreement_id:string|null;participant_agent_ids:string[];participant_owner_user_ids:string[];
};
export const taskSelect=`SELECT t.*, a.owner_user_id AS assignee_owner_user_id,u.github_user_id::text AS assignee_github_id,
  payer.owner_user_id AS payer_owner_user_id,pu.display_name AS publisher_name,ru.display_name AS reviewer_name,
  a.name AS assignee_name,r.full_name AS repository_name,r.github_id AS github_repository_id,r.installation_id,
  r.owner AS repository_owner,r.name AS repository_slug,r.status AS repository_status,i.status AS installation_status,
  t.deadline_at<=clock_timestamp() AS overdue,ca.id AS active_agreement_id,
  COALESCE(members.agent_ids,ARRAY_REMOVE(ARRAY[a.id],NULL)) AS participant_agent_ids,
  COALESCE(members.owner_ids,ARRAY_REMOVE(ARRAY[a.owner_user_id],NULL)) AS participant_owner_user_ids
  FROM tasks t LEFT JOIN repositories r ON r.id=t.repository_id LEFT JOIN github_installations i ON i.installation_id=r.installation_id
  JOIN users pu ON pu.id=t.publisher_user_id JOIN users ru ON ru.id=t.reviewer_user_id
  LEFT JOIN agents a ON a.id=t.assignee_agent_id LEFT JOIN users u ON u.id=a.owner_user_id LEFT JOIN agents payer ON payer.id=t.payer_agent_id
  LEFT JOIN collaboration_agreements ca ON ca.task_id=t.id AND ca.status='active'
  LEFT JOIN LATERAL (SELECT array_agg(am.agent_id ORDER BY am.agent_id) AS agent_ids,array_agg(ma.owner_user_id ORDER BY am.agent_id) AS owner_ids
    FROM agreement_members am JOIN agents ma ON ma.id=am.agent_id WHERE am.agreement_id=ca.id) members ON true`;
export const userId=(actor:Actor)=>actor.type==='user'?actor.userId:actor.type==='agent'?actor.ownerUserId:null;
export const isPublisher=(task:TaskRow,actor:Actor)=>actor.type==='user'?task.publisher_user_id===actor.userId:actor.type==='agent'&&task.publisher_agent_id===actor.agentId;
export const isAssignee=(task:TaskRow,actor:Actor)=>actor.type==='user'?task.assignee_owner_user_id===actor.userId:actor.type==='agent'&&task.assignee_agent_id===actor.agentId;
export const isParticipant=(task:TaskRow,actor:Actor)=>isPublisher(task,actor)||!!participantAgent(task,actor);
export const isFinal=(task:TaskRow)=>task.status==='settled'||task.status==='cancelled';
export async function isAdmin(tx:Tx,actor:Actor) {
  return actor.type==='user'&&(await tx.query('SELECT role FROM users WHERE id=$1',[actor.userId])).rows[0]?.role==='admin';
}
export async function loadTask(tx:Tx,id:string,actor:Actor,lock=false):Promise<TaskRow> {
  const task=(await tx.query<TaskRow>(`${taskSelect} WHERE t.id=$1${lock?' FOR UPDATE OF t':''}`,[id])).rows[0];
  if(!task || (task.status==='draft'&&!isPublisher(task,actor)&&!await isAdmin(tx,actor))) throw new AppError('NOT_FOUND',404,'任务不存在');
  return task;
}
export function requireVersion(task:TaskRow,version:string) {
  parseAmount(version,true);
  if(task.version!==version) throw new AppError('TASK_VERSION_CONFLICT',409,'任务已更新，请刷新后重试');
}
export function requireState(task:TaskRow,states:TaskDto['status'][],allowDisputed=false) {
  if(!states.includes(task.status)) throw new AppError('TASK_STATE_CONFLICT',409,'当前任务状态不允许此操作');
  if(task.disputed&&!allowDisputed) throw new AppError('TASK_DISPUTED',409,'任务正在争议处理中');
}
export function requirePublisher(task:TaskRow,actor:Actor) {if(!isPublisher(task,actor)) throw new AppError('ACCESS_DENIED',403);}
export function requireAssignee(task:TaskRow,actor:Actor) {if(!isAssignee(task,actor)) throw new AppError('ACCESS_DENIED',403);}
export function requireReviewer(task:TaskRow,actor:Actor) {
  if(actor.type!=='user'||actor.userId!==task.reviewer_user_id) throw new AppError('ACCESS_DENIED',403);
  if(participantOwnerIds(task).includes(actor.userId)) throw new AppError('REVIEWER_CONFLICT',409,'验收人不能是任一参与 Agent 的所有者');
}
export function requireBeforeDeadline(task:TaskRow) {
  if(task.overdue) throw new AppError('TASK_DEADLINE_PASSED',409,'任务已到期，请申请管理员处理');
}
export function validateFields(input:CreateTaskInput,publisherUserId:string) {
  const fields={...input,repository_id:input.repository_id??null,acceptance_criteria:input.acceptance_criteria??input.description,
    required_checks:input.required_checks??[],reviewer_user_id:input.reviewer_user_id??publisherUserId};
  parseAmount(input.reward_points,true);
  if(new Date(input.deadline_at).getTime()<=Date.now()) throw new AppError('INVALID_REQUEST',400,'截止时间必须晚于现在');
  if(new Set(fields.required_checks.map(name=>name.trim())).size!==fields.required_checks.length) throw new AppError('INVALID_REQUEST',400,'检查项不能重复');
  if(!fields.repository_id) {
    if(fields.issue_number!=null||fields.required_checks.length) throw new AppError('INVALID_REQUEST',400,'纯文字任务不能设置 GitHub Issue 或检查项');
    if(fields.reviewer_user_id!==publisherUserId) throw new AppError('INVALID_REVIEWER',400,'纯文字任务由发布者本人验收');
  }
  return fields;
}
export async function validateReviewer(tx:Tx,id:string,assigneeOwner?:string|null) {
  const reviewer=(await tx.query('SELECT status FROM users WHERE id=$1',[id])).rows[0];
  if(!reviewer||reviewer.status!=='active') throw new AppError('INVALID_REVIEWER',400,'请选择已准入的验收人');
  if(id===assigneeOwner) throw new AppError('REVIEWER_CONFLICT',409,'验收人不能是承接 Agent 的所有者');
}
export function representedActor(task:TaskRow,actor:Actor):Actor {
  if(actor.type!=='user') return actor;
  const agentId=actor.representedAgentId??(isPublisher(task,actor)?task.publisher_agent_id??task.payer_agent_id:participantAgent(task,actor));
  return agentId?{...actor,representedAgentId:agentId}:actor;
}
export async function taskEvent(tx:Tx,task:TaskRow,actor:Actor,requestId:string,kind:string,details:Record<string,unknown>={}) {
  const actualActor=representedActor(task,actor);
  await tx.query(`INSERT INTO task_events(id,task_id,kind,actor_type,actor_user_id,actor_agent_id,details) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [randomUUID(),task.id,kind,actualActor.type,actualActor.type==='user'?actualActor.userId:null,actualActor.type==='agent'?actualActor.agentId:actualActor.type==='user'?actualActor.representedAgentId??null:null,JSON.stringify(details)]);
  await audit(tx,actualActor,`task.${kind}`,'task',task.id,requestId,details);
}
export function taskBody(task:TaskRow):Record<string,unknown> {
  const {assignee_owner_user_id:_a,assignee_github_id:_b,payer_owner_user_id:_c,github_repository_id:_d,installation_id:_e,
    repository_owner:_f,repository_slug:_g,installation_status:_h,repository_status:_i,overdue:_j,participant_agent_ids:_k,participant_owner_user_ids:_l,...body}=task;
  return body;
}
export async function markTaskDisputed(tx:Tx,task:TaskRow,actor:Actor,requestId:string,reason:string,kind:'disputed'|'admin_intervened'='disputed') {
  await tx.query("UPDATE task_cancellation_proposals SET status='superseded' WHERE task_id=$1 AND status='pending'",[task.id]);
  await tx.query('UPDATE tasks SET disputed=true,dispute_reason=$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1',[task.id,reason]);
  await taskEvent(tx,task,actor,requestId,kind,{reason});
}
export function taskResult(task:TaskRow,status=200):CommandResult {return {status,body:taskBody(task),resourceType:'task',resourceId:task.id};}
export function verifyEvidence(task:TaskRow,evidence:PullRequestEvidence,prNumber:number,headSha:string,settlement=false) {
  if(evidence.repositoryId!==task.github_repository_id||evidence.number!==prNumber||evidence.headSha!==headSha) throw new AppError('PR_VERSION_CHANGED',409,'PR 仓库或提交版本已变化，请重新提交成果');
  if(evidence.authorGithubId!==task.assignee_github_id) throw new AppError('PR_IDENTITY_MISMATCH',409,'PR 作者必须是承接 Agent 已绑定的 GitHub 用户');
  if(settlement) {
    if(!evidence.merged) throw new AppError('PR_NOT_MERGED',409,'PR 合并后才能结算');
    const missing=task.required_checks.filter(name=>{
      const matching=evidence.checks.filter(check=>check.name===name);
      return matching.length===0||matching.some(check=>check.status!=='completed'||check.conclusion!=='success');
    });
    if(missing.length) throw new AppError('PR_CHECKS_PENDING',409,`约定检查尚未全部通过：${missing.join('、')}`);
  }
}
export async function finishTask(tx:Tx,task:TaskRow,actor:Actor,requestId:string,input:{payment:string;refund:string;reason:string;outcome:'settled'|'cancelled';evidence?:PullRequestEvidence;payments?:Payment[]}) {
  const paid=parseAmount(input.payment),refund=parseAmount(input.refund);
  if(paid+refund!==BigInt(task.reward_points)||(!task.assignee_agent_id&&paid>0n)) throw new AppError('INVALID_SETTLEMENT',400,'报酬与退款之和必须等于冻结奖金');
  if(input.outcome==='settled'&&((task.repository_id&&!input.evidence)||paid!==BigInt(task.reward_points)||refund!==0n)) throw new AppError('INVALID_SETTLEMENT',400,'完成任务须支付全部约定奖金');
  const payments=await settlementPayments(tx,task,input.payment,input.payments,input.outcome);
  if(input.outcome==='settled'&&task.repository_id) {
    // Lock by stable repository + PR, not by request key; different tasks cannot both reward one PR.
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`rewarded-pr:${task.repository_id}:${input.evidence!.number}`]);
    const rewarded=(await tx.query('SELECT task_id FROM rewarded_pull_requests WHERE repository_id=$1 AND pr_number=$2',[task.repository_id,input.evidence!.number])).rows[0];
    if(rewarded) throw new AppError('PR_ALREADY_REWARDED',409,'此 PR 已获得另一任务的奖励');
  }
  const result=await finalizeHold(tx,{actor:{type:'system'},requestId},{holdId:task.hold_id!,payments:payments.filter(p=>BigInt(p.amount_points)>0n).map(p=>({agentId:p.agent_id,amount:p.amount_points})),refund:input.refund,reason:input.reason});
  if(input.outcome==='settled'&&task.repository_id) await tx.query('INSERT INTO rewarded_pull_requests(repository_id,pr_number,task_id,journal_id) VALUES($1,$2,$3,$4)',[task.repository_id,input.evidence!.number,task.id,result.transactionId]);
  await tx.query("UPDATE task_cancellation_proposals SET status='superseded' WHERE task_id=$1 AND status='pending'",[task.id]);
  await tx.query("UPDATE collaboration_agreements SET status='superseded' WHERE task_id=$1 AND status='pending'",[task.id]);
  await tx.query(`UPDATE tasks SET status=$2,version=version+1,settled_journal_id=$3,disputed=false,dispute_reason=NULL,finalized_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`,[task.id,input.outcome,result.transactionId]);
  await taskEvent(tx,task,actor,requestId,input.outcome,{payment_points:input.payment,payments,refund_points:input.refund,reason:input.reason,journal_id:result.transactionId,agreement_id:task.active_agreement_id});
}
export async function taskDetail(tx:Tx,task:TaskRow,actor:Actor) {
  const admin=await isAdmin(tx,actor),publisher=isPublisher(task,actor),assignee=isAssignee(task,actor),final=isFinal(task);
  const participant=isParticipant(task,actor),reviewer=actor.type==='user'&&actor.userId===task.reviewer_user_id&&!participantOwnerIds(task).includes(actor.userId);
  const mutable=!final&&!task.disputed;
  const independentAdmin=admin&&actor.type==='user'&&!participantOwnerIds(task).includes(actor.userId);
  const permission={edit:publisher&&['draft','open'].includes(task.status),publish:publisher&&task.status==='draft',
    accept:task.status==='open'&&!task.overdue&&userId(actor)!==task.reviewer_user_id,
    submit:assignee&&mutable&&['in_progress','changes_requested'].includes(task.status)&&!task.overdue,
    review:reviewer&&mutable&&task.status==='submitted',cancel:publisher&&task.status==='open',
    propose_cancel:participant&&mutable&&!!task.assignee_agent_id,dispute:participant&&!final&&!!task.assignee_agent_id,
    resolve:independentAdmin&&task.disputed&&!final,
    admin_cancel:independentAdmin&&mutable&&task.status==='open',
    admin_intervene:independentAdmin&&mutable&&!!task.assignee_agent_id&&['in_progress','submitted','changes_requested'].includes(task.status),
    propose_agreement:assignee&&mutable&&['in_progress','changes_requested'].includes(task.status)&&!task.overdue,
    contribute:!!participantAgent(task,actor)&&mutable&&['in_progress','changes_requested','submitted'].includes(task.status)&&!task.overdue,
    discuss:participant||reviewer||admin};
  const hold=task.hold_id?(await tx.query('SELECT id,status,reserved_total,captured_total,released_total,(reserved_total-captured_total-released_total)::text AS remaining FROM credit_holds WHERE id=$1',[task.hold_id])).rows[0]:null;
  const deliveries=(await tx.query('SELECT id,task_id,agent_id,pr_number,head_sha,pr_url,content,evidence,created_at FROM task_deliveries WHERE task_id=$1 ORDER BY created_at DESC,id DESC',[task.id])).rows;
  const reviews=(await tx.query('SELECT id,task_id,delivery_id,reviewer_user_id,decision,reason,unmet_criteria,evidence,created_at FROM task_reviews WHERE task_id=$1 ORDER BY created_at,id',[task.id])).rows;
  const proposals=(await tx.query('SELECT * FROM task_cancellation_proposals WHERE task_id=$1 ORDER BY created_at DESC,id DESC',[task.id])).rows.map(row=>({...row,can_accept:mutable&&row.status==='pending'&&row.confirmations.some((confirmation:import('@agentzero/contracts').ConfirmationDto)=>!confirmation.accepted_at&&mayConfirm(task,actor,confirmation))}));
  const events=(await tx.query<TaskEventDto>('SELECT * FROM task_events WHERE task_id=$1 ORDER BY created_at,id',[task.id])).rows;
  return {...taskBody(task),...await collaborationDetail(tx,task,actor),repository:task.repository_id?{id:task.repository_id,full_name:task.repository_name,status:task.repository_status,installation_status:task.installation_status}:null,hold,deliveries,reviews,cancellation_proposals:proposals,events,permissions:permission};
}
