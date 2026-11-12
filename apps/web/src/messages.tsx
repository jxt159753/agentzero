import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { ConversationDto as Conversation, MessagePageDto as MessagePage, MessageRecipientDto as Recipient, MessageUserRecipientDto as UserRecipient } from '@agentzero/contracts';
import { api, dateTime, queryString, useCommand } from './api';
import { Empty, ErrorNotice, Loading } from './components';
import type { Agent, ListResult, Me } from './types';
import styles from './style.module.css';
import chat from './messages.module.css';

const latestCursor = '9223372036854775807';
const timeLabel = (value: string) => new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' }).format(new Date(value));

function conversationName(conversation: Conversation, userId?: string) {
  if (conversation.kind === 'task') return '任务讨论';
  const others = conversation.members.filter(member => member.owner_user_id !== userId);
  return (others.length ? others : conversation.members).map(member => member.name).join('、');
}

function Avatar({ name, agent = false }: { name: string; agent?: boolean }) {
  return <span aria-hidden className={`${chat.avatar} ${agent ? chat.agentAvatar : ''}`}>{name.slice(0, 1).toUpperCase() || '聊'}</span>;
}

export function MessagesPage() {
  const { id = '' } = useParams();
  const [search, setSearch] = useSearchParams();
  const requestedAgent = search.get('agent') ?? '', requestedUser = search.get('user') ?? '';
  const [contactsOpen, setContactsOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [senders, setSenders] = useState<Record<string, string>>({});
  const sendCommand = useCommand(id);
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/me') });
  const conversations = useInfiniteQuery({
    queryKey: ['conversations'],
    queryFn: ({ pageParam }) => api<ListResult<Conversation>>(`/conversations${queryString({ cursor: pageParam })}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: last => last.next_cursor ?? undefined,
    refetchInterval: 5000,
  });
  const conversation = useQuery({ queryKey: ['conversation', id], queryFn: () => api<Conversation>(`/conversations/${id}`), enabled: Boolean(id) });
  const showContacts = contactsOpen || Boolean(requestedAgent || requestedUser);
  const all = [...new Map(conversations.data?.pages.flatMap(page => page.items).map(item => [item.id, item]) ?? []).values()];
  const visible = all.filter(item => item.members.some(member => member.name.toLowerCase().includes(filter.toLowerCase())) || item.kind === 'task' && '任务讨论'.includes(filter));
  const name = conversation.data ? conversationName(conversation.data, me.data?.user.id) : '聊天';

  function changeTab(contacts: boolean) {
    setContactsOpen(contacts); setFilter('');
    if (requestedAgent || requestedUser) setSearch({});
  }

  return <section className={`${chat.messenger} ${id ? chat.conversationOpen : ''}`} aria-label="私聊">
    <aside className={chat.sidebar}>
      <div className={chat.sidebarHeading}><h1>消息</h1><button className={chat.iconButton} aria-label="发起私聊" title="发起私聊" onClick={() => changeTab(true)}>＋</button></div>
      <div className={chat.search}><span aria-hidden>⌕</span><input aria-label="搜索会话或联系人" placeholder={showContacts ? '搜索联系人' : '搜索会话'} value={filter} onChange={event => setFilter(event.target.value)} /></div>
      <div className={chat.tabs}><button aria-pressed={!showContacts} onClick={() => changeTab(false)}>会话</button><button aria-pressed={showContacts} onClick={() => changeTab(true)}>联系人</button></div>
      {showContacts ? <Contacts key={`${requestedUser}:${requestedAgent}`} filter={filter} requestedUser={requestedUser} requestedAgent={requestedAgent} onOpened={(conversationId, sender) => { setSenders(previous => ({ ...previous, [conversationId]: sender })); setContactsOpen(false); setFilter(''); }} /> : <nav className={chat.contactScroll} aria-label="会话列表">
        <ErrorNotice error={conversations.error} />
        {conversations.isPending ? <Loading /> : <>
          {visible.map(item => {
            const title = conversationName(item, me.data?.user.id);
            const represented = item.members.find(member => member.agent_id && member.owner_user_id === me.data?.user.id);
            return <Link key={item.id} className={`${chat.contact} ${item.id === id ? chat.selected : ''}`} aria-current={item.id === id ? 'page' : undefined} to={item.kind === 'task' ? `/tasks/${item.task_id}` : `/messages/${item.id}`}>
              <Avatar name={title} agent={item.members.some(member => member.agent_id && member.owner_user_id !== me.data?.user.id)} />
              <span className={chat.contactText}><span className={chat.contactTitle}><strong>{title}</strong>{item.last_message && <time dateTime={item.last_message.created_at} title={dateTime(item.last_message.created_at)}>{timeLabel(item.last_message.created_at)}</time>}</span><small>{item.last_message ? `${item.last_message.sender_name}：${item.last_message.body}` : '开始聊天吧'}{represented ? ` · 代表 ${represented.name}` : ''}</small></span>
            </Link>;
          })}
          {!visible.length && <Empty>{filter ? '没有找到会话' : '还没有会话'}<button className={chat.emptyAction} onClick={() => changeTab(true)}>找人聊聊</button></Empty>}
          {conversations.hasNextPage && <button className={chat.moreButton} disabled={conversations.isFetchingNextPage} onClick={() => void conversations.fetchNextPage()}>更多会话</button>}
        </>}
      </nav>}
    </aside>
    <div className={chat.chatPane}>
      {id ? <>
        <header className={chat.chatHeading}><Link className={chat.mobileBack} to="/messages" aria-label="返回会话列表">‹</Link><Avatar name={name} /><div><h2>{name}</h2><small>私聊</small></div></header>
        {conversation.isPending ? <Loading /> : conversation.error ? <ErrorNotice error={conversation.error} /> : conversation.data && <MessageThread key={id} path={`/conversations/${id}/messages`} members={conversation.data.members} draft={drafts[id] ?? ''} onDraftChange={value => setDrafts(previous => ({ ...previous, [id]: value }))} draftSender={senders[id] ?? ''} onSenderChange={value => setSenders(previous => ({ ...previous, [id]: value }))} sendCommand={sendCommand} />}
      </> : <div className={chat.welcome}><span aria-hidden>◌</span><h2>聊聊新的想法</h2><p>选择一个会话，或找位朋友开始聊天</p><button onClick={() => changeTab(true)}>找人聊聊</button></div>}
    </div>
  </section>;
}

function Contacts({ filter, requestedAgent, requestedUser, onOpened }: { filter: string; requestedAgent: string; requestedUser: string; onOpened: (conversationId: string, sender: string) => void }) {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/me') });
  const agents = useQuery({ queryKey: ['agents', 'message-options'], queryFn: () => api<ListResult<Agent>>('/agents?limit=100') });
  const recipients = useQuery({ queryKey: ['message-recipients'], queryFn: () => api<{ items: Recipient[]; users?: UserRecipient[] }>('/message-recipients') });
  const [sender, setSender] = useState('');
  const command = useCommand(), client = useQueryClient(), navigate = useNavigate();
  const users = recipients.data?.users ?? [], self = me.data?.user;
  const availableUsers = sender && self?.status === 'active' && !users.some(user => user.id === self.id)
    ? [...users, { id: self.id, name: self.display_name, github_login: self.github_login }] : users;
  const contacts = [
    ...availableUsers.filter(user => sender || user.id !== self?.id).map(user => ({ id: user.id, name: user.name, detail: `@${user.github_login}`, kind: 'user' as const })),
    ...(recipients.data?.items ?? []).filter(agent => agent.id !== sender).map(agent => ({ id: agent.id, name: agent.name, detail: `Agent · ${agent.owner_name}`, kind: 'agent' as const })),
  ];
  const requested = requestedUser || requestedAgent, requestedKind = requestedUser ? 'user' : 'agent';
  const unavailable = requested && recipients.isSuccess && !contacts.some(contact => contact.id === requested && contact.kind === requestedKind);
  const visible = contacts.filter(contact => `${contact.name} ${contact.detail}`.toLowerCase().includes(filter.toLowerCase())).sort((a, b) => Number(b.id === requested && b.kind === requestedKind) - Number(a.id === requested && a.kind === requestedKind));
  const ownAgents = agents.data?.items.filter(agent => agent.status === 'active') ?? [];
  return <>
    <div className={chat.identityPicker}><label>发起身份<select aria-label="发起身份" value={sender} disabled={command.pending} onChange={event => setSender(event.target.value)}><option value="">我本人</option>{ownAgents.map(agent => <option key={agent.id} value={agent.id}>代表 {agent.name}</option>)}</select></label></div>
    <div className={chat.contactScroll}>
      <ErrorNotice error={agents.error ?? recipients.error ?? me.error ?? command.error} />
      {unavailable && <p className={chat.contactHint} role="status">{requestedKind === 'agent' ? '这个 Agent 暂不可联系，请选择其他联系对象。' : '这位访客暂不可联系，请选择其他联系对象。'}</p>}
      {recipients.isPending ? <Loading /> : visible.map(contact => <button key={`${contact.kind}:${contact.id}`} aria-label={`联系 ${contact.name}`} className={`${chat.contact} ${contact.id === requested && contact.kind === requestedKind ? chat.selected : ''}`} disabled={command.pending || Boolean(recipients.error)} onClick={() => void command.run<Conversation>('/conversations', 'POST', { ...(contact.kind === 'agent' ? { recipient_agent_id: contact.id } : { recipient_user_id: contact.id }), ...(sender ? { sender_agent_id: sender } : {}) }, async result => {
        client.setQueryData(['conversation', result.id], result);
        await client.invalidateQueries({ queryKey: ['conversations'] });
        onOpened(result.id, sender); navigate(`/messages/${result.id}`);
      })}>
        <Avatar name={contact.name} agent={contact.kind === 'agent'} /><span className={chat.contactText}><strong>{contact.name}</strong><small>{contact.detail}</small></span><span className={chat.contactArrow} aria-hidden>›</span>
      </button>)}
      {recipients.isSuccess && !visible.length && <Empty>没有找到联系人</Empty>}
    </div>
  </>;
}

export function TaskDiscussion({ taskId, agentIds }: { taskId: string; agentIds: string[] }) {
  const [opened, setOpened] = useState(false);
  return <section className={styles.card}><div className={styles.sectionHeading}><div><h2>任务讨论</h2><p className={styles.hint}>供发布者、参与者和验收人交流。</p></div><button className={styles.secondary} aria-expanded={opened} onClick={() => setOpened(!opened)}>{opened ? '收起讨论' : '打开讨论'}</button></div>{opened && <><p className={styles.hint}>合同确认、取消和结算请在任务中单独操作。</p><div className={chat.taskThread}><MessageThread path={`/tasks/${taskId}/messages`} agentIds={agentIds} /></div></>}</section>;
}

function MessageThread({ path, members, agentIds, draft, onDraftChange, draftSender, onSenderChange, sendCommand }: { path: string; members?: Conversation['members']; agentIds?: string[]; draft?: string; onDraftChange?: (value: string) => void; draftSender?: string; onSenderChange?: (value: string) => void; sendCommand?: ReturnType<typeof useCommand> }) {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/me') });
  const agents = useQuery({ queryKey: ['agents', 'message-options'], queryFn: () => api<ListResult<Agent>>('/agents?limit=100') });
  const [following, setFollowing] = useState(true);
  const messages = useInfiniteQuery({ queryKey: ['messages', path], queryFn: ({ pageParam }) => api<MessagePage>(`${path}${queryString({ before: pageParam, limit: '30' })}`), initialPageParam: latestCursor, getNextPageParam: last => last.has_more ? last.next_cursor : undefined, refetchInterval: following ? 5000 : false, refetchOnWindowFocus: false });
  const [localSender, setLocalSender] = useState(''), [localBody, setLocalBody] = useState('');
  const sender = draftSender ?? localSender, setSender = onSenderChange ?? setLocalSender;
  const body = draft ?? localBody, setBody = onDraftChange ?? setLocalBody;
  const localCommand = useCommand(), client = useQueryClient();
  const command = sendCommand ?? localCommand;
  const scroller = useRef<HTMLDivElement>(null), input = useRef<HTMLTextAreaElement>(null);
  const follow = useRef(true), historyHeight = useRef<number | null>(null);
  const ownAgents = agents.data?.items.filter(agent => agent.status === 'active' && (!members || members.some(member => member.agent_id === agent.id)) && (!agentIds || agentIds.includes(agent.id))) ?? [];
  const userCanSend = !members || members.some(member => member.user_id === me.data?.user.id);
  const selectedSender = ownAgents.some(agent => agent.id === sender) ? sender : userCanSend ? '' : ownAgents[0]?.id ?? '';
  const canSend = userCanSend || Boolean(selectedSender);
  const identityCount = ownAgents.length + Number(userCanSend);
  const items = [...new Map(messages.data?.pages.slice().reverse().flatMap(page => page.items).map(item => [item.id, item]) ?? []).values()];
  const firstId = items[0]?.id, lastId = items.at(-1)?.id;

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    if (historyHeight.current !== null) {
      element.scrollTop += element.scrollHeight - historyHeight.current;
      historyHeight.current = null;
    } else if (follow.current) element.scrollTop = element.scrollHeight;
  }, [firstId, lastId]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!body.trim() || !canSend || command.pending || messages.isPending || messages.error) return;
    await command.run(path, 'POST', { body: body.trim(), ...(selectedSender ? { sender_agent_id: selectedSender } : {}) }, async () => {
      setBody(''); follow.current = true; setFollowing(true);
      await Promise.all([client.invalidateQueries({ queryKey: ['messages', path] }), client.invalidateQueries({ queryKey: ['conversations'] })]);
    });
    input.current?.focus({ preventScroll: true });
  }

  return <>
    <div className={chat.timeline} ref={scroller} onScroll={event => { const element = event.currentTarget; follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 70; setFollowing(follow.current); }}>
      <ErrorNotice error={messages.error ?? agents.error} />
      {messages.isError && <button className={chat.moreButton} onClick={() => void messages.refetch()}>重新加载消息</button>}
      {messages.isPending ? <Loading /> : <>
        {messages.hasNextPage && <button className={chat.moreButton} disabled={messages.isFetchingNextPage} onClick={() => { historyHeight.current = scroller.current?.scrollHeight ?? null; void messages.fetchNextPage().then(result => { if (result.isFetchNextPageError) historyHeight.current = null; }); }}>查看更早消息</button>}
        <ol className={chat.messageList} aria-label="消息记录" aria-live="polite">{items.map(message => {
          const mine = message.sender_user_id === me.data?.user.id || Boolean(message.sender_agent_id && (members?.some(member => member.agent_id === message.sender_agent_id && member.owner_user_id === me.data?.user.id) || agents.data?.items.some(agent => agent.id === message.sender_agent_id)));
          return <li key={message.id} className={mine ? chat.mine : ''}><Avatar name={message.sender_name} agent={Boolean(message.sender_agent_id)} /><div className={chat.messageContent}><div className={chat.messageMeta}><span>{message.sender_name}{message.sender_agent_id ? ' · Agent' : ''}</span><time dateTime={message.created_at} title={dateTime(message.created_at)}>{timeLabel(message.created_at)}</time></div><p className={chat.bubble}>{message.body}</p></div></li>;
        })}</ol>
        {!items.length && !messages.error && <div className={chat.emptyThread}>打个招呼，开始聊天吧</div>}
      </>}
    </div>
    <form className={chat.composer} onSubmit={event => void submit(event)}>
      <div className={chat.senderLine}>{identityCount > 1 ? <label>发送身份<select aria-label="发送身份" value={selectedSender} disabled={command.pending} onChange={event => setSender(event.target.value)}>{userCanSend && <option value="">我本人</option>}{ownAgents.map(agent => <option key={agent.id} value={agent.id}>代表 {agent.name}</option>)}</select></label> : <span>{selectedSender ? `代表 ${ownAgents.find(agent => agent.id === selectedSender)?.name}` : canSend ? '我本人' : '此会话中的 Agent 暂不能发送消息。'}</span>}</div>
      <textarea ref={input} aria-label="消息内容" rows={3} maxLength={8000} value={body} disabled={command.pending || !canSend} onChange={event => setBody(event.target.value)} placeholder="输入消息…" onKeyDown={event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
      }} />
      <ErrorNotice error={command.error} />
      <div className={chat.composerFooter}><small>Enter 发送 · Shift + Enter 换行</small><button disabled={command.pending || !body.trim() || !canSend || messages.isPending || Boolean(messages.error)}>{command.pending ? '发送中…' : '发送消息'}</button></div>
    </form>
  </>;
}
