"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Row } from "../../lib/types";
import type { Run } from "../../lib/execution/types.mts";
import type { Authorization, OperationDescriptor, PrepareExecutionInput, ResourceBudget } from "../../lib/execution/authorization-types.mts";

import type { BackendAttestation } from "../../lib/execution/attestations.mts";
type Backend = { phase: string; receipts: BackendAttestation[] };
type Catalog = { operations: OperationDescriptor[]; ceilings: ResourceBudget };
const active = (run: Run | null) => !!run && ["queued", "running", "waiting"].includes(run.state);
async function api<T>(pendingResponse: Promise<Response>): Promise<T> {
  const response = await pendingResponse;
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw Error(result.error || "授权请求失败");
  return result as T;
}
/** A dedicated owner decision flow; planning prose is never converted to authority. */
export function AuthorizationPanel({ tickets, onAuthenticationDenied }: { tickets: Row[]; onAuthenticationDenied: () => void }) {
  const [selectedId, setSelectedId] = useState("");
  const ticket = tickets.find(t => t.id === selectedId) ?? tickets[0];
  const ticketId = ticket?.id, revision = ticket?.revision;
  const [operationId, setOperationId] = useState("");
  const [backend, setBackend] = useState<Backend | null>(null);
  const [connection, setConnection] = useState("正在检查执行后端");
  const [connected, setConnected] = useState(false);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [authorization, setAuthorization] = useState<Authorization | null>(null);
  const [budget, setBudget] = useState<ResourceBudget>({ timeoutMs: 30000, memoryMb: 256, cpus: 1, pids: 64 });
  const [expiryMinutes, setExpiryMinutes] = useState(10);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const sequence = useRef(0), nextAttempt = useRef(1), lifecycle = useRef(0);
  const selectedOperation = (active(run) ? authorization?.operations[0] : undefined) ?? catalog?.operations.find(o => o.operationId === operationId) ?? catalog?.operations[0];
  const storageKey = `execution-request:${ticketId}:v${revision}:${selectedOperation?.operationId ?? ""}`;
  const request = useCallback(async (url: string, isCurrent: () => boolean, body?: unknown) => {
    const response = await fetch(url, { cache: "no-store", ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    if (!isCurrent()) throw Error("请求已失效");
    // Inspect every response before JSON parsing or a sibling request can delay it.
    if (response.status === 401 || response.status === 403) {
      ++lifecycle.current;
      ++sequence.current;
      setCatalog(null); setRun(null); setAuthorization(null); setBackend(null); setConnected(false); setConnection("登录已失效");
      onAuthenticationDenied();
      throw Error("登录已失效或无权访问");
    }
    return response;
  }, [onAuthenticationDenied]);
  const refresh = useCallback(async () => {
    if (!ticketId || !revision) return;
    const current = ++sequence.current, generation = lifecycle.current;
    const isCurrent = () => sequence.current === current && lifecycle.current === generation;
    try {
      const [nextCatalog, listed, health] = await Promise.all([
        api<Catalog>(request(`/api/authorization?ticketId=${encodeURIComponent(ticketId)}&expectedRevision=${revision}`, isCurrent)),
        api<{ runs: Run[] }>(request(`/api/execution?ticketId=${encodeURIComponent(ticketId)}`, isCurrent)),
        request("/api/execution/dispatch", isCurrent),
      ]);
      if (!isCurrent()) return;
      let latest = listed.runs.find(r => active(r)) ?? listed.runs[0] ?? null;
      let nextAuthorization: Authorization | null = null;
      let nextBackend: Backend | null = null;
      const healthy = health.ok;
      if (latest && healthy) {
        const response = await request(`/api/execution/dispatch?runId=${encodeURIComponent(latest.id)}`, isCurrent);
        if (response.ok) { const result = await response.json() as { run: Run; backend: Backend | null }; latest = result.run; nextBackend = result.backend; }
        else if (response.status !== 503) throw Error("无法读取执行结果");
      }
      if (latest) {
        // Older model-only Runs can have an authorization reference with no grant.
        const response = await request(`/api/authorization?id=${encodeURIComponent(latest.authorizationId)}`, isCurrent);
        if (response.ok) nextAuthorization = (await response.json() as { authorization: Authorization }).authorization;
        else if (response.status !== 404) throw Error("无法读取授权状态");
      }
      if (isCurrent()) {
        setCatalog(nextCatalog); setRun(latest); setAuthorization(nextAuthorization); setBackend(nextBackend);
        setConnected(healthy); setConnection(healthy ? "执行后端已连接" : "执行后端暂不可用或未配置（503）");
        nextAttempt.current = Math.max(0, ...listed.runs.map(r => r.attempt)) + 1;
        setError(""); setLoading(false);
      }
    } catch (e) { if (isCurrent()) { setError(e instanceof Error ? e.message : "授权状态不可用"); setLoading(false); } }
  }, [ticketId, revision, request]);
  useEffect(() => {
    const pendingSequence = sequence, generation = lifecycle;
    ++generation.current;
    const startup = window.setTimeout(() => { setBusy(false); setLoading(true); setCatalog(null); setRun(null); setAuthorization(null); setBackend(null); setConnected(false); setConnection("正在检查执行后端"); void refresh(); }, 0);
    const interval = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 5000);
    return () => { ++pendingSequence.current; ++generation.current; window.clearTimeout(startup); window.clearInterval(interval); };
  }, [refresh]);
  async function write(action: (isCurrent: () => boolean) => Promise<void>) {
    const generation = lifecycle.current;
    const isCurrent = () => lifecycle.current === generation;
    ++sequence.current;
    setBusy(true); setError("");
    try { await action(isCurrent); if (isCurrent()) await refresh(); }
    catch (e) { if (isCurrent()) setError(e instanceof Error ? e.message : "授权请求失败；可用相同请求重试"); }
    finally { if (isCurrent()) setBusy(false); }
  }
  function requestAuthorization() {
    if (!ticket || !catalog) return;
    void write(async (isCurrent) => {
      const saved = sessionStorage.getItem(storageKey);
      let input: PrepareExecutionInput;
      if (saved) input = JSON.parse(saved) as PrepareExecutionInput;
      else {
        input = { ticketId: ticket.id, expectedRevision: ticket.revision, requestId: crypto.randomUUID(), attempt: nextAttempt.current,
          scope: [{ operationId: selectedOperation!.operationId, definitionHash: selectedOperation!.definitionHash }], budget: { ...budget }, expiresAt: Date.now() + expiryMinutes * 60000 };
        // Persist before the network write. Lost responses and reloads retain this identity.
        sessionStorage.setItem(storageKey, JSON.stringify(input));
      }
      const result = await api<{ run: Run; authorization: Authorization }>(request("/api/authorization", isCurrent, { action: "prepare", ...input }));
      if (!isCurrent()) return;
      setRun(result.run); setAuthorization(result.authorization);
    });
  }
  function decide(outcome: "approved" | "rejected" | "revoked") {
    if (!authorization) return;
    void write(async (isCurrent) => {
      const key = `execution-decision:${authorization.id}:${outcome}`;
      const decisionId = sessionStorage.getItem(key) ?? crypto.randomUUID(); sessionStorage.setItem(key, decisionId);
      await api(request("/api/authorization", isCurrent, { action: outcome === "revoked" ? "revoke" : "decide", authorizationId: authorization.id, decisionId, ...(outcome === "revoked" ? {} : { outcome }) }));
    });
  }
  function cancelRun() {
    if (!run) return;
    void write(async (isCurrent) => {
      const committed = await api<{ run: Run }>(request("/api/execution", isCurrent, { action: "cancel", id: run.id, expectedVersion: run.version }));
      if (!isCurrent()) return;
      setRun(committed.run); sessionStorage.removeItem(storageKey);
      setBackend(previous => previous?.receipts.some(r => r.claims.purpose === "stop") ? previous : { phase: "cancellation_pending", receipts: previous?.receipts ?? [] });
      if (connected) {
        const response = await request("/api/execution/dispatch", isCurrent, { action: "cancel", runId: run.id });
        if (response.status === 503 && isCurrent()) { setConnected(false); setConnection("取消已保存；后端暂不可用，物理停止尚未确认（503）"); }
        await api(Promise.resolve(response));
      }
    });
  }
  function startRun() {
    if (!run) return;
    void write(async isCurrent => { await api(request("/api/execution/dispatch", isCurrent, { action: "start", runId: run.id })); });
  }
  function download(kind: "stdout" | "stderr" | "artifact", path?: string) {
    if (!run) return;
    void write(async isCurrent => {
      const response = await request("/api/execution/dispatch", isCurrent, { action: "content", runId: run.id, kind, ...(path ? { path } : {}) });
      if (!response.ok) throw Error("保留的内容不可用；没有可验证的下载数据");
      const blob = await response.blob(); if (!isCurrent()) return;
      const url = URL.createObjectURL(blob), link = document.createElement("a");
      link.href = url; link.download = path?.split("/").at(-1) ?? `${kind}.log`; link.click(); URL.revokeObjectURL(url);
    });
  }
  const result = backend?.receipts.find(r => r.claims.purpose === "result")?.claims;
  if (!tickets.length) return null;
  const requested = active(run), pending = authorization?.effectiveStatus === "pending";
  return (
    <section className="idea-card" role="region" aria-label="执行授权">
      <h2>执行授权</h2>
      <p role="status">{connection}</p>
      <p>选择已登记的操作，单独批准固定 Ticket 版本的执行。申请和批准均不会启动进程。</p>
      <label>授权 Ticket <select aria-label="授权 Ticket" value={ticketId ?? ""} disabled={busy} onChange={e => setSelectedId(e.target.value)}>
        {tickets.map(t => <option value={t.id} key={t.id}>{t.title} · v{t.revision}</option>)}
      </select></label>
      {catalog && <>
        <label>操作 <select aria-label="执行操作" value={selectedOperation?.operationId ?? ""} disabled={busy || active(run)} onChange={e => setOperationId(e.target.value)}>{selectedOperation && !catalog.operations.some(o => o.operationId === selectedOperation.operationId) && <option value={selectedOperation.operationId}>{selectedOperation.label} · {selectedOperation.operationId}</option>}{catalog.operations.map(o => <option key={o.operationId} value={o.operationId}>{o.label} · {o.operationId}</option>)}</select></label>
        <p>无网络、无凭据 · 固定输入 input/ticket.json · 工作空间 64 MiB</p>
        <details><summary>查看冻结的操作定义</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(authorization?.operations ?? [selectedOperation], null, 2)}</pre></details>
      </>}
      {!requested && <div className="form-grid">
        {([ ["timeoutMs", "超时（毫秒）", 30000], ["memoryMb", "内存（MiB）", 256], ["cpus", "CPU", 1], ["pids", "进程数", 64] ] as const).map(([key, label, max]) => (
          <label key={key}>{label}<input type="number" aria-label={label} min={key === "cpus" ? 0.01 : 1} max={max} step={key === "cpus" ? 0.01 : 1} value={budget[key]} disabled={busy} onChange={e => setBudget({ ...budget, [key]: Number(e.target.value) })} /></label>
        ))}
        <label>最晚开始（分钟）<input type="number" aria-label="最晚开始（分钟）" min={1} max={1440} value={expiryMinutes} disabled={busy} onChange={e => setExpiryMinutes(Number(e.target.value))} /></label>
      </div>}
      {run && <p>Run {run.id} · v{run.version} · {run.state} · Ticket v{run.ticketRevision}</p>}
      {backend && <p>后端状态：{backend.phase} · {backend.receipts.some(r => r.claims.purpose === "stop") ? "已确认物理停止" : "尚未确认物理停止"}</p>}
      {result && <div aria-label="实际执行结果"><p>实际结果：{result.status} · 退出码 {result.exitCode ?? "未知"}</p>
        {(["stdout", "stderr"] as const).map(kind => result[kind] && <button key={kind} type="button" disabled={busy} onClick={() => download(kind)}>下载 {kind}（{result[kind]!.bytes} 字节{result[kind]!.truncated ? "，已截断" : ""}）</button>)}
        {result.artifacts.map(a => <p key={a.path}><button type="button" disabled={busy} onClick={() => download("artifact", a.path)}>下载 {a.path}</button> · {a.bytes} 字节 · SHA-256 {a.sha256}</p>)}
      </div>}
      {authorization && <>
        <p>有效授权状态：<strong>{authorization.effectiveStatus}</strong></p>
        <p>最晚开始：{new Date(authorization.expiresAt).toLocaleString()} · 超时 {authorization.budget.timeoutMs} ms · 内存 {authorization.budget.memoryMb} MiB · CPU {authorization.budget.cpus} · 进程 {authorization.budget.pids}</p>
        <details><summary>授权决策记录（{authorization.decisions.length}）</summary>{authorization.decisions.map(d => <p key={d.decisionId}>{d.kind} · {d.actor} · {new Date(d.at).toLocaleString()} · {d.decisionId}</p>)}</details>
      </>}
      {requested && <p>旧 Run 仍占用此 Ticket。拒绝、撤销或过期后，可取消 Run 再申请；取消不会自动启动其他执行；实际停止确认前仍保留物理执行占用。</p>}
      <div className="card-actions" style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
        {!requested && <button type="button" disabled={busy || loading} onClick={() => { sessionStorage.removeItem(storageKey); setError(""); }}>重新设置申请</button>}
        {!requested && <button className="primary" type="button" disabled={busy || loading || !catalog} onClick={requestAuthorization}>请求执行授权</button>}
        {authorization?.effectiveStatus === "approved" && requested && <button type="button" disabled={busy || !connected} onClick={startRun}>启动已批准的执行</button>}
        {pending && requested && <><button type="button" disabled={busy} onClick={() => decide("approved")}>批准授权</button><button type="button" disabled={busy} onClick={() => decide("rejected")}>拒绝授权</button></>}
        {authorization && ["pending", "approved"].includes(authorization.status) && <button type="button" disabled={busy} onClick={() => decide("revoked")}>撤销授权</button>}
        {requested && <button type="button" disabled={busy} onClick={cancelRun}>取消 Run，允许重新申请</button>}
        <button type="button" disabled={busy} onClick={() => void refresh()}>刷新授权状态</button>
      </div>
      {error && <p role="alert" className="form-error">{error}</p>}
    </section>
  );
}
