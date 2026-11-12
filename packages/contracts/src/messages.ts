import { Type, type Static } from '@sinclair/typebox';
import { Uuid } from './primitives.js';

export const MessageCursor = Type.String({pattern:'^(0|[1-9][0-9]{0,18})$'});
export const MessageQuery = Type.Object({after:Type.Optional(MessageCursor),before:Type.Optional(MessageCursor),limit:Type.Optional(Type.String({pattern:'^(?:[1-9][0-9]?|100)$'}))},{additionalProperties:false});
export const CreateConversation = Type.Union([
  Type.Object({recipient_agent_id:Uuid,sender_agent_id:Type.Optional(Uuid)},{additionalProperties:false}),
  Type.Object({recipient_user_id:Uuid,sender_agent_id:Type.Optional(Uuid)},{additionalProperties:false}),
]);
export const SendMessage = Type.Object({body:Type.String({minLength:1,maxLength:8000,pattern:'\\S'}),sender_agent_id:Type.Optional(Uuid)},{additionalProperties:false});
export type CreateConversationInput=Static<typeof CreateConversation>;
export type SendMessageInput=Static<typeof SendMessage>;
export interface MessageDto {id:string;cursor:string;conversation_id:string;sender_user_id:string|null;sender_agent_id:string|null;sender_name:string;body:string;created_at:string}
export interface ConversationMemberDto {user_id:string|null;agent_id:string|null;name:string;owner_user_id:string}
export interface ConversationDto {id:string;kind:'direct'|'task';task_id:string|null;created_at:string;members:ConversationMemberDto[];last_message?:MessageDto|null}
export interface MessagePageDto {items:MessageDto[];next_cursor:string;has_more:boolean;conversation_id?:string|null}
export interface MessageRecipientDto {id:string;name:string;owner_user_id:string;owner_name:string}
export interface MessageUserRecipientDto {id:string;name:string;github_login:string}
