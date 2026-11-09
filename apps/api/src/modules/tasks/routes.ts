import { randomUUID } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { withTransaction, type Tx } from '@agentzero/database';
import {
  AcceptTask,CancelTaskProposal,ConfirmAgreement,CreateTask,EditTask,IdParams,PageQuery,ResolveTask,ReviewTask,SubmitTask,TaskReasonBody,TaskStatus,TaskVersionBody,Uuid,
  type Actor,type CancelTaskInput,type ConfirmationDto,type ConfirmAgreementInput,type CreateTaskInput,type EditTaskInput,type ResolveTaskInput,type ReviewTaskInput,
} from '@agentzero/contracts';
import { AppError,decodeCursor,lockActor,paginated,type CommandOptions } from '../../core.js';
import { command,replayCommand,type ApiContext } from '../../http.js';
import { adjustHold,reserve } from '../ledger/service.js';
import { assertRepositoryAvailable } from '../github/service.js';
import type { GitHubRepositoryProvider,PullRequestEvidence } from '../github/provider.js';
import { activeParticipants,confirmationRows,confirmationSubject,participantAgent,participantOwnerIds,settlementPayments } from '../collaboration/service.js';
import {
  finishTask,isAdmin,isFinal,isParticipant,isPublisher,loadTask,requireAssignee,requireBeforeDeadline,requirePublisher,requireReviewer,
  requireState,requireVersion,taskBody,taskDetail,taskEvent,taskResult,taskSelect,userId,validateFields,validateReviewer,verifyEvidence,type TaskRow,
} from './service.js';

type TaskRequest=FastifyRequest<{Params:{id:string}}>;
function actorOptions(task:TaskRow,actor:Actor,role:'publisher'|'assignee'|'reviewer'|'participant',allowPaused=true):Partial<CommandOptions> {
  const asPublisher=role==='publisher'||role==='participant'&&isPublisher(task,actor);
  const agentId=actor.type==='user'?(asPublisher?task.publisher_agent_id??task.payer_agent_id:role==='assignee'?task.assignee_agent_id:role==='participant'?participantAgent(task,actor):null):null;
  return {allowPaused,...(agentId?{agentId}:{}),userIds:[task.publisher_user_id,task.reviewer_user_id,...participantOwnerIds(task)]};
}
async function snapshot(ctx:ApiContext,request:TaskRequest) {
  return withTransaction(ctx.pool,async tx=>{await lockActor(tx,request.actor,{allowPaused:true});return loadTask(tx,request.params.id,request.actor);});
}
async function current(tx:Tx,request:TaskRequest,version:string) {
  const task=await loadTask(tx,request.params.id,request.actor,true);
  requireVersion(task,version);
  return task;
}
async function fetchEvidence(provider:GitHubRepositoryProvider,task:TaskRow,number:number) {
  return provider.getPullRequest({installationId:task.installation_id,repositoryId:task.github_repository_id,owner:task.repository_owner,name:task.repository_slug,number});
}
async function latestDelivery(tx:Tx,task:TaskRow) {
  const delivery=(await tx.query('SELECT * FROM task_deliveries WHERE id=$1 AND task_id=$2',[task.latest_delivery_id,task.id])).rows[0];
  if(!delivery) throw new AppError('TASK_STATE_CONFLICT',409,'任务尚未提交交付成果');
  return delivery;
}
async function assertSnapshotRepository(tx:Tx,task:TaskRow,prior:TaskRow) {
  await assertRepositoryAvailable(tx,task.repository_id);
  if(task.repository_id!==prior.repository_id||task.github_repository_id!==prior.github_repository_id||task.installation_id!==prior.installation_id||task.repository_owner!==prior.repository_owner||task.repository_slug!==prior.repository_slug) throw new AppError('TASK_VERSION_CONFLICT',409,'仓库配置已变化，请重试');
}
async function recordReview(tx:Tx,task:TaskRow,actor:Actor,decision:string,reason:string,unmet:string|null,evidence?:PullRequestEvidence) {
  await tx.query(`INSERT INTO task_reviews(id,task_id,delivery_id,reviewer_user_id,decision,reason,unmet_criteria,evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[randomUUID(),task.id,task.latest_delivery_id,userId(actor),decision,reason,unmet,evidence?JSON.stringify(evidence):null]);
}

export async function registerTasks(app:FastifyInstance,ctx:ApiContext,provider:GitHubRepositoryProvider) {
  app.get('/api/v1/task-reviewers',async request=>withTransaction(ctx.pool,async tx=>{
    await lockActor(tx,request.actor);
    return {items:(await tx.query("SELECT id,display_name,github_login FROM users WHERE status='active' ORDER BY display_name,id")).rows};
  }));
  app.get<{Querystring:{cursor?:string;limit?:string;status?:string;mine?:string}}>('/api/v1/tasks',{schema:{querystring:Type.Intersect([PageQuery,Type.Object({status:Type.Optional(TaskStatus),mine:Type.Optional(Type.Literal('true'))})])}},async request=>withTransaction(ctx.pool,async tx=>{
    await lockActor(tx,request.actor,{allowPaused:true});
    const admin=await isAdmin(tx,request.actor),q=request.query,cursor=decodeCursor(q.cursor),limit=Number(q.limit??30);
    const rows=(await tx.query<TaskRow>(`${taskSelect} WHERE (t.status<>'draft' OR ($8::uuid IS NULL AND t.publisher_user_id=$1) OR t.publisher_agent_id=$8 OR $2)
      AND ($3::text IS NULL OR t.status=$3) AND (NOT $4 OR ($8::uuid IS NULL AND (t.publisher_user_id=$1 OR a.owner_user_id=$1 OR t.reviewer_user_id=$1 OR $1=ANY(members.owner_ids))) OR t.publisher_agent_id=$8 OR t.assignee_agent_id=$8 OR $8=ANY(members.agent_ids)
        OR EXISTS(SELECT 1 FROM collaboration_agreements invited JOIN agreement_confirmations ic ON ic.agreement_id=invited.id WHERE invited.task_id=t.id AND invited.status='pending' AND (($8::uuid IS NULL AND ic.user_id=$1) OR ic.agent_id=$8)))
      AND ($5::timestamptz IS NULL OR (t.created_at,t.id)<($5,$6::uuid)) ORDER BY t.created_at DESC,t.id DESC LIMIT $7`,
    [userId(request.actor),admin,q.status??null,q.mine==='true',cursor?.[0]??null,cursor?.[1]??null,limit+1,request.actor.type==='agent'?request.actor.agentId:null])).rows;
    const page=paginated(rows,limit);
    return {...page,items:page.items.map(task=>taskBody(task))};
  }));
  app.get<{Params:{id:string}}>('/api/v1/tasks/:id',{schema:{params:IdParams}},async request=>withTransaction(ctx.pool,async tx=>{
    await lockActor(tx,request.actor,{allowPaused:true});
    // Keep the contract and its hold/timeline coherent across the detail queries.
    return taskDetail(tx,await loadTask(tx,request.params.id,request.actor,true),request.actor);
  }));
  app.post<{Body:CreateTaskInput}>('/api/v1/tasks',{schema:{body:CreateTask}},async(request,reply)=>{
    const b=request.body;
    if(request.actor.type==='agent'&&b.payer_agent_id!==request.actor.agentId) throw new AppError('ACCESS_DENIED',403);
    return command(ctx,request,reply,{...(b.payer_agent_id?{agentId:b.payer_agent_id}:{admin:true}),userIds:[b.reviewer_user_id]},async tx=>{
      validateFields(b);
      await assertRepositoryAvailable(tx,b.repository_id);await validateReviewer(tx,b.reviewer_user_id);
      const id=randomUUID();
      await tx.query(`INSERT INTO tasks(id,title,description,repository_id,issue_number,acceptance_criteria,required_checks,reward_points,deadline_at,publisher_user_id,publisher_agent_id,payer_agent_id,reviewer_user_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[id,b.title.trim(),b.description.trim(),b.repository_id,b.issue_number??null,b.acceptance_criteria.trim(),JSON.stringify(b.required_checks.map(n=>n.trim())),b.reward_points,b.deadline_at,userId(request.actor),request.actor.type==='agent'?request.actor.agentId:b.payer_agent_id,b.payer_agent_id,b.reviewer_user_id]);
      const task=await loadTask(tx,id,request.actor);
      await taskEvent(tx,task,request.actor,request.id,'created');
      return taskResult(task,201);
    });
  });
  app.patch<{Params:{id:string};Body:EditTaskInput}>('/api/v1/tasks/:id',{schema:{params:IdParams,body:EditTask}},async(request,reply)=>{
    const prior=await snapshot(ctx,request),b=request.body;
    requirePublisher(prior,request.actor);
    const payer=b.payer_agent_id===undefined?prior.payer_agent_id:b.payer_agent_id;
    const options=actorOptions(prior,request.actor,'publisher',false);
    options.userIds=[...(options.userIds??[]),...(b.reviewer_user_id?[b.reviewer_user_id]:[])];
    if(payer) options.agentId=payer;
    else options.admin=true;
    if(request.actor.type==='agent'&&payer!==request.actor.agentId) throw new AppError('ACCESS_DENIED',403);
    return command(ctx,request,reply,options,async tx=>{
      const task=await current(tx,request,b.version);requirePublisher(task,request.actor);requireState(task,['draft','open']);
      if(task.status==='open'&&(b.payer_agent_id!==undefined&&b.payer_agent_id!==task.payer_agent_id||b.repository_id!==undefined&&b.repository_id!==task.repository_id)) throw new AppError('TASK_STATE_CONFLICT',409,'已发布任务不能更换资金来源或仓库');
      const fields:CreateTaskInput={title:b.title??task.title,description:b.description??task.description,repository_id:b.repository_id??task.repository_id,
        issue_number:b.issue_number===undefined?task.issue_number:b.issue_number,acceptance_criteria:b.acceptance_criteria??task.acceptance_criteria,
        required_checks:b.required_checks??task.required_checks,reward_points:b.reward_points??task.reward_points,deadline_at:b.deadline_at??new Date(task.deadline_at).toISOString(),reviewer_user_id:b.reviewer_user_id??task.reviewer_user_id,payer_agent_id:payer};
      validateFields(fields);await assertRepositoryAvailable(tx,fields.repository_id);await validateReviewer(tx,fields.reviewer_user_id);
      if(task.hold_id&&fields.reward_points!==task.reward_points) await adjustHold(tx,{actor:request.actor,requestId:request.id},{holdId:task.hold_id,amount:fields.reward_points,revision:`task:${task.id}:${task.version}`,permission:'can_accept_task',reason:'发布者调整任务奖金'});
      await tx.query(`UPDATE tasks SET title=$2,description=$3,repository_id=$4,issue_number=$5,acceptance_criteria=$6,required_checks=$7,reward_points=$8,deadline_at=$9,reviewer_user_id=$10,payer_agent_id=$11,publisher_agent_id=$12,version=version+1,updated_at=clock_timestamp() WHERE id=$1`,
        [task.id,fields.title.trim(),fields.description.trim(),fields.repository_id,fields.issue_number??null,fields.acceptance_criteria.trim(),JSON.stringify(fields.required_checks.map(n=>n.trim())),fields.reward_points,fields.deadline_at,fields.reviewer_user_id,payer,request.actor.type==='agent'?request.actor.agentId:payer]);
      await taskEvent(tx,task,request.actor,request.id,'updated',{reward_points:fields.reward_points});
      return taskResult(await loadTask(tx,task.id,request.actor));
    });
  });
  app.delete<{Params:{id:string};Body:{version:string}}>('/api/v1/tasks/:id',{schema:{params:IdParams,body:TaskVersionBody}},async(request,reply)=>{
    if(await replayCommand(ctx,request,reply,{allowPaused:true})) return reply;
    const prior=await snapshot(ctx,request);
    return command(ctx,request,reply,actorOptions(prior,request.actor,'publisher'),async tx=>{
      const task=await current(tx,request,request.body.version);requirePublisher(task,request.actor);requireState(task,['draft']);
      await taskEvent(tx,task,request.actor,request.id,'deleted');
      await tx.query('DELETE FROM tasks WHERE id=$1',[task.id]);
      return {status:200,body:{id:task.id,deleted:true}};
    });
  });
  app.post<{Params:{id:string};Body:{version:string}}>('/api/v1/tasks/:id/publish',{schema:{params:IdParams,body:TaskVersionBody}},async(request,reply)=>{
    const prior=await snapshot(ctx,request);
    return command(ctx,request,reply,actorOptions(prior,request.actor,'publisher',false),async tx=>{
      const task=await current(tx,request,request.body.version);requirePublisher(task,request.actor);requireState(task,['draft']);requireBeforeDeadline(task);
      await assertRepositoryAvailable(tx,task.repository_id);await validateReviewer(tx,task.reviewer_user_id);
      const hold=await reserve(tx,{actor:request.actor,requestId:request.id},{businessRef:`task:${task.id}`,payerAgentId:task.payer_agent_id,amount:task.reward_points,permission:'can_accept_task',reason:`发布任务：${task.title}`});
      await tx.query("UPDATE tasks SET status='open',hold_id=$2,version=version+1,published_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1",[task.id,hold.holdId]);
      await taskEvent(tx,task,request.actor,request.id,'published',{hold_id:hold.holdId,reward_points:task.reward_points});
      return taskResult(await loadTask(tx,task.id,request.actor));
    });
  });
  app.post<{Params:{id:string};Body:{version:string;agent_id:string}}>('/api/v1/tasks/:id/accept',{schema:{params:IdParams,body:AcceptTask}},async(request,reply)=>{
    const prior=await snapshot(ctx,request),b=request.body;
    return command(ctx,request,reply,{agentId:b.agent_id,userIds:[prior.reviewer_user_id,prior.publisher_user_id]},async tx=>{
      const task=await current(tx,request,b.version);requireState(task,['open']);requireBeforeDeadline(task);
      await assertRepositoryAvailable(tx,task.repository_id);await validateReviewer(tx,task.reviewer_user_id,userId(request.actor));
      if(task.payer_agent_id===b.agent_id) throw new AppError('ACCESS_DENIED',403,'付款 Agent 不能承接自己的任务');
      const policy=(await tx.query('SELECT can_accept_task FROM agent_policies WHERE agent_id=$1 FOR UPDATE',[b.agent_id])).rows[0];
      if(!policy?.can_accept_task) throw new AppError('ACCESS_DENIED',403,'请先开启 Agent 接单权限');
      await tx.query("UPDATE tasks SET status='in_progress',assignee_agent_id=$2,accepted_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp() WHERE id=$1",[task.id,b.agent_id]);
      const updated=await loadTask(tx,task.id,request.actor);
      await taskEvent(tx,updated,request.actor,request.id,'accepted',{agent_id:b.agent_id});
      return taskResult(updated);
    });
  });
  app.post<{Params:{id:string};Body:{version:string;pr_number:number;head_sha:string}}>('/api/v1/tasks/:id/deliveries',{schema:{params:IdParams,body:SubmitTask}},async(request,reply)=>{
    if(await replayCommand(ctx,request,reply,{allowPaused:true})) return reply;
    const prior=await snapshot(ctx,request),b=request.body;
    requireAssignee(prior,request.actor);requireVersion(prior,b.version);requireState(prior,['in_progress','changes_requested']);requireBeforeDeadline(prior);
    await withTransaction(ctx.pool,tx=>assertRepositoryAvailable(tx,prior.repository_id));
    const evidence=await fetchEvidence(provider,prior,b.pr_number);
    return command(ctx,request,reply,actorOptions(prior,request.actor,'assignee'),async tx=>{
      const task=await current(tx,request,b.version);requireAssignee(task,request.actor);requireState(task,['in_progress','changes_requested']);requireBeforeDeadline(task);
      await assertSnapshotRepository(tx,task,prior);verifyEvidence(task,evidence,b.pr_number,b.head_sha);
      const id=randomUUID();
      await tx.query('INSERT INTO task_deliveries(id,task_id,agent_id,pr_number,head_sha,pr_url,evidence) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,task.id,task.assignee_agent_id,b.pr_number,b.head_sha,evidence.url,JSON.stringify(evidence)]);
      await tx.query("UPDATE task_cancellation_proposals SET status='superseded' WHERE task_id=$1 AND status='pending'",[task.id]);
      await tx.query("UPDATE tasks SET status='submitted',latest_delivery_id=$2,version=version+1,review_due_at=clock_timestamp()+interval '72 hours',review_reminded_at=NULL,updated_at=clock_timestamp() WHERE id=$1",[task.id,id]);
      await taskEvent(tx,task,request.actor,request.id,'submitted',{delivery_id:id,pr_number:b.pr_number,head_sha:b.head_sha});
      return taskResult(await loadTask(tx,task.id,request.actor),201);
    });
  });
  app.post<{Params:{id:string};Body:ReviewTaskInput}>('/api/v1/tasks/:id/reviews',{schema:{params:IdParams,body:ReviewTask}},async(request,reply)=>{
    if(await replayCommand(ctx,request,reply,{allowPaused:true})) return reply;
    const prior=await snapshot(ctx,request),b=request.body;
    requireReviewer(prior,request.actor);
    let evidence:PullRequestEvidence|undefined;
    if(prior.status!=='settled') {
      requireVersion(prior,b.version);requireState(prior,['submitted']);
      if(b.decision==='accept') {
        const delivery=await withTransaction(ctx.pool,async tx=>{await assertRepositoryAvailable(tx,prior.repository_id);return latestDelivery(tx,prior);});
        evidence=await fetchEvidence(provider,prior,delivery.pr_number);
      } else if(!b.unmet_criteria?.trim()) throw new AppError('INVALID_REQUEST',400,'退回修改必须引用未满足的验收条件');
    }
    return command(ctx,request,reply,actorOptions(prior,request.actor,'reviewer'),async tx=>{
      const task=await loadTask(tx,request.params.id,request.actor,true);requireReviewer(task,request.actor);
      if(task.status==='settled'&&b.decision==='accept') return taskResult(task);
      requireVersion(task,b.version);requireState(task,['submitted']);
      const delivery=await latestDelivery(tx,task);
      if(b.decision==='accept') {
        await assertSnapshotRepository(tx,task,prior);verifyEvidence(task,evidence!,delivery.pr_number,delivery.head_sha,true);
        await finishTask(tx,task,request.actor,request.id,{payment:task.reward_points,refund:'0',reason:b.reason,outcome:'settled',evidence});
      } else {
        if(!b.unmet_criteria?.trim()) throw new AppError('INVALID_REQUEST',400,'退回修改必须引用未满足的验收条件');
        await tx.query("UPDATE task_cancellation_proposals SET status='superseded' WHERE task_id=$1 AND status='pending'",[task.id]);
        await tx.query("UPDATE tasks SET status='changes_requested',version=version+1,review_due_at=NULL,review_reminded_at=NULL,updated_at=clock_timestamp() WHERE id=$1",[task.id]);
        await taskEvent(tx,task,request.actor,request.id,'changes_requested',{reason:b.reason,unmet_criteria:b.unmet_criteria});
      }
      await recordReview(tx,task,request.actor,b.decision,b.reason,b.unmet_criteria??null,evidence);
      return taskResult(await loadTask(tx,task.id,request.actor));
    });
  });
  app.post<{Params:{id:string};Body:{version:string;reason:string}}>('/api/v1/tasks/:id/cancel',{schema:{params:IdParams,body:TaskReasonBody}},async(request,reply)=>{
    const prior=await snapshot(ctx,request);
    return command(ctx,request,reply,actorOptions(prior,request.actor,'publisher'),async tx=>{
      const task=await loadTask(tx,request.params.id,request.actor,true);requirePublisher(task,request.actor);
      if(task.status==='cancelled'&&!task.assignee_agent_id) return taskResult(task);
      requireVersion(task,request.body.version);requireState(task,['open']);
      await finishTask(tx,task,request.actor,request.id,{payment:'0',refund:task.reward_points,reason:request.body.reason,outcome:'cancelled'});
      return taskResult(await loadTask(tx,task.id,request.actor));
    });
  });
  app.post<{Params:{id:string};Body:CancelTaskInput}>('/api/v1/tasks/:id/cancellation-proposals',{schema:{params:IdParams,body:CancelTaskProposal}},async(request,reply)=>{
    const prior=await snapshot(ctx,request),b=request.body;
    return command(ctx,request,reply,{...actorOptions(prior,request.actor,'participant'),...(b.agent_id?{agentId:b.agent_id}:{})},async tx=>{
      const task=await current(tx,request,b.version);requireState(task,['in_progress','submitted','changes_requested']);
      if(!isParticipant(task,request.actor)) throw new AppError('ACCESS_DENIED',403);
      if(BigInt(b.payment_points)+BigInt(b.refund_points)!==BigInt(task.reward_points)) throw new AppError('INVALID_SETTLEMENT',400,'报酬与退款之和必须等于冻结奖金');
      const payments=await settlementPayments(tx,task,b.payment_points,b.payments,'cancelled');
      const confirmations=confirmationRows(task,await activeParticipants(tx,task));
      const subject=confirmationSubject(task,request.actor,b,confirmations);
      subject.accepted_at=new Date().toISOString();
      const publisher=confirmations.find(c=>c.subject_key==='publisher')!.accepted_at!==null;
      const assignee=confirmations.find(c=>c.agent_id===task.assignee_agent_id&&c.subject_key!=='publisher')!.accepted_at!==null;
      await tx.query("UPDATE task_cancellation_proposals SET status='superseded' WHERE task_id=$1 AND status='pending'",[task.id]);
      const id=randomUUID();
      await tx.query(`INSERT INTO task_cancellation_proposals(id,task_id,payment_points,refund_points,reason,publisher_accepted,assignee_accepted,payments,confirmations) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,task.id,b.payment_points,b.refund_points,b.reason,publisher,assignee,JSON.stringify(payments),JSON.stringify(confirmations)]);
      await tx.query('UPDATE tasks SET version=version+1,updated_at=clock_timestamp() WHERE id=$1',[task.id]);
      await taskEvent(tx,task,request.actor.type==='user'&&subject.agent_id?{...request.actor,representedAgentId:subject.agent_id}:request.actor,request.id,'cancellation_proposed',{proposal_id:id,payment_points:b.payment_points,payments,refund_points:b.refund_points,reason:b.reason,subject_key:subject.subject_key});
      return taskResult(await loadTask(tx,task.id,request.actor),201);
    });
  });
  app.post<{Params:{id:string;proposalId:string};Body:ConfirmAgreementInput}>('/api/v1/tasks/:id/cancellation-proposals/:proposalId/accept',{schema:{params:Type.Object({id:Uuid,proposalId:Uuid}),body:ConfirmAgreement}},async(request,reply)=>{
    const prior=await snapshot(ctx,request);
    return command(ctx,request,reply,{...actorOptions(prior,request.actor,'participant'),...(request.body.agent_id?{agentId:request.body.agent_id}:{})},async tx=>{
      const task=await loadTask(tx,request.params.id,request.actor,true);
      if(!isParticipant(task,request.actor)) throw new AppError('ACCESS_DENIED',403);
      const proposal=(await tx.query('SELECT * FROM task_cancellation_proposals WHERE id=$1 AND task_id=$2 FOR UPDATE',[request.params.proposalId,task.id])).rows[0];
      if(!proposal) throw new AppError('NOT_FOUND',404);
      if(task.status==='cancelled'&&proposal.status==='accepted') return taskResult(task);
      requireVersion(task,request.body.version);requireState(task,['in_progress','submitted','changes_requested']);
      if(proposal.status!=='pending') throw new AppError('TASK_VERSION_CONFLICT',409,'取消方案已失效');
      const confirmations:ConfirmationDto[]=proposal.confirmations;
      const subject=confirmationSubject(task,request.actor,request.body,confirmations);
      subject.accepted_at??=new Date().toISOString();
      const publisher=confirmations.find(c=>c.subject_key==='publisher')!.accepted_at!==null;
      const assignee=confirmations.find(c=>c.agent_id===task.assignee_agent_id&&c.subject_key!=='publisher')!.accepted_at!==null;
      await tx.query('UPDATE task_cancellation_proposals SET publisher_accepted=$2,assignee_accepted=$3,confirmations=$4 WHERE id=$1',[proposal.id,publisher,assignee,JSON.stringify(confirmations)]);
      await taskEvent(tx,task,request.actor.type==='user'&&subject.agent_id?{...request.actor,representedAgentId:subject.agent_id}:request.actor,request.id,'cancellation_accepted',{proposal_id:proposal.id,subject_key:subject.subject_key});
      if(confirmations.every(c=>c.accepted_at)) {
        await finishTask(tx,task,request.actor,request.id,{payment:proposal.payment_points,payments:proposal.payments,refund:proposal.refund_points,reason:proposal.reason,outcome:'cancelled'});
        await tx.query("UPDATE task_cancellation_proposals SET status='accepted',accepted_at=clock_timestamp() WHERE id=$1",[proposal.id]);
      } else await tx.query('UPDATE tasks SET version=version+1,updated_at=clock_timestamp() WHERE id=$1',[task.id]);
      return taskResult(await loadTask(tx,task.id,request.actor));
    });
  });
  app.post<{Params:{id:string};Body:{version:string;reason:string}}>('/api/v1/tasks/:id/disputes',{schema:{params:IdParams,body:TaskReasonBody}},async(request,reply)=>{
    const prior=await snapshot(ctx,request);
    return command(ctx,request,reply,actorOptions(prior,request.actor,'participant'),async tx=>{
      const task=await current(tx,request,request.body.version);requireState(task,['in_progress','submitted','changes_requested'],true);
      if(!isParticipant(task,request.actor)) throw new AppError('ACCESS_DENIED',403);
      if(!task.disputed) {
        await tx.query("UPDATE task_cancellation_proposals SET status='superseded' WHERE task_id=$1 AND status='pending'",[task.id]);
        await tx.query('UPDATE tasks SET disputed=true,dispute_reason=$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1',[task.id,request.body.reason]);
        await taskEvent(tx,task,request.actor,request.id,'disputed',{reason:request.body.reason});
      }
      return taskResult(await loadTask(tx,task.id,request.actor));
    });
  });
  app.post<{Params:{id:string};Body:ResolveTaskInput}>('/api/v1/admin/tasks/:id/resolve',{schema:{params:IdParams,body:ResolveTask}},async(request,reply)=>{
    if(await replayCommand(ctx,request,reply,{admin:true})) return reply;
    await withTransaction(ctx.pool,tx=>lockActor(tx,request.actor,{admin:true}));
    const prior=await snapshot(ctx,request),b=request.body;
    let evidence:PullRequestEvidence|undefined;
    if(!isFinal(prior)) {
      requireVersion(prior,b.version);
      if(!prior.disputed) throw new AppError('TASK_STATE_CONFLICT',409,'任务没有未处理争议');
      if(b.outcome==='settled') {
        const delivery=await withTransaction(ctx.pool,async tx=>{await assertRepositoryAvailable(tx,prior.repository_id);return latestDelivery(tx,prior);});
        evidence=await fetchEvidence(provider,prior,delivery.pr_number);
      }
    }
    return command(ctx,request,reply,{...actorOptions(prior,request.actor,'reviewer'),admin:true},async tx=>{
      const task=await loadTask(tx,request.params.id,request.actor,true);
      if(participantOwnerIds(task).includes(userId(request.actor)!)) throw new AppError('REVIEWER_CONFLICT',409,'管理员不能裁决自己 Agent 参与的任务');
      if(isFinal(task)) throw new AppError('BUSINESS_ALREADY_FINALIZED',409);
      requireVersion(task,b.version);
      if(!task.disputed) throw new AppError('TASK_STATE_CONFLICT',409,'任务没有未处理争议');
      if(b.outcome==='settled') {
        await assertSnapshotRepository(tx,task,prior);const delivery=await latestDelivery(tx,task);
        verifyEvidence(task,evidence!,delivery.pr_number,delivery.head_sha,true);
      }
      await finishTask(tx,task,request.actor,request.id,{payment:b.payment_points,payments:b.payments,refund:b.refund_points,reason:b.reason,outcome:b.outcome,evidence});
      await recordReview(tx,task,request.actor,`resolve_${b.outcome}`,b.reason,null,evidence);
      return taskResult(await loadTask(tx,task.id,request.actor));
    });
  });
}
