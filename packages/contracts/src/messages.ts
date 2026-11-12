import { Type, type Static } from '@sinclair/typebox';
import { Uuid } from './primitives.js';

export const MessageCursor = Type.String({pattern:'^(0|[1-9][0-9]{0,18})$'});
export const MessageQuery = Type.Object({after:Type.Optional(MessageCursor),limit:Type.Optional(Type.String({pattern:'^(?:[1-9][0-9]?|100)$'}))},{additionalProperties:false});
export const CreateConversation = Type.Union([
  Type.Object({recipient_agent_id:Uuid,sender_agent_id:Type.Optional(Uuid)},{additionalProperties:false}),
  Type.Object({recipient_user_id:Uuid,sender_agent_id:Type.Optional(Uuid)},{additionalProperties:false}),
]);
export const GroupTitle = Type.String({minLength:1,maxLength:80,pattern:'\\S'});
export const GroupRole = Type.Union([Type.Literal('admin'),Type.Literal('member')]);
// Agents and visitors are invited by ID; duplicates and existing members are ignored server-side.
const groupMemberFields = {
  member_agent_ids: Type.Optional(Type.Array(Uuid,{maxItems:49})),
  member_user_ids: Type.Optional(Type.Array(Uuid,{maxItems:49})),
};
export const CreateGroupConversation = Type.Object({title:GroupTitle,...groupMemberFields,sender_agent_id:Type.Optional(Uuid)},{additionalProperties:false});
export const AddGroupMembers = Type.Object({...groupMemberFields,sender_agent_id:Type.Optional(Uuid)},{additionalProperties:false,minProperties:1});
export const RenameGroupConversation = Type.Object({title:GroupTitle,sender_agent_id:Type.Optional(Uuid)},{additionalProperties:false});
export const SetGroupMemberRole = Type.Object({role:GroupRole,sender_agent_id:Type.Optional(Uuid)},{additionalProperties:false});
export const GroupMemberCommand = Type.Object({sender_agent_id:Type.Optional(Uuid)},{additionalProperties:false});
export const GroupMemberParams = Type.Object({id:Uuid,memberId:Uuid});
export const SendMessage = Type.Object({body:Type.String({minLength:1,maxLength:8000,pattern:'\\S'}),sender_agent_id:Type.Optional(Uuid)},{additionalProperties:false});
export type CreateConversationInput=Static<typeof CreateConversation>;
export type SendMessageInput=Static<typeof SendMessage>;
export type CreateGroupConversationInput=Static<typeof CreateGroupConversation>;
export type AddGroupMembersInput=Static<typeof AddGroupMembers>;
export type RenameGroupConversationInput=Static<typeof RenameGroupConversation>;
export type SetGroupMemberRoleInput=Static<typeof SetGroupMemberRole>;
export type GroupMemberRole=Static<typeof GroupRole>;
export type GroupMemberCommandInput=Static<typeof GroupMemberCommand>;
export interface MessageDto {id:string;cursor:string;conversation_id:string;sender_user_id:string|null;sender_agent_id:string|null;sender_name:string;body:string;created_at:string}
export interface ConversationMemberDto {id:string;user_id:string|null;agent_id:string|null;name:string;owner_user_id:string;role:'owner'|'admin'|'member'}
export interface ConversationDto {id:string;kind:'direct'|'group'|'task';task_id:string|null;title:string|null;created_at:string;members:ConversationMemberDto[]}
export interface MessagePageDto {items:MessageDto[];next_cursor:string;has_more:boolean;conversation_id?:string|null}
export interface MessageRecipientDto {id:string;name:string;owner_user_id:string;owner_name:string}
export interface MessageUserRecipientDto {id:string;name:string;github_login:string}
