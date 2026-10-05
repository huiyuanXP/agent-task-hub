import type {
  RecordRow,
  RecordBody,
  JobRow,
  PlanningResult,
  VisibleJob,
} from "./types";
import { database } from "./store";
import { planningMetadata } from "./planning-recovery.mts";

/** Public whitelist: internal job/event/claim storage must never cross a read API. */
export async function visibleJob(
  job: JobRow,
  currentRevision: number,
): Promise<VisibleJob> {
  return {
    id: job.id,
    idea_id: job.idea_id,
    idea_revision: job.idea_revision,
    created: job.created,
    result: job.result,
    current_revision: currentRevision,
    ...(await planningMetadata(job)),
  };
}

// Derive current planning state without editing Idea text or bumping its revision.
export async function ideaWithPlanning(row: RecordRow, owner: string) {
  const body = JSON.parse(row.body) as RecordBody;
  const job = await database()
    .prepare("SELECT * FROM jobs WHERE owner=? AND idea_id=? AND idea_revision=?")
    .bind(owner, row.id, row.revision)
    .first<JobRow>();
  const planning = job ? await planningMetadata(job) : null;
  let planId = "",
    ticketIds: string[] = [];
  if (job?.status === "done" && job.result) {
    const result = JSON.parse(job.result) as PlanningResult;
    planId = result.plan_id || "";
    ticketIds = result.ticket_ids || [];
  }
  return {
    ...body,
    id: row.id,
    kind: row.kind,
    revision: row.revision,
    created: row.created,
    updated: row.updated,
    planningStatus: planId ? "planned" : planning?.status || "unplanned",
    planId,
    ticketIds,
    planningDelivery: planning?.delivery || null,
    planning,
  };
}
export async function visibleJobs(owner: string) {
  const { results } = await database()
    .prepare("SELECT j.*,i.revision AS current_revision FROM jobs j JOIN records i ON i.id=j.idea_id AND i.owner=j.owner AND i.kind='idea' WHERE j.owner=? ORDER BY j.created DESC LIMIT 100")
    .bind(owner)
    .all<JobRow & { current_revision: number }>();
  return Promise.all(results.map(job => visibleJob(job, job.current_revision)));
}
