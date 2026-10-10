"use client";
import { useEffect, useState, useRef, useCallback } from "react";
import {TicketBoard} from "../components/board/ticket-board";
import {TicketCard} from "../components/board/ticket-card";
import {TicketActionDialog} from "../components/board/ticket-action-dialog";
import {sortTickets,filterTickets,defaultTicketSort} from "../lib/tickets/selectors.mts";
import type {TicketSort} from "../lib/tickets/selectors.mts";
import { PlanningStatus, planningControls } from "../components/planning-status";
import { AuthorizationPanel } from "../components/execution/authorization-panel";
import { ConnectionPanel } from "../components/connectors/connection-panel";
import { DevelopmentPanel } from "../components/workspace-runs/development-panel";
import type { FormEvent } from "react";
import { TicketExecutionPanel } from "../components/ticket-execution/ticket-execution-panel";
import { RecordDetails } from "../components/record-details/record-details";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import type {
  Row,
  RecordDraft,
  PlanningState,
  JobRow,
  SessionState,
} from "../lib/types";
import {
  Lightbulb,
  Inbox,
  LayoutGrid,
  History,
  Plug,
  Plus,
  Search,
  Check,
  ChevronRight,
  FileText,
  ArrowUpRight,
  RefreshCw,
  SlidersHorizontal,
  Layers,
  AlertCircle,
} from "lucide-react";
const statuses: Record<string, string> = {
  todo: "待开始",
  running: "进行中",
  waiting: "等待中",
  done: "已完成",
  error: "异常",
};
const reasons: Record<string, string> = {
  clarification: "需要澄清",
  approval: "需要授权",
  review: "等待验收",
  external: "外部依赖",
  recovery: "恢复确认",
};
function empty(kind: string): RecordDraft {
  return {
    kind,
    title: "",
    text: "",
    project: "通用",
    priority: "P2",
    status: "todo",
    planningStatus: "unplanned",
    goal: "",
    scope: "",
    acceptance: "",
    dependencies: "",
    queue: "default",
    budget: "",
    allowedActions: "",
    assumptions: "",
    category: "general",
    cadence: "one_off",
    waitingReason: "clarification",
    evidence: "",
    notes: "",
    ideaId: "",
    planId: "",
  };
}
export default function Home() {
  const [rows, setRows] = useState<Row[]>([]),
    [projects, setProjects] = useState<string[]>([]),
    [view, setView] = useState("inbox"),
    [query, setQuery] = useState(""),
    [project, setProject] = useState("全部项目"),
    [stateFilter, setStateFilter] = useState("all"),
    [list, setList] = useState(false),
    [loading, setLoading] = useState(true),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [draft, setDraft] = useState<RecordDraft | null>(null),
    [capture, setCapture] = useState(""),
    [captureProject, setCaptureProject] = useState("通用"),
    [planning, setPlanning] = useState<PlanningState>({
      jobs: [],
      subscriptions: 0,
    });
  const [ticketSort,setTicketSort]=useState<TicketSort>(defaultTicketSort);
  const [boardAction,setBoardAction]=useState<{ticket:Row;target:string}|null>(null);
  const [planningNow, setPlanningNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setPlanningNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const [session, setSession] = useState<SessionState | null>(null);
  const [accountVersion, setAccountVersion] = useState(0);
  const sessionRef = useRef<SessionState | null>(null);
  const expiryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const identityVersion = useRef(0);
  const loadSequence = useRef(0);
  const captureProjectExplicit = useRef(false);
  function selectProject(value: string) {
    setProject(value);
    if (!captureProjectExplicit.current)
      setCaptureProject(value === "全部项目" ? "通用" : value);
  }
  const clearPrivateState = useCallback(() => {
    identityVersion.current++;
    setAccountVersion(identityVersion.current);
    setRows([]);
    setProjects([]);
    captureProjectExplicit.current = false;
    setBoardAction(null);
    setTicketSort(defaultTicketSort);
    setPlanning({ jobs: [], subscriptions: 0 });
    setDraft(null);
    setCapture("");
    setCaptureProject("通用");
    setQuery("");
    setProject("全部项目");
    setStateFilter("all");
    setView("inbox");
    setList(false);
    setNotice("");
    setSaving(false);
  }, []);
  const expireSession = useCallback(() => {
    ++loadSequence.current;
    if (expiryTimer.current) clearTimeout(expiryTimer.current);
    sessionRef.current = null;
    setSession(null);
    clearPrivateState();
    setLoading(false);
    setError("登录已失效或无权访问，请重新登录");
  }, [clearPrivateState]);
  const authenticationDenied = useCallback(
    (response: Response) => {
      if (response.status !== 401 && response.status !== 403) return false;
      expireSession();
      return true;
    },
    [expireSession],
  );
  const accountId = session?.user.userId;
  const panelAuthenticationDenied = useCallback(() => {
    if (
      identityVersion.current === accountVersion &&
      sessionRef.current?.user.userId === accountId
    ) {
      expireSession();
    }
  }, [accountId, accountVersion, expireSession]);
  const projectCatalogChanged = useCallback((entries: { name: string }[]) => {
    if (identityVersion.current === accountVersion && sessionRef.current?.user.userId === accountId)
      setProjects(entries.map(entry => entry.name));
  }, [accountId, accountVersion]);
  const load = useCallback(
    async (silent = false) => {
      const seq = ++loadSequence.current;
      if (!silent) setLoading(true);
      try {
        const sr = await fetch("/api/session", { cache: "no-store" });
        if (seq !== loadSequence.current) return;
        if (authenticationDenied(sr)) return;
        if (!sr.ok) throw Error("账户服务暂时不可用，请稍后重试");
        const next = (await sr.json()) as SessionState;
        if (seq !== loadSequence.current) return;
        if (next.expiresAt !== null && next.expiresAt <= Date.now()) {
          expireSession();
          return;
        }
        if (sessionRef.current?.user.userId !== next.user.userId)
          clearPrivateState();
        sessionRef.current = next;
        setSession(next);
        if (expiryTimer.current) clearTimeout(expiryTimer.current);
        expiryTimer.current =
          next.expiresAt === null
            ? null
            : setTimeout(expireSession, next.expiresAt - Date.now());
        const [r, pr] = await Promise.all(
          ["/api/records", "/api/planning"].map(async (url) => {
            const response = await fetch(url, { cache: "no-store" });
            // A sibling may fail or never finish; process current denials immediately.
            if (seq === loadSequence.current) authenticationDenied(response);
            return response;
          }),
        );
        if (seq !== loadSequence.current) return;
        const d = (await r.json()) as { records: Row[]; projects: { name: string }[]; error?: string },
          pd = (await pr.json()) as PlanningState;
        if (!r.ok) throw Error(d.error);
        if (!pr.ok) throw Error(pd.error);
        if (seq === loadSequence.current) {
          setRows(d.records);
          setProjects(d.projects.map(entry => entry.name));
          setPlanning(pd);
          setError("");
        }
      } catch (e) {
        if (seq === loadSequence.current)
          setError(e instanceof Error ? e.message : "无法连接本地");
      } finally {
        if (seq === loadSequence.current) setLoading(false);
      }
    },
    [authenticationDenied, clearPrivateState, expireSession],
  );
  useEffect(() => {
    const sequence = loadSequence;
    const startup = window.setTimeout(() => {
      void load();
    }, 0);
    const refresh = () => {
      if (document.visibilityState === "visible") load(true);
    };
    const timer = window.setInterval(refresh, 10000);
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      ++sequence.current;
      if (expiryTimer.current) clearTimeout(expiryTimer.current);
      window.clearTimeout(startup);
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load]);
  function openPlan(idea: Row) {
    const plan = rows.find(r => r.kind === "plan" && r.ideaId === idea.id && r.ideaRevision === idea.revision)
      || rows.find(r => r.kind === "plan" && r.id === idea.planId && r.ideaId === idea.id);
    if (plan) setDraft({ ...plan });
    else setError("当前点子尚无可查看的关联计划");
  }
  async function save(value: RecordDraft, reportFailure = false) {
    const version = identityVersion.current;
    setSaving(true);
    setError("");
    try {
      const r = await fetch("/api/records", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(value),
      });
      if (version !== identityVersion.current || authenticationDenied(r))
        return null;
      const d = (await r.json()) as {
        id: string;
        revision: number;
        error?: string;
      };
      if (!r.ok) throw Error(d.error);
      if (version !== identityVersion.current) return null;
      await load();
      if (version !== identityVersion.current) return null;
      setNotice("已保存到本地");
      setTimeout(() => setNotice(""), 3500);
      return d;
    } catch (e) {
      if (version === identityVersion.current)
        setError(e instanceof Error ? e.message : "保存失败，内容已保留");
      if (reportFailure && version === identityVersion.current) throw e;
      return null;
    } finally {
      if (version === identityVersion.current) setSaving(false);
    }
  }
  async function quickCapture(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!capture.trim()) return;
    const d = await save({
      ...empty("idea"),
      title: capture.trim().split("\n")[0].slice(0, 100),
      text: capture.trim(),
      project: captureProject,
    });
    if (d) {
      setCapture("");
      captureProjectExplicit.current = false;
      setCaptureProject(project === "全部项目" ? "通用" : project);
    }
  }
  async function requestPlan(idea: Row) {
    const version = identityVersion.current;
    setSaving(true);
    try {
      const r = await fetch("/api/planning", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ideaId: idea.id }),
      });
      if (version !== identityVersion.current || authenticationDenied(r))
        return;
      const d = (await r.json()) as {
        job: Pick<JobRow, "status" | "delivery">;
        error?: string;
      };
      if (!r.ok) throw Error(d.error);
      if (version !== identityVersion.current) return;
      await load();
      if (version !== identityVersion.current) return;
      setNotice(
        d.job.status === "done"
          ? "这条点子已经规划完成，可以查看 Plan 和 Tickets"
          : d.job.status === "planning"
            ? "Agent 正在处理，页面会自动更新"
            : d.job.delivery === "accepted"
              ? "请求已送达，页面会自动更新规划结果"
              : d.job.delivery === "no_subscription"
                ? "规划请求已保存；需要先连接插件并订阅事件"
                : "规划请求已保存，投递未完成，可重试",
      );
      setTimeout(() => setNotice(""), 6000);
    } catch (e) {
      if (version === identityVersion.current)
        setError(e instanceof Error ? e.message : "请求失败");
    } finally {
      if (version === identityVersion.current) setSaving(false);
    }
  }
  function createPlan(idea: Row) {
    setDraft({
      ...empty("plan"),
      title: idea.title,
      project: idea.project,
      priority: idea.priority,
      ideaId: idea.id,
      ideaRevision: idea.revision,
      goal: idea.text || idea.title,
    });
  }
  function createTicket(plan?: Row) {
    setDraft({
      ...empty("ticket"),
      title: plan?.title || "",
      project: plan?.project || "通用",
      priority: plan?.priority || "P2",
      planId: plan?.id || "",
      ideaId: plan?.ideaId || "",
      goal: plan?.goal || "",
      scope: plan?.scope || "",
      acceptance: plan?.acceptance || "",
      allowedActions: plan?.allowedActions || "",
      budget: plan?.budget || "",
    });
  }
  const ideas = rows.filter((r) => r.kind === "idea"),
    plans = rows.filter((r) => r.kind === "plan"),
    tickets = rows.filter((r) => r.kind === "ticket"),
    runs = rows.filter((r) => r.kind === "run");
  const waiting = tickets.filter((r) => r.status === "waiting");
  const filtered = (items: Row[]) =>
    items.filter(
      (r) =>
        (project === "全部项目" || (r.project || "通用") === project) &&
        (!query ||
          [r.title, r.text, r.goal, r.project, r.id, r.planId, r.ideaId]
            .join(" ")
            .toLowerCase()
            .includes(query.toLowerCase())) &&
        (stateFilter === "all" || r.status === stateFilter),
    );
  const titles: Record<string, string> = {
    inbox: "点子收件箱",
    plans: "规划工作台",
    board: "Ticket 看板",
    review: "待我处理",
    runs: "执行记录",
    integrations: "连接与执行",
  };
  const descriptions: Record<string, string> = {
    inbox: "先记下来，让每一个想法都有下一步。",
    plans: "明确目标、边界与验收，再拆成可执行任务。",
    board: "从待开始到已完成，跟进每一步。",
    review: "集中处理澄清、授权、验收和外部依赖。",
    runs: "保留执行时的任务版本与验收证据。",
    integrations: "安装 MCP、关联 workspace，查看真实连接与 Agent 状态。",
  };
  const visibleTickets=sortTickets(filterTickets(tickets,{project,query,status:stateFilter}),ticketSort);
  const openBoardIntent=(ticket:Row,target:string)=>{if(target!==ticket.status)setBoardAction({ticket,target});};
  const openBoardExecution=(ticket:Row)=>setBoardAction({ticket,target:"execute"});
  function ticketCard(ticket:Row){return <TicketCard key={ticket.id} ticket={ticket} onDetails={ticket=>setDraft({...ticket})} onIntent={openBoardIntent} onExecute={openBoardExecution}/>;}
  return (
    <div className="app">
      <aside className="sidebar">
        <Link
          className="brand"
          href="/"
          onNavigate={(event) => {
            // Home is already mounted; reset its workspace without an RSC navigation.
            event.preventDefault();
            setView("inbox");
            setQuery("");
            setProject("全部项目");
            setStateFilter("all");
            setList(false);
            setDraft(null);
            setCapture("");
            setCaptureProject("通用");
            captureProjectExplicit.current = false;
            setNotice("");
            setError("");
            void load();
          }}
        >
          <span className="brand-icon">
            <Layers size={23} />
          </span>
          <span>
            点子工坊<small>AGENT TASK HUB</small>
          </span>
        </Link>
        <div className="workspace">
          <span className="avatar">W</span>
          <div>
            个人工作区<small>从想法到行动</small>
          </div>
        </div>
        <span className="nav-label">工作台</span>
        <nav>
          {(
            [
              ["inbox", "点子收件箱", Inbox, ideas.length],
              ["plans", "规划工作台", FileText, plans.length],
              ["board", "Ticket 看板", LayoutGrid, tickets.length],
              ["review", "待我处理", AlertCircle, waiting.length],
              ["runs", "执行记录", History, runs.length],
            ] as [string, string, LucideIcon, number][]
          ).map(([key, label, Icon, count]) => (
            <button
              key={key}
              className={view === key ? "active" : ""}
              onClick={() => {
                setView(key);
                setStateFilter("all");
              }}
            >
              <Icon size={19} />
              <span>{label}</span>
              <em>{count}</em>
            </button>
          ))}
        </nav>
        <span className="nav-label">项目</span>
        <div className="project-list">
          <button
            className={project === "全部项目" ? "selected" : ""}
            onClick={() => selectProject("全部项目")}
          >
            <span className="project-square" />
            全部项目
          </button>
          {projects.map((p) => (
            <button
              key={p}
              className={project === p ? "selected" : ""}
              onClick={() => selectProject(p)}
            >
              <span className="project-square" />
              {p}
            </button>
          ))}
        </div>
        <div className="sidebar-bottom">
          <button onClick={() => setView("integrations")}>
            <Plug size={18} />
            连接与执行
          </button>
          <p>
            原始想法始终保留
            <br />
            任务有边界，结果有证据
          </p>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <div className="breadcrumb">
            工作台 <ChevronRight size={15} /> <strong>{titles[view]}</strong>
          </div>
          <div className="top-actions">
            <span className="private-badge">个人工作区</span>
            <button
              className="icon-btn"
              aria-label="刷新数据"
              onClick={() => load()}
            >
              <RefreshCw size={17} className={loading ? "spin" : ""} />
            </button>
            {session ? (
              <>
                <span aria-label="当前账户">
                  <span>{session.user.displayName}</span>
                  <small> · 本地账户</small>
                </span>
                <span className="avatar small" aria-label="账户缩写">
                  {session.user.displayName
                    .trim()
                    .split(/\s+/)
                    .slice(0, 2)
                    .map((part) => Array.from(part)[0])
                    .join("")
                    .toUpperCase()}
                </span>
                <form method="post" action="/api/auth/logout">
                  <button type="submit">退出登录</button>
                </form>
              </>
            ) : (
              !loading && <a href="/signin?return_to=%2F">登录</a>
            )}
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <span className="eyebrow">CAPTURE. CLARIFY. SHIP.</span>
              <h1>{titles[view]}</h1>
              <p>{descriptions[view]}</p>
            </div>
            <button
              className="primary"
              onClick={() =>
                view === "inbox"
                  ? setDraft({ ...empty("idea"), project: project === "全部项目" ? "通用" : project })
                  : view === "plans"
                    ? setDraft({ ...empty("plan"), project: project === "全部项目" ? "通用" : project })
                    : createTicket()
              }
            >
              <Plus size={18} />
              {view === "inbox"
                ? "新点子"
                : view === "plans"
                  ? "新建 Plan"
                  : "新建 Ticket"}
            </button>
          </div>
          {error && (
            <div className="alert" role="alert">
              <AlertCircle size={18} />
              {error}
              <button onClick={() => load()}>重新加载</button>
            </div>
          )}
          {notice && (
            <div className="toast" role="status">
              <Check size={17} />
              {notice}
            </div>
          )}
          <div className="metrics">
            <div>
              <span>收集的点子</span>
              <strong>
                {ideas.length}
                <small>个想法</small>
              </strong>
            </div>
            <div>
              <span>待推进任务</span>
              <strong>
                {
                  tickets.filter(
                    (t) => t.status === "todo" || t.status === "running",
                  ).length
                }
                <small>个 Ticket</small>
              </strong>
            </div>
            <div>
              <span>需要你的处理</span>
              <strong className={waiting.length ? "amber" : ""}>
                {waiting.length}
                <small>项等待</small>
              </strong>
            </div>
            <div>
              <span>已完成</span>
              <strong>
                {tickets.filter((t) => t.status === "done").length}
                <small>项交付</small>
              </strong>
            </div>
          </div>
          {view === "inbox" && (
            <form className="capture" onSubmit={quickCapture}>
              <div className="capture-title">
                <span className="bulb">
                  <Lightbulb size={20} />
                </span>
                <strong>现在有什么点子？</strong>
                <span>不必想完整，先留下原话</span>
              </div>
              <textarea
                aria-label="快速记录点子"
                placeholder="我想做一个…… / 发现一个问题…… / 下次可以试试……"
                value={capture}
                onChange={(e) => setCapture(e.target.value)}
                required
              />
              <div className="capture-footer">
                <label>
                  项目
                  <input
                    aria-label="点子所属项目"
                    value={captureProject}
                    onChange={(e) => {
                      captureProjectExplicit.current = true;
                      setCaptureProject(e.target.value);
                    }}
                    list="projects"
                  />
                </label>
                <span>保存后发出 Agent 规划请求</span>
                <button
                  className="primary"
                  disabled={saving || !capture.trim()}
                >
                  <Plus size={16} />
                  {saving ? "保存中…" : "收集点子"}
                </button>
              </div>
            </form>
          )}
          {!["integrations"].includes(view) && (
            <div className="toolbar">
              <div className="tabs">
                <strong>
                  {view === "inbox"
                    ? "所有点子"
                    : view === "plans"
                      ? "所有规划"
                      : view === "board"
                        ? "任务进度"
                        : view === "review"
                          ? "等待队列"
                          : "记录列表"}
                </strong>
                <span>
                  {
                    view === "board" ? visibleTickets.length : filtered(
                      view === "inbox"
                        ? ideas
                        : view === "plans"
                          ? plans
                          : view === "runs"
                            ? runs
                            : view === "review"
                              ? waiting
                              : tickets,
                    ).length
                  }
                </span>
              </div>
              <div className="filters">
                <label className="search">
                  <Search size={16} />
                  <input
                    aria-label="搜索"
                    placeholder="搜索标题、项目…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </label>
                <select
                  aria-label="项目筛选"
                  value={project}
                  onChange={(e) => selectProject(e.target.value)}
                >
                  <option>全部项目</option>
                  {projects.map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
                {view === "board" && (
                  <>
                    <select
                      aria-label="状态筛选"
                      value={stateFilter}
                      onChange={(e) => setStateFilter(e.target.value)}
                    >
                      <option value="all">全部状态</option>
                      {Object.entries(statuses).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                    </select>
                    <select aria-label="任务排序" value={ticketSort.field} onChange={event=>setTicketSort({...ticketSort,field:event.target.value as TicketSort["field"]})}><option value="created">创建时间</option><option value="updated">更新时间</option><option value="priority">优先级（仅展示）</option></select>
                    <select aria-label="排序方向" value={ticketSort.direction} onChange={event=>setTicketSort({...ticketSort,direction:event.target.value as TicketSort["direction"]})}><option value="desc">{ticketSort.field==="priority"?"低到高":"新到旧"}</option><option value="asc">{ticketSort.field==="priority"?"高到低":"旧到新"}</option></select>
                    <button
                      className="icon-btn"
                      aria-label="切换列表或看板"
                      title="切换列表或看板"
                      onClick={() => setList(!list)}
                    >
                      <SlidersHorizontal size={17} />
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
          {loading && rows.length === 0 ? (
            <div className="empty">正在读取本地工作区…</div>
          ) : (
            <>
              {view === "inbox" && (
                <div className="idea-grid">
                  {filtered(ideas).map((i) => {
                    const linked = plans.filter(
                      (p) =>
                        p.id === i.planId ||
                        (p.ideaId === i.id && p.ideaRevision === i.revision),
                    );
                    const metadata = planning.jobs.find(
                      (j) =>
                        j.idea_id === i.id && j.idea_revision === i.revision,
                    ) || i.planning;
                    const job = {
                      status:
                        i.planningStatus === "planned"
                          ? "done"
                          : i.planningStatus || "unplanned",
                      delivery: i.planningDelivery,
                      ...metadata,
                    };
                    const controls = planningControls(job, planningNow);
                    return (
                      <article className="idea-card" key={i.id}>
                        <div className="card-top">
                          <span className="project-tag">{i.project}</span>
                          <span className="muted">
                            {new Date(i.created).toLocaleDateString("zh-CN", {
                              month: "short",
                              day: "numeric",
                            })}
                          </span>
                        </div>
                        <button
                          className="title-button"
                          onClick={() => setDraft({ ...i })}
                        >
                          <h3>{i.title}</h3>
                        </button>
                        <p className="idea-text">{i.text}</p>
                        <PlanningStatus job={job} now={planningNow} compact />
                        {job.delivery === "no_subscription" && job.status !== "done" && (
                          <div className="planning-next-step">
                            <p>点子已保存。接入「{i.project || "通用"}」项目的 Agent 后会自动领取规划；也可以先手工整理成 Plan。</p>
                            <button className="secondary" type="button" onClick={() => {
                              setProject(i.project || "通用");
                              setQuery("");
                              setView("integrations");
                            }}>接入项目 Agent</button>
                          </div>
                        )}
                        <div className="idea-footer">
                          <button
                            className="text-btn"
                            disabled={!linked.length}
                            onClick={() => openPlan(i)}
                          >
                            {linked.length
                              ? `${linked.length} 个 Plan · ${tickets.filter((t) => linked.some((p) => p.id === t.planId)).length} 个 Tickets`
                              : "尚未整理"}
                          </button>
                          <button
                            className="text-btn"
                            onClick={() => createPlan(i)}
                          >
                            手工整理
                          </button>
                          <button
                            className="text-btn"
                            disabled={saving || controls.disabled}
                            onClick={() =>
                              job?.status === "done"
                                ? openPlan(i)
                                : requestPlan(i)
                            }
                          >
                            {controls.label}{" "}
                            <ArrowUpRight size={16} />
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
              {view === "plans" && (
                <div className="idea-grid">
                  {filtered(plans).map((p) => (
                    <article className="idea-card" key={p.id}>
                      <div className="card-top">
                        <span className="project-tag">{p.project}</span>
                        <span className="id">PLAN · v{p.revision}</span>
                      </div>
                      <button
                        className="title-button"
                        onClick={() => setDraft({ ...p })}
                      >
                        <h3>{p.title}</h3>
                      </button>
                      {p.ideaId &&
                        p.ideaRevision !== undefined &&
                        (() => {
                          const sourceIdea = ideas.find(
                            (idea) => idea.id === p.ideaId,
                          );
                          return (
                            <p className="planning-status">
                              {!sourceIdea
                                ? "来源点子不可用"
                                : sourceIdea.revision === p.ideaRevision
                                  ? `来源点子 v${p.ideaRevision} · 当前版本`
                                  : `已过期 · 点子 v${p.ideaRevision} / 当前 v${sourceIdea.revision}`}
                            </p>
                          );
                        })()}
                      <p className="idea-text">{p.goal}</p>
                      <div className="idea-footer">
                        <button
                          className="text-btn"
                          onClick={() => {
                            setView("board");
                            setProject("全部项目");
                            setStateFilter("all");
                            setQuery(p.id);
                          }}
                        >
                          查看 {tickets.filter((t) => t.planId === p.id).length}{" "}
                          个 Tickets
                        </button>
                        <button
                          className="text-btn"
                          onClick={() => createTicket(p)}
                        >
                          拆分 Ticket <Plus size={16} />
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
              {view === "board" && filtered(tickets).length === 0 && (
                <div className="empty">
                  <h3>{query || project !== "全部项目" ? "没有匹配的 Ticket" : "先把想法变成一个 Ticket"}</h3>
                  <p>从点子整理目标、范围和验收，再拆成任务；已有明确任务也可以直接创建。</p>
                  <div className="card-actions">
                    <button className="primary" type="button" onClick={() => { setQuery(""); setView("inbox"); }}>从点子开始</button>
                    <button className="secondary" type="button" onClick={() => setDraft({ ...empty("ticket"), project: project === "全部项目" ? "通用" : project })}>创建第一个 Ticket</button>
                  </div>
                </div>
              )}
              {view === "board" && <TicketBoard tickets={visibleTickets} list={list} statusFilter={stateFilter} onDetails={ticket=>setDraft({...ticket})} onIntent={openBoardIntent} onExecute={openBoardExecution}/>}
              {view === "review" && (
                <div className="idea-grid">
                  {filtered(waiting).map(ticketCard)}
                </div>
              )}
              {view === "runs" && (
                <div className="run-list">
                  {filtered(runs).map((r) => (
                    <article className="idea-card" key={r.id}>
                      <div className="card-top">
                        <span className="project-tag">手工记录</span>
                        <span className="muted">
                          {new Date(r.created).toLocaleString("zh-CN")}
                        </span>
                      </div>
                      <h3>{r.title}</h3>
                      <p>
                        Ticket 版本 v{r.ticketRevision} · {r.contract?.project}
                      </p>
                      <p className="preserve">{r.evidence || "未填写证据"}</p>
                      <details>
                        <summary>查看冻结的任务约定</summary>
                        <p className="preserve">
                          目标：{r.contract?.goal}
                          <br />
                          边界：{r.contract?.scope}
                          <br />
                          验收：{r.contract?.acceptance}
                        </p>
                      </details>
                    </article>
                  ))}
                </div>
              )}
              {!["board", "integrations"].includes(view) &&
                filtered(
                  view === "inbox"
                    ? ideas
                    : view === "plans"
                      ? plans
                      : view === "runs"
                        ? runs
                        : waiting,
                ).length === 0 && (
                  <div className="empty">
                    <span className="empty-icon">
                      {view === "inbox" ? (
                        <Lightbulb size={28} />
                      ) : (
                        <Layers size={28} />
                      )}
                    </span>
                    <h3>
                      {query || project !== "全部项目"
                        ? "没有匹配的记录"
                        : view === "inbox"
                          ? "第一个好点子，从这里开始"
                          : view === "plans"
                            ? "把点子整理成清晰的行动计划"
                            : view === "review"
                              ? "暂时没有需要处理的等待项"
                              : "还没有执行记录"}
                    </h3>
                    <p>
                      {view === "inbox"
                        ? "在上方随手记下想法，之后再慢慢完善。"
                        : view === "plans"
                          ? "从点子收件箱整理，或新建一个 Plan。"
                          : view === "review"
                            ? "需要澄清、授权或验收的任务会出现在这里。"
                            : "在 Ticket 详情中追加真实的执行证据。"}
                    </p>
                  </div>
                )}
              {view === "board" && (
                <details className="workspace-section">
                <summary>固定 Docker 操作与独立执行授权</summary>
                <AuthorizationPanel
                  key={session?.user.userId ?? "anonymous"}
                  tickets={tickets}
                  onAuthenticationDenied={panelAuthenticationDenied}
                />
                </details>
              )}
              {["board", "review", "runs"].includes(view) && (
                <details className="workspace-section" open={tickets.length > 0}>
                <summary>本机 Agent 开发执行 · 申请、进度与验收</summary>
                <DevelopmentPanel
                  key={session?.user.userId ?? "anonymous"}
                  tickets={tickets}
                  project={project}
                  onAuthenticationDenied={panelAuthenticationDenied}
                  onRecordsChanged={() => void load(true)}
                />
                </details>
              )}
              {view === "integrations" && (
                <ConnectionPanel
                  key={session?.user.userId ?? "anonymous"}
                  projects={projects}
                  initialProject={project === "全部项目" ? "通用" : project}
                  onProjectsChanged={projectCatalogChanged}
                  onAuthenticationDenied={panelAuthenticationDenied}
                />
              )}
            </>
          )}
          <footer className="main-footer">
            <span>IDEA → PLAN → TICKET → EVIDENCE</span>
            <span>
              每 10 秒自动刷新 ·{" "}
              {planning.subscriptions > 0
                ? "规划事件已订阅 · MCP 与 Agent 状态见连接与执行"
                : "MCP 与 Agent 状态见连接与执行"}
            </span>
          </footer>
        </main>
      </div>
      <datalist id="projects">
        {projects.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
      {boardAction&&<TicketActionDialog key={boardAction.ticket.id+":"+boardAction.ticket.revision+":"+boardAction.target} ticket={boardAction.ticket} target={boardAction.target} current={rows.some(row=>row.id===boardAction.ticket.id&&row.revision===boardAction.ticket.revision)} onClose={()=>setBoardAction(null)} onAuthenticationDenied={panelAuthenticationDenied} onRecordsChanged={()=>void load(true)}/>}
      {draft && <RecordDetails key={draft.id ?? draft.kind} record={draft} rows={rows} planning={planning} now={planningNow} saving={saving} error={error} onClose={() => setDraft(null)} onSave={value => save(value, true)} onRequestPlan={requestPlan} newRecord={empty} renderExecution={ticket => <TicketExecutionPanel ticket={ticket} onAuthenticationDenied={panelAuthenticationDenied} onRecordsChanged={() => void load(true)} />} />}
    </div>
  );
}
