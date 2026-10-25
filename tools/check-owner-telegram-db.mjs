import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
const db = new PGlite();
const owner = '10000000-0000-0000-0000-000000000001';
const other = '10000000-0000-0000-0000-000000000002';
const sql = (s, args=[]) => db.query(s,args);
const rows = async () => (await sql('select event,status,entity_key from owner_telegram_notifications order by created_at,id')).rows;
try {
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; grant usage on schema auth,public to anon,authenticated,service_role;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create table accounts(id uuid primary key references auth.users(id),role text);
    create function has_account_role(allowed text[]) returns boolean language sql stable security definer as $$
      select coalesce((select role=any(allowed) from accounts where id=auth.uid()),false) $$;
    create table bookings(ref text primary key,booking_group_ref text,full_name text,email text,status text,payment_status text,receipt_status text);
    create table open_play_registrations(id bigint generated always as identity primary key,full_name text,email text,payment_status text,receipt_status text);
    grant select,insert,update on bookings to anon,authenticated;
  `);
  for (const id of [owner,other]) {
    await sql('insert into auth.users values($1)',[id]);
    await sql("insert into accounts values($1,'court_owner')",[id]);
  }
  for (const file of ['20261017080000_owner_email_notifications.sql','20261025080000_owner_telegram_notifications.sql']) {
    await db.exec(readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
  }
  await sql("select set_config('request.jwt.claim.sub',$1,false)",[owner]);
  await db.exec('set role authenticated');
  await sql("insert into owner_telegram_preferences(user_id,chat_id,enabled) values($1,'123456789',true)",[owner]);
  await assert.rejects(sql("insert into owner_telegram_preferences(user_id,chat_id) values($1,'123')",[other]),e=>e.code==='42501');
  await assert.rejects(sql('select * from owner_telegram_notifications'),e=>e.code==='42501');
  await assert.rejects(sql('select * from claim_owner_telegram_notifications()'),e=>e.code==='42501');
  await assert.rejects(sql('update owner_telegram_preferences set last_test_at=null'),e=>e.code==='42501');
  await assert.rejects(sql("update owner_telegram_preferences set chat_id='invalid'"),e=>e.code==='23514');
  await assert.rejects(sql('update owner_telegram_preferences set notify_pending=false,notify_auto_confirmed=false'),e=>e.code==='23514');
  await assert.rejects(sql('update owner_email_preferences set enabled=true'),e=>e.code==='42501');
  // The source marker cannot be forged by a public client.
  await db.exec("insert into bookings values('FORGED',null,'Test','x@test','confirmed','paid','none','paymongo')");
  assert.equal((await sql("select automatic_confirmation_source from bookings where ref='FORGED'")).rows[0].automatic_confirmation_source,null);
  await db.exec('reset role');
  assert.equal((await rows()).length,0);
  const add = async (ref,status='pending',payment='unpaid',receipt='none',group=null,name='Test',source=null) => sql(
    'insert into bookings values($1,$2,$3,$4,$5,$6,$7,$8)',[ref,group,name,'x@test',status,payment,receipt,source]);
  await add('HOLD','pending','unpaid','none',null,'Reserving court');
  await add('VERIFY','verifying');
  assert.equal((await rows()).length,0,'No holds or in-progress verification alerts');
  await add('ONE');
  assert.deepEqual((await rows()).map(r=>r.event),['pending']);
  assert.equal((await sql('select available_at>now() from owner_telegram_notifications')).rows[0]['?column?'],true);
  await sql("update bookings set full_name='Updated' where ref='ONE'");
  assert.equal((await rows()).length,1,'Unrelated changes do not duplicate pending alerts');
  await sql("update bookings set status='confirmed',payment_status='paid' where ref='ONE'");
  assert.equal((await rows()).length,1,'Manual confirmation is not automatic');
  await sql("update bookings set receipt_status='auto_approved' where ref='ONE'");
  assert.deepEqual((await rows()).map(r=>r.event).sort(),['auto_confirmed','pending'],'Metadata pass produces separate confirmation');
  await sql("update bookings set receipt_status='auto_approved' where ref='ONE'");
  assert.equal((await rows()).length,2);
  await add('GROUP-A','pending','unpaid','none','GROUP');
  await add('GROUP-B','pending','unpaid','none','GROUP');
  assert.equal((await rows()).filter(r=>r.entity_key==='GROUP').length,1);
  await sql("update bookings set status='confirmed',payment_status='downpayment_paid',automatic_confirmation_source='paymongo' where booking_group_ref='GROUP'");
  assert.equal((await rows()).filter(r=>r.entity_key==='GROUP').length,2,'Grouped confirmation deduplicates without merging pending');
  await sql('update owner_telegram_preferences set notify_auto_confirmed=false');
  await add('DISABLED','confirmed','paid','auto_approved');
  assert.equal((await rows()).filter(r=>r.entity_key==='DISABLED').length,0);
  await sql('update owner_telegram_preferences set notify_auto_confirmed=true,notify_pending=false');
  await add('NO-PENDING');
  await sql("update bookings set status='confirmed',payment_status='paid',automatic_confirmation_source='paymongo' where ref='NO-PENDING'");
  assert.deepEqual((await rows()).filter(r=>r.entity_key==='NO-PENDING').map(r=>r.event),['auto_confirmed']);
  await sql("insert into open_play_registrations(full_name,email,payment_status,receipt_status) values('Player','x@test','paid','auto_approved')");
  assert.equal((await rows()).filter(r=>r.entity_key==='1')[0].event,'auto_confirmed');
  assert.equal((await sql('select count(*)::int n from owner_email_notifications')).rows[0].n,0,'No new email jobs');
  await sql("update owner_telegram_notifications set available_at=now()-interval '1 minute'");
  const claimed=(await sql('select * from claim_owner_telegram_notifications(3)')).rows;
  assert.equal(claimed.length,3);
  await sql("update owner_telegram_notifications set locked_until=now()-interval '1 minute',payload='{"+'"dispatch":"started"'+"}'::jsonb where id=$1",[claimed[0].id]);
  await sql('select * from claim_owner_telegram_notifications(3)');
  assert.equal((await sql('select status from owner_telegram_notifications where id=$1',[claimed[0].id])).rows[0].status,'failed','Never resend uncertain Telegram delivery after lease expiry');
  console.log('Telegram database checks passed: roles, private settings, switches, source guard, distinct events, grouped dedupe, verification, email retirement and lease recovery.');
} finally { await db.close(); }
