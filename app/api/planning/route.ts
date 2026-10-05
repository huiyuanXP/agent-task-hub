import { configuredOrigin } from '../../../lib/local-auth.mts';
import type { RecordRow, RecordBody, JobRow } from "../../../lib/types";
import { visibleJob, visibleJobs } from "../../../lib/planning-state";
import { getCurrentUser } from "../../../lib/current-user";
import { database } from "../../../lib/store";
import { deliverJob, EVENT } from "../../../lib/events";
import { retryPlanningJob } from "../../../lib/planning-recovery";
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "请登录" }, { status: 401 });
  try {
    const db = database();
    const results = await visibleJobs(user.userId);
    const count = await db
      .prepare(
        "SELECT count(*) as total FROM subscriptions WHERE owner=? AND expires>?",
      )
      .bind(user.userId, Date.now())
      .first<{ total: number }>();
    return Response.json(
      { jobs: results, subscriptions: count?.total || 0 },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    console.error(e);
    return Response.json(
      { error: "暂时无法读取自动规划状态" },
      { status: 503 },
    );
  }
}
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "请登录" }, { status: 401 });
  if (req.headers.get("origin") !== configuredOrigin())
    return Response.json({ error: "请求来源无效" }, { status: 403 });
  try {
    let input: unknown;
    try { input = await req.json(); }
    catch { return Response.json({ error: "无效的规划请求" }, { status: 400 }); }
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).some(key => key !== "ideaId") ||
        !("ideaId" in input) || typeof input.ideaId !== "string" ||
        !input.ideaId.trim() || input.ideaId.length > 256)
      return Response.json({ error: "无效的点子 ID" }, { status: 400 });
    const { ideaId } = input;
    const db = database();
    const idea = await db
      .prepare("SELECT * FROM records WHERE id=? AND owner=? AND kind=?")
      .bind(ideaId, user.userId, "idea")
      .first<RecordRow>();
    if (!idea) return Response.json({ error: "点子不存在" }, { status: 404 });
    const id = `planning:${idea.id}:${idea.revision}`;
    const body = JSON.parse(idea.body) as RecordBody,
      now = new Date().toISOString();
    const event = {
      eventId: "evt_" + id,
      name: EVENT,
      timestamp: now,
      data: {
        idea_id: idea.id,
        idea_revision: idea.revision,
        job_id: id,
        project: body.project || "通用",
      },
      cursor: null,
    };
    await db
      .prepare(
        "INSERT OR IGNORE INTO jobs (id,owner,idea_id,idea_revision,status,event,delivery,created) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM records WHERE id=? AND owner=? AND kind='idea' AND revision=?)",
      )
      .bind(
        id,
        user.userId,
        idea.id,
        idea.revision,
        "queued",
        JSON.stringify(event),
        "pending",
        now,
        idea.id,
        user.userId,
        idea.revision,
      )
      .run();
    const current = await retryPlanningJob(id, user.userId, db);
    if (!current) return Response.json({ error: "点子版本已更新，请刷新后重试" }, { status: 409 });
    await deliverJob(id, user.userId);
    const job = await db
      .prepare("SELECT j.*,i.revision AS current_revision FROM jobs j JOIN records i ON i.id=j.idea_id AND i.owner=j.owner AND i.kind='idea' WHERE j.id=? AND j.owner=?")
      .bind(id, user.userId)
      .first<JobRow & { current_revision: number }>();
    if (!job) throw Error("Planning job unavailable");
    return Response.json({ job: await visibleJob(job, job.current_revision) },
      { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error(e);
    return Response.json(
      { error: "请求失败，点子仍然保留，请重试" },
      { status: 503 },
    );
  }
}
