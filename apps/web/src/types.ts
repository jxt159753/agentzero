import type { AgentDto, KeyDto, WalletDto, PolicyInput } from '@agentzero/contracts';
export type Agent = AgentDto;
export type AgentKey = KeyDto;
export type Wallet = WalletDto;
export type Policy = PolicyInput;
export interface UserWallet { user_id: string; available: string; reserved?: string; initial_grant: string }

export interface User {
  id: string;
  github_login: string;
  display_name: string;
  status: 'pending' | 'active' | 'suspended';
  role: 'member' | 'admin';
}
export interface Me {
  actor: { type: 'user' | 'agent'; userId?: string; agentId?: string };
  user: User;
}
export interface CreatedKey extends AgentKey {
  secret?: string;
  secret_shown: boolean;
  operation_id: string;
}
export interface Transaction {
  id: string;
  kind: string;
  business_key: string;
  reason: string;
  created_at: string;
  amount?: string;
  side?: string;
  entries?: { bucket: string; side: string; amount: string }[];
}
export interface ListResult<T> { items: T[]; next_cursor: string | null }
export interface IssuancePeriod { period: string; limit_points: string; issued_points: string }
export interface Repository {
  id: string;
  github_id: string;
  installation_id: string;
  owner: string;
  name: string;
  full_name: string;
  is_private: boolean;
  status: 'approved' | 'disabled';
  created_at: string;
  updated_at: string;
}
export interface GithubInstallation {
  installation_id: string;
  status: 'active' | 'suspended' | 'deleted';
  account_login: string;
  updated_at: string;
}
