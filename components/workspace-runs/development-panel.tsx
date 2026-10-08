"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Row } from "../../lib/types";
import type { ConnectionList } from "../connectors/types";

interface DevelopmentRun {
  id: string; ticketId: string; revision: number; connectionId: string; project: string;
  state: string; createdAt: number; updatedAt: number; timeoutMs: number; error: string | null;
  result: { summary: string; diff: string; files: string[]; tests: { command: string; exitCode: number; output: string }[]; worktree: string } | null;
  events: { id: string; sequence: number; stage: string; message: string; createdAt: number }[];
}
const states: Record<string, string> = { pending: "待批准", approved: "等待 Agent", running: "执行中", review: "待验收", succeeded: "已验收", failed: "失败", cancelled: "已取消" };

export function DevelopmentPanel({ tickets, project, onAuthenticationDenied, onRecordsChanged }: {
  tickets: Row[]; project: string; onAuthenticationDenied: () => void; onRecordsChanged: () => void;
}) {
  const [connections, setConnections] = useState<ConnectionList["connections"]>([]);
  const [runs, setRuns] = useState<DevelopmentRun[]>([]), [ticketId, setTicketId] = useState("");
  const [connectionId, setConnectionId] = useState(""), [minutes, setMinutes] = useState(20);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const sequence = useRef(0);
  const request = useCallback(async (url: string, body?: unknown) => {
    const response = await fetch(url, { cache: "no-store", ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
    if (response.status === 401 || response.status === 403) { onAuthenticationDenied(); throw Error("请重新登录"); }
    const value = await response.json();
    if (!response.ok) throw Error(value.error || "开发执行请求失败");
    return value;
  }, [onAuthenticationDenied]);
  const refresh = useCallback(async () => {
    const current = ++sequence.current;
    try {
      const [connectionData, runData] = await Promise.all([request("/api/connectors"), request("/api/workspace-runs")]);
      if (current === sequence.current) { setConnections(connectionData.connections); setRuns(runData.runs); setError(""); }
    } catch (failure) { if (current === sequence.current) setError(failure instanceof Error ? failure.message : "暂时无法读取执行状态"); }
  }, [request]);
  useEffect(() => {
    const pending = sequence;
    const startup = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => void refresh(), 5000);
    return () => { clearTimeout(startup); clearInterval(timer); ++pending.current; };
  }, [refresh]);
  const visibleTickets = tickets.filter(t => project === "全部项目" || t.project === project);
  const ticket = visibleTickets.find(t => t.id === ticketId) ?? visibleTickets[0];
  const availableConnections = connections.filter(c => !c.revokedAt && c.project === (ticket?.project || "通用") && c.capabilities.includes("execute"));
  const connection = availableConnections.find(c => c.id === connectionId) ?? availableConnections[0];
  const visibleRuns = runs.filter(r => project === "全部项目" || r.project === project);
  async function action(body: unknown, recordsChanged = false) {
    setBusy(true); setError("");
    try { await request("/api/workspace-runs", body); await refresh(); if (recordsChanged) onRecordsChanged(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "操作失败"); }
    finally { setBusy(false); }
  }
  return <section className="workspace-section" aria-label="本机 Agent 开发执行">
    <div className="section-heading"><div><h2>本机 Agent 开发执行</h2><p>选择本项目已安装的 Agent，批准任务范围后，在独立 Git 工作区修改并回报真实结果。</p></div><button className="secondary" type="button" onClick={() => void refresh()}>刷新执行</button></div>
    {ticket && <div className="workspace-form">
      <label>开发 Ticket<select value={ticket.id} onChange={e => setTicketId(e.target.value)}>{visibleTickets.map(t => <option key={t.id} value={t.id}>{t.title} · v{t.revision}</option>)}</select></label>
      <label>执行 workspace<select value={connection?.id ?? ""} onChange={e => setConnectionId(e.target.value)}><option value="" disabled>先在连接与执行中安装本项目客户端</option>{availableConnections.map(c => <option key={c.id} value={c.id}>{c.name} · {c.agentReady ? "Agent 可用" : "Agent 未就绪"}</option>)}</select></label>
      <label>执行期限（分钟）<input type="number" min={1} max={60} value={minutes} onChange={e => setMinutes(Number(e.target.value))} /></label>
      <button className="primary" type="button" disabled={busy || !connection || !Number.isFinite(minutes) || minutes < 1 || minutes > 60} onClick={() => void action({ action: "prepare", ticketId: ticket.id, revision: ticket.revision, connectionId: connection?.id, requestId: crypto.randomUUID(), timeoutMs: Math.round(minutes * 60000) })}>申请开发执行</button>
    </div>}
    {!ticket && <p className="form-help">先创建 Ticket，或让规划 Agent 从点子生成 Tickets。</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="development-runs">{visibleRuns.map(run => <article className="idea-card" key={run.id}>
      <div className="card-top"><span className="project-tag">{run.project}</span><strong>{states[run.state] || run.state}</strong></div>
      <h3>{tickets.find(t => t.id === run.ticketId)?.title ?? run.ticketId}</h3><p>Ticket v{run.revision} · {connections.find(c => c.id === run.connectionId)?.name ?? run.connectionId} · {new Date(run.createdAt).toLocaleString("zh-CN")}</p>
      <p>本机工作区执行 · 最长 {Math.round(run.timeoutMs / 60000)} 分钟</p>
      {run.error && <p className="form-error">{run.error}</p>}
      {run.events?.length > 0 && <details open={run.state === "running"}><summary>执行进度（{run.events.length}）</summary><ol className="execution-timeline">{run.events.map(event => <li key={event.id}><time>{new Date(event.createdAt).toLocaleTimeString("zh-CN")}</time> <strong>{event.stage}</strong> {event.message}</li>)}</ol></details>}
      {run.result && <div className="development-result"><h4>交付结果</h4><p>{run.result.summary}</p><p>修改文件：{run.result.files?.join("、") || "无"}</p>
        <details><summary>查看实际变更</summary><pre>{run.result.diff || "没有文件差异"}</pre></details>
        <details><summary>查看测试证据</summary>{run.result.tests?.map((test, index) => <div key={index}><strong>{test.command} · 退出码 {test.exitCode}</strong><pre>{test.output}</pre></div>)}</details>
      </div>}
      <div className="card-actions">
        {run.state === "pending" && <><button className="primary" type="button" disabled={busy} onClick={() => void action({ action: "approve", runId: run.id })}>批准开发</button><button className="secondary" type="button" disabled={busy} onClick={() => void action({ action: "reject", runId: run.id })}>拒绝</button></>}
        {["pending", "approved", "running"].includes(run.state) && <button className="secondary" type="button" disabled={busy} onClick={() => void action({ action: "cancel", runId: run.id })}>取消任务</button>}
        {run.state === "review" && <><button className="primary" type="button" disabled={busy} onClick={() => void action({ action: "accept", runId: run.id }, true)}>验收通过</button><button className="secondary" type="button" disabled={busy} onClick={() => void action({ action: "rework", runId: run.id })}>要求返工</button></>}
      </div>
    </article>)}</div>
    {!visibleRuns.length && <p className="form-help">开发执行记录会显示在这里；已有手工快照和固定 Docker 操作仍单独保留。</p>}
  </section>;
}
