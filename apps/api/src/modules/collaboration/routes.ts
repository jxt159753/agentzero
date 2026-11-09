import { randomUUID } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance,FastifyRequest } from 'fastify';
import { withTransaction,type Tx } from '@agentzero/database';
import { ConfirmAgreement,IdParams,ProposeAgreement,RejectAgreement,SubmitContribution,Uuid,parseAmount,type Actor,type ConfirmationDto,type ConfirmAgreementInput,type ProposeAgreementInput,type RejectAgreementInput,type SubmitContributionInput } from '@agentzero/contracts';
import { AppError,lockActor,type CommandOptions } from '../../core.js';
import { command,type ApiContext } from '../../http.js';
import { loadTask,requireAssignee,requireBeforeDeadline,requireState,requireVersion,taskEvent,taskResult,type TaskRow } from '../tasks/service.js';
import { activeParticipants,assertCollaborationAllowed,confirmationRows,confirmationSubject,members,participantOwnerIds } from './service.js';

type TaskRequest=FastifyRequest<{Params:{id:string}}>;
async function snapshot(ctx:ApiContext,request:TaskRequest) {
  return withTransaction(ctx.pool,async tx=>{await lockActor(tx,request.actor,{allowPaused:true});return loadTask(tx,request.params.id,request.actor);});
}
async function ownerIds(tx:Tx,ids:string[]):Promise<string[]> {
  return (await tx.query<{owner_user_id:string}>('SELECT owner_user_id FROM agents WHERE id=ANY($1::uuid[]) AND deleted_at IS NULL',[ids])).rows.map(row=>row.owner_user_id);
}
function options(task:TaskRow,extra:string[]=[],agentId?:string):Partial<CommandOptions> {
  return {allowPaused:true,userIds:[task.publisher_user_id,task.reviewer_user_id,...participantOwnerIds(task),...extra],...(agentId?{agentId}: {})};
}
function represented(actor:Actor,subject:ConfirmationDto):Actor {
  return actor.type==='user'&&subject.agent_id?{...actor,representedAgentId:subject.agent_id}:actor;
}
async function markConfirmation(tx:Tx,agreementId:string,subject:ConfirmationDto,actor:Actor) {
  await tx.query(`UPDATE agreement_confirmations SET accepted_at=clock_timestamp(),actor_type=$3,actor_user_id=$4,actor_agent_id=$5 WHERE agreement_id=$1 AND subject_key=$2 AND accepted_at IS NULL`,
    [agreementId,subject.subject_key,actor.type,actor.type==='user'?actor.userId:null,actor.type==='agent'?actor.agentId:null]);
}

export async function registerCollaboration(app:FastifyInstance,ctx:ApiContext) {
  app.get('/api/v1/collaboration-agents',async request=>withTransaction(ctx.pool,async tx=>{
    await lockActor(tx,request.actor,{allowPaused:true});
    return {items:(await tx.query(`SELECT a.id,a.name,a.owner_user_id,u.display_name AS owner_name FROM agents a JOIN users u ON u.id=a.owner_user_id JOIN agent_policies p ON p.agent_id=a.id WHERE a.status='active' AND u.status='active' AND p.can_collaborate ORDER BY a.name,a.id`)).rows};
  }));
  app.post<{Params:{id:string};Body:ProposeAgreementInput}>('/api/v1/tasks/:id/agreements',{schema:{params:IdParams,body:ProposeAgreement}},async(request,reply)=>{
    const prior=await snapshot(ctx,request),b=request.body;
    requireAssignee(prior,request.actor);
    const additionalOwners=await withTransaction(ctx.pool,tx=>ownerIds(tx,b.members.map(member=>member.agent_id)));
    return command(ctx,request,reply,options(prior,additionalOwners,prior.assignee_agent_id!),async tx=>{
      const task=await loadTask(tx,request.params.id,request.actor,true);
      requireVersion(task,b.version);requireAssignee(task,request.actor);requireState(task,['in_progress','changes_requested']);requireBeforeDeadline(task);
      if(new Set(b.members.map(m=>m.agent_id)).size!==b.members.length||!b.members.some(m=>m.agent_id===task.assignee_agent_id)||b.members.some(m=>m.agent_id===task.payer_agent_id)) throw new AppError('INVALID_AGREEMENT',400,'成员必须唯一、包含主承接者且不能包含付款 Agent');
      if(b.members.reduce((sum,m)=>sum+parseAmount(m.amount_points),0n)!==BigInt(task.reward_points)) throw new AppError('INVALID_AGREEMENT',400,'全部成员分账之和必须等于任务奖金');
      if(Date.parse(b.deadline_at)<=Date.now()) throw new AppError('INVALID_AGREEMENT',400,'协议截止时间必须晚于现在');
      const owners=await ownerIds(tx,b.members.map(m=>m.agent_id));
      if(owners.includes(task.reviewer_user_id)) throw new AppError('REVIEWER_CONFLICT',409,'验收人不能属于任何拟参与 Agent');
      await assertCollaborationAllowed(tx,[task.assignee_agent_id!]);
      // Read-only invitations are permitted while an invitee has collaboration disabled;
      // their explicit acceptance and final activation enforce current authorization.
      if(owners.length!==b.members.length) throw new AppError('INVALID_AGREEMENT',400,'参与 Agent 不存在或已删除');
      const existing=await activeParticipants(tx,task);
      await tx.query("UPDATE collaboration_agreements SET status='superseded' WHERE task_id=$1 AND status='pending'",[task.id]);
      const id=randomUUID(),version=(await tx.query('SELECT (COALESCE(max(version),0)+1)::text AS version FROM collaboration_agreements WHERE task_id=$1',[task.id])).rows[0].version;
      await tx.query('INSERT INTO collaboration_agreements(id,task_id,version,deadline_at) VALUES($1,$2,$3,$4)',[id,task.id,version,b.deadline_at]);
      for(const member of b.members) await tx.query('INSERT INTO agreement_members(agreement_id,agent_id,role,deliverable,amount_points) VALUES($1,$2,$3,$4,$5)',[id,member.agent_id,member.role.trim(),member.deliverable.trim(),member.amount_points]);
      const proposed=await members(tx,id),all=[...existing,...proposed.filter(member=>!existing.some(old=>old.agent_id===member.agent_id))];
      const confirmations=confirmationRows(task,all);
      for(const row of confirmations) await tx.query('INSERT INTO agreement_confirmations(agreement_id,subject_key,agent_id,user_id) VALUES($1,$2,$3,$4)',[id,row.subject_key,row.agent_id,row.user_id]);
      const proposer=confirmations.find(row=>row.subject_key===`agent:${task.assignee_agent_id}`)!;
      await markConfirmation(tx,id,proposer,request.actor);
      await tx.query('UPDATE tasks SET version=version+1,updated_at=clock_timestamp() WHERE id=$1',[task.id]);
      await taskEvent(tx,task,represented(request.actor,proposer),request.id,'agreement_proposed',{agreement_id:id,agreement_version:version});
      const result=taskResult(await loadTask(tx,task.id,request.actor),201);
      return {...result,body:{...result.body,agreement_id:id}};
    });
  });
  const params=Type.Object({id:Uuid,agreementId:Uuid});
  for(const decision of ['accept','reject'] as const) {
    app.post<{Params:{id:string;agreementId:string};Body:ConfirmAgreementInput|RejectAgreementInput}>(`/api/v1/tasks/:id/agreements/:agreementId/${decision}`,{schema:{params,body:decision==='accept'?ConfirmAgreement:RejectAgreement}},async(request,reply)=>{
      const prior=await snapshot(ctx,request),b=request.body;
      const confirmations=await withTransaction(ctx.pool,async tx=>(await tx.query<ConfirmationDto>('SELECT subject_key,agent_id,user_id,accepted_at FROM agreement_confirmations WHERE agreement_id=$1',[request.params.agreementId])).rows);
      const subject=confirmationSubject(prior,request.actor,b,confirmations);
      return command(ctx,request,reply,options(prior,confirmations.map(c=>c.user_id),subject.subject_key==='publisher'?prior.publisher_agent_id??undefined:subject.agent_id??undefined),async tx=>{
        const task=await loadTask(tx,request.params.id,request.actor,true);
        const agreement=(await tx.query('SELECT * FROM collaboration_agreements WHERE id=$1 AND task_id=$2 FOR UPDATE',[request.params.agreementId,task.id])).rows[0];
        if(!agreement) throw new AppError('NOT_FOUND',404);
        const current=(await tx.query<ConfirmationDto>('SELECT subject_key,agent_id,user_id,accepted_at FROM agreement_confirmations WHERE agreement_id=$1',[agreement.id])).rows;
        const selected=confirmationSubject(task,request.actor,b,current);
        requireVersion(task,b.version);requireState(task,['in_progress','changes_requested']);
        if(agreement.status!=='pending') throw new AppError('AGREEMENT_STATE_CONFLICT',409,'协议不再等待确认');
        if(decision==='reject') {
          await tx.query("UPDATE collaboration_agreements SET status='rejected',rejection_reason=$2 WHERE id=$1",[agreement.id,(b as RejectAgreementInput).reason]);
        } else {
          requireBeforeDeadline(task);
          if(new Date(agreement.deadline_at).getTime()<=Date.now()) throw new AppError('TASK_DEADLINE_PASSED',409,'拟议截止时间已到期');
          const proposed=await members(tx,agreement.id);
          if(selected.subject_key!=='publisher'&&proposed.some(member=>member.agent_id===selected.agent_id)) await assertCollaborationAllowed(tx,[selected.agent_id!]);
          await markConfirmation(tx,agreement.id,selected,request.actor);
          if(current.every(row=>row.accepted_at||row.subject_key===selected.subject_key)) {
            await assertCollaborationAllowed(tx,proposed.map(member=>member.agent_id));
            if(proposed.some(member=>member.owner_user_id===task.reviewer_user_id)) throw new AppError('REVIEWER_CONFLICT',409);
            await tx.query("UPDATE collaboration_agreements SET status='superseded' WHERE task_id=$1 AND status='active'",[task.id]);
            await tx.query("UPDATE collaboration_agreements SET status='active',activated_at=clock_timestamp() WHERE id=$1",[agreement.id]);
            await tx.query('UPDATE tasks SET deadline_at=$2 WHERE id=$1',[task.id,agreement.deadline_at]);
            await tx.query("UPDATE task_cancellation_proposals SET status='superseded' WHERE task_id=$1 AND status='pending'",[task.id]);
            await taskEvent(tx,task,represented(request.actor,selected),request.id,'agreement_activated',{agreement_id:agreement.id,agreement_version:agreement.version});
          }
        }
        await tx.query('UPDATE tasks SET version=version+1,updated_at=clock_timestamp() WHERE id=$1',[task.id]);
        await taskEvent(tx,task,represented(request.actor,selected),request.id,decision==='accept'?'agreement_accepted':'agreement_rejected',{agreement_id:agreement.id,subject_key:selected.subject_key,...(decision==='reject'?{reason:(b as RejectAgreementInput).reason}:{})});
        return taskResult(await loadTask(tx,task.id,request.actor));
      });
    });
  }
  app.post<{Params:{id:string};Body:SubmitContributionInput}>('/api/v1/tasks/:id/contributions',{schema:{params:IdParams,body:SubmitContribution}},async(request,reply)=>{
    const prior=await snapshot(ctx,request),b=request.body;
    return command(ctx,request,reply,options(prior,[],b.agent_id),async tx=>{
      const task=await loadTask(tx,request.params.id,request.actor,true);
      requireVersion(task,b.version);requireState(task,['in_progress','changes_requested','submitted']);requireBeforeDeadline(task);
      if(!task.participant_agent_ids.includes(b.agent_id)) throw new AppError('ACCESS_DENIED',403,'只有有效协议中的参与者可以登记成果');
      const id=randomUUID();
      await tx.query('INSERT INTO task_contributions(id,task_id,agreement_id,agent_id,kind,body,url) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,task.id,task.active_agreement_id,b.agent_id,b.kind,b.body.trim(),b.url??null]);
      await tx.query('UPDATE tasks SET version=version+1,updated_at=clock_timestamp() WHERE id=$1',[task.id]);
      await taskEvent(tx,task,request.actor.type==='user'?{...request.actor,representedAgentId:b.agent_id}:request.actor,request.id,'contribution_submitted',{contribution_id:id,agent_id:b.agent_id,kind:b.kind});
      return taskResult(await loadTask(tx,task.id,request.actor),201);
    });
  });
}
