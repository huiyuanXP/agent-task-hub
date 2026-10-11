import { configuredOrigin } from '../../../lib/local-auth.mts';
import type { RecordRow, RecordBody, RecordDraft } from "../../../lib/types";
import { ideaWithPlanning } from "../../../lib/planning-state";
import { deliverJob, EVENT } from "../../../lib/events";
import { getCurrentUser } from "../../../lib/current-user";
import { database } from "../../../lib/store";
import { listProjects } from "../../../lib/projects/catalog.mts";
import { ticketStatusWriteGuard } from "../../../lib/tickets/record-write.mts";
const kinds = ["idea", "plan", "ticket", "run"];
const states = ["todo", "running", "waiting", "done", "error"];
export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user)
      return Response.json({ error: "请重新登录后重试" }, { status: 401 });
    const { results } = await database()
      .prepare("SELECT * FROM records WHERE owner = ? ORDER BY created DESC")
      .bind(user.userId)
      .all<RecordRow>();
    return Response.json(
      {
        projects: await listProjects(database(), user.userId),
        records: await Promise.all(
          results.map((r) =>
            r.kind === "idea"
              ? ideaWithPlanning(r, user.userId)
              : {
                  ...(JSON.parse(r.body) as RecordBody),
                  ...(r.kind === "run" ? { source: "manual" } : {}),
                  id: r.id,
                  kind: r.kind,
                  revision: r.revision,
                  created: r.created,
                  updated: r.updated,
                },
          ),
        ),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    console.error(e);
    return Response.json(
      { error: "暂时无法读取本地数据，请重试" },
      { status: 503 },
    );
  }
}
export async function POST(req: Request) {
  try {
    const user = await getCurrentUser();
    if (!user)
      return Response.json({ error: "请重新登录后重试" }, { status: 401 });
    const origin = req.headers.get("origin");
    if (origin !== configuredOrigin())
      return Response.json({ error: "请求来源无效" }, { status: 403 });
    const payload = (await req.json()) as RecordDraft;
    const { id, kind, revision, ...body } = payload;
    if (
      !kinds.includes(kind) ||
      typeof body.title !== "string" ||
      !body.title.trim() ||
      body.title.length > 250 ||
      JSON.stringify(body).length > 80000
    )
      return Response.json(
        { error: "请填写标题（最多 250 字），并缩短过长的内容" },
        { status: 400 },
      );
    if (
      kind === "idea" &&
      body.project !== undefined &&
      (typeof body.project !== "string" || body.project.length > 120)
    )
      return Response.json(
        { error: "项目名称须为文字（最多 120 字）" },
        { status: 400 },
      );
    if (kind === "ticket" && !states.includes(body.status || ""))
      return Response.json({ error: "无效的 Ticket 状态" }, { status: 400 });
    if (
      kind === "ticket" &&
      body.status === "waiting" &&
      !["clarification", "approval", "review", "external", "recovery"].includes(
        body.waitingReason || "",
      )
    )
      return Response.json({ error: "请填写等待原因" }, { status: 400 });
    if (kind === "ticket" && body.status === "done" && !body.evidence?.trim())
      return Response.json(
        { error: "完成 Ticket 前请填写验收证据" },
        { status: 400 },
      );
    const db = database();
    const now = new Date().toISOString();
    if (id) {
      if (typeof revision !== "number" || !Number.isInteger(revision))
        return Response.json(
          { error: "缺少修订版本，请刷新" },
          { status: 400 },
        );
      const old = await db
        .prepare(
          "SELECT kind,body,revision FROM records WHERE id=? AND owner=?",
        )
        .bind(id, user.userId)
        .first<Pick<RecordRow, "kind" | "body" | "revision">>();
      if (!old || old.kind !== kind)
        return Response.json({ error: "记录不存在" }, { status: 404 });
      if (kind === "run")
        return Response.json(
          { error: "执行快照不可修改，请追加新记录" },
          { status: 400 },
        );
      if (old.revision !== revision)
        return Response.json(
          { error: "另一处已修改此记录。请刷新并重新打开，避免覆盖新内容" },
          { status: 409 },
        );
      const statusChanged = kind === "ticket" && (JSON.parse(old.body) as RecordBody).status !== body.status;
      const statusGuard = statusChanged ? " AND " + ticketStatusWriteGuard : "";
      const auditId = crypto.randomUUID();
      const statements = [
        db
          .prepare(
            `INSERT INTO records (id,owner,kind,body,revision,created,updated) SELECT ?,?,'history',?,1,?,? WHERE EXISTS(SELECT 1 FROM records WHERE id=? AND owner=? AND revision=?${statusGuard})`,
          )
          .bind(
            auditId,
            user.userId,
            JSON.stringify({
              title: (JSON.parse(old.body) as RecordBody).title,
              recordId: id,
              recordKind: kind,
              previousRevision: revision,
              snapshot: JSON.parse(old.body) as RecordBody,
            }),
            now,
            now,
            id,
            user.userId,
            revision,
          ),
        db
          .prepare(
            `UPDATE records SET body=?,revision=revision+1,updated=? WHERE id=? AND owner=? AND revision=?${statusGuard}`,
          )
          .bind(JSON.stringify(body), now, id, user.userId, revision),
      ];
      const jobId = `planning:${id}:${revision + 1}`;
      if (kind === "idea") {
        const event = {
          eventId: "evt_" + jobId,
          name: EVENT,
          timestamp: now,
          data: {
            idea_id: id,
            idea_revision: revision + 1,
            job_id: jobId,
            project: body.project || "通用",
          },
          cursor: null,
        };
        statements.push(
          db
            .prepare(
              "INSERT OR IGNORE INTO jobs (id,owner,idea_id,idea_revision,status,event,delivery,created) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM records WHERE id=? AND owner=? AND kind='history') AND EXISTS(SELECT 1 FROM records WHERE id=? AND owner=? AND kind='idea' AND revision=?)",
            )
            .bind(
              jobId,
              user.userId,
              id,
              revision + 1,
              "queued",
              JSON.stringify(event),
              "pending",
              now,
              auditId,
              user.userId,
              id,
              user.userId,
              revision + 1,
            ),
        );
      }
      const results = await db.batch(statements);
      if (!results[1].meta.changes)
        return Response.json(
          { error: "修订或活动执行已改变。输入已保留，请刷新关联数据后重新确认" },
          { status: 409 },
        );
      if (kind === "idea") {
        try {
          await deliverJob(jobId, user.userId);
        } catch {
          console.error("Event retained for retry");
        }
      }
      return Response.json({ id, revision: revision + 1 });
    }
    if (kind === "run") {
      body.source = "manual";
      const ticket = await db
        .prepare(
          "SELECT body,revision FROM records WHERE id=? AND owner=? AND kind=?",
        )
        .bind(body.ticketId ?? null, user.userId, "ticket")
        .first<Pick<RecordRow, "body" | "revision">>();
      if (!ticket)
        return Response.json({ error: "关联 Ticket 不存在" }, { status: 400 });
      body.contract = JSON.parse(ticket.body) as RecordBody;
      body.ticketRevision = ticket.revision;
    }
    if (kind === "ticket" && body.planId) {
      const plan = await db
        .prepare("SELECT id FROM records WHERE id=? AND owner=? AND kind=?")
        .bind(body.planId, user.userId, "plan")
        .first();
      if (!plan)
        return Response.json({ error: "关联 Plan 不存在" }, { status: 400 });
    }
    const newId = crypto.randomUUID();
    const insert = db
      .prepare(
        "INSERT INTO records (id,owner,kind,body,revision,created,updated) VALUES (?,?,?,?,1,?,?)",
      )
      .bind(newId, user.userId, kind, JSON.stringify(body), now, now);
    if (kind === "idea") {
      const jobId = "planning:" + newId + ":1";
      const event = {
        eventId: "evt_" + jobId,
        name: EVENT,
        timestamp: now,
        data: {
          idea_id: newId,
          idea_revision: 1,
          job_id: jobId,
          project: body.project || "通用",
        },
        cursor: null,
      };
      await db.batch([
        insert,
        db
          .prepare(
            "INSERT INTO jobs (id,owner,idea_id,idea_revision,status,event,delivery,created) VALUES (?,?,?,?,?,?,?,?)",
          )
          .bind(
            jobId,
            user.userId,
            newId,
            1,
            "queued",
            JSON.stringify(event),
            "pending",
            now,
          ),
      ]);
      try {
        await deliverJob(jobId, user.userId);
      } catch {
        console.error("Event retained for retry");
      }
    } else await insert.run();
    return Response.json({ id: newId, revision: 1 }, { status: 201 });
  } catch (e) {
    console.error(e);
    return Response.json(
      { error: "保存失败，输入内容已保留，请稍后重试" },
      { status: 503 },
    );
  }
}
