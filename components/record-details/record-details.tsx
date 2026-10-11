"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode, FormEvent } from "react";
import { X } from "lucide-react";
import type { RecordDraft, Row, PlanningState } from "../../lib/types";
import { PlanningStatus, planningControls } from "../planning-status";

const statuses: Record<string, string> = { todo: "待开始", running: "进行中", waiting: "等待中", done: "已完成", error: "异常" };
const reasons: Record<string, string> = { clarification: "需要澄清", approval: "需要授权", review: "等待验收", external: "外部依赖", recovery: "恢复确认" };
const priorities = { P0: "P0 · 紧急", P1: "P1 · 重要", P2: "P2 · 常规", P3: "P3 · 有空再做" };
type TextKey = "project" | "text" | "goal" | "scope" | "acceptance" | "dependencies" | "assumptions" | "allowedActions" | "budget" | "notes" | "queue" | "evidence";
type Props = {
  record: RecordDraft; rows: Row[]; planning: PlanningState; now: number; saving: boolean; error: string;
  onClose: () => void; onSave: (value: RecordDraft) => Promise<{ id: string; revision: number } | null>;
  onRequestPlan: (idea: Row) => Promise<void>;
  newRecord: (kind: string) => RecordDraft;
  renderExecution?: (ticket: Row) => ReactNode;
};
type Entry = { record: RecordDraft; scroll: number; focusId?: string };

/** One modal retains the opener and the list context while following record links. */
export function RecordDetails(props: Props) {
  const [path, setPath] = useState<Entry[]>([{ record: props.record, scroll: 0 }]);
  const modal = useRef<HTMLElement>(null);
  const [opener] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const active = path[path.length - 1];
  useEffect(() => {
    const background = [...document.querySelectorAll<HTMLElement>(".app > :not(.modal-overlay)")];
    const previous = background.map(element => element.inert);
    background.forEach(element => { element.inert = true; });
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const root = modal.current?.querySelector<HTMLElement>('[data-unsaved-dialog]') ?? modal.current;
      const controls = [...(root?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, a[href], [tabindex="0"]') ?? [])].filter(element => element.getClientRects().length > 0);
      const first = controls[0], last = controls[controls.length - 1];
      if (!first) { event.preventDefault(); root?.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || !root?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !root?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", trap, true);
    return () => {
      document.removeEventListener("keydown", trap, true);
      background.forEach((element, index) => { element.inert = previous[index]; });
      document.body.style.overflow = oldOverflow;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [opener]);
  const scrollReset = useCallback(() => { if (modal.current) modal.current.scrollTop = 0; }, []);
  const navigate = (record: RecordDraft) => {
    setPath(current => [...current.slice(0, -1), { ...active, scroll: modal.current?.scrollTop ?? 0, focusId: (document.activeElement as HTMLElement)?.dataset.relatedRecord }, { record, scroll: 0 }]);
  };
  const back = () => {
    const previous = path[path.length - 2];
    setPath(path.slice(0, -1));
    requestAnimationFrame(() => { if (modal.current) modal.current.scrollTop = previous.scroll; if (previous.focusId) [...(modal.current?.querySelectorAll<HTMLElement>("[data-related-record]") ?? [])].find(element => element.dataset.relatedRecord === previous.focusId)?.focus({ preventScroll: true }); });
  };
  return <div className="modal-overlay" onClick={event => { if (event.target === event.currentTarget) modal.current?.querySelector<HTMLButtonElement>('[aria-label="关闭"]')?.click(); }}>
    <section className="modal record-detail" role="dialog" aria-modal="true" aria-labelledby="dialog-title" tabIndex={-1} ref={modal}>
      <DetailContent key={`${active.record.id ?? active.record.kind}:${path.length}`} {...props} record={active.record} onNavigate={navigate} onBack={path.length > 1 ? back : undefined} onScrollReset={scrollReset} />
    </section>
  </div>;
}

function DetailContent({ record, rows, planning, now, saving, error, onClose, onSave, onRequestPlan, newRecord, renderExecution, onNavigate, onBack, onScrollReset }: Props & { onNavigate: (record: RecordDraft) => void; onBack?: () => void; onScrollReset: () => void }) {
  const [draft, setDraft] = useState<RecordDraft>({ ...record });
  const [baseline, setBaseline] = useState<RecordDraft>({ ...record });
  const [editing, setEditing] = useState(!record.id);
  const [pending, setPending] = useState<(() => void) | null>(null);
  const [localError, setLocalError] = useState("");
  const [showExecution, setShowExecution] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const confirm = useRef<HTMLDivElement>(null);
  const evidence = useRef<HTMLTextAreaElement>(null);
  const dirty = editing && JSON.stringify(draft) !== JSON.stringify(baseline);
  const visible = editing ? draft : rows.find(row => row.id === record.id && row.kind === record.kind) ?? record;
  useEffect(() => { onScrollReset(); root.current?.querySelector<HTMLElement>("[data-initial-focus]")?.focus({ preventScroll: true }); }, [editing, onScrollReset]);
  useEffect(() => { if (pending) confirm.current?.querySelector<HTMLButtonElement>("button")?.focus(); }, [pending]);
  const guard = (action: () => void) => { if (saving) return; if (dirty) setPending(() => action); else action(); };
  const cancel = () => guard(() => { if (!record.id) { if (onBack) onBack(); else onClose(); return; } setDraft({ ...baseline }); setEditing(false); setLocalError(""); });
  const navigate = (value: RecordDraft) => guard(() => onNavigate(value));
  async function saveDraft(after?: () => void) {
    if (!draft.title.trim()) { setPending(null); setLocalError("请填写标题"); root.current?.querySelector<HTMLInputElement>('input[name="title"]')?.focus(); return; }
    if (draft.kind === "ticket" && draft.status === "done" && !draft.evidence?.trim()) { setPending(null); setLocalError("标记完成前请填写验收证据"); evidence.current?.focus(); return; }
    setLocalError("");
    try {
      if (await onSave(draft)) { setPending(null); if (after) after(); else onClose(); }
    } catch (failure) { setPending(null); setLocalError(failure instanceof Error ? failure.message : "保存失败，内容已保留"); }
  }
  const textField = (label: string, key: TextKey, help: string, multiline = true) => <div className="detail-field" key={key}>
    {editing ? <label>{label}{multiline ? <textarea ref={key === "evidence" ? evidence : undefined} value={draft[key] ?? ""} onChange={event => setDraft({ ...draft, [key]: event.target.value })} aria-required={key === "evidence" && draft.status === "done"} /> : <input list={key === "project" ? "projects" : undefined} value={draft[key] ?? ""} onChange={event => setDraft({ ...draft, [key]: event.target.value })} />}</label> : <><h4>{label}</h4><p className="preserve">{visible[key]?.trim() || "尚未填写"}</p></>}
    {help && <p className="form-help">{help}</p>}
  </div>;
  const selectField = (label: string, key: "priority" | "status" | "waitingReason" | "category" | "cadence", options: Record<string, string>, help = "") => <label>{label}<select value={draft[key] ?? ""} onChange={event => setDraft({ ...draft, [key]: event.target.value })}>{Object.entries(options).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select>{help && <span className="form-help">{help}</span>}</label>;
  const plans = rows.filter(row => row.kind === "plan" && row.ideaId === visible.id);
  const linkedTickets = rows.filter(row => row.kind === "ticket" && row.planId === visible.id);
  const idea = rows.find(row => row.kind === "idea" && row.id === visible.ideaId);
  const plan = rows.find(row => row.kind === "plan" && row.id === visible.planId);
  const job = { status: visible.planningStatus === "planned" ? "done" : visible.planningStatus ?? "unplanned", delivery: visible.planningDelivery, ...(planning.jobs.find(job => job.idea_id === visible.id && job.idea_revision === visible.revision) ?? visible.planning) };
  const controls = planningControls(job, now);
  const dependencySummary = [visible.dependencies?.trim() ? "有依赖" : "", visible.assumptions?.trim() ? "有假设与待确认信息" : ""].filter(Boolean).join(" · ");
  const openDependencies = () => { const details = root.current?.querySelector<HTMLDetailsElement>("[data-dependencies]"); if (details) { details.open = true; details.querySelector("summary")?.focus(); details.scrollIntoView({ block: "nearest" }); } };
  const newPlan = () => navigate({ ...newRecord("plan"), title: visible.title, project: visible.project, priority: visible.priority, ideaId: visible.id, ideaRevision: visible.revision, goal: visible.text || visible.title });
  const newTicket = () => navigate({ ...newRecord("ticket"), title: visible.title, project: visible.project, priority: visible.priority, planId: visible.id, ideaId: visible.ideaId, goal: visible.goal, scope: visible.scope, acceptance: visible.acceptance, allowedActions: visible.allowedActions, budget: visible.budget });
  const newRun = () => navigate({ ...newRecord("run"), title: visible.title, ticketId: visible.id, project: visible.project });
  const relation = visible.ideaRevision == null ? "来源修订未记录" : `来源点子 v${visible.ideaRevision}${idea ? idea.revision === visible.ideaRevision ? " · 当前修订" : ` · 当前点子为 v${idea.revision}` : ""}`;
  return <div ref={root} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); event.preventDefault(); if (pending) { setPending(null); root.current?.querySelector<HTMLElement>("[data-initial-focus]")?.focus(); } else guard(onClose); } }} onClick={event => event.stopPropagation()}>
    <header className="detail-header">
      <div><span className="eyebrow">{record.id ? `${record.kind.toUpperCase()} · v${visible.revision}` : `NEW ${record.kind.toUpperCase()}`}{editing ? " · 编辑" : " · 阅读"}</span><h2 id="dialog-title">{record.kind === "idea" ? "原始点子" : record.kind === "plan" ? "规划 Plan" : record.kind === "run" ? "记录已有执行" : "Ticket 详情"}</h2></div>
      <button data-initial-focus={!editing || undefined} className="icon-btn" aria-label="关闭" onClick={() => guard(onClose)} disabled={saving}><X /></button>
    </header>
    <form onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (editing) void saveDraft(); }}>
      <fieldset disabled={saving} className="detail-fields"><div className="detail-body">
        <div className="detail-basic">
          {onBack && <button type="button" className="text-btn" onClick={() => guard(onBack)} disabled={saving}>返回{record.kind === "ticket" && plan ? "计划" : "上一条记录"}</button>}
          {editing ? <><label>标题<input data-initial-focus name="title" required maxLength={250} value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} /></label><div className="detail-meta-edit">{record.kind !== "run" && <>{textField("项目", "project", "这条记录属于哪个项目。", false)}{selectField("优先级", "priority", priorities, "表示处理紧迫程度，不代表执行领取顺序。")}</>}</div></> : <><h3 className="detail-title">{visible.title}</h3><p>{visible.project || "通用"} · {visible.priority || "P2"}</p></>}
          {record.kind !== "idea" && record.kind !== "run" && <div className="detail-source">{visible.ideaId && <p>{relation}</p>}{record.kind === "ticket" && <>{plan ? <button type="button" className="text-btn" onClick={() => navigate(plan)}>查看来源计划：{plan.title}</button> : <p>{visible.planId ? "关联计划不可用" : "独立任务"}</p>}</>}</div>}
        </div>
        {record.kind === "idea" ? <>
          <section className="detail-section"><h3>原文</h3>{textField("原始内容", "text", "保留最初的想法、背景和上下文。")}</section>
          {record.id && <><section className="detail-section"><h3>规划进度</h3><PlanningStatus job={job} now={now} compact />{controls.label !== "查看结果" && <button type="button" className="secondary" disabled={saving || controls.disabled || editing} onClick={() => void onRequestPlan(visible as Row)}>{controls.label}</button>}</section>
          <section className="detail-section"><h3>关联结果</h3>{plans.length ? plans.map(result => <button className="related-record" type="button" key={result.id} data-related-record={result.id} onClick={() => navigate(result)}><span>{result.title}</span><small>{result.ideaRevision === visible.revision ? `当前点子修订 v${visible.revision}` : result.ideaRevision == null ? "来源修订未记录" : `旧修订 v${result.ideaRevision}`} · {rows.filter(row => row.kind === "ticket" && row.planId === result.id).length} 个任务</small></button>) : <p>尚无关联计划，当前修订尚未产生可查看结果。</p>}<button type="button" className="secondary" onClick={newPlan} disabled={saving || editing}>手工整理</button></section></>}
        </> : record.kind === "run" ? <section className="detail-section"><h3>记录已有执行</h3><p className="form-help">保存时冻结当前 Ticket 修订；这里保存已有执行的手工快照，不会启动 Agent 或授予执行授权。</p>{textField("执行过程与证据", "evidence", "填写命令、日志摘要、交付链接与实际结果。")}</section> : <>
          <section className="detail-section"><h3>{record.kind === "plan" ? "要解决的问题" : "做什么"}</h3>{textField("目标", "goal", "说明希望解决的问题与期望结果。")}{textField("范围与边界", "scope", "明确这次工作覆盖的内容和边界。")}</section>
          <section className="detail-section"><h3>{record.kind === "plan" ? "完成标准" : "怎样算完成"}</h3>{textField("验收标准", "acceptance", "列出可以检查的完成条件。")}{record.kind === "ticket" && (editing || visible.status === "done" || visible.evidence?.trim()) && textField("验收证据（完成时必填）", "evidence", "提供支持完成结论的实际结果、测试输出或交付链接。")}</section>
          {record.kind === "plan" ? <section className="detail-section related-tickets"><h3>拆分任务</h3>{record.id ? <>{linkedTickets.length ? linkedTickets.map(ticket => <button className="related-record" type="button" key={ticket.id} data-related-record={ticket.id} onClick={() => navigate(ticket)}><span>{ticket.title}<small>{ticket.goal}</small></span><small>{statuses[ticket.status ?? "todo"] ?? ticket.status}</small></button>) : <p>尚未拆分 Ticket。</p>}<button className="secondary" type="button" onClick={newTicket} disabled={saving || editing}>拆分 Ticket</button></> : <p>保存计划后可以建立关联任务。</p>}</section> : <section className="detail-section"><h3>当前进度</h3>{editing ? <>{selectField("状态", "status", statuses)}{draft.status === "waiting" && selectField("等待原因", "waitingReason", reasons)}</> : <><p>手工跟进状态：{statuses[visible.status ?? "todo"] ?? visible.status}</p>{visible.status === "waiting" && <p className="wait-tag">等待原因：{reasons[visible.waitingReason ?? "clarification"] ?? visible.waitingReason}</p>}</>}<p className="form-help">手工状态记录任务跟进进度；本机开发 Run 的申请、批准、运行与验收，以及固定 Docker 操作，均使用独立执行流程。</p>{record.id && <><button type="button" className="secondary" onClick={newRun} disabled={saving || editing}>记录已有执行</button>{renderExecution && !editing && (showExecution ? renderExecution(visible as Row) : <button type="button" className="secondary" disabled={saving} onClick={() => setShowExecution(true)}>执行此任务</button>)}</>}</section>}
          {!!dependencySummary && <div className="detail-hint"><strong>{dependencySummary}</strong>{visible.dependencies?.trim() && <p>依赖：{visible.dependencies.trim().split("\n").find(Boolean)}</p>}{visible.assumptions?.trim() && <p>假设：{visible.assumptions.trim().split("\n").find(Boolean)}</p>}<button type="button" className="text-btn" onClick={openDependencies}>展开依赖与假设</button></div>}
          <details className="origin" data-dependencies><summary>依赖与假设</summary>{textField("依赖 Ticket / 外部条件", "dependencies", "记录推进前需要完成的任务或满足的外部条件。")}{textField("假设与待确认问题", "assumptions", "记录方案成立的前提与仍需确认的问题。")}</details>
          <details className="origin"><summary>执行约定</summary>{textField("允许的操作", "allowedActions", "填写操作范围；实际执行权限以独立审批结果为准。")}{textField("预算 / 限额", "budget", "填写预期投入或限额；实际资源约束以执行申请的有效预算为准。", false)}</details>
          {record.kind === "ticket" && <details className="origin"><summary>任务设置</summary>{textField("执行队列", "queue", "记录队列名称；实际领取顺序以执行接口为准。", false)}{editing ? <>{selectField("业务分类", "category", { general: "通用", recruitment: "求职" }, "为任务标注业务领域。")}{selectField("执行类型", "cadence", { one_off: "一次性", recurring: "周期性（尚未调度）" }, "标注意图；周期性字段不会启用调度。")}</> : <><p className="form-help">业务分类标注任务领域，执行类型标注意图，均不授予执行权限。</p><p>业务分类：{visible.category === "recruitment" ? "求职" : visible.category === "general" ? "通用" : visible.category || "尚未填写"}</p><p>执行类型：{visible.cadence === "recurring" ? "周期性（尚未调度）" : visible.cadence === "one_off" ? "一次性" : visible.cadence || "尚未填写"}</p></>}</details>}
          <details className="origin"><summary>补充说明</summary>{textField("补充说明", "notes", "记录帮助理解任务与协作的补充背景。")}</details>
        </>}
        {record.id && <details className="origin"><summary>来源与历史</summary><p>标识：{visible.id}</p><p>修订：v{visible.revision} · 来源：{visible.source || "未记录"}</p>{visible.logicalKey && <p>逻辑标识：{visible.logicalKey}</p>}<p>创建：{visible.created} · 更新：{visible.updated}</p>{visible.planId && <p>计划标识：{visible.planId}</p>}{visible.ideaId && <><p>点子标识：{visible.ideaId} · {relation}</p>{idea ? <><button type="button" className="text-btn" onClick={() => navigate(idea)}>查看原始点子</button><p className="preserve">当前点子 v{idea.revision}：{idea.text || idea.title}</p></> : <p>来源点子不可用。</p>}</>}{rows.filter(row => row.kind === "history" && row.recordId === visible.id).map(history => <p className="preserve" key={history.id}>v{history.previousRevision} · {history.created}<br />{history.snapshot?.title}<br />{history.snapshot?.goal || history.snapshot?.text}</p>)}{!rows.some(row => row.kind === "history" && row.recordId === visible.id) && <p>尚无修订历史。</p>}</details>}
      </div>
      <footer className="modal-footer">{(localError || error) && <p className="form-error" role="alert">{localError || error}</p>}<span />{editing ? <><button type="button" className="secondary" disabled={saving} onClick={cancel}>取消编辑</button><button type="submit" key="save-record" className="primary" disabled={saving}>{saving ? "保存中…" : "保存到本地"}</button></> : <><button type="button" className="secondary" disabled={saving} onClick={() => guard(onClose)}>返回列表</button><button type="button" key="edit-record" className="primary" disabled={saving} onClick={() => { setBaseline({ ...visible }); setDraft({ ...visible }); setEditing(true); }}>编辑</button></>}</footer></fieldset>
    </form>
    {pending && <div className="unsaved-dialog" role="alertdialog" aria-modal="true" aria-labelledby="unsaved-title" data-unsaved-dialog ref={confirm}><h3 id="unsaved-title">保留未保存的修改？</h3><p>这条记录有未保存内容，可以保存后继续、放弃修改，或继续编辑。</p><div><button type="button" className="secondary" disabled={saving} onClick={() => { setPending(null); root.current?.querySelector<HTMLElement>("[data-initial-focus]")?.focus(); }}>继续编辑</button><button type="button" className="secondary" disabled={saving} onClick={() => { const action = pending; setPending(null); action(); }}>放弃修改</button><button type="button" className="primary" disabled={saving} onClick={() => void saveDraft(pending)}>保存后继续</button></div></div>}
  </div>;
}
