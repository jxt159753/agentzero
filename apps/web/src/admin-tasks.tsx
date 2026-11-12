import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { TaskDto } from '@agentzero/contracts';
import { api, dateTime, points, queryString } from './api';
import { Empty, ErrorNotice, Loading, Pagination, useCursor } from './components';
import type { ListResult } from './types';
import styles from './style.module.css';
import taskStyles from './tasks.module.css';

const statuses: Record<TaskDto['status'], string> = { draft: '草稿', open: '待接单', in_progress: '执行中', submitted: '待验收', changes_requested: '待修改', settled: '已结算', cancelled: '已取消' };

export function TasksAdminPanel() {
  const [status, setStatus] = useState(''), [disputed, setDisputed] = useState(false);
  const cursor = useCursor();
  const tasks = useQuery({ queryKey: ['admin-tasks', status, disputed, cursor.cursor],
    queryFn: () => api<ListResult<TaskDto>>(`/admin/tasks${queryString({ status, disputed: disputed ? 'true' : undefined, cursor: cursor.cursor })}`) });
  return <section className={styles.card}>
    <h2>任务管理</h2><p className={styles.hint}>查看合同和处理记录。未接单任务可关闭并全额退款；已接单任务可介入，再依据现有合同裁定。</p>
    <div className={taskStyles.filters}>
      <label>管理任务状态<select value={status} onChange={event => { setStatus(event.target.value); cursor.reset(); }}><option value="">全部状态</option>{Object.entries(statuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label><input type="checkbox" checked={disputed} onChange={event => { setDisputed(event.target.checked); cursor.reset(); }} />仅看争议任务</label>
      <button className={styles.textButton} onClick={() => void tasks.refetch()}>刷新管理列表</button>
    </div>
    <ErrorNotice error={tasks.error} />
    {tasks.isPending ? <Loading /> : tasks.data && <>
      {tasks.data.items.length ? <div className={taskStyles.taskList}>{tasks.data.items.map(task => <Link className={taskStyles.taskCard} to={`/tasks/${task.id}`} key={task.id}>
        <div className={taskStyles.taskCardMain}><span className={`${taskStyles.status} ${taskStyles[task.disputed ? 'disputed' : task.status] ?? ''}`}>{task.disputed ? '争议处理中' : statuses[task.status]}</span><h3>{task.title}</h3>
          <p className={styles.hint}>发布者：{task.publisher_name ?? task.publisher_user_id} · 截止 {dateTime(task.deadline_at)}</p>{task.dispute_reason && <p>{task.dispute_reason}</p>}
        </div><div className={taskStyles.taskReward}><strong>{points(task.reward_points)}</strong><small>积分奖金 · 查看详情</small></div>
      </Link>)}</div> : <Empty>暂无符合条件的任务。</Empty>}
      <Pagination {...cursor} nextCursor={tasks.data.next_cursor} />
    </>}
  </section>;
}
