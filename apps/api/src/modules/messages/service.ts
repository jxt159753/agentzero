import { randomUUID } from 'node:crypto';
import type { Actor,GroupMemberRole,MessageDto } from '@agentzero/contracts';
import type { Tx } from '@agentzero/database';
import { AppError,audit } from '../../core.js';

export const groupMemberLimit=50;
export type GroupMembershipRole='owner'|GroupMemberRole;

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
  (c.kind IN ('direct','group') AND EXISTS(SELECT 1 FROM conversation_members cm LEFT JOIN agents a ON a.id=cm.agent_id
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
export type ConversationRow={id:string;kind:string;task_id:string|null;title:string|null;created_at:string};
export async function conversationBody(tx:Tx,row:ConversationRow) {
  const members=(await tx.query(`SELECT cm.id,cm.user_id,cm.agent_id,cm.role,coalesce(a.name,u.display_name) AS name,coalesce(a.owner_user_id,u.id) AS owner_user_id
    FROM conversation_members cm LEFT JOIN agents a ON a.id=cm.agent_id LEFT JOIN users u ON u.id=cm.user_id WHERE cm.conversation_id=$1 ORDER BY cm.joined_at,cm.id`,[row.id])).rows;
  return {id:row.id,kind:row.kind,task_id:row.task_id,title:row.title,created_at:row.created_at,members};
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

/* Group conversations: one owner, admins and members. Only group chats carry a title and roles. */
export type GroupRow=ConversationRow&{kind:'group'};
interface GroupMemberRow {id:string;user_id:string|null;agent_id:string|null;role:GroupMembershipRole}

/** Loads a group chat the acting identity may access; direct and task conversations are rejected. */
export async function requireGroup(tx:Tx,id:string,actor:Actor):Promise<GroupRow> {
  const row=(await tx.query(`SELECT c.* FROM conversations c WHERE c.id=$3 AND ${conversationAccess}`,[...accessParams(actor),id])).rows[0];
  if(!row) throw new AppError('ACCESS_DENIED',403,'无权访问此群聊');
  if(row.kind!=='group') throw new AppError('NOT_FOUND',404,'群聊不存在或已变更');
  return row;
}
/** Serializes membership changes so the group size limit and the single owner stay stable. */
export async function lockGroup(tx:Tx,id:string):Promise<GroupRow> {
  const row=(await tx.query('SELECT * FROM conversations WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(!row||row.kind!=='group') throw new AppError('NOT_FOUND',404,'群聊不存在或已变更');
  return row;
}
/** Resolves the acting Agent or user to their own membership row; owners manage on their own identity. */
export async function actingGroupMember(tx:Tx,conversationId:string,actor:Actor,senderAgentId:string|null):Promise<GroupMemberRow> {
  const sql=senderAgentId
    ?'SELECT id,user_id,agent_id,role FROM conversation_members WHERE conversation_id=$1 AND agent_id=$2'
    :'SELECT id,user_id,agent_id,role FROM conversation_members WHERE conversation_id=$1 AND user_id=$2';
  const row=(await tx.query(sql,[conversationId,senderAgentId??messageUserId(actor)])).rows[0];
  if(!row) throw new AppError('ACCESS_DENIED',403,'只有群成员可以执行此操作');
  return row as GroupMemberRow;
}
const isAdmin=(role:GroupMembershipRole) => role==='owner'||role==='admin';
async function activeAgentIds(tx:Tx,ids:string[]) {
  if(!ids.length) return new Set<string>();
  const rows=(await tx.query(`SELECT a.id FROM agents a JOIN users u ON u.id=a.owner_user_id
    WHERE a.id=ANY($1::uuid[]) AND a.status='active' AND a.deleted_at IS NULL AND u.status='active'`,[ids])).rows;
  return new Set<string>(rows.map(row=>row.id));
}
async function activeUserIds(tx:Tx,ids:string[]) {
  if(!ids.length) return new Set<string>();
  const rows=(await tx.query("SELECT id FROM users WHERE id=ANY($1::uuid[]) AND status='active'",[ids])).rows;
  return new Set<string>(rows.map(row=>row.id));
}
async function requireContactable(tx:Tx,agentIds:string[],userIds:string[]) {
  if((await activeAgentIds(tx,agentIds)).size!==agentIds.length) throw new AppError('NOT_FOUND',404,'部分受邀 Agent 不可用');
  if((await activeUserIds(tx,userIds)).size!==userIds.length) throw new AppError('NOT_FOUND',404,'部分受邀访客不可用');
}
async function insertMembers(tx:Tx,conversationId:string,agentIds:string[],userIds:string[],role:'member') {
  if(!agentIds.length&&!userIds.length) return;
  // INSERT … SELECT does not infer parameter types from the target columns, so cast every parameter.
  await tx.query(`INSERT INTO conversation_members(conversation_id,agent_id,user_id,role)
    SELECT $1::uuid,agent_id,NULL,$4::text FROM unnest($2::uuid[]) AS agent_id
    UNION ALL SELECT $1::uuid,NULL,user_id,$4::text FROM unnest($3::uuid[]) AS user_id`,[conversationId,agentIds,userIds,role]);
}
export async function createGroupConversation(tx:Tx,actor:Actor,requestId:string,input:{title:string;member_agent_ids?:string[];member_user_ids?:string[]},senderAgentId:string|null) {
  const title=input.title.trim(),agentIds=[...new Set(input.member_agent_ids??[])],userIds=[...new Set(input.member_user_ids??[])],selfUserId=messageUserId(actor);
  if((senderAgentId&&agentIds.includes(senderAgentId))||(!senderAgentId&&userIds.includes(selfUserId))) throw new AppError('INVALID_REQUEST',400,'创建者已在受邀名单中');
  if(agentIds.length+userIds.length+1>groupMemberLimit) throw new AppError('INVALID_REQUEST',400,`群聊最多 ${groupMemberLimit} 位成员`);
  await requireContactable(tx,agentIds,userIds);
  const id=randomUUID();
  await tx.query("INSERT INTO conversations(id,kind,title,created_by_user_id) VALUES($1,'group',$2,$3)",[id,title,selfUserId]);
  await tx.query('INSERT INTO conversation_members(conversation_id,user_id,agent_id,role) VALUES($1,$2,$3,$4)',[id,senderAgentId?null:selfUserId,senderAgentId,'owner']);
  await insertMembers(tx,id,agentIds,userIds,'member');
  await audit(tx,actor,'messages.group_created','conversation',id,requestId,{title,member_agent_ids:agentIds,member_user_ids:userIds,sender_agent_id:senderAgentId});
  return {status:201,body:await conversationBody(tx,(await tx.query('SELECT * FROM conversations WHERE id=$1',[id])).rows[0]),resourceType:'conversation',resourceId:id};
}
export async function inviteGroupMembers(tx:Tx,actor:Actor,requestId:string,conversation:GroupRow,input:{member_agent_ids?:string[];member_user_ids?:string[]},senderAgentId:string|null) {
  const acting=await actingGroupMember(tx,conversation.id,actor,senderAgentId);
  if(!isAdmin(acting.role)) throw new AppError('ACCESS_DENIED',403,'只有群主或管理员可以邀请成员');
  const agentIds=[...new Set(input.member_agent_ids??[])],userIds=[...new Set(input.member_user_ids??[])];
  if(!agentIds.length&&!userIds.length) throw new AppError('INVALID_REQUEST',400,'请选择要邀请的 Agent 或访客');
  await requireContactable(tx,agentIds,userIds);
  const members=(await tx.query('SELECT agent_id,user_id FROM conversation_members WHERE conversation_id=$1',[conversation.id])).rows;
  const existingAgents=new Set<string>(members.map(row=>row.agent_id).filter(Boolean)),existingUsers=new Set<string>(members.map(row=>row.user_id).filter(Boolean));
  const addedAgents=agentIds.filter(id=>!existingAgents.has(id)),addedUsers=userIds.filter(id=>!existingUsers.has(id));
  if(members.length+addedAgents.length+addedUsers.length>groupMemberLimit) throw new AppError('INVALID_REQUEST',400,`群聊最多 ${groupMemberLimit} 位成员`);
  await insertMembers(tx,conversation.id,addedAgents,addedUsers,'member');
  if(addedAgents.length||addedUsers.length) await audit(tx,actor,'messages.group_members_added','conversation',conversation.id,requestId,{member_agent_ids:addedAgents,member_user_ids:addedUsers,sender_agent_id:senderAgentId});
  return {status:addedAgents.length||addedUsers.length?201:200,body:await conversationBody(tx,conversation),resourceType:'conversation',resourceId:conversation.id};
}
export async function removeGroupMember(tx:Tx,actor:Actor,requestId:string,conversation:GroupRow,memberId:string,senderAgentId:string|null) {
  const acting=await actingGroupMember(tx,conversation.id,actor,senderAgentId);
  const target=(await tx.query('SELECT id,user_id,agent_id,role FROM conversation_members WHERE id=$1 AND conversation_id=$2',[memberId,conversation.id])).rows[0] as GroupMemberRow|undefined;
  if(!target) throw new AppError('NOT_FOUND',404,'群成员不存在或已离开');
  const leaving=acting.id===target.id;
  if(leaving) {
    if(acting.role==='owner') throw new AppError('INVALID_REQUEST',400,'群主不能退出群聊');
  } else {
    if(!isAdmin(acting.role)) throw new AppError('ACCESS_DENIED',403,'只有群主或管理员可以移出成员');
    if(target.role==='owner') throw new AppError('ACCESS_DENIED',403,'不能移出群主');
    if(target.role==='admin'&&acting.role!=='owner') throw new AppError('ACCESS_DENIED',403,'只有群主可以移出管理员');
  }
  await tx.query('DELETE FROM conversation_members WHERE id=$1',[target.id]);
  await audit(tx,actor,leaving?'messages.group_left':'messages.group_member_removed','conversation',conversation.id,requestId,{member_id:target.id,agent_id:target.agent_id,user_id:target.user_id,sender_agent_id:senderAgentId});
  return {status:200,body:{conversation_id:conversation.id,member_id:target.id,left:leaving},resourceType:'conversation',resourceId:conversation.id};
}
export async function leaveGroupConversation(tx:Tx,actor:Actor,requestId:string,conversation:GroupRow,senderAgentId:string|null) {
  const acting=await actingGroupMember(tx,conversation.id,actor,senderAgentId);
  if(acting.role==='owner') throw new AppError('INVALID_REQUEST',400,'群主不能退出群聊');
  return removeGroupMember(tx,actor,requestId,conversation,acting.id,senderAgentId);
}
export async function setGroupMemberRole(tx:Tx,actor:Actor,requestId:string,conversation:GroupRow,memberId:string,role:GroupMemberRole,senderAgentId:string|null) {
  const acting=await actingGroupMember(tx,conversation.id,actor,senderAgentId);
  if(acting.role!=='owner') throw new AppError('ACCESS_DENIED',403,'只有群主可以调整成员权限');
  const target=(await tx.query('SELECT id,user_id,agent_id,role FROM conversation_members WHERE id=$1 AND conversation_id=$2',[memberId,conversation.id])).rows[0] as GroupMemberRow|undefined;
  if(!target) throw new AppError('NOT_FOUND',404,'群成员不存在或已离开');
  if(target.role==='owner') throw new AppError('INVALID_REQUEST',400,'群主权限不能修改');
  if(target.role===role) throw new AppError('NO_CHANGE',409,'成员权限没有变化');
  await tx.query('UPDATE conversation_members SET role=$2 WHERE id=$1',[target.id,role]);
  await audit(tx,actor,'messages.group_member_role_changed','conversation',conversation.id,requestId,{member_id:target.id,agent_id:target.agent_id,user_id:target.user_id,role,sender_agent_id:senderAgentId});
  return {status:200,body:{conversation_id:conversation.id,member_id:target.id,role},resourceType:'conversation',resourceId:conversation.id};
}
export async function renameGroupConversation(tx:Tx,actor:Actor,requestId:string,conversation:GroupRow,title:string,senderAgentId:string|null) {
  const acting=await actingGroupMember(tx,conversation.id,actor,senderAgentId);
  if(!isAdmin(acting.role)) throw new AppError('ACCESS_DENIED',403,'只有群主或管理员可以修改群聊名称');
  const nextTitle=title.trim();
  if(nextTitle===conversation.title) throw new AppError('NO_CHANGE',409,'群聊名称没有变化');
  await tx.query('UPDATE conversations SET title=$2 WHERE id=$1',[conversation.id,nextTitle]);
  await audit(tx,actor,'messages.group_renamed','conversation',conversation.id,requestId,{title:nextTitle,previous_title:conversation.title,sender_agent_id:senderAgentId});
  return {status:200,body:await conversationBody(tx,(await tx.query('SELECT * FROM conversations WHERE id=$1',[conversation.id])).rows[0]),resourceType:'conversation',resourceId:conversation.id};
}
