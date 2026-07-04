alter table public.open_play_registrations
  add column if not exists email text,
  add column if not exists contact_number text;

