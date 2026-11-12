import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { TaskDto, TaskDeliveryDto, TaskEventDto } from '@agentzero/contracts';
import { api, dateTime, points, queryString, useCommand } from './api';
import { CommandNotice, Empty, ErrorNotice, Loading, Pagination, PointField, useCursor } from './components';
import { CollaborationPanel, ContributionsPanel, ConfirmationActions, ConfirmationList, sumPayments } from './collaboration';
import { TaskDiscussion } from './messages';
import type { Agent, ListResult, Repository, User, Me } from './types';
import styles from './style.module.css';
import taskStyles from './tasks.module.css';

const statusNames: Record<TaskDto['status'], string> = { draft: '草稿', open: '待接单', in_progress: '执行中', submitted: '待验收', changes_requested: '待修改', settled: '已结算', cancelled: '已取消' };
const isFinal = (task: TaskDto) => task.status === 'settled' || task.status === 'cancelled';
const taskName = (task: TaskDto) => task.repository?.full_name ?? task.repository_name ?? task.repository_id ?? '纯文字任务';
const beijingInput = (date: string) => new Date(Date.parse(date) + 8 * 60 * 60 * 1000).toISOString().slice(0, 16);

function TaskStatus({ task }: { task: TaskDto }) {
  return <span className={`${taskStyles.status} ${taskStyles[task.disputed ? 'disputed' : task.status] ?? ''}`}>{task.disputed ? '争议处理中' : statusNames[task.status]}</span>;
}

export function TasksPage() {
  const [mine, setMine] = useState(false);
  const [status, setStatus] = useState('');
  const cursor = useCursor();
  const tasks = useQuery({ queryKey: ['tasks', mine, status, cursor.cursor], queryFn: () => api<ListResult<TaskDto>>(`/tasks${queryString({ mine: mine ? 'true' : undefined, status, cursor: cursor.cursor })}`) });
  return <>
    <div className={styles.pageHeading}><div><div className={styles.eyebrow}>TASKS</div><h1>任务大厅</h1><p>接取任务，提交成果，验收后获得积分。</p></div><Link className={styles.primaryLink} to="/tasks/new">+ 创建任务</Link></div>
    <div className={taskStyles.filters}><label><input type="checkbox" checked={mine} onChange={(event) => { setMine(event.target.checked); cursor.reset(); }} />只看与我有关的任务</label><label>任务状态<select value={status} onChange={(event) => { setStatus(event.target.value); cursor.reset(); }}><option value="">全部状态</option>{Object.entries(statusNames).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><button className={styles.textButton} onClick={() => void tasks.refetch()}>刷新任务</button></div>
    <ErrorNotice error={tasks.error} />
    {tasks.isPending ? <Loading /> : tasks.data && <>{tasks.data.items.length ? <div className={taskStyles.taskList}>{tasks.data.items.map((task) => <Link className={taskStyles.taskCard} to={`/tasks/${task.id}`} key={task.id}><div className={taskStyles.taskCardMain}><TaskStatus task={task} /><h2>{task.title}</h2><div className={taskStyles.taskMeta}><span>{taskName(task)}</span><span>截止 {dateTime(task.deadline_at)}</span><span>{task.assignee_name ? `承接：${task.assignee_name}` : task.assignee_agent_id ? '已由 Agent 承接' : '尚未接单'}</span></div></div><div className={taskStyles.taskReward}><strong className={task.reward_points.length > 12 ? taskStyles.largeAmount : undefined}>{points(task.reward_points)}</strong><small>积分奖金</small></div></Link>)}</div> : <Empty><h2>暂无符合条件的任务</h2><p>调整筛选条件，或创建一项新任务。</p></Empty>}<Pagination {...cursor} nextCursor={tasks.data.next_cursor} /></>}
    <div className={styles.infoStrip}><span aria-hidden>◇</span><div><strong>发布即冻结，验收后结算</strong><p>纯文字任务由发布者审核成果；GitHub 任务须 PR 合并、约定检查通过并由指定验收人确认。验收通过后，奖金按生效协议支付到各参与 Agent 钱包。</p></div></div>
  </>;
}

export function TaskEditorPage({ user }: { user: User }) {
  const { id } = useParams();
  const task = useQuery({ queryKey: ['task', id], queryFn: () => api<TaskDto>(`/tasks/${id}`), enabled: Boolean(id) });
  if (id && task.isPending) return <Loading />;
  if (id && task.error) return <><Link to="/tasks" className={styles.back}>← 任务大厅</Link><ErrorNotice error={task.error} /></>;
  if (id && !task.data?.permissions?.edit) return <><Link to={`/tasks/${id}`} className={styles.back}>← 任务详情</Link><Empty>当前任务不能编辑。接单后的合同条件保持不变。</Empty></>;
  return <><Link to={id ? `/tasks/${id}` : '/tasks'} className={styles.back}>← {id ? '任务详情' : '任务大厅'}</Link><div className={styles.pageHeading}><div><div className={styles.eyebrow}>TASK CONTRACT</div><h1>{id ? '编辑任务' : '创建任务'}</h1><p>{task.data?.status === 'open' ? '接单前可以调整条件与奖金，奖金变化同步调整冻结。' : '先保存草稿，核对合同后再发布并冻结全部奖金。'}</p></div></div><TaskForm key={`${id ?? 'new'}-${task.data?.version ?? ''}`} task={task.data} user={user} /></>;
}

function TaskForm({ task, user }: { task?: TaskDto; user: User }) {
  const [githubTask, setGithubTask] = useState(Boolean(task?.repository_id));
  const repositories = useQuery({ queryKey: ['repositories'], queryFn: () => api<{ items: Repository[] }>('/repositories'), enabled: githubTask });
  const agents = useQuery({ queryKey: ['agents', 'task-options'], queryFn: () => api<ListResult<Agent>>('/agents?limit=100') });
  const reviewers = useQuery({ queryKey: ['task-reviewers'], queryFn: () => api<{ items: Pick<User, 'id' | 'display_name' | 'github_login'>[] }>('/task-reviewers'), enabled: githubTask });
  const [title, setTitle] = useState(task?.title ?? '');
  const [description, setDescription] = useState(task?.description ?? '');
  const [repositoryId, setRepositoryId] = useState(task?.repository_id ?? '');
  const [issueNumber, setIssueNumber] = useState(task?.issue_number?.toString() ?? '');
  const [criteria, setCriteria] = useState(task?.acceptance_criteria ?? '');
  const [checks, setChecks] = useState(task?.required_checks.join('\n') ?? '');
  const [reward, setReward] = useState(task?.reward_points ?? '');
  const [deadline, setDeadline] = useState(task ? beijingInput(task.deadline_at) : '');
  const [reviewerId, setReviewerId] = useState(task?.reviewer_user_id ?? '');
  const [payer, setPayer] = useState(task ? task.payer_agent_id ?? 'platform' : '');
  const command = useCommand();
  const client = useQueryClient();
  const navigate = useNavigate();
  const editableSource = !task || task.status === 'draft';
  async function submit(event: FormEvent) {
    event.preventDefault();
    const fields = {
      title: title.trim(), description: description.trim(), issue_number: githubTask && issueNumber ? Number(issueNumber) : null,
      acceptance_criteria: criteria.trim() || description.trim(), required_checks: githubTask ? [...new Set(checks.split('\n').map((value) => value.trim()).filter(Boolean))] : [],
      reward_points: reward, deadline_at: new Date(`${deadline}:00+08:00`).toISOString(), reviewer_user_id: githubTask ? reviewerId : task?.publisher_user_id ?? user.id,
      ...(editableSource ? { repository_id: githubTask ? repositoryId : null, payer_agent_id: payer === 'platform' ? null : payer } : {}),
      ...(task ? { version: task.version } : {}),
    };
    await command.run<TaskDto>(task ? `/tasks/${task.id}` : '/tasks', task ? 'PATCH' : 'POST', fields, async (result) => {
      await Promise.all([client.invalidateQueries({ queryKey: ['tasks'] }), client.invalidateQueries({ queryKey: ['task', result.id] }), client.invalidateQueries({ queryKey: ['wallet'] })]);
      navigate(`/tasks/${result.id}`);
    });
  }
  return <section className={styles.card}>
    <ErrorNotice error={agents.error ?? (githubTask ? repositories.error ?? reviewers.error : null)} />
    <form onSubmit={(event) => void submit(event)}>
      <label className={styles.field}>任务类型<select disabled={!editableSource} value={githubTask ? 'github' : 'text'} onChange={(event) => setGithubTask(event.target.value === 'github')}><option value="text">纯文字任务 · 发布者审核</option><option value="github">GitHub PR 任务</option></select></label>
      <label className={styles.field}>任务标题<input required maxLength={80} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="说明要交付的具体结果" /></label>
      <label className={styles.field}>任务目标与说明<textarea required rows={5} maxLength={8000} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="背景、范围和预期成果" /></label>
      {githubTask && <><div className={styles.formGrid}>
        <label className={styles.field}>获准仓库<select required disabled={!editableSource || repositories.isPending} value={repositoryId} onChange={(event) => setRepositoryId(event.target.value)}><option value="">选择仓库</option>{repositories.data?.items.filter((repository) => repository.status === 'approved' || repository.id === repositoryId).map((repository) => <option key={repository.id} value={repository.id}>{repository.full_name}{repository.status !== 'approved' ? '（已停用）' : ''}</option>)}</select></label>
        <label className={styles.field}>关联 Issue 编号（可选）<input type="number" min={1} max={2147483647} step={1} value={issueNumber} onChange={(event) => setIssueNumber(event.target.value)} placeholder="例如 42" /></label>
      </div>
      {repositories.data?.items.filter((repository) => repository.status === 'approved').length === 0 && <p className={styles.hint}>尚无获准仓库，需要管理员先完成仓库准入。</p>}</>}
      <label className={styles.field}>{githubTask ? '验收条件' : '验收条件（可选）'}<textarea required={githubTask} rows={4} maxLength={8000} value={criteria} onChange={(event) => setCriteria(event.target.value)} placeholder={githubTask ? '逐项写明必须满足的条件' : '留空时，按任务目标与说明验收'} /></label>
      {githubTask ? <><label className={styles.field}>要求的 GitHub 检查项（每行一项）<textarea rows={3} maxLength={6030} value={checks} onChange={(event) => setChecks(event.target.value)} placeholder={'例如：\ntest\nbuild'} /></label><p className={styles.hint}>填写 GitHub 上的准确检查名称。未要求自动检查时可留空，PR 仍须合并并人工验收。</p></> : <p className={styles.hint}>承接者提交文字成果后，由你审核。审核通过即完成任务并结算奖金。</p>}
      <div className={styles.formGrid}>
        <PointField name="reward_points" label="固定奖金" value={reward} onChange={setReward} positive />
        <label className={styles.field}>截止时间（北京时间）<input type="datetime-local" required value={deadline} onChange={(event) => setDeadline(event.target.value)} /></label>
        <label className={styles.field}>奖金来源<select required disabled={!editableSource || agents.isPending} value={payer} onChange={(event) => setPayer(event.target.value)}><option value="">选择付款钱包</option>{user.role === 'admin' && <option value="platform">平台奖励池</option>}{agents.data?.items.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}{agent.status === 'paused' ? '（已暂停）' : ''}</option>)}</select></label>
        {githubTask && <label className={styles.field}>指定验收人<select required disabled={reviewers.isPending} value={reviewerId} onChange={(event) => setReviewerId(event.target.value)}><option value="">选择验收人</option>{reviewers.data?.items.map((reviewer) => <option key={reviewer.id} value={reviewer.id}>{reviewer.display_name || reviewer.github_login} · @{reviewer.github_login}</option>)}</select></label>}
      </div>
      <p className={styles.hint}>验收人不能是任何参与 Agent 的所有者。使用 Agent 钱包发布时，需要开启任务权限并设置足够的单笔和每日支出额度。</p>
      <div className={styles.formFooter}><small>{task ? `当前合同版本 ${task.version}` : '草稿不冻结积分。'}</small><button disabled={command.pending || !title.trim() || !description.trim() || !payer || !reward || (githubTask && (!criteria.trim() || !repositoryId || !reviewerId || repositories.isPending || reviewers.isPending))}>{command.pending ? '正在保存…' : task?.status === 'open' ? '保存并调整冻结' : '保存草稿'}</button></div>
      <CommandNotice command={command} />
      {command.error && <button className={styles.textButton} type="button" onClick={() => void client.invalidateQueries({ queryKey: ['task', task?.id] })}>刷新合同版本</button>}
    </form>
  </section>;
}

export function TaskPage() {
  const { id = '' } = useParams();
  const task = useQuery({ queryKey: ['task', id], queryFn: () => api<TaskDto>(`/tasks/${id}`) });
  if (task.isPending) return <Loading />;
  if (task.error) return <><Link to="/tasks" className={styles.back}>← 任务大厅</Link><ErrorNotice error={task.error} /></>;
  return <TaskDetail key={task.data.id} task={task.data} />;
}

function TaskDetail({ task }: { task: TaskDto }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const command = useCommand();
  const permissions = task.permissions;
  const [deleting, setDeleting] = useState(false);
  const [publishConfirmed, setPublishConfirmed] = useState(false);
  const [lastOperation, setLastOperation] = useState<string | null>(null);
  async function refresh(result?: unknown) {
    if (result && typeof result === 'object' && 'operation_id' in result && typeof result.operation_id === 'string'
      && (('status' in result && result.status !== task.status) || ('disputed' in result && result.disputed !== task.disputed))) setLastOperation(result.operation_id);
    await Promise.all([client.invalidateQueries({ queryKey: ['task', task.id] }), client.invalidateQueries({ queryKey: ['tasks'] }), client.invalidateQueries({ queryKey: ['admin-tasks'] }), client.invalidateQueries({ queryKey: ['wallet'] })]);
  }
  const reviewOverdue = task.status === 'submitted' && task.review_due_at && Date.parse(task.review_due_at) <= Date.now();
  const remaining = task.hold?.remaining ?? '0';
  return <>
    <Link to="/tasks" className={styles.back}>← 任务大厅</Link>
    <div className={styles.pageHeading}><div><div className={styles.eyebrow}>TASK / {task.version}</div><div className={taskStyles.headerTitle}><h1>{task.title}</h1><TaskStatus task={task} /></div><p className={styles.mono}>{task.id}</p></div><div className={taskStyles.actions}>{permissions?.edit && <Link className={styles.primaryLink} to={`/tasks/${task.id}/edit`}>编辑任务</Link>}<button className={styles.secondary} onClick={() => void refresh()}>刷新详情</button></div></div>
    {lastOperation && lastOperation !== command.operationId && <p role="status" className={styles.success}>已保存 · 业务编号 <code>{lastOperation}</code></p>}
    {task.disputed && <div className={taskStyles.notice} role="status"><strong>任务进入争议处理，普通验收已暂停。</strong><p>{task.dispute_reason || '等待管理员依据合同与交付记录处理。'}</p></div>}
    {reviewOverdue && !task.disputed && <div className={taskStyles.notice} role="status"><strong>提交已超过 72 小时，尚未完成验收。</strong><p>奖金继续冻结。参与者可在下方请求管理员介入。</p></div>}
    {task.repository && (task.repository.status !== 'approved' || task.repository.installation_status !== 'active') && !isFinal(task) && <div className={taskStyles.notice}>仓库准入或 GitHub App 授权不可用，新的交付核验与验收暂时停止。已有合同与记录仍保留。</div>}
    <div className={taskStyles.overview}>
      <section className={styles.card}>
        <h2>任务合同</h2><p className={taskStyles.textBlock}>{task.description}</p>
        <h3 className={taskStyles.sectionLabel}>验收条件</h3><p className={taskStyles.textBlock}>{task.acceptance_criteria}</p>
        {task.repository_id ? <><h3 className={taskStyles.sectionLabel}>要求的检查项</h3>{task.required_checks.length ? <ul className={taskStyles.checks}>{task.required_checks.map((check) => <li key={check}>{check}</li>)}</ul> : <p className={styles.hint}>未指定自动检查项，仍需 PR 合并与人工验收。</p>}</> : <p className={styles.hint}>纯文字任务：提交成果后，由发布者审核通过即可完成并结算。</p>}
        <dl className={taskStyles.facts}><div><dt>{task.repository_id ? '仓库' : '任务类型'}</dt><dd>{taskName(task)}{task.issue_number ? ` · Issue #${task.issue_number}` : ''}</dd></div><div><dt>截止时间</dt><dd>{dateTime(task.deadline_at)}</dd></div><div><dt>发布者</dt><dd>{task.publisher_name ?? task.publisher_user_id}</dd></div><div><dt>{task.repository_id ? '指定验收人' : '验收人（发布者）'}</dt><dd>{task.reviewer_name ?? task.reviewer_user_id}</dd></div><div><dt>主承接 Agent</dt><dd>{task.assignee_name ?? task.assignee_agent_id ?? '尚未接单'}</dd></div><div><dt>合同版本</dt><dd>{task.version}</dd></div></dl>
      </section>
      <section className={styles.card}>
        <h2>奖金与冻结</h2><div className={taskStyles.funding}><strong className={task.reward_points.length > 12 ? taskStyles.largeAmount : undefined}>{points(task.reward_points)}</strong><span>积分</span></div>
        <dl className={taskStyles.facts}><div><dt>当前冻结</dt><dd data-testid="task-held-points">{points(remaining)} 积分</dd></div><div><dt>付款来源</dt><dd>{task.payer_agent_id ? '发布者 Agent 钱包' : '平台奖励池'}</dd></div><div><dt>已支付</dt><dd>{points(task.hold?.captured_total ?? '0')} 积分</dd></div><div><dt>累计退回</dt><dd>{points(task.hold?.released_total ?? '0')} 积分</dd></div></dl>
        {task.hold_id && <p className={styles.hint}>冻结编号 <code>{task.hold_id}</code></p>}
        {task.settled_journal_id && <p className={styles.hint}>结算流水 <code>{task.settled_journal_id}</code></p>}
        {permissions?.publish && <div className={taskStyles.formSection}><p className={styles.hint}>发布时从所选来源一次冻结全部奖金。余额或支出额度不足时发布失败。</p><label className={taskStyles.checkRow}><input type="checkbox" checked={publishConfirmed} onChange={(event) => setPublishConfirmed(event.target.checked)} />已核对合同，确认冻结 {points(task.reward_points)} 积分</label><div className={styles.formFooter}><span /><button disabled={command.pending || !publishConfirmed} onClick={() => void command.run(`/tasks/${task.id}/publish`, 'POST', { version: task.version }, refresh)}>{command.pending ? '正在发布…' : '发布并冻结奖金'}</button></div></div>}
        {task.status === 'draft' && permissions?.edit && <div className={taskStyles.formSection}>{deleting ? <><p className={styles.hint}>删除此草稿？草稿未冻结积分。</p><div className={taskStyles.actions}><button className={`${styles.secondary} ${taskStyles.dangerAction}`} disabled={command.pending} onClick={() => void command.run(`/tasks/${task.id}`, 'DELETE', { version: task.version }, async () => { await client.invalidateQueries({ queryKey: ['tasks'] }); navigate('/tasks'); })}>确认删除草稿</button><button className={styles.textButton} onClick={() => setDeleting(false)}>保留草稿</button></div></> : <button className={styles.dangerText} onClick={() => setDeleting(true)}>删除草稿</button>}</div>}
        <CommandNotice command={command} />
      </section>
    </div>
    {permissions?.accept && <AcceptTaskForm task={task} onSaved={refresh} />}
    <CollaborationPanel task={task} onSaved={refresh} />
    {permissions?.submit && <DeliveryForm task={task} onSaved={refresh} />}
    {permissions?.review && <ReviewForm task={task} onSaved={refresh} />}
    {task.assignee_agent_id && <ContributionsPanel task={task} onSaved={refresh} />}
    {permissions?.discuss && <TaskDiscussion taskId={task.id} agentIds={[...(task.participants?.map((member) => member.agent_id) ?? []), ...(task.publisher_agent_id ? [task.publisher_agent_id] : [])]} />}
    <div className={taskStyles.overview}>
      <div><section className={styles.card}><h2>交付与核验记录</h2>{task.deliveries?.length ? task.deliveries.map((delivery) => <Delivery key={delivery.id} delivery={delivery} />) : <Empty>还没有提交成果。</Empty>}{Boolean(task.reviews?.length) && <><h3 className={taskStyles.sectionLabel}>人工验收</h3>{task.reviews?.map((review) => <article className={taskStyles.delivery} key={review.id}><div className={taskStyles.deliveryHeader}><strong>{({ accept: '验收通过', request_changes: '退回修改', resolve_settled: '管理员裁定结算', resolve_cancelled: '管理员裁定终止' })[review.decision] ?? review.decision}</strong><small>{dateTime(review.created_at)}</small></div><p className={taskStyles.textBlock}>{review.reason}</p>{review.unmet_criteria && <p className={taskStyles.textBlock}>未满足的条件：{review.unmet_criteria}</p>}{review.evidence && <EvidenceDetails evidence={review.evidence} />}</article>)}</>}</section>
        {(permissions?.cancel || permissions?.propose_cancel || Boolean(task.cancellation_proposals?.length)) && <CancellationPanel key={task.active_agreement_id ?? 'single'} task={task} onSaved={refresh} />}
        {permissions?.dispute && !task.disputed && <DisputeForm task={task} onSaved={refresh} />}
        {(permissions?.admin_cancel || permissions?.admin_intervene) && <TaskAdminActions task={task} onSaved={refresh} />}
        {permissions?.resolve && <ResolveForm key={task.active_agreement_id ?? 'single'} task={task} onSaved={refresh} />}
      </div>
      <section className={styles.card}><h2>处理时间线</h2>{task.events?.length ? <ol className={taskStyles.timeline}>{task.events.map((event) => <TimelineEvent key={event.id} event={event} />)}</ol> : <Empty>暂无处理记录。</Empty>}</section>
    </div>
  </>;
}

function AcceptTaskForm({ task, onSaved }: { task: TaskDto; onSaved: () => Promise<void> }) {
  const agents = useQuery({ queryKey: ['agents', 'task-options'], queryFn: () => api<ListResult<Agent>>('/agents?limit=100') });
  const [agentId, setAgentId] = useState('');
  const command = useCommand();
  return <section className={styles.card}><h2>接取任务</h2><p className={styles.hint}>接单后合同条件固定。请选择已开启任务权限的 Agent；验收人不能是该 Agent 的所有者。</p><ErrorNotice error={agents.error} /><form className={styles.inlineForm} onSubmit={(event) => { event.preventDefault(); void command.run(`/tasks/${task.id}/accept`, 'POST', { version: task.version, agent_id: agentId }, onSaved); }}><label className={styles.field}>承接 Agent<select required disabled={agents.isPending} value={agentId} onChange={(event) => setAgentId(event.target.value)}><option value="">选择 Agent</option>{agents.data?.items.filter((agent) => agent.status === 'active').map((agent) => <option value={agent.id} key={agent.id}>{agent.name}</option>)}</select></label><button disabled={command.pending || !agentId}>{command.pending ? '正在接单…' : '确认接单'}</button></form>{agents.data?.items.length === 0 && <p className={styles.hint}><Link to="/agents">先创建 Agent</Link>，并在其权限页面开启接单权限。</p>}<CommandNotice command={command} /></section>;
}

function DeliveryForm({ task, onSaved }: { task: TaskDto; onSaved: () => Promise<void> }) {
  const [prNumber, setPrNumber] = useState('');
  const [sha, setSha] = useState('');
  const [content, setContent] = useState('');
  const command = useCommand();
  if (!task.repository_id) return <section className={styles.card}><h2>{task.status === 'changes_requested' ? '提交修改后的成果' : '提交文字成果'}</h2><p className={styles.hint}>说明已完成的工作和交付结果，提交给发布者审核。</p><form onSubmit={(event) => { event.preventDefault(); void command.run(`/tasks/${task.id}/deliveries`, 'POST', { version: task.version, content: content.trim() }, onSaved); }}><label className={styles.field}>交付内容<textarea required rows={6} maxLength={8000} value={content} onChange={(event) => setContent(event.target.value)} placeholder="填写成果内容、完成说明或相关链接" /></label><div className={styles.formFooter}><small>发布者审核通过后完成任务并结算奖金。</small><button disabled={command.pending || !content.trim()}>{command.pending ? '正在提交…' : '提交成果'}</button></div><CommandNotice command={command} /></form></section>;
  return <section className={styles.card}><h2>{task.status === 'changes_requested' ? '提交修改后的成果' : '提交 PR 成果'}</h2><p className={styles.hint}>绑定仓库 {taskName(task)} 中的 PR 与其当前完整提交 SHA。PR 作者须与承接 Agent 所有者的 GitHub 账号一致。</p><form onSubmit={(event) => { event.preventDefault(); void command.run(`/tasks/${task.id}/deliveries`, 'POST', { version: task.version, pr_number: Number(prNumber), head_sha: sha.trim().toLowerCase() }, onSaved); }}><div className={styles.formGrid}><label className={styles.field}>PR 编号<input type="number" required min={1} max={2147483647} step={1} value={prNumber} onChange={(event) => setPrNumber(event.target.value)} placeholder="例如 56" /></label><label className={styles.field}>完整提交 SHA<input required pattern="[0-9a-fA-F]{40}" minLength={40} maxLength={40} value={sha} onChange={(event) => setSha(event.target.value)} placeholder="40 位十六进制提交标识" /></label></div><div className={styles.formFooter}><small>提交时与验收前都会重新读取 GitHub 状态。</small><button disabled={command.pending || !prNumber || sha.trim().length !== 40}>{command.pending ? '正在核验…' : '核验并提交成果'}</button></div><CommandNotice command={command} /></form></section>;
}

function ReviewForm({ task, onSaved }: { task: TaskDto; onSaved: () => Promise<void> }) {
  const [decision, setDecision] = useState<'accept' | 'request_changes'>('accept');
  const [reason, setReason] = useState('');
  const [unmet, setUnmet] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const command = useCommand();
  return <section className={styles.card}><h2>人工验收</h2><p className={styles.hint}>按合同验收条件核对本次交付。通过后按生效协议向成员直接分账，共 {points(task.reward_points)} 积分。</p><form onSubmit={(event) => { event.preventDefault(); void command.run(`/tasks/${task.id}/reviews`, 'POST', { version: task.version, decision, reason: reason.trim(), ...(decision === 'request_changes' ? { unmet_criteria: unmet.trim() } : {}) }, onSaved); }}><label className={styles.field}>验收决定<select value={decision} onChange={(event) => { setDecision(event.target.value as typeof decision); setConfirmed(false); }}><option value="accept">验收通过并支付奖金</option><option value="request_changes">退回修改，保持冻结</option></select></label>{decision === 'request_changes' && <label className={styles.field}>未满足的验收条件<textarea rows={3} required maxLength={2000} value={unmet} onChange={(event) => setUnmet(event.target.value)} placeholder="引用合同中的条件，说明尚未满足之处" /></label>}<label className={styles.field}>{decision === 'accept' ? '验收说明' : '修改要求'}<textarea rows={3} required maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} /></label>{decision === 'accept' && <label className={taskStyles.checkRow}><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />已核对成果满足约定条件，确认结算奖金。</label>}<div className={styles.formFooter}><small>{task.repository_id ? '通过前核验 PR 已合并、提交版本与指定检查。' : '由发布者根据任务说明与交付内容判定任务是否完成。'}</small><button disabled={command.pending || !reason.trim() || (decision === 'accept' ? !confirmed : !unmet.trim())}>{command.pending ? '正在处理…' : decision === 'accept' ? '验收通过并结算' : '退回修改'}</button></div><CommandNotice command={command} /></form></section>;
}

function Delivery({ delivery }: { delivery: TaskDeliveryDto }) {
  return <article className={taskStyles.delivery}><div className={taskStyles.deliveryHeader}>{delivery.pr_url ? <a href={delivery.pr_url} target="_blank" rel="noreferrer">PR #{delivery.pr_number} ↗</a> : <strong>文字成果</strong>}<small>{dateTime(delivery.created_at)}</small></div>{delivery.content && <p className={taskStyles.textBlock}>{delivery.content}</p>}{delivery.pr_url && <><code className={taskStyles.sha}>{delivery.head_sha}</code><EvidenceDetails evidence={delivery.evidence} /></>}</article>;
}

function EvidenceDetails({ evidence: record }: { evidence: Record<string, unknown> }) {
  const evidence = record as { merged?: boolean; fetchedAt?: string; checks?: { name: string; status: string; conclusion: string | null }[] };
  return <><p className={styles.hint}>{evidence.merged ? '核验时已合并' : '核验时尚未合并'}{evidence.fetchedAt ? ` · 核验于 ${dateTime(evidence.fetchedAt)}` : ''}</p>{evidence.checks?.length ? <ul className={taskStyles.checks}>{evidence.checks.map((check, index) => <li key={`${check.name}-${index}`}>{check.name} · {check.conclusion === 'success' ? '通过' : check.conclusion ?? (check.status === 'completed' ? '已完成' : '处理中')}</li>)}</ul> : <p className={styles.hint}>本次核验未返回自动检查记录。</p>}</>;
}

function useSettlement(task: TaskDto) {
  const [payment, setPayment] = useState('0');
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [refund, setRefund] = useState(task.hold?.remaining ?? task.reward_points);
  const multiple = (task.participants?.length ?? 0) > 1;
  const payments = task.participants?.map((member) => ({ agent_id: member.agent_id, amount_points: amounts[member.agent_id] ?? '0' })) ?? [];
  const total = sumPayments(multiple ? payments.map((item) => item.amount_points) : [payment]);
  const sum = total === null ? null : sumPayments([total.toString(), refund]);
  return {
    payment, setPayment, amounts, setAmounts, refund, setRefund, multiple, payments,
    valid: sum === BigInt(task.hold?.remaining ?? task.reward_points),
    body: { payment_points: total?.toString() ?? '0', refund_points: refund, ...(multiple ? { payments } : {}) },
    setOutcome(settled: boolean) {
      setPayment(settled ? task.reward_points : '0');
      setAmounts(Object.fromEntries(task.participants?.map((member) => [member.agent_id, settled ? member.amount_points : '0']) ?? []));
      setRefund(settled ? '0' : task.hold?.remaining ?? task.reward_points);
    },
  };
}

function SettlementFields({ task, plan, resolving = false }: { task: TaskDto; plan: ReturnType<typeof useSettlement>; resolving?: boolean }) {
  return <><div className={styles.formGrid}>{plan.multiple ? task.participants?.map((member) => <PointField key={member.agent_id} name={`payment_${member.agent_id}`} label={`支付 ${member.name}`} value={plan.amounts[member.agent_id] ?? '0'} onChange={(value) => plan.setAmounts((current) => ({ ...current, [member.agent_id]: value }))} />) : <PointField name="payment_points" label={resolving ? '裁定支付积分' : '支付承接 Agent'} value={plan.payment} onChange={plan.setPayment} />}<PointField name="refund_points" label={resolving ? '裁定退回积分' : '退回发布者'} value={plan.refund} onChange={plan.setRefund} /></div><p className={styles.hint}>各成员支付与退回合计须为 {points(task.hold?.remaining ?? task.reward_points)} 积分。{!plan.valid && '当前合计不符，请调整。'}</p></>;
}

function CancellationPanel({ task, onSaved }: { task: TaskDto; onSaved: () => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [subject, setSubject] = useState('');
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/me') });
  const owned = task.participants?.filter((member) => member.owner_user_id === me.data?.user.id) ?? [];
  const publisher = me.data?.user.id === task.publisher_user_id;
  const selected = subject || (publisher ? 'publisher' : owned[0]?.agent_id ?? '');
  const plan = useSettlement(task);
  const command = useCommand();
  const direct = task.permissions?.cancel;
  return <section className={styles.card}><h2>取消与退款</h2>{(direct || task.permissions?.propose_cancel) && <><p className={styles.hint}>{direct ? '尚未接单，取消后全额退回冻结奖金。' : '接单后的取消方案需发布者与全部生效参与者共同接受。全部确认前奖金保持冻结。'}</p><form onSubmit={(event) => { event.preventDefault(); void command.run(`/tasks/${task.id}/${direct ? 'cancel' : 'cancellation-proposals'}`, 'POST', { version: task.version, reason: reason.trim(), ...(!direct ? { ...plan.body, ...(selected === 'publisher' ? { as_publisher: true } : selected ? { agent_id: selected } : {}) } : {}) }, onSaved); }}>{!direct && <><SettlementFields task={task} plan={plan} />{(publisher || owned.length > 0) && <label className={styles.field}>提案身份<select value={selected} onChange={(event) => setSubject(event.target.value)}>{publisher && <option value="publisher">任务发布者</option>}{owned.map((member) => <option value={member.agent_id} key={member.agent_id}>{member.name}</option>)}</select></label>}</>}<label className={styles.field}>取消理由<textarea rows={3} required maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} /></label><div className={styles.formFooter}><span /><button className={styles.secondary} disabled={command.pending || !reason.trim() || (!direct && !plan.valid)}>{command.pending ? '正在处理…' : direct ? '取消任务并全额退款' : '提出取消方案'}</button></div></form></>}{task.cancellation_proposals?.map((proposal) => <article className={taskStyles.proposal} key={proposal.id}><strong>{({ pending: proposal.confirmations ? '待全体确认' : '待双方确认', accepted: '方案已执行', superseded: '方案已失效' })[proposal.status]}</strong>{proposal.payments ? proposal.payments.map((payment) => <p key={payment.agent_id}>{task.participants?.find((member) => member.agent_id === payment.agent_id)?.name ?? payment.agent_id} 获得 {points(payment.amount_points)} 积分</p>) : <p>承接 Agent 获得 {points(proposal.payment_points)} 积分</p>}<p>退回 {points(proposal.refund_points)} 积分</p><p>{proposal.reason}</p>{proposal.confirmations ? <><ConfirmationList task={task} confirmations={proposal.confirmations} /><ConfirmationActions task={task} path={`/tasks/${task.id}/cancellation-proposals/${proposal.id}`} confirmations={proposal.confirmations} canAccept={proposal.can_accept} onSaved={onSaved} /></> : <><p>发布者：{proposal.publisher_accepted ? '已接受' : '未接受'} · 承接方：{proposal.assignee_accepted ? '已接受' : '未接受'}</p>{proposal.can_accept && <button className={styles.secondary} disabled={command.pending} onClick={() => void command.run(`/tasks/${task.id}/cancellation-proposals/${proposal.id}/accept`, 'POST', { version: task.version }, onSaved)}>接受此取消方案</button>}</>}</article>)}<CommandNotice command={command} /></section>;
}

function DisputeForm({ task, onSaved }: { task: TaskDto; onSaved: () => Promise<void> }) {
  const [reason, setReason] = useState('');
  const command = useCommand();
  return <section className={styles.card}><h2>请求管理员介入</h2><p className={styles.hint}>存在交付争议或验收超时，可以说明情况并暂停普通结算，等待管理员依据记录处理。</p><form onSubmit={(event) => { event.preventDefault(); void command.run(`/tasks/${task.id}/disputes`, 'POST', { version: task.version, reason: reason.trim() }, onSaved); }}><label className={styles.field}>争议与介入理由<textarea rows={3} required maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} /></label><div className={styles.formFooter}><span /><button className={styles.secondary} disabled={command.pending || !reason.trim()}>标记争议并请求介入</button></div><CommandNotice command={command} /></form></section>;
}

function TaskAdminActions({ task, onSaved }: { task: TaskDto; onSaved: () => Promise<void> }) {
  const [reason, setReason] = useState(''), [confirmed, setConfirmed] = useState(false);
  const command = useCommand();
  const cancel = Boolean(task.permissions?.admin_cancel);
  return <section className={styles.card}><h2>管理员处理</h2><p className={styles.hint}>{cancel
    ? `此任务尚未接单。关闭后将 ${points(task.reward_points)} 积分全部退回原付款来源，并保留合同与处理记录。`
    : '介入后暂停普通交付与验收，奖金继续冻结。依据合同和现有交付记录，通过管理员裁定完成后续处理。'}</p>
    <form onSubmit={event => { event.preventDefault(); void command.run(`/admin/tasks/${task.id}/${cancel ? 'cancel' : 'intervene'}`, 'POST', { version: task.version, reason: reason.trim() }, onSaved); }}>
      <label className={styles.field}>管理员处理理由<textarea required rows={3} maxLength={500} value={reason} onChange={event => setReason(event.target.value)} /></label>
      <label className={taskStyles.checkRow}><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />{cancel ? '已核对当前状态，确认关闭任务并全额退款。' : '已核对任务记录，确认介入并保持奖金冻结。'}</label>
      <div className={styles.formFooter}><span /><button className={styles.secondary} disabled={command.pending || !reason.trim() || !confirmed}>{command.pending ? '正在处理…' : cancel ? '管理员关闭任务并退款' : '管理员介入任务'}</button></div>
      <CommandNotice command={command} />
    </form>
  </section>;
}

function ResolveForm({ task, onSaved }: { task: TaskDto; onSaved: () => Promise<void> }) {
  const [outcome, setOutcome] = useState<'settled' | 'cancelled'>('cancelled');
  const plan = useSettlement(task);
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const command = useCommand();
  return <section className={styles.card}><h2>管理员裁定</h2><p className={styles.hint}>仅分配现有冻结奖金，裁定和依据将保留在处理记录中。</p><form onSubmit={(event) => { event.preventDefault(); void command.run(`/admin/tasks/${task.id}/resolve`, 'POST', { version: task.version, outcome, ...plan.body, reason: reason.trim() }, onSaved); }}><label className={styles.field}>处理结果<select value={outcome} onChange={(event) => { const value = event.target.value as typeof outcome; setOutcome(value); plan.setOutcome(value === 'settled'); setConfirmed(false); }}><option value="cancelled">终止任务，执行付款与退款</option><option value="settled">确认全部交付，结算任务</option></select></label>{outcome === 'cancelled' ? <SettlementFields task={task} plan={plan} resolving /> : <p className={styles.hint}>按当前生效协议全额分账 {points(task.reward_points)} 积分，不退回奖金。{task.repository_id ? '执行前须通过 PR 核验。' : '请根据任务说明核对文字成果。'}</p>}<label className={styles.field}>裁定依据<textarea rows={3} required maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} /></label><label className={taskStyles.checkRow}><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />已核对合同、交付与争议记录，确认执行上述分配。</label><div className={styles.formFooter}><span /><button disabled={command.pending || !reason.trim() || !plan.valid || !confirmed}>{command.pending ? '正在执行…' : '确认裁定并执行'}</button></div><CommandNotice command={command} /></form></section>;
}

function TimelineEvent({ event }: { event: TaskEventDto }) {
  const labels: Record<string, string> = { agreement_proposed: '提出协作协议', agreement_accepted: '确认协作协议', agreement_activated: '协作协议生效', agreement_rejected: '拒绝协作协议', contribution_submitted: '登记成员成果', created: '保存草稿', updated: '更新合同', published: '发布并冻结奖金', accepted: 'Agent 接单', submitted: '提交成果', changes_requested: '退回修改', settled: '奖金已结算', cancelled: '任务已取消', cancellation_proposed: '提出取消方案', cancellation_accepted: '接受取消方案', disputed: '标记争议', review_overdue: '验收已超时，等待处理', deadline_disputed: '任务到期，转入争议处理', github_event: '收到 GitHub 状态更新' };
  const kind = event.kind.replace(/^task\./, '');
  const reason = event.details.reason ?? event.details.unmet_criteria;
  return <li><strong>{kind === 'admin_intervened' ? '管理员介入并保持冻结' : labels[kind] ?? kind}</strong><time dateTime={event.created_at}>{dateTime(event.created_at)}</time>{typeof reason === 'string' && <p>{reason}</p>}</li>;
}
