import { describe, expect, it } from 'vitest';
import type { MessageNotificationDto } from '../../packages/contracts/src/messages.js';
import { defaultNotificationState, notificationStorageKey, parseNotificationState, readNotification, receiveNotifications } from '../../apps/web/src/notification-state.js';

const message = (cursor: string, owner = 'neighbor', conversation = 'chat-1'): MessageNotificationDto => ({
  id: `message-${cursor}`, cursor, conversation_id: conversation, conversation_kind: 'direct', task_id: null,
  sender_user_id: owner, sender_agent_id: null, sender_owner_user_id: owner, sender_name: '邻居', body: '你好', created_at: '2026-11-15T08:00:00Z',
});

describe('notification cursors and read state', () => {
  it('ignores repeated polls and own user/Agent messages, keeping incoming reminders when an own reply follows', () => {
    const state = { ...defaultNotificationState(), cursor: '10' };
    const ownAgent = { ...message('13', 'self'), sender_user_id: null, sender_agent_id: 'own-agent' };
    const received = receiveNotifications(state, [message('10'), message('11'), message('12', 'self'), ownAgent], 'self');
    expect(received.incoming.map(item => item.cursor)).toEqual(['11']);
    expect(received.state.unread['chat-1']?.cursor).toBe('11');
    expect(received.state.cursor).toBe('13');
    expect(receiveNotifications(received.state, [message('11'), ownAgent], 'self').incoming).toEqual([]);
  });
  it('reads only delivered cursors without clearing newer incoming messages or moving backwards', () => {
    const state = receiveNotifications(defaultNotificationState(), [message('9007199254740993'), message('9007199254740994')], 'self').state;
    const older = readNotification(state, 'chat-1', '9007199254740993');
    expect(older.unread['chat-1']?.cursor).toBe('9007199254740994');
    const read = readNotification(older, 'chat-1', '9007199254740994');
    expect(read.unread).toEqual({});
    expect(readNotification(read, 'chat-1', '10')).toBe(read);
    expect(receiveNotifications({ ...read, cursor: '0' }, [message('9007199254740993')], 'self').incoming).toEqual([]);
  });
  it('routes task discussions separately and continues tracking unread while a category is muted', () => {
    const state = defaultNotificationState(); state.settings.tasks = false;
    const received = receiveNotifications(state, [{ ...message('1', 'neighbor', 'task-chat'), conversation_kind: 'task', task_id: 'task-123' }], 'self');
    expect(received.state.unread['task-chat']).toEqual({ cursor: '1', category: 'tasks', path: '/tasks/task-123' });
    expect(received.state.settings.tasks).toBe(false);
  });
  it('restores preferences and unread cursors per account without storing message text', () => {
    const state = receiveNotifications(defaultNotificationState(), [message('1')], 'self').state;
    state.settings.sound = false;
    expect(parseNotificationState(JSON.stringify(state))).toEqual(state);
    expect(JSON.stringify(state)).not.toContain('你好');
    expect(notificationStorageKey('self')).not.toBe(notificationStorageKey('neighbor'));
    for (const value of ['broken', 'null', '{"cursor":"NaN","unread":{"x":{"cursor":"1","category":"messages","path":"https://example.com"}}}']) {
      const parsed = parseNotificationState(value);
      expect(parsed.cursor).toBeNull(); expect(parsed.unread).toEqual({});
    }
  });
});
