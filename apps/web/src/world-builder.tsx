import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { WORLD_METERS_PER_UNIT, WORLD_MODEL_CATALOG, WORLD_MODEL_LIMIT, WORLD_MODEL_MAX_SCALE, WORLD_MODEL_MIN_SCALE, worldModelFits, worldRoomFits,
  type WorldLand, type WorldModelId, type WorldModelPlacement, type WorldModelResult } from '@agentzero/contracts';
import { ApiError, measure, useCommand } from './api';
import { CommandNotice } from './components';
import type { WorldPlacementPreview, WorldPoint } from './world-scene';
import { WORLD_ASSET_CREDITS } from './world-assets';
import styles from './world-builder.module.css';

export interface BuilderSelection { landId: string; roomId?: string | null; placement?: WorldPlacementPreview; version?: string }
interface BuilderProps {
  lands: WorldLand[]; userId?: string; selection: BuilderSelection; connected: boolean; hidden: boolean;
  onChange: (selection: BuilderSelection) => void; onClose: () => void;
  onFocus: (point: WorldPoint) => void; onLockedChange: (locked: boolean) => void;
}
interface PendingRequest { path: string; method: 'POST' | 'PATCH' | 'DELETE'; body: Record<string, unknown>; landId: string }
type ModelCategory = typeof WORLD_MODEL_CATALOG[WorldModelId]['category'];
const categories = { all: '全部', building: '建筑', nature: '自然', outdoor: '庭院', furniture: '家具' } as const;
const categoryIcons: Record<ModelCategory, string> = { building: '⌂', nature: '♣', outdoor: '☼', furniture: '▥' };
const icons: Partial<Record<WorldModelId, string>> = { studio: '⌂', tree: '♣', lamp: '☼', bench: '▰', fountain: '⛲', plant: '❧', bookshelf: '▥' };
const modelIcon = (id: WorldModelId) => icons[id] ?? categoryIcons[WORLD_MODEL_CATALOG[id].category];
const modelIds = Object.keys(WORLD_MODEL_CATALOG) as WorldModelId[];
const round = (value: number) => Math.round(value * 1000) / 1000;

export function WorldBuilder({ lands, userId, selection, connected, hidden, onChange, onClose, onFocus, onLockedChange }: BuilderProps) {
  const command = useCommand(), submitting = useRef(false);
  const [collapsed, setCollapsed] = useState(false);
  const [category, setCategory] = useState<ModelCategory | 'all'>('all'), [search, setSearch] = useState('');
  const [submitted, setSubmitted] = useState<PendingRequest | null>(null);
  const [awaiting, setAwaiting] = useState<{ landId: string; version: string } | null>(null);
  const [notice, setNotice] = useState('');
  const ownLands = lands.filter(land => userId && land.owner?.id === userId);
  const land = lands.find(item => item.id === selection.landId), draft = selection.placement;
  const uncertain = command.error instanceof ApiError && command.error.uncertain;
  const synchronized = !awaiting || lands.some(item => item.id === awaiting.landId && BigInt(item.version) >= BigInt(awaiting.version));
  const locked = command.pending || uncertain || !synchronized;
  const canEdit = connected && Boolean(userId && land && land.owner?.id === userId && !land.listing);
  const models = land?.models ?? [], roomId = selection.roomId ?? null, rooms = models.filter(item => !item.room_id && WORLD_MODEL_CATALOG[item.model_id].category === 'building'), visiblePlacements = models.filter(item => (item.room_id ?? null) === roomId), selected = models.find(item => item.id === draft?.selectedId);
  const fits = Boolean(land && draft && (draft.room_id ? worldRoomFits(draft) : worldModelFits(land, draft)));
  const changedElsewhere = Boolean(draft?.selectedId && (!selected || selected.version !== selection.version));
  const roomHasContents = Boolean(draft?.selectedId && models.some(item => item.room_id === draft.selectedId));
  const full = !draft?.selectedId && models.length >= WORLD_MODEL_LIMIT;
  const visibleModels = modelIds.filter(id => (!roomId || WORLD_MODEL_CATALOG[id].category !== 'building') && (category === 'all' || WORLD_MODEL_CATALOG[id].category === category)
    && WORLD_MODEL_CATALOG[id].label.includes(search.trim()));
  useEffect(() => { onLockedChange(locked); return () => onLockedChange(false); }, [locked, onLockedChange]);

  const change = (next: BuilderSelection) => {
    if (locked) return;
    setNotice(''); setSubmitted(null); setAwaiting(null); onChange(next);
  };
  const selectLand = (id: string) => {
    change({ landId: id });
    const target = lands.find(item => item.id === id); if (target) onFocus(target);
  };
  const chooseModel = (modelId: WorldModelId) => {
    change({ landId: selection.landId, roomId, placement: { room_id: roomId, model_id: modelId, x: 0, y: 0, rotation: 0, scale: 1 } });
  };
  const selectPlacement = (model: WorldModelPlacement) => {
    change({ landId: selection.landId, roomId, placement: { room_id: model.room_id ?? null, model_id: model.model_id, x: model.x, y: model.y, rotation: model.rotation, scale: model.scale, selectedId: model.id }, version: model.version });
  };
  const update = (patch: Partial<WorldPlacementPreview>) => {
    if (draft) change({ ...selection, placement: { ...draft, ...patch } });
  };
  const run = async (request: PendingRequest) => {
    if (submitting.current) return;
    submitting.current = true; setSubmitted(request); setNotice('');
    try {
      await command.run<WorldModelResult | { deleted: true; id: string; land_version: string }>(request.path, request.method, request.body, result => {
        setAwaiting({ landId: request.landId, version: result.land_version });
        onChange({ landId: request.landId, roomId });
        setNotice(request.method === 'DELETE' ? '模型已移除。' : '模型布置已保存。');
      });
    } finally { submitting.current = false; }
  };
  const save = () => {
    if (!canEdit || locked || !land || !draft || !fits || full || changedElsewhere) return;
    const { model_id, x, y, rotation, scale, selectedId, room_id } = draft;
    void run({ landId: land.id, path: `/world/studios/${land.id}/models${selectedId ? `/${selectedId}` : ''}`,
      method: selectedId ? 'PATCH' : 'POST', body: selectedId ? { version: selection.version, x, y, rotation, scale } : { land_version: land.version, model_id, x, y, rotation, scale, room_id } });
  };
  const remove = () => {
    if (!canEdit || locked || !land || !draft?.selectedId || changedElsewhere || roomHasContents) return;
    void run({ landId: land.id, path: `/world/studios/${land.id}/models/${draft.selectedId}`, method: 'DELETE', body: { version: selection.version } });
  };

  return <aside className={`${styles.panel} ${collapsed ? styles.collapsed : ''}`} aria-label="模型布置" hidden={hidden}>
    <header className={styles.header}><div><span>MAKE IT YOURS</span><h2>布置我的地块</h2></div><div className={styles.headerActions}>
      <button type="button" onClick={() => setCollapsed(value => !value)} aria-expanded={!collapsed}>{collapsed ? '展开面板' : '收起选点'}</button>
      <button type="button" aria-label="关闭模型布置" disabled={locked} onClick={onClose}>×</button>
    </div></header>
    {collapsed && <p className={styles.collapsedHint}>{draft ? `点击地块放置「${WORLD_MODEL_CATALOG[draft.model_id].label}」，展开后保存。` : '展开面板，选择地块和免费模型。'}</p>}
    <div className={styles.content} hidden={collapsed}>
      {!ownLands.length ? <div className={styles.empty}><p>拥有地块后，就能用免费模型布置自己的空间。</p><Link to="/market">去资产市场查看土地 →</Link></div> : <>
        <label className={styles.field}>我的地块<select aria-label="选择布置地块" value={land?.owner?.id === userId ? selection.landId : ''} disabled={locked} onChange={event => selectLand(event.target.value)}>
          <option value="" disabled>选择自己的地块</option>{ownLands.map(item => <option key={item.id} value={item.id}>{item.name || item.code} · {item.code}{item.listing ? '（挂牌中）' : ''}</option>)}
        </select></label>
        {land && <div className={styles.landMeta}><span>{measure(land.area)} m² · {models.length} / {WORLD_MODEL_LIMIT} 个模型</span><button type="button" onClick={() => onFocus(roomId ? { x: 0, y: 0, room_id: roomId } : land)}>定位地块</button></div>}
        {land && <label className={styles.field}>布置空间<select aria-label="选择布置空间" value={roomId ?? ''} disabled={locked} onChange={event => { const next = event.target.value || null; change({ landId: selection.landId, roomId: next }); onFocus(next ? { x: 0, y: 0, room_id: next } : land); }}><option value="">室外地块</option>{rooms.map((room, index) => <option key={room.id} value={room.id}>{WORLD_MODEL_CATALOG[room.model_id].label} {index + 1} · 室内</option>)}</select></label>}
        {!connected && <p className={styles.warning} role="status">连接恢复后可继续布置。</p>}
        {land?.listing && <p className={styles.warning} role="status">地块挂牌中，撤销挂牌后才能修改布置。</p>}
        {land && land.owner?.id !== userId && <p className={styles.warning} role="status">地块产权已变化，请选择自己的地块。</p>}
        <div className={styles.sectionHeading}><h3>免费模型库 · {modelIds.length} 种</h3><a href={WORLD_ASSET_CREDITS} target="_blank" rel="noreferrer">Polyfork · CC BY</a></div>
        <div className={styles.categories} role="group" aria-label="模型分类">{(Object.keys(categories) as (ModelCategory | 'all')[]).map(value =>
          <button type="button" key={value} aria-pressed={category === value} onClick={() => setCategory(value)}>{categories[value]}</button>)}</div>
        <input className={styles.search} aria-label="搜索模型" type="search" placeholder="搜索模型名称" value={search} onChange={event => setSearch(event.target.value)} />
        <div className={styles.catalog} role="group" aria-label="免费模型库">{visibleModels.map(modelId => <button type="button" key={modelId} aria-pressed={draft?.model_id === modelId && !draft.selectedId}
          disabled={!canEdit || locked || models.length >= WORLD_MODEL_LIMIT} onClick={() => chooseModel(modelId)}><span aria-hidden>{modelIcon(modelId)}</span><strong>{WORLD_MODEL_CATALOG[modelId].label}</strong><small>免费</small></button>)}</div>
        {!visibleModels.length && <p className={styles.hint}>没有匹配的模型，可切换分类或修改搜索。</p>}
        <p className={styles.hint}>{roomId ? '在室内点击地板选位置，家具和游戏机须完整位于房间内。' : '选模型后点击地块选位置，再调整朝向和大小。可重叠摆放，完整模型须位于自己的地块内。'}</p>
        {models.length >= WORLD_MODEL_LIMIT && <p className={styles.warning} role="status">已达到 {WORLD_MODEL_LIMIT} 个上限，可调整或移除现有模型。</p>}
        {draft && <form className={styles.editor} onSubmit={event => { event.preventDefault(); save(); }}>
          <div className={styles.sectionHeading}><h3>{draft.selectedId ? '调整' : '添加'} · {WORLD_MODEL_CATALOG[draft.model_id].label}</h3><span className={fits ? styles.valid : styles.invalid}>{fits ? '可放置' : roomId ? '超出房间' : '超出地块'}</span></div>
          <fieldset disabled={locked || !canEdit}>
            <div className={styles.coordinates}><label className={styles.field}>左右偏移（米）<input aria-label="模型左右偏移" type="number" step="0.1" value={round(draft.x * WORLD_METERS_PER_UNIT)} onChange={event => update({ x: round(Number(event.target.value) / WORLD_METERS_PER_UNIT) })} /></label>
              <label className={styles.field}>前后偏移（米）<input aria-label="模型前后偏移" type="number" step="0.1" value={round(draft.y * WORLD_METERS_PER_UNIT)} onChange={event => update({ y: round(Number(event.target.value) / WORLD_METERS_PER_UNIT) })} /></label></div>
            <label className={styles.field}>旋转 <output>{draft.rotation}°</output><input aria-label="模型旋转角度" type="range" min="0" max="359" step="1" value={draft.rotation} onChange={event => update({ rotation: Number(event.target.value) })} /></label>
            <div className={styles.quickActions}><button type="button" onClick={() => update({ rotation: (draft.rotation + 270) % 360 })}>↶ 转 90°</button><button type="button" onClick={() => update({ rotation: (draft.rotation + 90) % 360 })}>转 90° ↷</button><button type="button" onClick={() => update({ x: 0, y: 0 })}>居中</button></div>
            <label className={styles.field}>大小 <output>{Math.round(draft.scale * 100)}%</output><input aria-label="模型缩放" type="range" min={WORLD_MODEL_MIN_SCALE} max={WORLD_MODEL_MAX_SCALE} step="0.05" value={draft.scale} onChange={event => update({ scale: Number(event.target.value) })} /></label>
          </fieldset>
          {!fits && <p className={styles.warning}>请移动到地块内，或缩小、旋转模型。</p>}
          {roomHasContents && <p className={styles.hint}>房屋内还有物品，先切换到室内移除物品后才能删除房屋。</p>}
          {changedElsewhere && <p className={styles.warning}>此模型已在别处更新，请从下方列表重新选择后调整。</p>}
          <div className={styles.actions}><button type="button" className={styles.secondary} disabled={locked} onClick={() => change({ landId: selection.landId, roomId })}>取消预览</button>
            {draft.selectedId && <button type="button" className={styles.delete} disabled={locked || !canEdit || changedElsewhere || roomHasContents} onClick={remove}>移除模型</button>}
            <button type="submit" disabled={locked || !canEdit || !fits || full || changedElsewhere}>{command.pending ? '正在保存…' : '保存布置'}</button></div>
        </form>}
        <div className={styles.sectionHeading}><h3>已摆放模型</h3><span>{models.length} / {WORLD_MODEL_LIMIT}</span></div>
        {visiblePlacements.length ? <ul className={styles.placements}>{visiblePlacements.map(model => <li key={model.id}><button type="button" disabled={locked || !canEdit} aria-pressed={draft?.selectedId === model.id} onClick={() => selectPlacement(model)}>
          <span aria-hidden>{modelIcon(model.model_id)}</span><strong>{WORLD_MODEL_CATALOG[model.model_id].label}</strong><small>{model.rotation}° · {Math.round(model.scale * 100)}%</small><span>调整</span></button></li>)}</ul> : <p className={styles.hint}>地块不会自动建房。从上方选择房屋、花草或家具，自由布置。</p>}
        <p className={styles.hint}>房屋可进入并布置家具、游戏机；已购买的装饰库存仍在资产市场管理。</p>
      </>}
      {submitted && <CommandNotice command={command} />}
      {uncertain && submitted && <div className={styles.warning}><p>操作结果待确认，预览已锁定。重试会沿用同一请求，不会重复添加模型。</p><button type="button" disabled={command.pending || !connected} onClick={() => void run(submitted)}>重试原请求</button></div>}
      {!synchronized && <p className={styles.hint} role="status">已保存，正在等待小镇同步…</p>}
      {notice && synchronized && <p className={styles.saved} role="status">{notice}</p>}
    </div>
  </aside>;
}
