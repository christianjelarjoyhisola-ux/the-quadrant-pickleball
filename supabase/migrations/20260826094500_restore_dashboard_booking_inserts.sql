-- Restore manual booking creation for authenticated dashboard operators.
-- The accumulated-remittance migration intentionally narrowed the public
-- insert policy to anonymous customer holds, but it also removed the previous
-- authenticated insert path used by Book for Customer.

begin;

alter table if exists public.bookings enable row level security;

drop policy if exists bookings_insert_dashboard_roles on public.bookings;
create policy bookings_insert_dashboard_roles
  on public.bookings
  for insert
  to authenticated
  with check (
    public.has_account_role(array['owner', 'court_owner', 'staff'])
    and coalesce(host_booking, false) = false
    and host_user_id is null
    and host_name is null
    and host_email is null
    and created_via in ('customer', 'admin')
    and (created_by_user_id is null or created_by_user_id = auth.uid())
    and (created_by_role is null or created_by_role = public.current_account_role())
    and (created_by_email is null or created_by_email = auth.jwt() ->> 'email')
  );

comment on policy bookings_insert_dashboard_roles on public.bookings is
  'Allows owner, court_owner, and staff dashboard accounts to create non-host customer bookings while preventing actor impersonation.';

notify pgrst, 'reload schema';

commit;
