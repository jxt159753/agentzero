import type { Actor, ConfirmationDto, ConfirmAgreementInput, ParticipantDto } from '@agentzero/contracts';
import { parseAmount } from '@agentzero/contracts';
import type { Tx } from '@agentzero/database';
import { AppError } from '../../core.js';
import { isPublisher, userId, type TaskRow } from '../tasks/service.js';

export type Payment={agent_id:string;amount_points:string};
export async function members(tx:Tx,agreementId:string):Promise<ParticipantDto[]> {
  const rows=(await tx.query<ParticipantDto>(`SELECT m.agent_id,a.owner_user_id,a.name,u.display_name AS owner_name,m.role,m.deliverable,m.amount_points
    FROM agreement_members m JOIN agents a ON a.id=m.agent_id JOIN users u ON u.id=a.owner_user_id WHERE m.agreement_id=$1 ORDER BY m.agent_id`,[agreementId])).rows;
  return rows.map(row=>({...row,shared_owner:rows.some(other=>other.agent_id!==row.agent_id&&other.owner_user_id===row.owner_user_id)}));
}
export async function activeParticipants(tx:Tx,task:TaskRow):Promise<ParticipantDto[]> {
  if(task.active_agreement_id) return members(tx,task.active_agreement_id);
  if(!task.assignee_agent_id) return [];
  const row=(await tx.query('SELECT a.id AS agent_id,a.owner_user_id,a.name,u.display_name AS owner_name FROM agents a JOIN users u ON u.id=a.owner_user_id WHERE a.id=$1',[task.assignee_agent_id])).rows[0];
  return [{...row,role:'主承接者',deliverable:task.description,amount_points:task.reward_points,shared_owner:false}];
}
export function mayConfirm(task:TaskRow,actor:Actor,confirmation:ConfirmationDto):boolean {
  return confirmation.subject_key==='publisher'?isPublisher(task,actor):actor.type==='agent'?confirmation.agent_id===actor.agentId:actor.type==='user'&&confirmation.user_id===actor.userId;
}
export function confirmationSubject(task:TaskRow,actor:Actor,input:Partial<ConfirmAgreementInput>,rows:ConfirmationDto[]):ConfirmationDto {
  if(input.as_publisher&&input.agent_id) throw new AppError('INVALID_REQUEST',400,'请明确选择发布方或一个参与 Agent');
  let subject:string|undefined;
  if(input.as_publisher) subject='publisher';
  else if(input.agent_id) subject=`agent:${input.agent_id}`;
  else if(actor.type==='agent') subject=`agent:${actor.agentId}`;
  else if(isPublisher(task,actor)) subject='publisher';
  else {
    const eligible=rows.filter(row=>row.subject_key!=='publisher'&&mayConfirm(task,actor,row));
    if(eligible.length===1) subject=eligible[0]!.subject_key;
  }
  const row=rows.find(item=>item.subject_key===subject);
  if(!row||!mayConfirm(task,actor,row)) throw new AppError('ACCESS_DENIED',403,'请选择本人有权代表的发布方或参与 Agent');
  return row;
}
export function confirmationRows(task:TaskRow,participants:ParticipantDto[]):ConfirmationDto[] {
  return [{subject_key:'publisher',agent_id:task.publisher_agent_id,user_id:task.publisher_user_id,accepted_at:null},...participants.map(member=>({subject_key:`agent:${member.agent_id}`,agent_id:member.agent_id,user_id:member.owner_user_id,accepted_at:null}))];
}
export async function assertCollaborationAllowed(tx:Tx,agentIds:string[]) {
  const rows=(await tx.query(`SELECT a.id,a.status,u.status AS owner_status,p.can_collaborate FROM agents a JOIN users u ON u.id=a.owner_user_id JOIN agent_policies p ON p.agent_id=a.id WHERE a.id=ANY($1::uuid[]) ORDER BY a.id FOR UPDATE OF p`,[agentIds])).rows;
  if(rows.length!==new Set(agentIds).size||rows.some(row=>row.status!=='active'||row.owner_status!=='active'||!row.can_collaborate)) throw new AppError('COLLABORATION_NOT_ALLOWED',403,'参与 Agent 必须处于活跃状态且已开启协作权限');
}
export async function settlementPayments(tx:Tx,task:TaskRow,total:string,provided:Payment[]|undefined,outcome:'settled'|'cancelled'):Promise<Payment[]> {
  const participants=await activeParticipants(tx,task);
  const expected=participants.map(member=>({agent_id:member.agent_id,amount_points:member.amount_points}));
  const payments=provided??(outcome==='settled'?expected:participants.length===1?[{agent_id:participants[0]!.agent_id,amount_points:total}]:[]);
  if(payments.length!==participants.length||new Set(payments.map(p=>p.agent_id)).size!==payments.length||payments.some(p=>!participants.some(member=>member.agent_id===p.agent_id))) throw new AppError('INVALID_SETTLEMENT',400,'取消或裁定必须列出每个有效参与 Agent 的报酬');
  if(payments.reduce((sum,p)=>sum+parseAmount(p.amount_points),0n)!==parseAmount(total)) throw new AppError('INVALID_SETTLEMENT',400,'成员报酬之和必须等于总付款');
  if(outcome==='settled'&&payments.some(p=>expected.find(e=>e.agent_id===p.agent_id)?.amount_points!==p.amount_points)) throw new AppError('INVALID_SETTLEMENT',400,'已完成任务必须按照有效协议分账');
  return payments;
}
export async function collaborationDetail(tx:Tx,task:TaskRow,actor:Actor) {
  const agreements=(await tx.query('SELECT * FROM collaboration_agreements WHERE task_id=$1 ORDER BY version DESC',[task.id])).rows;
  for(const agreement of agreements) {
    agreement.members=await members(tx,agreement.id);
    agreement.confirmations=(await tx.query<ConfirmationDto>('SELECT subject_key,agent_id,user_id,accepted_at FROM agreement_confirmations WHERE agreement_id=$1 ORDER BY subject_key',[agreement.id])).rows;
    const mutable=agreement.status==='pending'&&!task.disputed&&!['settled','cancelled'].includes(task.status);
    agreement.can_accept=mutable&&!task.overdue&&agreement.confirmations.some((row:ConfirmationDto)=>!row.accepted_at&&mayConfirm(task,actor,row));
    agreement.can_reject=mutable&&agreement.confirmations.some((row:ConfirmationDto)=>mayConfirm(task,actor,row));
  }
  const contributions=(await tx.query('SELECT * FROM task_contributions WHERE task_id=$1 ORDER BY created_at,id',[task.id])).rows;
  return {agreements,participants:await activeParticipants(tx,task),contributions};
}
export function participantOwnerIds(task:TaskRow):string[] {return task.participant_owner_user_ids??(task.assignee_owner_user_id?[task.assignee_owner_user_id]:[]);}
export function participantAgent(task:TaskRow,actor:Actor):string|undefined {
  if(actor.type==='agent') return task.participant_agent_ids?.includes(actor.agentId)?actor.agentId:undefined;
  if(actor.type==='user') return task.participant_agent_ids?.find((_,index)=>task.participant_owner_user_ids?.[index]===userId(actor));
  return undefined;
}
