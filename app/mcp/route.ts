import { configuredOrigin } from '../../lib/local-auth.mts';
import { executionEnvironment } from '../../lib/runtime-environment';
const env = executionEnvironment();
import { configuredRegistry } from '../../lib/execution/backend-config.mts';
import { backfillPlanning } from "../../lib/planning-recovery.mts";
import type {
  RpcRequest,
  Subscription,
  SubscriptionRow,
} from "../../lib/types";
import { getCurrentUser } from "../../lib/current-user";
import { database } from "../../lib/store";
import {
  EVENT,
  subId,
  safeCallback,
  secretBytes,
  signedPost,
} from "../../lib/events";
import { dispatchExecutionTool, executionTools } from "../../lib/execution/mcp.mts";
import { dispatchTaskReadTool, taskReadTools } from "../../lib/task-reads/mcp.mts";
import { boundedMCPResponse as boundedResponse } from '../../lib/task-reads/bounds.mts';
import { readBody } from '../../lib/execution/http.mts';
import { ExecutionError } from "../../lib/execution/errors.mts";
import { dispatchPlanningTool, planningTools as tools, object, str } from '../../lib/connectors/planning.mts';
const boundedMCPResponse = (value: unknown, init: ResponseInit = {}) =>
  boundedResponse(value, init.status ?? 200, { 'Cache-Control': 'no-store', ...Object.fromEntries(new Headers(init.headers)) });
const eventDef = {
  name: EVENT,
  description:
    "An idea has requested AI planning into a Plan and actionable Tickets. Read the idea with get_idea, claim its job, then save the plan and tickets. Does not authorize task execution.",
  delivery: ["webhook"],
  inputSchema: object({
    project: {
      type: "string",
      description: "Optional exact project name; omit to handle all projects.",
    },
  }),
  payloadSchema: object(
    {
      idea_id: str,
      idea_revision: { type: "integer" },
      job_id: str,
      project: str,
    },
    ["idea_id", "idea_revision", "job_id", "project"],
  ),
};
function same(a: string, b: string) {
  const x = new TextEncoder().encode(a),
    y = new TextEncoder().encode(b);
  let v = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++)
    v |= (x[i] || 0) ^ (y[i] || 0);
  return v === 0;
}
export async function POST(req: Request) {
  let id: string | number | null = null;
  try {
    if (req.headers.has("origin") && req.headers.get("origin") !== configuredOrigin())
      return boundedMCPResponse({ error: "Invalid request origin" }, { status: 403 });
    const rpc = (await readBody(req, 200000)) as RpcRequest;
    id = rpc.id ?? null;
    const p = rpc.params || {},
      method = rpc.method;
    console.info(
      JSON.stringify({
        component: "mcp",
        stage: "received",
        method,
        tool: method === "tools/call" ? p.name : undefined,
      }),
    );
    const respond = (result: Record<string, unknown>) =>
      boundedMCPResponse(
        { jsonrpc: "2.0", id, result: { resultType: "complete", ...result } },
        { headers: { "Cache-Control": "no-store" } },
      );
    if (method === "server/discover")
      return respond({
        resultType: "complete",
        supportedVersions: ["2026-07-28"],
        serverInfo: { name: "idea-ticket-hub", version: "1.0.0" },
        capabilities: { tools: {}, events: {} },
      });
    if (method === "initialize")
      return respond({
        protocolVersion:
          rpc.params?.protocolVersion === "2026-07-28"
            ? "2026-07-28"
            : "2025-03-26",
        serverInfo: { name: "idea-ticket-hub", version: "1.0.0" },
        capabilities: { tools: {}, events: {} },
      });
    if (method === "notifications/initialized")
      return new Response(null, { status: 202 });
    if (method === "ping") return respond({});
    if (method === "tools/list") return respond({ tools: [...tools, ...executionTools, ...taskReadTools] });
    if (method === "events/list") return respond({ events: [eventDef] });
    const user = await getCurrentUser();
    console.info(
      JSON.stringify({
        component: "mcp",
        stage: "authentication",
        authenticated: !!user,
      }),
    );
    if (!user)
      return boundedMCPResponse(
        {
          jsonrpc: "2.0",
          id,
          error: { code: -32001, message: "Authenticated user required" },
        },
        { status: 401 },
      );
    const owner = user.userId,
      db = database();
    if (method === "events/subscribe" || method === "events/unsubscribe") {
      if (
        p.name !== EVENT ||
        p.delivery?.mode !== "webhook" ||
        typeof p.delivery.url !== "string" ||
        (method === "events/subscribe" && typeof p.delivery.secret !== "string") ||
        (p.arguments !== undefined &&
          (!p.arguments || typeof p.arguments !== "object" || Array.isArray(p.arguments))) ||
        (p.ttlMs !== undefined &&
          (typeof p.ttlMs !== "number" || !Number.isFinite(p.ttlMs))) ||
        Object.keys(p.arguments || {}).some((k) => k !== "project") ||
        (p.arguments?.project !== undefined &&
          (typeof p.arguments.project !== "string" || p.arguments.project.length > 120))
      )
        throw Error("Invalid event subscription");
      console.info(
        JSON.stringify({
          component: "events",
          stage: "callback_validation",
          host: new URL(p.delivery.url).hostname,
        }),
      );
      safeCallback(p.delivery.url);
      const sid = await subId(owner, { ...p, delivery: p.delivery });
      if (method === "events/unsubscribe") {
        await db
          .prepare("DELETE FROM subscriptions WHERE id=? AND owner=?")
          .bind(sid, owner)
          .run();
        await backfillPlanning(owner, db);
        return respond({});
      }
      secretBytes(p.delivery.secret);
      const old = await db
        .prepare("SELECT body FROM subscriptions WHERE id=? AND owner=?")
        .bind(sid, owner)
        .first<Pick<SubscriptionRow, "body">>();
      const previous = old ? (JSON.parse(old.body) as Subscription) : null;
      const sub: Subscription = {
        id: sid,
        url: p.delivery.url,
        secret: p.delivery.secret,
        args: p.arguments || {},
      };
      if (previous && previous.secret !== sub.secret) {
        sub.previousSecret = previous.secret;
        sub.rotationUntil = Date.now() + 300000;
      }
      if (
        !previous ||
        (previous.verifiedAt || 0) < Date.now() - 300000 ||
        previous.secret !== sub.secret
      ) {
        const challenge = crypto.randomUUID();
        try {
          const r = await signedPost(
            sub,
            { type: "verification", challenge },
            "verify_" + crypto.randomUUID(),
          );
          console.info(
            JSON.stringify({
              component: "events",
              stage: "verification_response",
              status: r.status,
            }),
          );
          const echoed = (await r.json()) as { challenge?: unknown };
          if (!r.ok || !same(challenge, String(echoed.challenge || "")))
            throw Error();
        } catch (e) {
          console.error(
            JSON.stringify({
              component: "events",
              stage: "verification_failed",
              category: e instanceof Error ? e.name : "unknown",
              detail:
                e instanceof Error
                  ? e.message.replace(/https?:[^\s]+/g, "[url]").slice(0, 240)
                  : "unknown",
            }),
          );
          return boundedMCPResponse({
            jsonrpc: "2.0",
            id,
            error: {
              code: -32015,
              message: "Callback verification failed",
              data: { reason: "challenge_failed" },
            },
          });
        }
      }
      sub.verifiedAt = Date.now();
      const ttl =
        p.ttlMs == null
          ? 86400000
          : Math.max(60000, Math.min(604800000, Number(p.ttlMs) || 86400000));
      const expires = Date.now() + ttl;
      await db
        .prepare(
          "INSERT INTO subscriptions(id,owner,body,expires) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,expires=excluded.expires WHERE owner=excluded.owner",
        )
        .bind(sid, owner, JSON.stringify(sub), expires)
        .run();
      console.info(
        JSON.stringify({ component: "events", stage: "subscription_saved" }),
      );
      await backfillPlanning(owner, db);
      return respond({
        id: sid,
        refreshBefore: new Date(expires).toISOString(),
        cursor: null,
        truncated: false,
      });
    }
    if (method !== "tools/call")
      return boundedMCPResponse({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "Method not found" },
      });
    const taskReadResult = await dispatchTaskReadTool(db, owner, p.name as string, p.arguments, () => configuredRegistry(env));
    if (taskReadResult !== undefined) return respond({
      content: [{ type: "text", text: JSON.stringify(taskReadResult) }], structuredContent: taskReadResult, isError: false,
    });
    const executionResult = await dispatchExecutionTool(db, () => ({ owner, actor: owner, grantAuthority: "owner", registry: configuredRegistry(env) }), p.name as string, p.arguments);
    if (executionResult !== undefined) return respond({
      content: [{ type: "text", text: JSON.stringify(executionResult) }], structuredContent: executionResult, isError: false,
    });
    const result = await dispatchPlanningTool(db, owner, p.name as string, p.arguments);
    if (result === undefined) throw Error("Unknown tool");
    return respond({
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
      isError: false,
    });
  } catch (e) {
    if (!(e instanceof ExecutionError)) console.error(e instanceof Error ? e.message : "MCP error");
    return boundedMCPResponse(
      {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32602,
          message: e instanceof Error ? e.message : "Request failed",
          ...(e instanceof ExecutionError ? { data: { code: e.code, status: e.status } } : {}),
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
export async function GET() {
  return new Response("MCP JSON-RPC endpoint. Use POST.", {
    status: 405,
    headers: { Allow: "POST" },
  });
}
