import { database } from './store';
import { deliverDue, discoverDeliveries, type DeliveryRow } from './planning-delivery';
import type { JobRow, PlanningEvent, PlanningMetadata } from './types';
export type { PlanningMetadata } from './types';

const currentIdea=`EXISTS(SELECT 1 FROM records i WHERE i.id=jobs.idea_id AND i.owner=jobs.owner AND i.kind='idea' AND i.revision=jobs.idea_revision)`;

/** Read-only, owner-scoped and safe to attach to any authenticated job DTO. */
export async function planningMetadata(job: JobRow, db: D1Database = database(), now=Date.now()): Promise<PlanningMetadata> {
  const {results}=await db.prepare('SELECT * FROM planning_deliveries WHERE job_id=? AND owner=? ORDER BY generation,id').bind(job.id,job.owner).all<DeliveryRow>();
  const idea=await db.prepare("SELECT revision FROM records WHERE id=? AND owner=? AND kind='idea'").bind(job.idea_id,job.owner).first<{revision:number}>();
  const current=idea?.revision===job.idea_revision;
  const targets=results.filter(t=>t.generation===job.generation);
  const expired=job.status==='planning' && (job.lease??0)<=now;
  const next=targets.flatMap(t=>t.status==='delivering' && t.delivery_lease!==null ? [t.delivery_lease] : t.next_attempt_at===null ? [] : [t.next_attempt_at]);
  const eligible=expired || (job.status==='queued' && (job.delivery==='failed' || (job.wake_deadline!==null && job.wake_deadline<=now)));
  return {status:!current?'superseded':expired?'expired':job.status,lease_expires:job.lease,retry_allowed:current && eligible && (job.retry_after??0)<=now,
    generation:job.generation,recoveries:job.recoveries,recovery_reason:job.recovery_reason,
    attempt_total:results.reduce((n,t)=>n+t.attempts,0),next_retry_at:next.length?Math.min(...next):null,
    wake_deadline:job.wake_deadline,retry_after:job.retry_after,delivery:job.delivery,
    targets:targets.map(t=>({id:t.id,subscription_id:t.subscription_id,status:t.status,attempts:t.attempts,last_http_status:t.last_http_status,reason:t.terminal_reason,next_retry_at:t.next_attempt_at}))};
}

async function transition(db:D1Database, job:JobRow, manual:boolean) {
  const now=Date.now();
  const expired=job.status==='planning' && (job.lease??0)<=now;
  const reason=expired?'claim_expired':'consumer_unclaimed';
  const predicate=manual
    ? `((status='planning' AND COALESCE(lease,0)<=?) OR (status='queued' AND (delivery='failed' OR wake_deadline<=?))) AND COALESCE(retry_after,0)<=?`
    : `((status='planning' AND COALESCE(lease,0)<=?) OR (status='queued' AND wake_deadline<=?))`;
  const guards=[now,now,...(manual?[now]:[])];
  if(!manual && job.recoveries>=3) {
    await db.prepare(`UPDATE jobs SET status='queued',claim_token=NULL,lease=NULL,wake_deadline=NULL,delivery='failed',recovery_reason='recovery_exhausted',updated_at=?
      WHERE id=? AND owner=? AND generation=? AND claim_token IS ? AND ${predicate} AND ${currentIdea}`)
      .bind(now,job.id,job.owner,job.generation,job.claim_token,...guards).run();
    return;
  }
  const event=JSON.parse(job.event) as PlanningEvent;
  event.eventId=`evt_${job.id}:g${job.generation+1}`;
  event.timestamp=new Date(now).toISOString();
  await db.prepare(`UPDATE jobs SET status='queued',claim_token=NULL,lease=NULL,wake_deadline=NULL,generation=generation+1,
    recoveries=?,retry_after=?,recovery_reason=?,event=?,delivery='pending',updated_at=?
    WHERE id=? AND owner=? AND generation=? AND claim_token IS ? AND ${predicate} AND ${currentIdea}`)
    .bind(manual?0:job.recoveries+1,manual?now+60000:job.retry_after,manual?'manual_retry':reason,JSON.stringify(event),now,
      job.id,job.owner,job.generation,job.claim_token,...guards).run();
}

/** Returns the unchanged active/pending/done job or one CAS-reset generation. Caller authenticates first. */
export async function retryPlanningJob(jobId:string, owner:string, db:D1Database=database()):Promise<JobRow|null> {
  const job=await db.prepare(`SELECT j.* FROM jobs j JOIN records i ON i.id=j.idea_id AND i.owner=j.owner WHERE j.id=? AND j.owner=? AND i.kind='idea' AND i.revision=j.idea_revision`).bind(jobId,owner).first<JobRow>();
  if(!job) return null;
  await transition(db,job,true);
  return db.prepare('SELECT * FROM jobs WHERE id=? AND owner=?').bind(jobId,owner).first<JobRow>();
}

export async function recoverPlanningJobs(db:D1Database=database()) {
  const now=Date.now();
  const {results}=await db.prepare(`SELECT * FROM jobs WHERE ((status='planning' AND COALESCE(lease,0)<=?) OR (status='queued' AND wake_deadline<=?))
    AND ${currentIdea} ORDER BY COALESCE(lease,wake_deadline),id LIMIT 50`).bind(now,now).all<JobRow>();
  for(const job of results) {
    if(job.recoveries>=3) { await transition(db,job,false); continue; }
    // A disconnected consumer cannot burn the recovery budget. Preserve one
    // fresh event for reconnect, after either the claim or accepted wake expires.
    const active=await db.prepare(`SELECT id FROM subscriptions WHERE owner=? AND expires>? AND
      (COALESCE(json_extract(body,'$.args.project'),'')='' OR json_extract(body,'$.args.project')=?) LIMIT 1`)
      .bind(job.owner,now,(JSON.parse(job.event) as PlanningEvent).data.project).first();
    if(!active) {
      const expired=job.status==='planning';
      const event=JSON.parse(job.event) as PlanningEvent;
      event.eventId=`evt_${job.id}:g${job.generation+1}`;
      event.timestamp=new Date(now).toISOString();
      await db.prepare(`UPDATE jobs SET status='queued',claim_token=NULL,lease=NULL,wake_deadline=NULL,delivery='no_subscription',recovery_reason=?,updated_at=?,generation=?,event=?
        WHERE id=? AND owner=? AND generation=? AND status=? AND claim_token IS ? AND COALESCE(lease,0)<=? AND ${currentIdea}`)
        .bind(expired?'claim_expired':'consumer_unclaimed',now,job.generation+1,JSON.stringify(event),job.id,job.owner,job.generation,job.status,job.claim_token,now).run();
    } else await transition(db,job,false);
  }
}

/** Backfill is bounded to 50 jobs; outbound acquisition is bounded to 20 targets. */
export async function deliverJob(jobId:string, owner:string) {
  const db=database();
  await discoverDeliveries(db,owner,jobId);
  await deliverDue(db,owner,jobId);
}
export async function backfillPlanning(owner:string, db:D1Database=database()) {
  await discoverDeliveries(db,owner);
  await deliverDue(db,owner);
}
export async function scheduledPlanning(db:D1Database=database()) {
  await recoverPlanningJobs(db);
  await discoverDeliveries(db);
  await deliverDue(db);
}
