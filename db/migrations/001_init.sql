create extension if not exists pgcrypto;

create table if not exists qbo_connections (
  user_id text not null,
  realm_id text not null,
  display_name text,
  encrypted_tokens text not null,
  access_token_expires_at timestamptz not null,
  refresh_token_expires_at timestamptz,
  active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, realm_id)
);

create unique index if not exists qbo_one_active_company_per_user
  on qbo_connections (user_id) where active;

create table if not exists qbo_oauth_nonces (
  nonce text primary key,
  user_id text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists qbo_oauth_nonces_expiry
  on qbo_oauth_nonces (expires_at);

create table if not exists qbo_write_proposals (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  realm_id text not null,
  operation text not null check (operation in ('create', 'update', 'delete', 'void')),
  entity text not null,
  encrypted_payload text not null,
  status text not null default 'prepared'
    check (status in ('prepared', 'executing', 'executed', 'failed')),
  result_id text,
  error_code text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  executed_at timestamptz
);

create index if not exists qbo_write_proposals_lookup
  on qbo_write_proposals (user_id, id);
