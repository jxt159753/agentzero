import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { withTransaction } from '@agentzero/database';
import { AddGroupMembers,CreateConversation,CreateGroupConversation,GroupMemberCommand,GroupMemberParams,IdParams,MessageQuery,PageQuery,RenameGroupConversation,SendMessage,SetGroupMemberRole,type AddGroupMembersInput,type CreateConversationInput,type CreateGroupConversationInput,type GroupMemberCommandInput,type RenameGroupConversationInput,type SendMessageInput,type SetGroupMemberRoleInput } from '@agentzero/contracts';
import { AppError,audit,decodeCursor,lockActor } from '../../core.js';
import { command,type ApiContext } from '../../http.js';
import { accessParams,appendMessage,conversationAccess,conversationBody,createGroupConversation,inviteGroupMembers,leaveGroupConversation,lockGroup,messagePage,messageUserId,removeGroupMember,renameGroupConversation,requireConversation,requireGroup,requireTaskDiscussion,sendingAgent,setGroupMemberRole } from './service.js';

export async function registerMessages(app:FastifyInstance,ctx:ApiContext) {
  app.get('/api/v1/message-recipients',async request=>withTransaction(ctx.pool,async tx=>{
    await lockActor(tx,request.actor,{allowPaused:true});
    const items=(await tx.query(`SELECT a.id,a.name,a.owner_user_id,u.display_name AS owner_name FROM agents a JOIN users u ON u.id=a.owner_user_id WHERE a.status='active' AND u.status='active' ORDER BY a.name,a.id`)).rows;
    const users=(await tx.query(`SELECT id,display_name AS name,github_login FROM users WHERE status='active' AND ($1::uuid IS NULL OR id<>$1) ORDER BY display_name,id`,[request.actor.type==='user'?request.actor.userId:null])).rows;
    return {items,users};
  }));
  app.get<{Querystring:{cursor?:string;limit?:string}}>('/api/v1/conversations',{schema:{querystring:PageQuery}},async request=>withTransaction(ctx.pool,async tx=>{
    await lockActor(tx,request.actor,{allowPaused:true});
    const cursor=decodeCursor(request.query.cursor),limit=Number(request.query.limit??30);
    const rows=(await tx.query(`SELECT c.*,latest.id AS last_message_id,
      to_char(COALESCE(latest.created_at,c.created_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS activity_at
      FROM conversations c LEFT JOIN LATERAL (SELECT m.id,m.created_at FROM messages m WHERE m.conversation_id=c.id ORDER BY m.cursor DESC LIMIT 1) latest ON true
      WHERE ${conversationAccess} AND ($3::timestamptz IS NULL OR (COALESCE(latest.created_at,c.created_at),c.id)<($3,$4::uuid))
      ORDER BY COALESCE(latest.created_at,c.created_at) DESC,c.id DESC LIMIT $5`,[...accessParams(request.actor),cursor?.[0]??null,cursor?.[1]??null,limit+1])).rows;
    const items=rows.slice(0,limit),last=items.at(-1);
    const page={items,next_cursor:rows.length>limit?Buffer.from(JSON.stringify([last.activity_at,last.id])).toString('base64url'):null};
    return {...page,items:await Promise.all(page.items.map(row=>conversationBody(tx,row)))};
  }));
  app.post<{Body:CreateConversationInput}>('/api/v1/conversations',{schema:{body:CreateConversation}},async(request,reply)=>{
    const sender=sendingAgent(request.actor,request.body.sender_agent_id);
    const targetAgent='recipient_agent_id' in request.body?request.body.recipient_agent_id:null;
    const targetUser='recipient_user_id' in request.body?request.body.recipient_user_id:null;
    if((sender&&sender===targetAgent)||(!sender&&targetUser===messageUserId(request.actor))) throw new AppError('INVALID_REQUEST',400,'请选择另一位对话参与者');
    if(request.actor.type==='user'&&sender) request.actor={...request.actor,representedAgentId:sender};
    const recipientOwner=targetAgent?(await ctx.pool.query<{owner_user_id:string}>('SELECT owner_user_id FROM agents WHERE id=$1',[targetAgent])).rows[0]?.owner_user_id:targetUser;
    return command(ctx,request,reply,{...(sender?{agentId:sender}:{}),userIds:recipientOwner?[recipientOwner]:[]},async tx=>{
      const recipient=targetAgent
        ?(await tx.query(`SELECT a.id FROM agents a JOIN users u ON u.id=a.owner_user_id WHERE a.id=$1 AND a.deleted_at IS NULL AND a.status='active' AND u.status='active'`,[targetAgent])).rows[0]
        :(await tx.query(`SELECT id FROM users WHERE id=$1 AND status='active'`,[targetUser])).rows[0];
      if(!recipient) throw new AppError('NOT_FOUND',404,targetAgent?'接收 Agent 不可用':'接收访客不可用');
      const directKey=[sender?`agent:${sender}`:`user:${messageUserId(request.actor)}`,targetAgent?`agent:${targetAgent}`:`user:${targetUser}`].sort().join('|'),id=randomUUID();
      const inserted=await tx.query(`INSERT INTO conversations(id,kind,direct_key) VALUES($1,'direct',$2) ON CONFLICT(direct_key) DO NOTHING RETURNING *`,[id,directKey]);
      let conversation=inserted.rows[0];
      if(conversation) {
        await tx.query('INSERT INTO conversation_members(conversation_id,user_id,agent_id) VALUES($1,$2,$3),($1,$4,$5)',[id,sender?null:messageUserId(request.actor),sender,targetUser,targetAgent]);
        await audit(tx,request.actor,'messages.conversation_created','conversation',id,request.id,{...(targetAgent?{recipient_agent_id:targetAgent}:{recipient_user_id:targetUser}),sender_agent_id:sender});
      } else conversation=(await tx.query('SELECT * FROM conversations WHERE direct_key=$1',[directKey])).rows[0];
      return {status:inserted.rowCount?201:200,body:await conversationBody(tx,conversation),resourceType:'conversation',resourceId:conversation.id};
    });
  });
  // Group chats are created by a user or Agent identity that becomes the single owner.
  app.post<{Body:CreateGroupConversationInput}>('/api/v1/conversations/groups',{schema:{body:CreateGroupConversation}},async(request,reply)=>{
    const sender=sendingAgent(request.actor,request.body.sender_agent_id);
    if(request.actor.type==='user'&&sender) request.actor={...request.actor,representedAgentId:sender};
    const ownerIds=request.body.member_agent_ids?.length
      ?(await ctx.pool.query<{owner_user_id:string}>('SELECT owner_user_id FROM agents WHERE id=ANY($1::uuid[])',[request.body.member_agent_ids])).rows.map(row=>row.owner_user_id)
      :[];
    return command(ctx,request,reply,{...(sender?{agentId:sender}:{}),userIds:[...(request.body.member_user_ids??[]),...ownerIds]},async tx=>createGroupConversation(tx,request.actor,request.id,request.body,sender));
  });
  app.get<{Params:{id:string}}>('/api/v1/conversations/:id',{schema:{params:IdParams}},async request=>withTransaction(ctx.pool,async tx=>{
    await lockActor(tx,request.actor,{allowPaused:true});
    return conversationBody(tx,await requireConversation(tx,request.params.id,request.actor));
  }));
  app.patch<{Params:{id:string};Body:RenameGroupConversationInput}>('/api/v1/conversations/:id',{schema:{params:IdParams,body:RenameGroupConversation}},async(request,reply)=>{
    const sender=sendingAgent(request.actor,request.body.sender_agent_id);
    if(request.actor.type==='user'&&sender) request.actor={...request.actor,representedAgentId:sender};
    return command(ctx,request,reply,{...(sender?{agentId:sender}:{})},async tx=>{
      const group=await requireGroup(tx,request.params.id,request.actor);
      return renameGroupConversation(tx,request.actor,request.id,await lockGroup(tx,group.id),request.body.title,sender);
    });
  });
  app.post<{Params:{id:string};Body:AddGroupMembersInput}>('/api/v1/conversations/:id/members',{schema:{params:IdParams,body:AddGroupMembers}},async(request,reply)=>{
    const sender=sendingAgent(request.actor,request.body.sender_agent_id);
    if(request.actor.type==='user'&&sender) request.actor={...request.actor,representedAgentId:sender};
    const ownerIds=request.body.member_agent_ids?.length
      ?(await ctx.pool.query<{owner_user_id:string}>('SELECT owner_user_id FROM agents WHERE id=ANY($1::uuid[])',[request.body.member_agent_ids])).rows.map(row=>row.owner_user_id)
      :[];
    return command(ctx,request,reply,{...(sender?{agentId:sender}:{}),userIds:[...(request.body.member_user_ids??[]),...ownerIds]},async tx=>{
      const group=await requireGroup(tx,request.params.id,request.actor);
      return inviteGroupMembers(tx,request.actor,request.id,await lockGroup(tx,group.id),request.body,sender);
    });
  });
  app.patch<{Params:{id:string;memberId:string};Body:SetGroupMemberRoleInput}>('/api/v1/conversations/:id/members/:memberId',{schema:{params:GroupMemberParams,body:SetGroupMemberRole}},async(request,reply)=>{
    const sender=sendingAgent(request.actor,request.body.sender_agent_id);
    if(request.actor.type==='user'&&sender) request.actor={...request.actor,representedAgentId:sender};
    return command(ctx,request,reply,{...(sender?{agentId:sender}:{})},async tx=>{
      const group=await requireGroup(tx,request.params.id,request.actor);
      return setGroupMemberRole(tx,request.actor,request.id,await lockGroup(tx,group.id),request.params.memberId,request.body.role,sender);
    });
  });
  app.delete<{Params:{id:string;memberId:string};Body:GroupMemberCommandInput}>('/api/v1/conversations/:id/members/:memberId',{schema:{params:GroupMemberParams,body:GroupMemberCommand}},async(request,reply)=>{
    const sender=sendingAgent(request.actor,request.body?.sender_agent_id);
    if(request.actor.type==='user'&&sender) request.actor={...request.actor,representedAgentId:sender};
    return command(ctx,request,reply,{...(sender?{agentId:sender}:{})},async tx=>{
      const group=await requireGroup(tx,request.params.id,request.actor);
      return removeGroupMember(tx,request.actor,request.id,await lockGroup(tx,group.id),request.params.memberId,sender);
    });
  });
  app.post<{Params:{id:string};Body:GroupMemberCommandInput}>('/api/v1/conversations/:id/leave',{schema:{params:IdParams,body:GroupMemberCommand}},async(request,reply)=>{
    const sender=sendingAgent(request.actor,request.body?.sender_agent_id);
    if(request.actor.type==='user'&&sender) request.actor={...request.actor,representedAgentId:sender};
    return command(ctx,request,reply,{...(sender?{agentId:sender}:{})},async tx=>{
      const group=await requireGroup(tx,request.params.id,request.actor);
      return leaveGroupConversation(tx,request.actor,request.id,await lockGroup(tx,group.id),sender);
    });
  });
  app.get<{Params:{id:string};Querystring:{after?:string;before?:string;limit?:string}}>('/api/v1/conversations/:id/messages',{schema:{params:IdParams,querystring:MessageQuery}},async request=>withTransaction(ctx.pool,async tx=>{
    await lockActor(tx,request.actor,{allowPaused:true});await requireConversation(tx,request.params.id,request.actor);
    return messagePage(tx,request.actor,request.query,request.params.id);
  }));
  app.post<{Params:{id:string};Body:SendMessageInput}>('/api/v1/conversations/:id/messages',{schema:{params:IdParams,body:SendMessage}},async(request,reply)=>{
    const sender=sendingAgent(request.actor,request.body.sender_agent_id);
    if(request.actor.type==='user'&&sender) request.actor={...request.actor,representedAgentId:sender};
    return command(ctx,request,reply,{...(sender?{agentId:sender}:{})},async tx=>appendMessage(tx,request.actor,request.id,await requireConversation(tx,request.params.id,request.actor),request.body.body,sender));
  });
  app.get<{Params:{id:string};Querystring:{after?:string;before?:string;limit?:string}}>('/api/v1/tasks/:id/messages',{schema:{params:IdParams,querystring:MessageQuery}},async request=>withTransaction(ctx.pool,async tx=>{
    await lockActor(tx,request.actor,{allowPaused:true});await requireTaskDiscussion(tx,request.params.id,request.actor);
    const conversation=(await tx.query("SELECT id FROM conversations WHERE task_id=$1 AND kind='task'",[request.params.id])).rows[0];
    if(!conversation) {
      if(request.query.after!==undefined&&request.query.before!==undefined||BigInt(request.query.before??request.query.after??'0')>9223372036854775807n) throw new AppError('INVALID_REQUEST',400,'无效消息游标');
      return {items:[],next_cursor:request.query.before??request.query.after??'0',has_more:false,conversation_id:null};
    }
    return messagePage(tx,request.actor,request.query,conversation.id);
  }));
  app.post<{Params:{id:string};Body:SendMessageInput}>('/api/v1/tasks/:id/messages',{schema:{params:IdParams,body:SendMessage}},async(request,reply)=>{
    const sender=sendingAgent(request.actor,request.body.sender_agent_id);
    if(request.actor.type==='user'&&sender) request.actor={...request.actor,representedAgentId:sender};
    return command(ctx,request,reply,{...(sender?{agentId:sender}:{})},async tx=>{
      await requireTaskDiscussion(tx,request.params.id,request.actor,sender);
      await tx.query("INSERT INTO conversations(kind,task_id) VALUES('task',$1) ON CONFLICT(task_id) DO NOTHING",[request.params.id]);
      const conversation=(await tx.query('SELECT * FROM conversations WHERE task_id=$1',[request.params.id])).rows[0];
      return appendMessage(tx,request.actor,request.id,conversation,request.body.body,sender);
    });
  });
  app.get<{Querystring:{after?:string;before?:string;limit?:string}}>('/api/v1/messages',{schema:{querystring:MessageQuery}},async request=>withTransaction(ctx.pool,async tx=>{
    await lockActor(tx,request.actor,{allowPaused:true});return messagePage(tx,request.actor,request.query);
  }));
}
