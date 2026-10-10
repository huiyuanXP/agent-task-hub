import { scheduledPlanning } from '../lib/planning-recovery.mts';

export function planningInterval(value = process.env.APP_SCHEDULER_INTERVAL_MS) {
  const interval = value === undefined ? 60000 : Number(value);
  if (value === '' || !Number.isInteger(interval) || interval < 0 || interval > 2147483647) {
    throw Error('APP_SCHEDULER_INTERVAL_MS must be 0 (disabled) or a positive integer up to 2147483647');
  }
  return interval;
}

// Started only by the server after HTTP readiness. Database lease/CAS guards
// remain authoritative when another process maintains the same SQLite file.
export function startPlanningScheduler(db, interval = planningInterval()) {
  let stopped = false;
  let active;
  const tick = () => {
    if (stopped || active) return;
    active = scheduledPlanning(db)
      .catch(error => console.error('Planning maintenance failed:', error))
      .finally(() => { active = undefined; });
  };
  const timer = interval === 0 ? undefined : setInterval(tick, interval);
  timer?.unref();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await active;
    },
  };
}
