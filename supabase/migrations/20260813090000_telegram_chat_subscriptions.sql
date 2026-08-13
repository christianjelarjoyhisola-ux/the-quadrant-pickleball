create table if not exists public.telegram_chat_subscriptions (
  chat_id text primary key,
  chat_type text not null default 'private',
  title text,
  username text,
  first_name text,
  last_name text,
  is_active boolean not null default false,
  registered_at timestamptz,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists telegram_chat_subscriptions_active_idx
  on public.telegram_chat_subscriptions (is_active)
  where is_active = true;

alter table public.telegram_chat_subscriptions enable row level security;

-- No client policies are intentional. Telegram chat details are private and
-- may only be accessed by trusted Edge Functions through the service role.
revoke all on table public.telegram_chat_subscriptions from anon, authenticated;

