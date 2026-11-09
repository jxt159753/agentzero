import type { Pool } from 'pg';
import { withTransaction,type Tx } from '@agentzero/database';
import { loadTask,taskEvent } from './service.js';

/** Durable in-app notices; no auto-approval, auto-payment, or external message delivery. */
export async function processTaskDeadlines(pool:Pool) {
  return withTransaction(pool,async tx=>{
    const rows=(await tx.query(`SELECT id,status FROM tasks WHERE
      (status IN ('in_progress','changes_requested') AND NOT disputed AND deadline_at<=clock_timestamp())
      OR (status='submitted' AND NOT disputed AND review_reminded_at IS NULL AND review_due_at<=clock_timestamp())
      ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED`)).rows;
    let disputed=0,reminded=0;
    for(const row of rows) {
      const task=await loadTask(tx,row.id,{type:'system'});
      if(row.status==='submitted') {
        await tx.query('UPDATE tasks SET review_reminded_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp() WHERE id=$1',[row.id]);
        await taskEvent(tx,task,{type:'system'},`task-reminder:${row.id}`,'review_overdue',{reviewer_user_id:task.reviewer_user_id,review_due_at:task.review_due_at});
        reminded++;
      } else {
        await tx.query("UPDATE task_cancellation_proposals SET status='superseded' WHERE task_id=$1 AND status='pending'",[row.id]);
        await tx.query("UPDATE tasks SET disputed=true,dispute_reason='截止时间内未完成交付',version=version+1,updated_at=clock_timestamp() WHERE id=$1",[row.id]);
        await taskEvent(tx,task,{type:'system'},`task-deadline:${row.id}`,'deadline_disputed',{deadline_at:task.deadline_at});
        disputed++;
      }
    }
    return {disputed,reminded};
  });
}

export async function recordGithubTaskEvent(tx:Tx,input:{repositoryGithubId:string;prNumber?:number;headSha?:string;deliveryId:string;eventName:string}) {
  if(input.prNumber===undefined&&!input.headSha) return;
  const tasks=(await tx.query(`SELECT t.id FROM tasks t JOIN repositories r ON r.id=t.repository_id
    WHERE r.github_id=$1 AND EXISTS(SELECT 1 FROM task_deliveries d WHERE d.task_id=t.id
      AND (($2::integer IS NOT NULL AND d.pr_number=$2) OR ($3::text IS NOT NULL AND d.head_sha=$3))) ORDER BY t.id FOR UPDATE OF t`,
  [input.repositoryGithubId,input.prNumber??null,input.headSha??null])).rows;
  for(const row of tasks) {
    const existing=await tx.query("SELECT 1 FROM task_events WHERE task_id=$1 AND kind='github_event' AND details->>'delivery_id'=$2",[row.id,input.deliveryId]);
    if(existing.rowCount) continue;
    const task=await loadTask(tx,row.id,{type:'system'});
    await taskEvent(tx,task,{type:'system'},input.deliveryId,'github_event',{delivery_id:input.deliveryId,event_name:input.eventName,pr_number:input.prNumber??null,head_sha:input.headSha??null});
  }
}
