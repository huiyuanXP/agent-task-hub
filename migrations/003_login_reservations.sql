-- A new generation separates reset/expired windows from in-flight checks.
ALTER TABLE login_throttle ADD COLUMN generation TEXT NOT NULL DEFAULT '';
