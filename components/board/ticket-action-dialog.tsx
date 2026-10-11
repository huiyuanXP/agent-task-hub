"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Row } from "../../lib/types";
import type { WorkspaceRun } from "../../lib/workspace-runs/types.mts";
import type { Run } from "../../lib/execution/types.mts";
import { resolveTicketAction } from "../../lib/tickets/selectors.mts";
import type { TicketAction } from "../../lib/tickets/selectors.mts";
import { readTicketWorkspaceRuns, ticketRequest, TicketRequestError } from "../../lib/tickets/request.mts";
import { TicketExecutionPanel } from "../ticket-execution/ticket-execution-panel";
import { ticketStatuses, waitingReasons } from "./ticket-card";
export function TicketActionDialog({ ticket, target, current, onClose, onAuthenticationDenied, onRecordsChanged }: {
    ticket: Row;
    target: string;
    current: boolean;
    onClose: () => void;
    onAuthenticationDenied: () => void;
    onRecordsChanged: () => void;
}) {
    const [action, setAction] = useState<TicketAction | null>(target === "execute" ? { type: "open-execution", ticketId: ticket.id, revision: ticket.revision } : null), [error, setError] = useState(""), [busy, setBusy] = useState(false), [conflict, setConflict] = useState(false), [reason, setReason] = useState(""), [notes, setNotes] = useState("");
    const dialog = useRef<HTMLElement>(null), alive = useRef(true), closeRef = useRef(onClose);
    const valid = useRef(current), busyRef = useRef(busy);
    useLayoutEffect(() => { valid.current = current; closeRef.current = onClose; busyRef.current = busy; }, [current, onClose, busy]);
    useEffect(() => {
        alive.current = true;
        const previous = document.activeElement as HTMLElement | null;
        dialog.current?.querySelector<HTMLElement>("button")?.focus();
        const key = (event: KeyboardEvent) => { if (event.key === "Escape" && !busyRef.current) {
            event.preventDefault();
            closeRef.current();
        } if (event.key === "Tab") {
            const focusable = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]') ?? []).filter(element => element.getClientRects().length);
            const first = focusable[0], last = focusable.at(-1);
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
            }
            else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
            }
        } };
        document.addEventListener("keydown", key);
        return () => { alive.current = false; document.removeEventListener("keydown", key); if (previous?.isConnected)
            previous.focus(); };
    }, []);
    useEffect(() => {
        if (target === "execute")
            return;
        let cancelled = false;
        const request = <T,>(url: string) => ticketRequest<T>(url, { onAuthenticationDenied, isCurrent: () => alive.current && !cancelled && valid.current });
        Promise.all([readTicketWorkspaceRuns<WorkspaceRun>(ticket.id, request), Promise.all(["queued", "running", "waiting"].map(state => request<{
                runs: Run[];
            }>("/api/execution?ticketId=" + encodeURIComponent(ticket.id) + "&state=" + state + "&limit=100"))).then(pages => pages.flatMap(page => page.runs))]).then(([workspace, docker]) => { if (!cancelled && alive.current)
            setAction(resolveTicketAction(ticket, target, workspace, docker)); }).catch(cause => { if (!cancelled && alive.current)
            setError(cause instanceof Error ? cause.message : "无法读取执行状态"); });
        return () => { cancelled = true; };
    }, [ticket, target, onAuthenticationDenied]);
    async function save() {
        if (action?.type !== "open-status" || !current || conflict || busy)
            return;
        setBusy(true);
        setError("");
        // Keep the original persisted body, including unknown future fields; remove wire metadata.
        const body = { ...ticket } as Partial<Row>;
        delete body.created;
        delete body.updated;
        try {
            await ticketRequest("/api/records", { body: { ...body, status: action.status, ...(action.status === "waiting" ? { waitingReason: reason } : { waitingReason: undefined }), notes: ticket.notes ? (ticket.notes + "\n" + notes.trim()) : notes.trim() }, onAuthenticationDenied, isCurrent: () => alive.current && valid.current });
            if (alive.current) {
                onRecordsChanged();
                onClose();
            }
        }
        catch (cause) {
            if (alive.current) {
                setError(cause instanceof Error ? cause.message : "状态保存失败");
                if (cause instanceof TicketRequestError && cause.status === 409) {
                    setConflict(true);
                    onRecordsChanged();
                }
            }
        }
        finally {
            if (alive.current)
                setBusy(false);
        }
    }
    const stale = !current || conflict;
    return <div className="modal-overlay" onClick={event => { if (event.target === event.currentTarget && !busy)
        onClose(); }}><section ref={dialog} className="modal board-action-modal" role="dialog" aria-modal="true" aria-labelledby="board-action-title"><header><div><span className="eyebrow">TICKET · v{ticket.revision}</span><h2 id="board-action-title">处理：{ticket.title}</h2></div><button type="button" className="icon-btn" aria-label="关闭操作" disabled={busy} onClick={onClose}>×</button></header>
  {stale ? <div className="board-action-body"><p role="alert">Ticket 已消失或修订改变。原输入已保留，请关闭后刷新任务并重新确认。</p>{reason && <p>等待原因：{waitingReasons[reason as keyof typeof waitingReasons]}</p>}{notes && <p className="preserve">{notes}</p>}</div> : <>
   {!action && !error && <p className="board-action-body">正在读取此 Ticket 的真实执行状态…</p>}
   {(action?.type === "completed-info" || action?.type === "open-active") && <p className="board-action-body">{action.reason}</p>}
   {action?.type === "no-op" && <p className="board-action-body">任务状态保持不变。</p>}
   {action?.type === "open-status" && <form onSubmit={event => { event.preventDefault(); void save(); }}><div className="form-grid"><p className="wide">将手工记录状态从“{ticketStatuses[(ticket.status || "todo") as keyof typeof ticketStatuses]}”改为“{ticketStatuses[action.status]}”。确认后保存一个新修订；不会启动执行。</p>{action.status === "waiting" && <label className="wide">等待原因<select required aria-label="等待原因" value={reason} disabled={busy} onChange={event => setReason(event.target.value)}><option value="">请选择真实等待原因</option>{Object.entries(waitingReasons).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}<label className="wide">变更说明<textarea required aria-label="变更说明" value={notes} disabled={busy} onChange={event => setNotes(event.target.value)} placeholder="说明本次状态变化的真实原因"/></label></div><div className="modal-footer"><button type="button" className="secondary" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="primary" disabled={busy || !notes.trim() || (action.status === "waiting" && !reason)}>确认保存状态</button></div></form>}
   {(action?.type === "open-execution" || action?.type === "open-review" || action?.type === "open-active") && <TicketExecutionPanel ticket={ticket} intent={action.type === "open-review" ? "review" : action.type === "open-active" ? "active" : "execute"} runId={action.type === "open-review" || action.type === "open-active" ? action.runId : undefined} initialBackend={action.type === "open-active" ? action.backend : undefined} onAuthenticationDenied={onAuthenticationDenied} onRecordsChanged={onRecordsChanged}/>}
  </>}{error && <p role="alert" className="form-error">{error}</p>}</section></div>;
}
