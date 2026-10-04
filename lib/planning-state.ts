import type {
  RecordRow,
  RecordBody,
  JobRow,
  PlanningResult,
  VisibleJob,
} from "./types";
import { database } from "./store";
// Derive planning metadata from the authoritative revision-specific job. This
// repairs historical rows without editing raw idea text or bumping its revision.
export async function ideaWithPlanning(row: RecordRow, owner: string) {
  const body = JSON.parse(row.body) as RecordBody;
  const job = await database()
    .prepare(
      "SELECT status,delivery,result FROM jobs WHERE owner=? AND idea_id=? AND idea_revision=?",
    )
    .bind(owner, row.id, row.revision)
    .first<Pick<JobRow, "status" | "delivery" | "result">>();
  let planId = "",
    ticketIds: string[] = [];
  if (job?.status === "done" && job.result) {
    const r = JSON.parse(job.result) as PlanningResult;
    planId = r.plan_id || "";
    ticketIds = r.ticket_ids || [];
  }
  return {
    ...body,
    id: row.id,
    kind: row.kind,
    revision: row.revision,
    created: row.created,
    updated: row.updated,
    planningStatus: planId
      ? "planned"
      : job?.status === "planning"
        ? "planning"
        : job
          ? "queued"
          : "unplanned",
    planId,
    ticketIds,
    planningDelivery: job?.delivery || null,
  };
}
export async function visibleJobs(owner: string) {
  const { results } = await database()
    .prepare(
      "SELECT j.id,j.idea_id,j.idea_revision,j.status,j.delivery,j.created,j.result,i.revision AS current_revision FROM jobs j JOIN records i ON i.id=j.idea_id AND i.owner=j.owner WHERE j.owner=? ORDER BY j.created DESC LIMIT 100",
    )
    .bind(owner)
    .all<VisibleJob>();
  return results.map((r) => ({
    ...r,
    status: r.idea_revision !== r.current_revision ? "superseded" : r.status,
  }));
}
