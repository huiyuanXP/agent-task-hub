import type { PlanningMetadata } from "../lib/types";

export type PlanningView = Partial<Omit<PlanningMetadata, "delivery">> & {
  status: string;
  delivery?: string | null;
};

/** A local clock changes presentation; the server authorizes every retry. */
export function planningControls(job: PlanningView, now: number) {
  const active = job.status === "planning" && (job.lease_expires ?? 0) > now;
  const expired = job.status === "expired" || (
    job.status === "planning" &&
    job.lease_expires != null &&
    job.lease_expires <= now
  );
  const failed = job.delivery === "failed";
  const wakeDue = job.wake_deadline != null && job.wake_deadline <= now;
  const cooling = (job.retry_after ?? 0) > now;
  const eligible = !cooling && (
    expired || failed || wakeDue || job.retry_allowed === true
  );
  const waiting = job.retry_allowed !== undefined && !eligible &&
    ["pending", "retrying", "accepted", "partial"].includes(job.delivery ?? "");
  return {
    active,
    expired,
    disabled: job.status !== "done" && (active || cooling || waiting),
    label: job.status === "done"
      ? "查看结果"
      : active
        ? "Agent 正在处理"
        : cooling
          ? "等待重试冷却"
          : eligible
            ? "重试规划"
            : waiting
              ? "等待自动重试"
              : "请求 Agent",
  };
}

const deadline = (value: number) => new Date(value).toLocaleString("zh-CN");

export function PlanningStatus({ job, now }: { job: PlanningView; now: number }) {
  const { active, expired } = planningControls(job, now);
  const reasons = [...new Set([
    job.recovery_reason,
    ...(job.targets ?? []).map(target => target.reason),
  ].filter(Boolean))];
  const text = job.status === "unplanned"
    ? "当前版本尚未规划，请求 Agent 开始整理"
    : job.status === "done"
      ? "规划完成 · 结果已保存"
      : expired
        ? "规划租约已过期 · 可恢复"
        : active
          ? "Agent 正在规划"
          : job.delivery === "accepted"
            ? "请求已送达 · 等待 Agent 处理"
            : job.delivery === "no_subscription"
              ? "已排队 · 等待项目 Agent"
              : job.delivery === "failed"
                ? "投递失败 · 可恢复"
                : job.delivery === "retrying"
                  ? "投递暂时失败 · 等待自动重试"
                  : "规划已排队";
  return (
    <div className="planning-status" aria-live="polite">
      <div>{text}</div>
      {job.planner_error && <div>Agent 错误：{job.planner_error}</div>}
      {(job.planner_retry_at ?? 0) > now && <div>Agent 重试冷却：剩余 {Math.ceil((job.planner_retry_at! - now) / 1000)} 秒</div>}
      {active && job.lease_expires != null && (
        <div>
          租约到期：{deadline(job.lease_expires)} · 剩余 {Math.ceil((job.lease_expires - now) / 1000)} 秒
        </div>
      )}
      {job.next_retry_at != null && (
        <div>下次投递：{deadline(job.next_retry_at)}</div>
      )}
      {job.delivery === "accepted" && job.wake_deadline != null && (
        <div>等待领取至：{deadline(job.wake_deadline)}</div>
      )}
      {(job.retry_after ?? 0) > now && (
        <div>重试冷却：剩余 {Math.ceil((job.retry_after! - now) / 1000)} 秒</div>
      )}
      {!!reasons.length && <div>原因：{reasons.join(" · ")}</div>}
    </div>
  );
}
