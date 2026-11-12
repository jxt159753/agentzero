import { useState, type FormEvent } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { ConversationDto as Conversation, ConversationMemberDto as ConversationMember, MessagePageDto as MessagePage, MessageRecipientDto as Recipient, MessageUserRecipientDto as UserRecipient } from '@agentzero/contracts';
import { api, dateTime, queryString, useCommand } from './api';
import { CommandNotice, Empty, ErrorNotice, Loading, Pagination, useCursor } from './components';
import type { Agent, ListResult, Me } from './types';
import styles from './style.module.css';
import taskStyles from './tasks.module.css';
import messageStyles from './messages.module.css';

function conversationName(conversation: Conversation) {
  if (conversation.kind === 'task') return '任务讨论';
  if (conversation.kind === 'group') return conversation.title ?? '群聊';
  return conversation.members.map((member) => member.name).join(' ↔ ');
}

function conversationHint(conversation: Conversation) {
  if (conversation.kind === 'task') return '任务参与者讨论';
  if (conversation.kind === 'group') return `群聊 · ${conversation.members.length} 位成员`;
  return '仅对话成员及 Agent 所有者可见';
}

const roleLabel: Record<ConversationMember['role'], string> = { owner: '群主', admin: '管理员', member: '成员' };

export function MessagesPage() {
  const cursor = useCursor();
  const [search] = useSearchParams();
  const requestedAgent = search.get('agent') ?? '';
  const requestedUser = search.get('user') ?? '';
  const conversations = useQuery({ queryKey: ['conversations', cursor.cursor], queryFn: () => api<ListResult<Conversation>>(`/conversations${queryString({ cursor: cursor.cursor })}`) });
  return <>
    <div className={styles.pageHeading}><div><div className={styles.eyebrow}>CONVERSATIONS</div><h1>消息</h1><p>与访客和 Agent 私聊，创建群聊，也可以代表你的 Agent 交流。</p></div><button className={styles.secondary} onClick={() => void conversations.refetch()}>刷新会话</button></div>
    <NewConversation key={`${requestedUser}:${requestedAgent}`} requestedAgent={requestedAgent} requestedUser={requestedUser} />
    <NewGroup />
    <section className={styles.card}><h2>我的会话</h2><ErrorNotice error={conversations.error} />{conversations.isPending ? <Loading /> : conversations.data && <>{conversations.data.items.length ? <ul className={messageStyles.conversationList}>{conversations.data.items.map((conversation) => <li key={conversation.id}><Link to={conversation.kind === 'task' ? `/tasks/${conversation.task_id}` : `/messages/${conversation.id}`}><strong>{conversationName(conversation)}</strong><small>{conversationHint(conversation)} · {dateTime(conversation.created_at)}</small></Link></li>)}</ul> : <Empty>还没有会话。选择一位访客或 Agent 开始交流，或创建一个群聊。</Empty>}<Pagination {...cursor} nextCursor={conversations.data.next_cursor} /></>}</section>
  </>;
}

function NewConversation({ requestedAgent, requestedUser }: { requestedAgent: string; requestedUser: string }) {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/me') });
  const agents = useQuery({ queryKey: ['agents', 'message-options'], queryFn: () => api<ListResult<Agent>>('/agents?limit=100') });
  const recipients = useQuery({ queryKey: ['message-recipients'], queryFn: () => api<{ items: Recipient[]; users?: UserRecipient[] }>('/message-recipients') });
  const [sender, setSender] = useState('');
  const [recipientKind, setRecipientKind] = useState<'agent' | 'user'>(requestedUser ? 'user' : 'agent');
  const [recipient, setRecipient] = useState(requestedUser || requestedAgent);
  const command = useCommand();
  const navigate = useNavigate();
  const client = useQueryClient();
  const users = recipients.data?.users ?? [];
  const self = me.data?.user;
  const availableUsers = sender && self?.status === 'active' && !users.some(user => user.id === self.id)
    ? [...users, { id: self.id, name: self.display_name, github_login: self.github_login }] : users;
  const availableRecipients = recipientKind === 'agent'
    ? (recipients.data?.items ?? []).filter(agent => agent.id !== sender).map(agent => ({ id: agent.id, label: `${agent.name} · ${agent.owner_name}` }))
    : availableUsers.filter(user => sender || user.id !== self?.id).map(user => ({ id: user.id, label: `${user.name} · @${user.github_login}` }));
  const selectedRecipient = availableRecipients.some(contact => contact.id === recipient) ? recipient : '';
  const unavailable = Boolean(recipient) && recipients.isSuccess && !selectedRecipient;
  const canOpen = Boolean(selectedRecipient) && !recipients.error;
  return <section className={styles.card}><h2>开始私聊</h2><ErrorNotice error={agents.error ?? recipients.error ?? me.error} />{unavailable && <p className={styles.hint} role="status">{recipientKind === 'agent' ? '这个 Agent 暂不可联系，请选择其他联系对象。' : '这位访客暂不可联系，请选择其他联系对象。'}</p>}<form onSubmit={(event) => { event.preventDefault(); if (!canOpen) return; void command.run<Conversation>('/conversations', 'POST', { ...(recipientKind === 'agent' ? { recipient_agent_id: selectedRecipient } : { recipient_user_id: selectedRecipient }), ...(sender ? { sender_agent_id: sender } : {}) }, async (result) => { await client.invalidateQueries({ queryKey: ['conversations'] }); navigate(`/messages/${result.id}`); }); }}>
    <div className={styles.formGrid}>
      <label className={styles.field}>发起身份<select value={sender} onChange={(event) => { const next = event.target.value; setSender(next); if (recipientKind === 'agent' ? recipient === next : !next && recipient === self?.id) setRecipient(''); }}><option value="">我本人</option>{agents.data?.items.filter((agent) => agent.status === 'active').map((agent) => <option value={agent.id} key={agent.id}>代表 {agent.name}</option>)}</select></label>
      <label className={styles.field}>联系类型<select value={recipientKind} onChange={(event) => { setRecipientKind(event.target.value as 'agent' | 'user'); setRecipient(''); }}><option value="agent">Agent</option><option value="user">访客</option></select></label>
      <label className={styles.field}>{recipientKind === 'agent' ? '联系 Agent' : '联系访客'}<select required value={selectedRecipient} onChange={(event) => setRecipient(event.target.value)}><option value="">选择联系对象</option>{availableRecipients.map(contact => <option value={contact.id} key={contact.id}>{contact.label}</option>)}</select></label>
    </div><div className={styles.formFooter}><small>可查看你本人及所属 Agent 的对话。</small><button disabled={command.pending || !canOpen}>{command.pending ? '正在打开…' : '打开私聊'}</button></div><CommandNotice command={command} />
  </form></section>;
}

function NewGroup() {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/me') });
  const agents = useQuery({ queryKey: ['agents', 'message-options'], queryFn: () => api<ListResult<Agent>>('/agents?limit=100') });
  const recipients = useQuery({ queryKey: ['message-recipients'], queryFn: () => api<{ items: Recipient[]; users?: UserRecipient[] }>('/message-recipients') });
  const [title, setTitle] = useState('');
  const [sender, setSender] = useState('');
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [userIds, setUserIds] = useState<string[]>([]);
  const command = useCommand();
  const navigate = useNavigate();
  const client = useQueryClient();
  const self = me.data?.user;
  const agentOptions = (recipients.data?.items ?? []).filter(agent => agent.id !== sender);
  const userOptions = [...(recipients.data?.users ?? []), ...(sender || !self ? [] : [{ id: self.id, name: `${self.display_name}（我本人）`, github_login: self.github_login }])];
  const toggle = (list: string[], id: string) => list.includes(id) ? list.filter(value => value !== id) : [...list, id];
  const selected = agentIds.length + userIds.length;
  const canCreate = Boolean(title.trim()) && selected > 0;
  return <section className={styles.card}><h2>创建群聊</h2><p className={styles.hint}>群主可以邀请或移出成员、调整管理员权限；管理员可以邀请成员并修改群名。</p><ErrorNotice error={agents.error ?? recipients.error ?? me.error} /><form onSubmit={(event) => { event.preventDefault(); if (!canCreate) return; void command.run<Conversation>('/conversations/groups', 'POST', { title: title.trim(), ...(agentIds.length ? { member_agent_ids: agentIds } : {}), ...(userIds.length ? { member_user_ids: userIds } : {}), ...(sender ? { sender_agent_id: sender } : {}) }, async (result) => { setTitle(''); setAgentIds([]); setUserIds([]); await client.invalidateQueries({ queryKey: ['conversations'] }); navigate(`/messages/${result.id}`); }); }}>
    <div className={styles.formGrid}>
      <label className={styles.field}>群聊名称<input required maxLength={80} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：群聊功能联调" /></label>
      <label className={styles.field}>群主身份<select value={sender} onChange={(event) => { const next = event.target.value; setSender(next); setAgentIds(list => list.filter(id => id !== next)); }}><option value="">我本人</option>{agents.data?.items.filter((agent) => agent.status === 'active').map((agent) => <option value={agent.id} key={agent.id}>代表 {agent.name}</option>)}</select></label>
    </div>
    <div className={styles.formGrid}>
      <fieldset className={styles.field}><legend>邀请 Agent</legend>{agentOptions.length ? <div className={messageStyles.checkList}>{agentOptions.map(agent => <label key={agent.id}><input type="checkbox" checked={agentIds.includes(agent.id)} onChange={() => setAgentIds(list => toggle(list, agent.id))} /> {agent.name} · {agent.owner_name}</label>)}</div> : <small>暂无可邀请的 Agent。</small>}</fieldset>
      <fieldset className={styles.field}><legend>邀请访客</legend>{userOptions.length ? <div className={messageStyles.checkList}>{userOptions.map(user => <label key={user.id}><input type="checkbox" checked={userIds.includes(user.id)} onChange={() => setUserIds(list => toggle(list, user.id))} /> {user.name} · @{user.github_login}</label>)}</div> : <small>暂无可邀请的访客。</small>}</fieldset>
    </div>
    <div className={styles.formFooter}><small>已选 {selected} 位受邀成员，群主创建后自动加入；最多 50 位成员。</small><button disabled={command.pending || !canCreate}>{command.pending ? '正在创建…' : '创建群聊'}</button></div><CommandNotice command={command} />
  </form></section>;
}

export function ConversationPage() {
  const { id = '' } = useParams();
  const conversation = useQuery({ queryKey: ['conversation', id], queryFn: () => api<Conversation>(`/conversations/${id}`) });
  return <><Link to="/messages" className={styles.back}>← 消息</Link>{conversation.isPending ? <Loading /> : conversation.error ? <ErrorNotice error={conversation.error} /> : <><div className={styles.pageHeading}><div><div className={styles.eyebrow}>{conversation.data.kind === 'group' ? 'GROUP CONVERSATION' : 'PRIVATE CONVERSATION'}</div><h1>{conversationName(conversation.data)}</h1><p>{conversationHint(conversation.data)}</p></div></div>{conversation.data.kind === 'group' && <GroupPanel key={id} conversation={conversation.data} />}<section className={styles.card}><MessageThread key={id} path={`/conversations/${id}/messages`} members={conversation.data.members} /></section></>}</>;
}

function GroupPanel({ conversation }: { conversation: Conversation }) {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/me') });
  const agents = useQuery({ queryKey: ['agents', 'message-options'], queryFn: () => api<ListResult<Agent>>('/agents?limit=100') });
  const recipients = useQuery({ queryKey: ['message-recipients'], queryFn: () => api<{ items: Recipient[]; users?: UserRecipient[] }>('/message-recipients') });
  const [sender, setSender] = useState('');
  const [title, setTitle] = useState(conversation.title ?? '');
  const [inviteKind, setInviteKind] = useState<'agent' | 'user'>('agent');
  const [invite, setInvite] = useState('');
  const command = useCommand();
  const client = useQueryClient();
  const self = me.data?.user;
  const ownAgents = (agents.data?.items ?? []).filter(agent => agent.status === 'active' && conversation.members.some(member => member.agent_id === agent.id));
  const memberIds = new Set(conversation.members.flatMap(member => [member.user_id, member.agent_id].filter(Boolean) as string[]));
  const actingMember = conversation.members.find(member => sender ? member.agent_id === sender : member.user_id === self?.id);
  const role = actingMember?.role ?? 'member';
  const canManage = role === 'owner' || role === 'admin';
  const isOwner = role === 'owner';
  const inviteOptions = inviteKind === 'agent'
    ? (recipients.data?.items ?? []).filter(agent => !memberIds.has(agent.id)).map(agent => ({ id: agent.id, label: `${agent.name} · ${agent.owner_name}` }))
    : (recipients.data?.users ?? []).filter(user => !memberIds.has(user.id)).map(user => ({ id: user.id, label: `${user.name} · @${user.github_login}` }));
  async function refresh() {
    await Promise.all([client.invalidateQueries({ queryKey: ['conversation', conversation.id] }), client.invalidateQueries({ queryKey: ['conversations'] })]);
  }
  const acting = (): Record<string, string> => sender ? { sender_agent_id: sender } : {};
  return <section className={styles.card}><div className={styles.sectionHeading}><div><h2>群成员与管理</h2><p className={styles.hint}>群主可以调整权限；管理员可以邀请成员和修改群名。</p></div></div><ErrorNotice error={agents.error ?? recipients.error ?? me.error} />
    <div className={styles.formGrid}>
      <label className={styles.field}>操作身份<select value={sender} onChange={(event) => setSender(event.target.value)}><option value="">我本人</option>{ownAgents.map(agent => <option value={agent.id} key={agent.id}>代表 {agent.name}（{roleLabel[conversation.members.find(member => member.agent_id === agent.id)?.role ?? 'member']}）</option>)}</select></label>
      <div className={styles.field}><span>我的权限</span><small>{actingMember ? roleLabel[role] : '旁观（仅所有者可见）'}</small></div>
    </div>
    <ul className={messageStyles.memberList}>{conversation.members.map(member => { const kickable = canManage && member.role !== 'owner' && (isOwner || member.role === 'member') && !(member.user_id === self?.id); return <li key={member.id}><span><strong>{member.name}</strong><small>{member.agent_id ? 'Agent' : '访客'} · {roleLabel[member.role]}</small></span>{isOwner && member.role !== 'owner' && <button className={styles.textButton} disabled={command.pending} onClick={() => void command.run(`/conversations/${conversation.id}/members/${member.id}`, 'PATCH', { role: member.role === 'admin' ? 'member' : 'admin', ...acting() }, refresh)}>{member.role === 'admin' ? '取消管理员' : '设为管理员'}</button>}{kickable && <button className={styles.textButton} disabled={command.pending} onClick={() => void command.run(`/conversations/${conversation.id}/members/${member.id}`, 'DELETE', acting(), refresh)}>移出</button>}</li>; })}</ul>
    {canManage && <form className={taskStyles.formSection} onSubmit={(event) => { event.preventDefault(); if (!invite) return; void command.run(`/conversations/${conversation.id}/members`, 'POST', { ...(inviteKind === 'agent' ? { member_agent_ids: [invite] } : { member_user_ids: [invite] }), ...acting() }, async () => { setInvite(''); await refresh(); }); }}><div className={styles.formGrid}><label className={styles.field}>邀请类型<select value={inviteKind} onChange={(event) => { setInviteKind(event.target.value as 'agent' | 'user'); setInvite(''); }}><option value="agent">Agent</option><option value="user">访客</option></select></label><label className={styles.field}>邀请对象<select value={invite} onChange={(event) => setInvite(event.target.value)}><option value="">选择要邀请的对象</option>{inviteOptions.map(option => <option value={option.id} key={option.id}>{option.label}</option>)}</select></label></div><div className={styles.formFooter}><small>被邀请者即刻加入，最多 50 位成员。</small><button disabled={command.pending || !invite}>{command.pending ? '正在邀请…' : '邀请加入'}</button></div></form>}
    {canManage && <form className={taskStyles.formSection} onSubmit={(event) => { event.preventDefault(); if (!title.trim() || title.trim() === conversation.title) return; void command.run(`/conversations/${conversation.id}`, 'PATCH', { title: title.trim(), ...acting() }, refresh); }}><label className={styles.field}>群聊名称<input maxLength={80} value={title} onChange={(event) => setTitle(event.target.value)} /></label><div className={styles.formFooter}><small>只有群主和管理员可以改名。</small><button disabled={command.pending || !title.trim() || title.trim() === conversation.title}>{command.pending ? '正在保存…' : '保存群名'}</button></div></form>}
    {actingMember && role !== 'owner' && <div className={styles.formFooter}><small>退出后不再接收此群聊的新消息。</small><button className={styles.secondary} disabled={command.pending} onClick={() => void command.run(`/conversations/${conversation.id}/leave`, 'POST', acting(), async () => { await refresh(); })}>退出群聊</button></div>}
    <CommandNotice command={command} />
  </section>;
}

export function TaskDiscussion({ taskId, agentIds }: { taskId: string; agentIds: string[] }) {
  const [opened, setOpened] = useState(false);
  return <section className={styles.card}><div className={styles.sectionHeading}><div><h2>任务讨论</h2><p className={styles.hint}>供发布者、参与者和验收人交流。</p></div><button className={styles.secondary} aria-expanded={opened} onClick={() => setOpened(!opened)}>{opened ? '收起讨论' : '打开讨论'}</button></div>{opened && <MessageThread path={`/tasks/${taskId}/messages`} agentIds={agentIds} />}</section>;
}

function MessageThread({ path, members, agentIds }: { path: string; members?: Conversation['members']; agentIds?: string[] }) {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/me') });
  const agents = useQuery({ queryKey: ['agents', 'message-options'], queryFn: () => api<ListResult<Agent>>('/agents?limit=100') });
  const messages = useInfiniteQuery({ queryKey: ['messages', path], queryFn: ({ pageParam }) => api<MessagePage>(`${path}${queryString({ after: pageParam, limit: '30' })}`), initialPageParam: '0', getNextPageParam: (last) => last.has_more ? last.next_cursor : undefined, refetchInterval: 10000 });
  const [sender, setSender] = useState('');
  const [body, setBody] = useState('');
  const command = useCommand();
  const client = useQueryClient();
  const ownAgents = agents.data?.items.filter((agent) => agent.status === 'active' && (!members || members.some((member) => member.agent_id === agent.id)) && (!agentIds || agentIds.includes(agent.id))) ?? [];
  const userCanSend = !members || members.some((member) => member.user_id === me.data?.user.id);
  const selectedSender = userCanSend ? sender : sender || ownAgents[0]?.id || '';
  const canSend = userCanSend || Boolean(selectedSender);
  async function submit(event: FormEvent) {
    event.preventDefault();
    await command.run(path, 'POST', { body: body.trim(), ...(selectedSender ? { sender_agent_id: selectedSender } : {}) }, async () => {
      setBody('');
      await Promise.all([client.invalidateQueries({ queryKey: ['messages', path] }), client.invalidateQueries({ queryKey: ['conversations'] })]);
    });
  }
  return <>
    <p className={styles.hint}>聊天用于交流。合同确认、取消和结算须在任务中单独操作。</p>
    <ErrorNotice error={messages.error ?? agents.error} />
    {messages.isPending ? <Loading /> : messages.data && <><ol className={messageStyles.messageList} aria-label="消息记录">{messages.data.pages.flatMap((page) => page.items).map((message) => <li key={message.id}><div className={messageStyles.messageHeader}><strong>{message.sender_name}{message.sender_agent_id && <span> · Agent</span>}</strong><time dateTime={message.created_at}>{dateTime(message.created_at)}</time></div><p>{message.body}</p></li>)}</ol>{messages.data.pages.every((page) => !page.items.length) && <Empty>还没有消息。</Empty>}<div className={taskStyles.actions}>{messages.hasNextPage && <button className={styles.secondary} disabled={messages.isFetchingNextPage} onClick={() => void messages.fetchNextPage()}>加载后续消息</button>}<button className={styles.textButton} onClick={() => void messages.refetch()}>刷新消息</button></div></>}
    {!messages.error && <form className={taskStyles.formSection} onSubmit={(event) => void submit(event)}><label className={styles.field}>发送身份<select value={selectedSender} disabled={!canSend} onChange={(event) => setSender(event.target.value)}>{userCanSend && <option value="">我本人</option>}{ownAgents.map((agent) => <option value={agent.id} key={agent.id}>代表 {agent.name}</option>)}</select></label><label className={styles.field}>消息内容<textarea required rows={3} maxLength={8000} value={body} onChange={(event) => setBody(event.target.value)} placeholder="描述进展、问题或合作意向" /></label><div className={styles.formFooter}><small>{!canSend ? '此会话中的 Agent 暂不能发送消息。' : '发送后保留真实操作人与 Agent 身份。'}</small><button disabled={command.pending || !body.trim() || !canSend}>{command.pending ? '正在发送…' : '发送消息'}</button></div><CommandNotice command={command} /></form>}
  </>;
}
