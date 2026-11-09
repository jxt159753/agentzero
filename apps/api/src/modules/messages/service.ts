import { randomUUID } from 'node:crypto';
import type { Actor,MessageDto } from '@agentzero/contracts';
import type { Tx } from '@agentzero/database';
import { AppError,audit } from '../../core.js';

export function messageUserId(actor:Actor):string {
  if(actor.type==='system') throw new AppError('ACCESS_DENIED',403);
  return actor.type==='user'?actor.userId:actor.ownerUserId;
}
// $1 is the user; $2 is an Agent credential's subject (null for a user session).
// A user sees their Agents' conversations, but one Agent cannot read a sibling's.
const taskAccess=`(
  ($2::uuid IS NULL AND (t.publisher_user_id=$1 OR t.reviewer_user_id=$1 OR EXISTS(SELECT 1 FROM users u WHERE u.id=$1 AND u.role='admin')))
  OR ($2::uuid IS NOT NULL AND t.publisher_agent_id=$2)
  OR EXISTS(SELECT 1 FROM agents a WHERE a.id=t.assignee_agent_id AND (($2::uuid IS NULL AND a.owner_user_id=$1) OR a.id=$2))
  OR EXISTS(SELECT 1 FROM collaboration_agreements ca JOIN agreement_members am ON am.agreement_id=ca.id JOIN agents a ON a.id=am.agent_id
    WHERE ca.task_id=t.id AND ca.status='active' AND (($2::uuid IS NULL AND a.owner_user_id=$1) OR a.id=$2))
)`;
export const conversationAccess=`(
  (c.kind='direct' AND EXISTS(SELECT 1 FROM conversation_members cm LEFT JOIN agents a ON a.id=cm.agent_id
    WHERE cm.conversation_id=c.id AND (($2::uuid IS NULL AND (cm.user_id=$1 OR a.owner_user_id=$1)) OR cm.agent_id=$2)))
  OR (c.kind='task' AND EXISTS(SELECT 1 FROM tasks t WHERE t.id=c.task_id AND ${taskAccess}))
)`;
export function accessParams(actor:Actor) {return [messageUserId(actor),actor.type==='agent'?actor.agentId:null];}
export function sendingAgent(actor:Actor,requested?:string):string|null {
  if(actor.type==='system') throw new AppError('ACCESS_DENIED',403);
  if(actor.type==='agent') {
    if(requested&&requested!==actor.agentId) throw new AppError('ACCESS_DENIED',403);
    return actor.agentId;
  }
  return requested??null;
}
export async function requireTaskDiscussion(tx:Tx,taskId:string,actor:Actor,senderAgentId?:string|null) {
  // Keep participant membership stable until this read/write transaction finishes.
  const task=(await tx.query('SELECT id FROM tasks WHERE id=$1 FOR SHARE',[taskId])).rows[0];
  if(!task) throw new AppError('NOT_FOUND',404);
  const params=senderAgentId?[messageUserId(actor),senderAgentId]:accessParams(actor);
  const allowed=(await tx.query(`SELECT t.id FROM tasks t WHERE t.id=$3 AND ${taskAccess}`,[...params,taskId])).rows[0];
  if(!allowed) throw new AppError('ACCESS_DENIED',403,'只有任务相关人员可以查看或参与讨论');
}
export async function requireConversation(tx:Tx,id:string,actor:Actor) {
  const row=(await tx.query(`SELECT c.* FROM conversations c WHERE c.id=$3 AND ${conversationAccess}`,[...accessParams(actor),id])).rows[0];
  if(!row) throw new AppError('ACCESS_DENIED',403,'无权访问此对话');
  if(row.kind==='task') await requireTaskDiscussion(tx,row.task_id,actor);
  return row;
}
export async function conversationBody(tx:Tx,row:Record<string,unknown>) {
  const members=(await tx.query(`SELECT cm.user_id,cm.agent_id,coalesce(a.name,u.display_name) AS name,coalesce(a.owner_user_id,u.id) AS owner_user_id
    FROM conversation_members cm LEFT JOIN agents a ON a.id=cm.agent_id LEFT JOIN users u ON u.id=cm.user_id WHERE cm.conversation_id=$1 ORDER BY cm.id`,[row.id])).rows;
  return {id:row.id,kind:row.kind,task_id:row.task_id,created_at:row.created_at,members};
}
export const messageSelect=`SELECT m.id,m.cursor::text,m.conversation_id,m.sender_user_id,m.sender_agent_id,coalesce(a.name,u.display_name) AS sender_name,m.body,m.created_at
  FROM messages m JOIN conversations c ON c.id=m.conversation_id LEFT JOIN agents a ON a.id=m.sender_agent_id LEFT JOIN users u ON u.id=m.sender_user_id`;
export async function messagePage(tx:Tx,actor:Actor,query:{after?:string;limit?:string},conversationId?:string) {
  const after=query.after??'0',limit=Number(query.limit??30);
  if(BigInt(after)>9223372036854775807n) throw new AppError('INVALID_REQUEST',400,'无效消息游标');
  const rows=(await tx.query<MessageDto>(`${messageSelect} WHERE ${conversationAccess} AND m.cursor>$3::bigint AND ($4::uuid IS NULL OR m.conversation_id=$4) ORDER BY m.cursor LIMIT $5`,[...accessParams(actor),after,conversationId??null,limit+1])).rows;
  const items=rows.slice(0,limit);
  return {items,next_cursor:items.at(-1)?.cursor??after,has_more:rows.length>limit,...(conversationId?{conversation_id:conversationId}:{})};
}
export async function appendMessage(tx:Tx,actor:Actor,requestId:string,conversation:Record<string,any>,body:string,senderAgentId:string|null) {
  if(conversation.kind==='task') await requireTaskDiscussion(tx,conversation.task_id,actor,senderAgentId);
  else {
    const member=(await tx.query(`SELECT id FROM conversation_members WHERE conversation_id=$1 AND ((agent_id=$2::uuid) OR ($2::uuid IS NULL AND user_id=$3))`,[conversation.id,senderAgentId,messageUserId(actor)])).rows[0];
    if(!member) throw new AppError('ACCESS_DENIED',403,'请使用对话中的本人或 Agent 身份发送消息');
  }
  const cursor=(await tx.query('UPDATE message_cursor SET value=value+1 WHERE singleton=true RETURNING value::text')).rows[0].value;
  const id=randomUUID();
  await tx.query(`INSERT INTO messages(id,cursor,conversation_id,sender_user_id,sender_agent_id,actor_user_id,body) VALUES($1,$2,$3,$4,$5,$6,$7)`,[id,cursor,conversation.id,senderAgentId?null:messageUserId(actor),senderAgentId,messageUserId(actor),body.trim()]);
  await audit(tx,actor,'messages.sent','message',id,requestId,{conversation_id:conversation.id,cursor,sender_agent_id:senderAgentId});
  // Chat content is not parsed as an instruction or a contract confirmation.
  const message=(await tx.query(`${messageSelect} WHERE m.id=$1`,[id])).rows[0];
  return {status:201,body:message,resourceType:'message',resourceId:id};
}
