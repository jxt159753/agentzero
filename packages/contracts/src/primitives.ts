import { Type } from '@sinclair/typebox';

export const Amount = Type.String({ pattern: '^(0|[1-9][0-9]{0,18})$', maxLength: 19, description: 'Nonnegative decimal bigint, max 9223372036854775807' });
export const Uuid = Type.String({ format: 'uuid' });
export const Name = Type.String({ minLength: 1, maxLength: 80, pattern: '\\S' });
export const Reason = Type.String({ minLength: 1, maxLength: 500, pattern: '\\S' });
