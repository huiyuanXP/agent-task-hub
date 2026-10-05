import { CallbackError, signedPost } from './event-transport';
import type { JobRow, PlanningEvent, Subscription } from './types';

export interface DeliveryRow {
  id: string; owner: string; job_id: string; subscription_id: string; generation: number;
  event_id: string; status: string; attempts: number; next_attempt_at: number | null;
  delivery_token: string | null; delivery_lease: number | null; last_http_status: number | null;
  terminal_reason: string | null;
}
// These predicates are reused by acquisition and result CAS. A planning claim
// always suppresses callbacks, including an expired claim awaiting recovery.
const currentQueued = `EXISTS(SELECT 1 FROM jobs j JOIN records i ON i.id=j.idea_id AND i.owner=j.owner
 WHERE j.id=planning_deliveries.job_id AND j.owner=planning_deliveries.owner AND j.generation=planning_deliveries.generation
 AND j.status='queued' AND COALESCE(j.recovery_reason,'')<>'recovery_exhausted' AND i.kind='idea' AND i.revision=j.idea_revision)`;
const activeTarget = `EXISTS(SELECT 1 FROM subscriptions s JOIN jobs j ON j.id=planning_deliveries.job_id AND j.owner=planning_deliveries.owner
 WHERE s.id=planning_deliveries.subscription_id AND s.owner=planning_deliveries.owner AND s.expires>?
 AND (COALESCE(json_extract(s.body,'$.args.project'),'')='' OR json_extract(s.body,'$.args.project')=json_extract(j.event,'$.data.project')))`;

export async function discoverDeliveries(db: D1Database, owner?: string, jobId?: string) {
  const now = Date.now();
  const { results } = await db.prepare(`SELECT j.* FROM jobs j JOIN records i ON i.id=j.idea_id AND i.owner=j.owner
    WHERE j.status='queued' AND COALESCE(j.recovery_reason,'')<>'recovery_exhausted' AND i.kind='idea' AND i.revision=j.idea_revision
    ${owner ? 'AND j.owner=?' : ''} ${jobId ? 'AND j.id=?' : ''} ORDER BY j.updated_at,j.id LIMIT 50`)
    .bind(...(owner ? [owner] : []), ...(jobId ? [jobId] : [])).all<JobRow>();
  for (const job of results) {
    await db.batch([
      db.prepare(`INSERT OR IGNORE INTO planning_deliveries(id,owner,job_id,subscription_id,generation,event_id,status,next_attempt_at,created_at,updated_at)
        SELECT j.id || ':' || s.id || ':' || j.generation,j.owner,j.id,s.id,j.generation,json_extract(j.event,'$.eventId'),'pending',?,?,?
        FROM jobs j JOIN records i ON i.id=j.idea_id AND i.owner=j.owner JOIN subscriptions s ON s.owner=j.owner
        WHERE j.id=? AND j.owner=? AND j.status='queued' AND COALESCE(j.recovery_reason,'')<>'recovery_exhausted' AND j.generation=? AND i.revision=j.idea_revision AND s.expires>?
        AND (COALESCE(json_extract(s.body,'$.args.project'),'')='' OR json_extract(s.body,'$.args.project')=json_extract(j.event,'$.data.project'))`)
        .bind(now,now,now,job.id,job.owner,job.generation,now),
      db.prepare(`UPDATE planning_deliveries SET status='pending',terminal_reason=NULL,next_attempt_at=?,updated_at=?
        WHERE job_id=? AND owner=? AND generation=? AND terminal_reason='subscription_inactive' AND ${currentQueued} AND ${activeTarget}`)
        .bind(now,now,job.id,job.owner,job.generation,now),
      db.prepare('UPDATE jobs SET updated_at=? WHERE id=? AND owner=? AND generation=?').bind(now,job.id,job.owner,job.generation),
    ]);
    await refreshDeliverySummary(db, job.id, job.owner);
  }
}

export async function refreshDeliverySummary(db: D1Database, jobId: string, owner: string) {
  // Compute inside a single statement so an old delivery cannot overwrite a new generation's summary.
  await db.prepare(`UPDATE jobs SET delivery=CASE
    WHEN recovery_reason='recovery_exhausted' THEN 'failed'
    WHEN NOT EXISTS(SELECT 1 FROM planning_deliveries d WHERE d.job_id=jobs.id AND d.owner=jobs.owner AND d.generation=jobs.generation AND COALESCE(d.terminal_reason,'')<>'subscription_inactive') THEN 'no_subscription'
    WHEN NOT EXISTS(SELECT 1 FROM planning_deliveries d WHERE d.job_id=jobs.id AND d.owner=jobs.owner AND d.generation=jobs.generation AND d.status<>'accepted') THEN 'accepted'
    WHEN EXISTS(SELECT 1 FROM planning_deliveries d WHERE d.job_id=jobs.id AND d.owner=jobs.owner AND d.generation=jobs.generation AND d.status='accepted') THEN 'partial'
    WHEN EXISTS(SELECT 1 FROM planning_deliveries d WHERE d.job_id=jobs.id AND d.owner=jobs.owner AND d.generation=jobs.generation AND d.status IN ('retrying','delivering') AND d.attempts>0) THEN 'retrying'
    WHEN EXISTS(SELECT 1 FROM planning_deliveries d WHERE d.job_id=jobs.id AND d.owner=jobs.owner AND d.generation=jobs.generation AND d.status='pending') THEN 'pending'
    ELSE 'failed' END WHERE id=? AND owner=? AND status='queued'`).bind(jobId,owner).run();
}

export async function deliverDue(db: D1Database, owner?: string, jobId?: string) {
  const now=Date.now();
  // One shared cleanup budget covers both reasons. Stopped rows leave the
  // candidate set, so the next tick continues in updated_at/id order. Delivery
  // guards remain authoritative even when cleanup leaves a dormant backlog.
  const { results: invalidated } = await db.prepare(`
    UPDATE planning_deliveries SET status='stopped',
      terminal_reason=CASE WHEN NOT (${currentQueued}) THEN 'job_inactive' ELSE 'subscription_inactive' END,
      delivery_token=NULL,delivery_lease=NULL,next_attempt_at=NULL,updated_at=?
    WHERE id IN (
      SELECT id FROM planning_deliveries
      WHERE status IN ('pending','retrying','delivering')
        AND (NOT (${currentQueued}) OR NOT (${activeTarget}))
        ${owner ? 'AND owner=?' : ''} ${jobId ? 'AND job_id=?' : ''}
      ORDER BY updated_at,id LIMIT 50
    ) RETURNING job_id,owner`)
    .bind(now, now, ...(owner ? [owner] : []), ...(jobId ? [jobId] : []))
    .all<{ job_id: string; owner: string }>();
  const changedJobs = new Map(invalidated.map(row => [row.job_id, row.owner]));
  for (const [id, jobOwner] of changedJobs) {
    await refreshDeliverySummary(db, id, jobOwner);
  }
  const {results}=await db.prepare(`SELECT * FROM planning_deliveries WHERE ((status IN ('pending','retrying') AND next_attempt_at<=?) OR (status='delivering' AND delivery_lease<=?))
    ${owner ? 'AND owner=?' : ''} ${jobId ? 'AND job_id=?' : ''} ORDER BY CASE WHEN status='delivering' THEN delivery_lease ELSE next_attempt_at END,id LIMIT 20`)
    .bind(now,now,...(owner ? [owner] : []),...(jobId ? [jobId] : [])).all<DeliveryRow>();
  await Promise.all(results.map(row=>attemptDelivery(db,row)));
}

async function attemptDelivery(db: D1Database, row: DeliveryRow) {
  const now=Date.now(), token=crypto.randomUUID();
  if(row.attempts>=5) {
    await db.prepare(`UPDATE planning_deliveries SET status='failed',terminal_reason='attempts_exhausted',delivery_token=NULL,delivery_lease=NULL,next_attempt_at=NULL,updated_at=? WHERE id=? AND ((status='delivering' AND delivery_lease<=?) OR (status IN ('pending','retrying') AND next_attempt_at<=?)) AND attempts>=5 AND ${currentQueued} AND ${activeTarget}`)
      .bind(now,row.id,now,now,now).run();
    await refreshDeliverySummary(db,row.job_id,row.owner); return;
  }
  const claimed=await db.prepare(`UPDATE planning_deliveries SET status='delivering',attempts=attempts+1,delivery_token=?,delivery_lease=?,updated_at=?
    WHERE id=? AND attempts<5 AND ((status IN ('pending','retrying') AND next_attempt_at<=?) OR (status='delivering' AND delivery_lease<=?)) AND ${currentQueued} AND ${activeTarget}`)
    .bind(token,now+30000,now,row.id,now,now,now).run();
  if(!claimed.meta.changes) return;
  const context=await db.prepare(`SELECT j.event,s.body,d.attempts FROM planning_deliveries d JOIN jobs j ON j.id=d.job_id AND j.owner=d.owner
    JOIN records i ON i.id=j.idea_id AND i.owner=j.owner JOIN subscriptions s ON s.id=d.subscription_id AND s.owner=d.owner
    WHERE d.id=? AND d.delivery_token=? AND j.generation=d.generation AND j.status='queued' AND COALESCE(j.recovery_reason,'')<>'recovery_exhausted' AND i.revision=j.idea_revision AND s.expires>?
    AND (COALESCE(json_extract(s.body,'$.args.project'),'')='' OR json_extract(s.body,'$.args.project')=json_extract(j.event,'$.data.project'))`)
    .bind(row.id,token,Date.now()).first<{event:string;body:string;attempts:number}>();
  if(!context) return; // Acquired token will be invalidated by the next sweep.
  let status='failed', reason:string|null=null, http:number|null=null;
  try {
    const response=await signedPost(JSON.parse(context.body) as Subscription,JSON.parse(context.event) as PlanningEvent,row.event_id);
    http=response.status;
    if(response.ok) status='accepted';
    else if(http===410) reason='subscription_gone';
    else if(http===429 || http>=500) {status='retrying'; reason='temporary_http';}
    else reason='permanent_http';
    await response.body?.cancel();
  } catch(error) {
    if(error instanceof CallbackError) {reason=error.reason; http=error.status;}
    else {status='retrying';reason='network_or_timeout';}
  }
  // The selected row may predate a competing completed attempt. This count was
  // read under our acquired token, after the atomic increment.
  const completedAt=Date.now(), attempts=context.attempts;
  if(status==='retrying' && attempts>=5) {status='failed';reason='attempts_exhausted';}
  const next=status==='retrying' ? completedAt+30000*2**(attempts-1) : null;
  // Token + generation + current revision guards also protect accepted wake deadlines.
  await db.batch([
    db.prepare(`UPDATE jobs SET wake_deadline=COALESCE(wake_deadline,?) WHERE id=? AND owner=? AND generation=? AND status='queued'
      AND ?='accepted' AND EXISTS(SELECT 1 FROM planning_deliveries WHERE id=? AND delivery_token=? AND ${currentQueued})`)
      .bind(completedAt+300000,row.job_id,row.owner,row.generation,status,row.id,token),
    db.prepare(`DELETE FROM subscriptions WHERE id=? AND owner=? AND body=? AND ?=410 AND EXISTS(SELECT 1 FROM planning_deliveries WHERE id=? AND delivery_token=? AND ${currentQueued})`)
      .bind(row.subscription_id,row.owner,context.body,http,row.id,token),
    db.prepare(`UPDATE planning_deliveries SET status=?,terminal_reason=?,last_http_status=?,next_attempt_at=?,delivery_token=NULL,delivery_lease=NULL,updated_at=?
      WHERE id=? AND delivery_token=? AND ${currentQueued}`)
      .bind(status,reason,http,next,completedAt,row.id,token),
  ]);
  await refreshDeliverySummary(db,row.job_id,row.owner);
}
