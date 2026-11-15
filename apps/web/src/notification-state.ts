import type { MessageNotificationDto } from '@agentzero/contracts';

export interface NotificationSettings {
  messages: boolean; tasks: boolean; badges: boolean; banners: boolean; sound: boolean; volume: number;
}
export interface UnreadNotification { cursor: string; category: 'messages' | 'tasks'; path: string }
export interface NotificationState {
  settings: NotificationSettings; cursor: string | null;
  read: Record<string, string>; unread: Record<string, UnreadNotification>;
}
export const latestMessageCursor = '9223372036854775807';
export const notificationStorageKey = (userId: string) => `agentzero:notifications:${userId}`;
export const notificationCategory = (message: MessageNotificationDto) => message.conversation_kind === 'task' ? 'tasks' : 'messages';
export const notificationPath = (message: MessageNotificationDto) => message.conversation_kind === 'task' ? `/tasks/${message.task_id}` : `/messages/${message.conversation_id}`;
export const defaultNotificationState = (): NotificationState => ({
  settings: { messages: true, tasks: true, badges: true, banners: true, sound: true, volume: 40 },
  cursor: null, read: {}, unread: {},
});

const validCursor = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= BigInt(latestMessageCursor);

export function parseNotificationState(value: string | null): NotificationState {
  const state = defaultNotificationState();
  if (!value) return state;
  try {
    const saved = JSON.parse(value) as NotificationState;
    for (const key of ['messages', 'tasks', 'badges', 'banners', 'sound'] as const) if (typeof saved.settings?.[key] === 'boolean') state.settings[key] = saved.settings[key];
    if (typeof saved.settings?.volume === 'number' && Number.isFinite(saved.settings.volume)) state.settings.volume = Math.max(0, Math.min(100, saved.settings.volume));
    if (validCursor(saved.cursor)) state.cursor = saved.cursor;
    state.read = Object.fromEntries(Object.entries(saved.read ?? {}).filter(([, cursor]) => validCursor(cursor)));
    state.unread = Object.fromEntries(Object.entries(saved.unread ?? {}).filter(([, item]) => item && validCursor(item.cursor) && ['messages', 'tasks'].includes(item.category) && /^\/(messages|tasks)\/[a-zA-Z0-9-]+$/.test(item.path)));
    return state;
  } catch { return defaultNotificationState(); }
}

export function receiveNotifications(state: NotificationState, messages: MessageNotificationDto[], userId: string) {
  const next = { ...state, unread: { ...state.unread } }, incoming: MessageNotificationDto[] = [];
  for (const message of messages) {
    if (BigInt(message.cursor) <= BigInt(next.cursor ?? '0')) continue;
    next.cursor = message.cursor;
    if (message.sender_owner_user_id === userId || BigInt(message.cursor) <= BigInt(state.read[message.conversation_id] ?? '0')) continue;
    next.unread[message.conversation_id] = { cursor: message.cursor, category: notificationCategory(message), path: notificationPath(message) };
    incoming.push(message);
  }
  return { state: next, incoming };
}

export function readNotification(state: NotificationState, conversationId: string, cursor: string): NotificationState {
  if (BigInt(cursor) <= BigInt(state.read[conversationId] ?? '0')) return state;
  const unread = { ...state.unread };
  if (unread[conversationId] && BigInt(unread[conversationId].cursor) <= BigInt(cursor)) delete unread[conversationId];
  return { ...state, read: { ...state.read, [conversationId]: cursor }, unread };
}
