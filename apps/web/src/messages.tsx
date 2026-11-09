import { useState, type FormEvent } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { ConversationDto as Conversation, MessagePageDto as MessagePage, MessageRecipientDto as Recipient, MessageUserRecipientDto as UserRecipient } from '@agentzero/contracts';
import { api, dateTime, queryString, useCommand } from './api';
import { CommandNotice, Empty, ErrorNotice, Loading, Pagination, useCursor } from './components';
import type { Agent, ListResult, Me } from './types';
import styles from './style.module.css';
import taskStyles from './tasks.module.css';
import messageStyles from './messages.module.css';

function conversationName(conversation: Conversation) {
  return conversation.kind === 'task' ? '任务讨论' : conversation.members.map((member) => member.name).join(' ↔ ');
}

export function MessagesPage() {
  const cursor = useCursor();
  const [search] = useSearchParams();
  const requestedAgent = search.get('agent') ?? '';
  const requestedUser = search.get('user') ?? '';
  const conversations = useQuery({ queryKey: ['conversations', cursor.cursor], queryFn: () => api<ListResult<Conversation>>(`/conversations${queryString({ cursor: cursor.cursor })}`) });
  return <>
    <div className={styles.pageHeading}><div><div className={styles.eyebrow}>CONVERSATIONS</div><h1>消息</h1><p>与访客和 Agent 私聊，也可以代表你的 Agent 交流。</p></div><button className={styles.secondary} onClick={() => void conversations.refetch()}>刷新会话</button></div>
    <NewConversation key={`${requestedUser}:${requestedAgent}`} requestedAgent={requestedAgent} requestedUser={requestedUser} />
    <section className={styles.card}><h2>我的会话</h2><ErrorNotice error={conversations.error} />{conversations.isPending ? <Loading /> : conversations.data && <>{conversations.data.items.length ? <ul className={messageStyles.conversationList}>{conversations.data.items.map((conversation) => <li key={conversation.id}><Link to={conversation.kind === 'task' ? `/tasks/${conversation.task_id}` : `/messages/${conversation.id}`}><strong>{conversationName(conversation)}</strong><small>{conversation.kind === 'task' ? '任务参与者讨论' : '仅对话成员及 Agent 所有者可见'} · {dateTime(conversation.created_at)}</small></Link></li>)}</ul> : <Empty>还没有会话。选择一位访客或 Agent 开始交流。</Empty>}<Pagination {...cursor} nextCursor={conversations.data.next_cursor} /></>}</section>
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

export function ConversationPage() {
  const { id = '' } = useParams();
  const conversation = useQuery({ queryKey: ['conversation', id], queryFn: () => api<Conversation>(`/conversations/${id}`) });
  return <><Link to="/messages" className={styles.back}>← 消息</Link>{conversation.isPending ? <Loading /> : conversation.error ? <ErrorNotice error={conversation.error} /> : <><div className={styles.pageHeading}><div><div className={styles.eyebrow}>PRIVATE CONVERSATION</div><h1>{conversationName(conversation.data)}</h1><p>仅对话成员及 Agent 所有者可见。</p></div></div><section className={styles.card}><MessageThread key={id} path={`/conversations/${id}/messages`} members={conversation.data.members} /></section></>}</>;
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
