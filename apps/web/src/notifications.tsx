import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router-dom';
import type { MessageNotificationDto, MessageNotificationPageDto } from '@agentzero/contracts';
import { api } from './api';
import { defaultNotificationState, latestMessageCursor, notificationCategory, notificationPath, notificationStorageKey, parseNotificationState, readNotification, receiveNotifications, type NotificationSettings, type NotificationState } from './notification-state';
import shell from './shell.module.css';

interface Notifications {
  state: NotificationState; saved: boolean; error: boolean; retry: () => void;
  configure: (settings: Partial<NotificationSettings>) => void;
  markRead: (conversationId: string, cursor: string) => void; markAllRead: () => void;
  preview: () => void; audioStatus: 'waiting' | 'ready' | 'unavailable';
}
const NotificationContext = createContext<Notifications | null>(null);
export const useNotifications = () => useContext(NotificationContext);

function useNotificationSound(settings: NotificationSettings) {
  const context = useRef<AudioContext | null>(null), latest = useRef(settings); latest.current = settings;
  const [audioStatus, setAudioStatus] = useState<Notifications['audioStatus']>('waiting');
  const unlock = useCallback(async () => {
    try {
      if (!window.AudioContext) { setAudioStatus('unavailable'); return false; }
      context.current ??= new AudioContext();
      if (context.current.state === 'suspended') await context.current.resume();
      const ready = context.current.state === 'running';
      setAudioStatus(ready ? 'ready' : 'waiting'); return ready;
    } catch { setAudioStatus('unavailable'); return false; }
  }, []);
  const play = useCallback(() => {
    const audio = context.current;
    if (!audio || audio.state !== 'running') return;
    const volume = latest.current.volume / 100 * 0.18;
    for (const [index, frequency] of [660, 880].entries()) {
      const oscillator = audio.createOscillator(), gain = audio.createGain(), start = audio.currentTime + index * 0.13;
      oscillator.type = 'sine'; oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, start); gain.gain.linearRampToValueAtTime(volume, start + 0.015); gain.gain.linearRampToValueAtTime(0, start + 0.14);
      oscillator.connect(gain); gain.connect(audio.destination); oscillator.start(start); oscillator.stop(start + 0.15);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    }
  }, []);
  useEffect(() => {
    const gesture = () => { if (latest.current.sound) void unlock(); };
    window.addEventListener('pointerdown', gesture); window.addEventListener('keydown', gesture);
    return () => { window.removeEventListener('pointerdown', gesture); window.removeEventListener('keydown', gesture); const audio = context.current; context.current = null; if (audio) void audio.close(); };
  }, [unlock]);
  return { play, audioStatus, preview: () => { void unlock().then(ready => { if (ready) play(); }); } };
}

export function NotificationProvider({ userId, enabled, children }: { userId: string; enabled: boolean; children: ReactNode }) {
  const storageKey = notificationStorageKey(userId);
  const [state, setState] = useState(() => {
    try { return parseNotificationState(localStorage.getItem(storageKey)); } catch { return defaultNotificationState(); }
  });
  const current = useRef(state), location = useLocation(), client = useQueryClient();
  const [saved, setSaved] = useState(true), [toast, setToast] = useState<MessageNotificationDto | null>(null);
  const audio = useNotificationSound(state.settings);
  const commit = useCallback((next: NotificationState) => { current.current = next; setState(next); }, []);
  const markRead = useCallback((conversationId: string, cursor: string) => { commit(readNotification(current.current, conversationId, cursor)); }, [commit]);
  const feed = useQuery({
    queryKey: ['notification-messages', userId], enabled, staleTime: 0, refetchInterval: 5000, refetchIntervalInBackground: true,
    queryFn: async () => {
      let cursor = current.current.cursor;
      if (cursor === null) {
        const page = await api<MessageNotificationPageDto>(`/messages?before=${latestMessageCursor}&limit=1`);
        return { baseline: true, cursor: page.items.at(-1)?.cursor ?? '0', items: [] as MessageNotificationDto[] };
      }
      const items: MessageNotificationDto[] = [];
      let more: boolean;
      do {
        const page: MessageNotificationPageDto = await api<MessageNotificationPageDto>(`/messages?after=${cursor}&limit=100`);
        items.push(...page.items); cursor = page.next_cursor; more = page.has_more;
      } while (more);
      return { baseline: false, cursor, items };
    },
  });
  useEffect(() => {
    const result = feed.data;
    if (!result) return;
    if (result.baseline) { if (current.current.cursor === null) commit({ ...current.current, cursor: result.cursor }); return; }
    if (!result.items.length || BigInt(result.cursor) <= BigInt(current.current.cursor ?? '0')) return;
    const received = receiveNotifications(current.current, result.items, userId);
    commit(received.state);
    void client.invalidateQueries({ queryKey: ['conversations'] });
    const incoming = received.incoming.filter(message => current.current.settings[notificationCategory(message)] && (document.hidden || location.pathname !== notificationPath(message)));
    if (incoming.length) {
      if (current.current.settings.banners) setToast(incoming.at(-1)!);
      if (current.current.settings.sound) audio.play();
    }
  }, [feed.data, userId, commit, client, location.pathname, audio.play]);
  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(state)); setSaved(true); } catch { setSaved(false); }
  }, [state, storageKey]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 8000);
    return () => window.clearTimeout(timer);
  }, [toast]);
  useEffect(() => { setToast(null); }, [location.pathname]);
  const configure = (settings: Partial<NotificationSettings>) => { commit({ ...current.current, settings: { ...current.current.settings, ...settings } }); setToast(null); };
  const markAllRead = () => {
    let next = current.current;
    for (const [id, item] of Object.entries(next.unread)) next = readNotification(next, id, item.cursor);
    commit(next); setToast(null);
  };
  return <NotificationContext value={{ state, saved, error: feed.isError, retry: () => void feed.refetch(), configure, markRead, markAllRead, preview: audio.preview, audioStatus: audio.audioStatus }}>
    {children}
    <div className={shell.notificationHost} aria-live="polite" aria-atomic="true">
      {toast && state.settings.banners && <div className={shell.notificationToast}>
        <Link to={notificationPath(toast)} onClick={() => setToast(null)}><strong>{toast.conversation_kind === 'task' ? '任务讨论' : '新消息'} · {toast.sender_name}</strong><span>{toast.body}</span><small>点击查看</small></Link>
        <button aria-label="关闭通知" onClick={() => setToast(null)}>×</button>
      </div>}
    </div>
  </NotificationContext>;
}

export function NotificationBadge({ destination, conversationId }: { destination?: string; conversationId?: string }) {
  const notifications = useNotifications();
  if (!notifications?.state.settings.badges) return null;
  const { settings, unread } = notifications.state;
  const hasUnread = Object.entries(unread).some(([id, item]) => settings[item.category] && (conversationId ? id === conversationId : destination === `/${item.category}`));
  return hasUnread ? <i className={shell.notificationDot} role="img" aria-label="有未读提醒" /> : null;
}

export function NotificationSettingsPanel() {
  const notifications = useNotifications();
  if (!notifications) return null;
  const { state, configure, audioStatus } = notifications;
  return <fieldset className={shell.notificationSettings}><legend>提醒与通知</legend>
    {([['messages', '私聊与群聊'], ['tasks', '任务讨论'], ['badges', '未读红点'], ['banners', '横幅通知'], ['sound', '提示音']] as const).map(([key, label]) => <label key={key}><span>{label}</span><input type="checkbox" role="switch" checked={state.settings[key]} onChange={event => configure({ [key]: event.target.checked })} /></label>)}
    <label><span>提示音量</span><input aria-label="提示音量" type="range" min="0" max="100" value={state.settings.volume} disabled={!state.settings.sound} onChange={event => configure({ volume: Number(event.target.value) })} /><output>{state.settings.volume}%</output></label>
    <div className={shell.notificationActions}><button disabled={!state.settings.sound} onClick={notifications.preview}>试听提示音</button><button onClick={notifications.markAllRead}>全部标为已读</button></div>
    {state.settings.sound && audioStatus !== 'ready' && <p>{audioStatus === 'waiting' ? '点击页面后启用提示音。' : '当前浏览器暂不能播放提示音。'}</p>}
    <p>设置和已读状态仅保存在当前浏览器。首次使用后开始提醒新消息。</p>
    {!notifications.saved && <p role="status">浏览器未能保存设置，刷新后将恢复默认。</p>}
    {notifications.error && <p role="status">消息提醒暂时断开。<button onClick={notifications.retry}>重新连接提醒</button></p>}
  </fieldset>;
}
