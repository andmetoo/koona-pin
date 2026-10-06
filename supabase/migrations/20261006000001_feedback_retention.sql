-- Retention of feedback (NP-088): a separate migration, the only part that needs
-- pg_cron; the tables and the function are tested without it (supabase/feedback.sql.test.ts).

-- Retention: feedback for 12 months, address hashes for a day.
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule(
  'feedback-retention',
  '17 3 * * *',
  $$
    delete from public.feedback where created_at < now() - interval '12 months';
    delete from public.feedback_hits where at < now() - interval '1 day';
  $$
);
