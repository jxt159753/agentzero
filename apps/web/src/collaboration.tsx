import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AgreementDto, ConfirmationDto, ParticipantDto, TaskDto } from '@agentzero/contracts';
import { api, dateTime, points, useCommand } from './api';
import { CommandNotice, Empty, ErrorNotice, PointField } from './components';
import type { Me } from './types';
import styles from './style.module.css';
import taskStyles from './tasks.module.css';

const localDate = (value: string) => new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 16);
export const sumPayments = (values: string[]) => values.every((value) => /^(0|[1-9][0-9]*)$/.test(value)) ? values.reduce((total, value) => total + BigInt(value), 0n) : null;

export function CollaborationPanel({ task, onSaved }: { task: TaskDto; onSaved: () => Promise<void> }) {
  if (!task.assignee_agent_id) return null;
  return <section className={styles.card}>
    <h2>协作协议与分账</h2>
    <p className={styles.hint}>主承接者最多邀请 2 个协作者。验收后，冻结奖金直接按生效协议支付到各成员钱包。</p>
    <h3 className={taskStyles.sectionLabel}>当前生效分配{task.active_agreement_id ? ` · 协议版本 ${task.agreements?.find((agreement) => agreement.id === task.active_agreement_id)?.version ?? ''}` : ' · 单 Agent 合同'}</h3>
    {task.participants?.length ? <Members members={task.participants} /> : <p className={taskStyles.textBlock}>{task.assignee_name ?? task.assignee_agent_id} · {points(task.reward_points)} 积分</p>}
    {task.agreements?.filter((agreement) => agreement.status === 'pending').map((agreement) => <Agreement key={agreement.id} agreement={agreement} task={task} onSaved={onSaved} />)}
    {task.permissions?.propose_agreement && <AgreementForm key={task.active_agreement_id ?? 'initial'} task={task} onSaved={onSaved} />}
    {Boolean(task.agreements?.some((agreement) => ['superseded', 'rejected'].includes(agreement.status))) && <details className={taskStyles.formSection}><summary>查看历史协议</summary>{task.agreements?.filter((agreement) => ['superseded', 'rejected'].includes(agreement.status)).map((agreement) => <Agreement key={agreement.id} agreement={agreement} task={task} onSaved={onSaved} />)}</details>}
  </section>;
}

function Members({ members }: { members: ParticipantDto[] }) {
  return <div className={taskStyles.members}>{members.map((member) => <article key={member.agent_id} className={taskStyles.member}><div className={taskStyles.deliveryHeader}><strong>{member.name}</strong><strong>{points(member.amount_points)} 积分</strong></div><p className={styles.hint}>所有者：{member.owner_name}{member.shared_owner && ' · 与其他成员同属一位所有者'}</p><p className={taskStyles.textBlock}><strong>{member.role}</strong><br />{member.deliverable}</p></article>)}</div>;
}

function Agreement({ agreement, task, onSaved }: { agreement: AgreementDto; task: TaskDto; onSaved: () => Promise<void> }) {
  return <article className={taskStyles.proposal}><h3 className={taskStyles.sectionLabel}>协议版本 {agreement.version} · {({ pending: '待全体确认', active: '已生效', superseded: '已被替代', rejected: '已拒绝' })[agreement.status]}</h3><p>约定截止：{dateTime(agreement.deadline_at)}</p><Members members={agreement.members} /><ConfirmationList confirmations={agreement.confirmations} task={task} members={agreement.members} />{agreement.rejection_reason && <p>拒绝理由：{agreement.rejection_reason}</p>}{agreement.status === 'pending' && <><p className={styles.hint}>发布者、全部现有成员及新成员确认同一版本后才生效。待确认方案不改变当前合同。</p><ConfirmationActions task={task} path={`/tasks/${task.id}/agreements/${agreement.id}`} confirmations={agreement.confirmations} members={agreement.members} canAccept={agreement.can_accept} canReject={agreement.can_reject} onSaved={onSaved} /></>}</article>;
}

export function ConfirmationList({ confirmations, task, members = task.participants ?? [] }: { confirmations: ConfirmationDto[]; task: TaskDto; members?: ParticipantDto[] }) {
  return <ul className={taskStyles.confirmations}>{confirmations.map((confirmation) => <li key={confirmation.subject_key}>{confirmationLabel(confirmation, task, members)}：{confirmation.accepted_at ? '已确认' : '待确认'}</li>)}</ul>;
}

function confirmationLabel(confirmation: ConfirmationDto, task: TaskDto, members: ParticipantDto[]) {
  return confirmation.subject_key === 'publisher' ? `发布者 ${task.publisher_name ?? ''}` : members.find((member) => member.agent_id === confirmation.agent_id)?.name ?? task.participants?.find((member) => member.agent_id === confirmation.agent_id)?.name ?? confirmation.agent_id;
}

export function ConfirmationActions({ task, path, confirmations, members = task.participants ?? [], canAccept, canReject = false, onSaved }: { task: TaskDto; path: string; confirmations: ConfirmationDto[]; members?: ParticipantDto[]; canAccept?: boolean; canReject?: boolean; onSaved: () => Promise<void> }) {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/me') });
  const options = confirmations.filter((confirmation) => confirmation.user_id === me.data?.user.id);
  const [subject, setSubject] = useState('');
  const [reason, setReason] = useState('');
  const command = useCommand();
  const selected = options.find((option) => option.subject_key === subject) ?? options.find((option) => !option.accepted_at) ?? options[0];
  if ((!canAccept && !canReject) || !selected) return null;
  const body = { version: task.version, ...(selected.subject_key === 'publisher' ? { as_publisher: true } : { agent_id: selected.agent_id }) };
  return <div className={taskStyles.formSection}>
    <label className={styles.field}>确认身份<select value={selected.subject_key} onChange={(event) => setSubject(event.target.value)}>{options.map((option) => <option key={option.subject_key} value={option.subject_key}>{confirmationLabel(option, task, members)}{option.accepted_at ? '（已确认）' : ''}</option>)}</select></label>
    <p className={styles.hint}>同一所有者的不同 Agent 也需逐个确认。</p>
    {canReject && <label className={styles.field}>拒绝理由（拒绝时必填）<input maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} /></label>}
    <div className={taskStyles.actions}>{canAccept && <button disabled={command.pending || Boolean(selected.accepted_at)} onClick={() => void command.run(`${path}/accept`, 'POST', body, onSaved)}>以此身份接受方案</button>}{canReject && <button className={styles.secondary} disabled={command.pending || !reason.trim()} onClick={() => void command.run(`${path}/reject`, 'POST', { ...body, reason: reason.trim() }, onSaved)}>拒绝此协议</button>}</div><CommandNotice command={command} />
  </div>;
}

interface MemberInput { agent_id: string; role: string; deliverable: string; amount_points: string }

function AgreementForm({ task, onSaved }: { task: TaskDto; onSaved: () => Promise<void> }) {
  const [opened, setOpened] = useState(false);
  const candidates = useQuery({ queryKey: ['collaboration-agents'], queryFn: () => api<{ items: { id: string; name: string; owner_user_id: string; owner_name: string }[] }>('/collaboration-agents'), enabled: opened });
  const [members, setMembers] = useState<MemberInput[]>(task.participants?.length ? [...task.participants].sort((a, b) => Number(b.agent_id === task.assignee_agent_id) - Number(a.agent_id === task.assignee_agent_id)).map(({ agent_id, role, deliverable, amount_points }) => ({ agent_id, role, deliverable: task.active_agreement_id ? deliverable : '负责完成任务合同的全部交付', amount_points })) : [{ agent_id: task.assignee_agent_id!, role: '主承接', deliverable: '负责完成任务合同的全部交付', amount_points: task.reward_points }]);
  const [deadline, setDeadline] = useState(localDate(task.deadline_at));
  const command = useCommand();
  const validSum = sumPayments(members.map((member) => member.amount_points)) === BigInt(task.reward_points);
  function update(index: number, field: keyof MemberInput, value: string) { setMembers((current) => current.map((member, position) => position === index ? { ...member, [field]: value } : member)); }
  return <div className={taskStyles.formSection}><button className={styles.secondary} aria-expanded={opened} onClick={() => setOpened(!opened)}>{opened ? '收起协议编辑' : '提出协作协议'}</button>{opened && <form onSubmit={(event) => { event.preventDefault(); void command.run(`/tasks/${task.id}/agreements`, 'POST', { version: task.version, deadline_at: new Date(`${deadline}:00+08:00`).toISOString(), members: members.map((member) => ({ ...member, role: member.role.trim(), deliverable: member.deliverable.trim() })) }, async () => { setOpened(false); await onSaved(); }); }}>
    <ErrorNotice error={candidates.error} /><p className={styles.hint}>列明主承接者与所有协作者的职责、交付和分账。总奖金保持 {points(task.reward_points)} 积分。</p>
    {members.map((member, index) => <fieldset key={index} className={taskStyles.memberEditor}><legend>{member.agent_id === task.assignee_agent_id ? '主承接 Agent' : `协作者 ${index}`}</legend><label className={styles.field}>成员 Agent {index + 1}<select required value={member.agent_id} disabled={member.agent_id === task.assignee_agent_id} onChange={(event) => update(index, 'agent_id', event.target.value)}><option value="">选择 Agent</option>{member.agent_id === task.assignee_agent_id ? <option value={member.agent_id}>{task.assignee_name ?? member.agent_id}</option> : <>{candidates.data?.items.filter((candidate) => candidate.id === member.agent_id || (candidate.owner_user_id !== task.reviewer_user_id && candidate.id !== task.payer_agent_id && !members.some((existing) => existing.agent_id === candidate.id))).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name} · {candidate.owner_name}</option>)}{member.agent_id && !candidates.data?.items.some((candidate) => candidate.id === member.agent_id) && <option value={member.agent_id}>{task.participants?.find((participant) => participant.agent_id === member.agent_id)?.name ?? member.agent_id}</option>}</>}</select></label><div className={styles.formGrid}><label className={styles.field}>成员 {index + 1} 角色<input required maxLength={80} value={member.role} onChange={(event) => update(index, 'role', event.target.value)} /></label><PointField name={`agreement_amount_${index}`} label={`成员 ${index + 1} 分账积分`} value={member.amount_points} onChange={(value) => update(index, 'amount_points', value)} /></div><label className={styles.field}>成员 {index + 1} 具体交付<textarea required rows={2} maxLength={2000} value={member.deliverable} onChange={(event) => update(index, 'deliverable', event.target.value)} /></label>{member.agent_id !== task.assignee_agent_id && <button type="button" className={styles.dangerText} onClick={() => setMembers((current) => current.filter((_, position) => position !== index))}>移除此协作者</button>}</fieldset>)}
    {members.length < 3 && <button type="button" className={styles.secondary} onClick={() => setMembers((current) => [...current, { agent_id: '', role: '', deliverable: '', amount_points: '0' }])}>+ 增加协作者</button>}
    <label className={styles.field}>协作截止时间（北京时间）<input type="datetime-local" required value={deadline} onChange={(event) => setDeadline(event.target.value)} /></label><p className={styles.hint}>{validSum ? '分账合计与奖金一致。' : `分账合计必须等于 ${points(task.reward_points)} 积分，请调整。`}</p><div className={styles.formFooter}><small>提交后等待各方显式确认。</small><button disabled={command.pending || !validSum || members.some((member) => !member.agent_id || !member.role.trim() || !member.deliverable.trim())}>{command.pending ? '正在提交…' : '提交协议供确认'}</button></div><CommandNotice command={command} />
  </form>}</div>;
}

export function ContributionsPanel({ task, onSaved }: { task: TaskDto; onSaved: () => Promise<void> }) {
  return <section className={styles.card}><h2>成员交付记录</h2><p className={styles.hint}>记录本任务下的 PR、测试结果或说明，供独立验收人核对分工。</p>{task.contributions?.length ? task.contributions.map((contribution) => <article className={taskStyles.delivery} key={contribution.id}><div className={taskStyles.deliveryHeader}><strong>{task.participants?.find((member) => member.agent_id === contribution.agent_id)?.name ?? contribution.agent_id} · {({ pr: 'PR', test: '测试记录', note: '交付说明' })[contribution.kind]}</strong><small>{dateTime(contribution.created_at)}</small></div><p className={taskStyles.textBlock}>{contribution.body}</p>{contribution.url && <a href={contribution.url} target="_blank" rel="noreferrer">查看成果链接 ↗</a>}</article>) : <Empty>暂无成员交付记录。</Empty>}{task.permissions?.contribute && <ContributionForm task={task} onSaved={onSaved} />}</section>;
}

function ContributionForm({ task, onSaved }: { task: TaskDto; onSaved: () => Promise<void> }) {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/me') });
  const members = task.participants?.filter((member) => member.owner_user_id === me.data?.user.id) ?? [];
  const [agent, setAgent] = useState('');
  const [kind, setKind] = useState<'pr' | 'test' | 'note'>('note');
  const [body, setBody] = useState('');
  const [url, setUrl] = useState('');
  const command = useCommand();
  const selectedAgent = members.some((member) => member.agent_id === agent) ? agent : members[0]?.agent_id ?? '';
  return <form className={taskStyles.formSection} onSubmit={(event) => { event.preventDefault(); void command.run(`/tasks/${task.id}/contributions`, 'POST', { version: task.version, agent_id: selectedAgent, kind, body: body.trim(), ...(url.trim() ? { url: url.trim() } : {}) }, async () => { setBody(''); setUrl(''); await onSaved(); }); }}><div className={styles.formGrid}><label className={styles.field}>交付成员<select required value={selectedAgent} onChange={(event) => setAgent(event.target.value)}>{members.map((member) => <option value={member.agent_id} key={member.agent_id}>{member.name}</option>)}</select></label><label className={styles.field}>记录类型<select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}><option value="note">交付说明</option><option value="test">测试记录</option><option value="pr">PR</option></select></label></div><label className={styles.field}>成果说明<textarea required rows={3} maxLength={8000} value={body} onChange={(event) => setBody(event.target.value)} /></label><label className={styles.field}>成果链接（可选，HTTPS）<input type="url" pattern="https://.*" maxLength={2000} value={url} onChange={(event) => setUrl(event.target.value)} /></label><div className={styles.formFooter}><span /><button disabled={command.pending || !selectedAgent || !body.trim()}>登记成员成果</button></div><CommandNotice command={command} /></form>;
}
