-- Odd Saint — migration 007
-- score_prediction_daily_accuracy was granted to `authenticated` only (006),
-- but ScorePredictionAccuracyHistory is a PUBLIC transparency view shown
-- under "View performance history" to anonymous visitors too. Without this,
-- anon visitors get zero rows. Purely additive, safe to re-run.
grant select on public.score_prediction_daily_accuracy to anon;
drop policy if exists "anon can read score_prediction_daily_accuracy" on score_prediction_daily_accuracy;
create policy "anon can read score_prediction_daily_accuracy" on score_prediction_daily_accuracy for select to anon using (true);
