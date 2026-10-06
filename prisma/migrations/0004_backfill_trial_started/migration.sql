-- Businesses created before Part 2 have a trial end date but no recorded start. The trial is 14 days
-- long by definition, so the start is exactly the end minus the trial length used at the time.
-- (Idempotent: only rows with no start recorded are touched.)
UPDATE "subscriptions"
SET trial_started_at = trial_ends_at - interval '14 days'
WHERE trial_started_at IS NULL AND trial_ends_at IS NOT NULL;

-- A business that already paid before Part 2 counts as converted, so trial phase reads "converted".
UPDATE "subscriptions"
SET converted_at = COALESCE(current_period_start, created_at)
WHERE converted_at IS NULL AND status IN ('ACTIVE', 'PAST_DUE', 'GRACE_PERIOD', 'CANCELED') AND trial_ends_at IS NULL;
