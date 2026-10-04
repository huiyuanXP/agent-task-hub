"use client";
import { useEffect, useState, useRef, useCallback } from "react";
import { AuthorizationPanel } from "../components/execution/authorization-panel";
import type { FormEvent } from "react";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import type { Row, RecordDraft, PlanningState, JobRow, SessionState } from "../lib/types";
import {
  Lightbulb,
  Inbox,
  LayoutGrid,
  History,
  Plug,
  Plus,
  Search,
  X,
  Check,
  ChevronRight,
  FileText,
  ArrowUpRight,
  RefreshCw,
  SlidersHorizontal,
  Layers,
  AlertCircle,
} from "lucide-react";
type TextField =
  | "project"
  | "text"
  | "goal"
  | "scope"
  | "acceptance"
  | "allowedActions"
  | "budget"
  | "dependencies"
  | "assumptions"
  | "queue"
  | "evidence"
  | "notes";
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
const priorities: Record<string, string> = {
  P0: "P0 · 紧急",
  P1: "P1 · 重要",
  P2: "P2 · 常规",
  P3: "P3 · 有空再做",
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
  const [session, setSession] = useState<SessionState | null>(null);
  const sessionRef = useRef<SessionState | null>(null);
  const expiryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const identityVersion = useRef(0);
  const loadSequence = useRef(0);
  const clearPrivateState = useCallback(() => {
    identityVersion.current++;
    setRows([]);
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
  const authenticationDenied = useCallback((response: Response) => {
    if (response.status !== 401 && response.status !== 403) return false;
    expireSession();
    return true;
  }, [expireSession]);
  const load = useCallback(async (silent = false) => {
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
      if (sessionRef.current?.user.userId !== next.user.userId) clearPrivateState();
      sessionRef.current = next;
      setSession(next);
      if (expiryTimer.current) clearTimeout(expiryTimer.current);
      expiryTimer.current = next.expiresAt === null ? null : setTimeout(expireSession, next.expiresAt - Date.now());
      const [r, pr] = await Promise.all([
        fetch("/api/records", { cache: "no-store" }),
        fetch("/api/planning", { cache: "no-store" }),
      ]);
      if (seq !== loadSequence.current) return;
      if (authenticationDenied(r) || authenticationDenied(pr)) return;
      const d = (await r.json()) as { records: Row[]; error?: string },
        pd = (await pr.json()) as PlanningState;
      if (!r.ok) throw Error(d.error);
      if (!pr.ok) throw Error(pd.error);
      if (seq === loadSequence.current) {
        setRows(d.records);
        setPlanning(pd);
        setError("");
      }
    } catch (e) {
      if (seq === loadSequence.current)
        setError(e instanceof Error ? e.message : "无法连接云端");
    } finally {
      if (seq === loadSequence.current) setLoading(false);
    }
  }, [authenticationDenied, clearPrivateState, expireSession]);
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
    const plan =
      rows.find((r) => r.kind === "plan" && r.id === idea.planId) ||
      rows.find((r) => r.kind === "plan" && r.ideaId === idea.id);
    if (plan) {
      setDraft({ ...plan });
    } else {
      setView("plans");
      setProject("全部项目");
      setStateFilter("all");
      setQuery(idea.id);
    }
  }
  async function save(value: RecordDraft) {
    const version = identityVersion.current;
    setSaving(true);
    setError("");
    try {
      const r = await fetch("/api/records", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(value),
      });
      if (version !== identityVersion.current || authenticationDenied(r)) return null;
      const d = (await r.json()) as {
        id: string;
        revision: number;
        error?: string;
      };
      if (!r.ok) throw Error(d.error);
      if (version !== identityVersion.current) return null;
      await load();
      if (version !== identityVersion.current) return null;
      setNotice("已保存到云端");
      setTimeout(() => setNotice(""), 3500);
      return d;
    } catch (e) {
      if (version === identityVersion.current) setError(e instanceof Error ? e.message : "保存失败，内容已保留");
      return null;
    } finally {
      if (version === identityVersion.current) setSaving(false);
    }
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (draft && (await save(draft))) setDraft(null);
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
    if (d) setCapture("");
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
      if (version !== identityVersion.current || authenticationDenied(r)) return;
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
      if (version === identityVersion.current) setError(e instanceof Error ? e.message : "请求失败");
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
  const projects = Array.from(
    new Set(rows.map((r) => r.project).filter((p): p is string => !!p)),
  ).sort();
  const waiting = tickets.filter((r) => r.status === "waiting");
  const filtered = (items: Row[]) =>
    items.filter(
      (r) =>
        (project === "全部项目" || r.project === project) &&
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
    integrations: "查看当前能力与尚未接通的环节。",
  };
  function field(
    label: string,
    key: TextField,
    area = false,
    placeholder = "",
  ) {
    if (!draft) return null;
    return (
      <label className={area ? "wide" : ""}>
        {label}
        {area ? (
          <textarea
            value={draft[key] || ""}
            onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
            placeholder={placeholder}
          />
        ) : (
          <input
            value={draft[key] || ""}
            onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
            placeholder={placeholder}
          />
        )}
      </label>
    );
  }
  function ticketCard(t: Row) {
    return (
      <button
        className="ticket-card"
        key={t.id}
        onClick={() => setDraft({ ...t })}
      >
        <div className="card-top">
          <span className="id">T-{t.id.slice(0, 6).toUpperCase()}</span>
          <span className={"priority " + t.priority}>{t.priority}</span>
        </div>
        <h3>{t.title}</h3>
        {t.goal && <p>{t.goal}</p>}
        <div className="card-bottom">
          <span className="project-tag">{t.project}</span>
          <span>v{t.revision}</span>
        </div>
        {t.status === "waiting" && (
          <span className="wait-tag">
            {reasons[t.waitingReason || "clarification"]}
          </span>
        )}
      </button>
    );
  }
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
            onClick={() => setProject("全部项目")}
          >
            <span className="project-square" />
            全部项目
          </button>
          {projects.map((p) => (
            <button
              key={p}
              className={project === p ? "selected" : ""}
              onClick={() => setProject(p)}
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
                  {session.mode === "development" && <small> · 本地开发身份</small>}
                </span>
                <span className="avatar small" aria-label="账户缩写">
                  {session.user.displayName.trim().split(/\s+/).slice(0, 2).map(part => Array.from(part)[0]).join("").toUpperCase()}
                </span>
                <form method="post" action="/signout-with-chatgpt">
                  <button type="submit">退出登录</button>
                </form>
              </>
            ) : !loading && <a href="/signin-with-chatgpt?return_to=%2F">登录</a>}
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
                  ? setDraft(empty("idea"))
                  : view === "plans"
                    ? setDraft(empty("plan"))
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
                    onChange={(e) => setCaptureProject(e.target.value)}
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
                    filtered(
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
                  onChange={(e) => setProject(e.target.value)}
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
                    <button
                      className="icon-btn"
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
            <div className="empty">正在读取云端工作区…</div>
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
                    const job = planning.jobs.find(
                      (j) =>
                        j.idea_id === i.id && j.idea_revision === i.revision,
                    ) || {
                      status:
                        i.planningStatus === "planned"
                          ? "done"
                          : i.planningStatus || "unplanned",
                      delivery: i.planningDelivery,
                    };
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
                        {job && (
                          <div className="planning-status">
                            {job.status === "unplanned"
                              ? "当前版本尚未规划，请求 Agent 开始整理"
                              : job.status === "done"
                                ? "规划完成 · 结果已保存"
                                : job.status === "planning"
                                  ? "Agent 正在规划"
                                  : job.delivery === "accepted"
                                    ? "请求已送达 · 等待 Agent 处理"
                                    : job.delivery === "no_subscription"
                                      ? "已排队 · 待连接插件"
                                      : job.delivery === "failed"
                                        ? "投递失败 · 可重试"
                                        : "规划已排队"}
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
                            disabled={saving || job?.status === "planning"}
                            onClick={() =>
                              job?.status === "done"
                                ? openPlan(i)
                                : requestPlan(i)
                            }
                          >
                            {job?.status === "done"
                              ? "查看结果"
                              : job?.status === "planning"
                                ? "Agent 正在处理"
                                : "请求 Agent"}{" "}
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
              {view === "board" && <AuthorizationPanel key={session?.user.userId ?? "anonymous"} tickets={tickets} />}
              {view === "board" && (
                <div className={"board " + (list ? "as-list" : "")}>
                  {Object.entries(statuses)
                    .filter(([s]) => stateFilter === "all" || s === stateFilter)
                    .map(([s, label]) => (
                      <section className={"column " + s} key={s}>
                        <header>
                          <span className="state-dot" />
                          <h2>{label}</h2>
                          <span>
                            {
                              filtered(tickets).filter((t) => t.status === s)
                                .length
                            }
                          </span>
                        </header>
                        {filtered(tickets)
                          .filter((t) => t.status === s)
                          .map(ticketCard)}
                        {filtered(tickets).filter((t) => t.status === s)
                          .length === 0 && (
                          <div className="column-empty">暂无任务</div>
                        )}
                      </section>
                    ))}
                </div>
              )}
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
              {view === "integrations" && (
                <div className="integration-grid">
                  {[
                    [
                      "云端工作区",
                      "已启用",
                      "点子、Plan、Ticket 和执行记录保存到云端；修订冲突会阻止覆盖。",
                    ],
                    [
                      "AI Planner / MCP Events",
                      planning.subscriptions > 0 ? "已订阅" : "待连接插件",
                      planning.subscriptions > 0
                        ? "点子保存后发送事件，订阅此事件的 ChatGPT Agent 读取原文、生成 Plan 和 Tickets 并回写。"
                        : "已实现事件接口。连接此网站的插件并订阅点子规划事件后，才会自动唤醒 Agent。未投递的请求保留，可手动重试。",
                    ],
                    [
                      "VM Runner / OpenAgents",
                      "未连接",
                      "目前不会启动 Agent 或执行代码。手动状态更新和执行记录不代表 VM 已运行。",
                    ],
                    [
                      "定时任务与额度",
                      "未启用",
                      "周期仅作为任务属性保存，尚未调度。模型与执行端的额度暂不可用。",
                    ],
                    [
                      "设备配对",
                      "待接入",
                      "已按本次确认改用 ChatGPT 私有访问。原规划的设备配对暂不启用。",
                    ],
                  ].map(([a, b, c]) => (
                    <article className="idea-card" key={a}>
                      <Plug size={22} />
                      <h3>{a}</h3>
                      <span
                        className={"connection " + (b === "已启用" ? "on" : "")}
                      >
                        {b}
                      </span>
                      <p>{c}</p>
                    </article>
                  ))}
                </div>
              )}
            </>
          )}
          <footer className="main-footer">
            <span>IDEA → PLAN → TICKET → EVIDENCE</span>
            <span>
              每 10 秒自动刷新 ·{" "}
              {planning.subscriptions > 0
                ? "Agent 事件已订阅 · VM 未连接"
                : "Agent 待订阅 · VM 未连接"}
            </span>
          </footer>
        </main>
      </div>
      <datalist id="projects">
        {projects.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
      {draft && (
        <div
          className="modal-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget && !saving) setDraft(null);
          }}
        >
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="dialog-title"
          >
            <header>
              <div>
                <span className="eyebrow">
                  {draft.id
                    ? `${draft.kind.toUpperCase()} · v${draft.revision}`
                    : "NEW " + draft.kind.toUpperCase()}
                </span>
                <h2 id="dialog-title">
                  {draft.kind === "idea"
                    ? "原始点子"
                    : draft.kind === "plan"
                      ? "规划 Plan"
                      : draft.kind === "run"
                        ? "追加执行记录"
                        : "Ticket 详情"}
                </h2>
              </div>
              <button
                className="icon-btn"
                aria-label="关闭"
                onClick={() => setDraft(null)}
                disabled={saving}
              >
                <X />
              </button>
            </header>
            <form onSubmit={submit}>
              <div className="form-grid">
                <label className="wide">
                  标题
                  <input
                    autoFocus
                    required
                    maxLength={250}
                    value={draft.title}
                    onChange={(e) =>
                      setDraft({ ...draft, title: e.target.value })
                    }
                  />
                </label>
                {draft.kind !== "run" && (
                  <>
                    {field("项目", "project")}
                    <label>
                      优先级
                      <select
                        value={draft.priority}
                        onChange={(e) =>
                          setDraft({ ...draft, priority: e.target.value })
                        }
                      >
                        {Object.entries(priorities).map(([k, v]) => (
                          <option key={k} value={k}>
                            {v}
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                )}
                {draft.kind === "idea" ? (
                  field("原始内容", "text", true, "保留最初的想法与上下文")
                ) : draft.kind === "run" ? (
                  <>
                    <p className="wide form-help">
                      保存时冻结当前 Ticket 版本；这里只记录已有执行，不会触发
                      Agent。
                    </p>
                    {field(
                      "执行过程与证据",
                      "evidence",
                      true,
                      "命令、日志摘要、链接、实际结果…",
                    )}
                  </>
                ) : (
                  <>
                    {field("目标", "goal", true)}
                    {field("范围与边界", "scope", true)}
                    {field(
                      "验收标准",
                      "acceptance",
                      true,
                      "怎样证明已经完成？",
                    )}
                    {field(
                      "允许的操作",
                      "allowedActions",
                      true,
                      "仅记录已获得授权的操作范围",
                    )}
                    {field("预算 / 限额", "budget")}
                    {field("依赖 Ticket / 外部条件", "dependencies")}
                    {field("假设与待确认问题", "assumptions", true)}
                    {draft.ideaId && (
                      <details className="wide origin">
                        <summary>查看原始点子</summary>
                        <p>
                          {ideas.find((i) => i.id === draft.ideaId)?.text ||
                            "原始点子不可用"}
                        </p>
                      </details>
                    )}
                    {draft.kind === "plan" && draft.id && (
                      <section className="wide related-tickets">
                        <h3>关联 Tickets</h3>
                        {tickets
                          .filter((t) => t.planId === draft.id)
                          .map((t) => (
                            <button
                              key={t.id}
                              type="button"
                              onClick={() => setDraft({ ...t })}
                            >
                              <span>{t.title}</span>
                              <small>{statuses[t.status || "todo"]}</small>
                              <ChevronRight size={16} />
                            </button>
                          ))}
                        {tickets.filter((t) => t.planId === draft.id).length ===
                          0 && <p>尚未拆分 Ticket</p>}
                      </section>
                    )}
                    {draft.kind === "ticket" && (
                      <>
                        <label>
                          状态
                          <select
                            value={draft.status}
                            onChange={(e) =>
                              setDraft({ ...draft, status: e.target.value })
                            }
                          >
                            {Object.entries(statuses).map(([k, v]) => (
                              <option key={k} value={k}>
                                {v}
                              </option>
                            ))}
                          </select>
                          {draft.status === "waiting" && (
                            <label>
                              等待原因
                              <select
                                value={draft.waitingReason}
                                onChange={(e) =>
                                  setDraft({
                                    ...draft,
                                    waitingReason: e.target.value,
                                  })
                                }
                              >
                                {Object.entries(reasons).map(([k, v]) => (
                                  <option key={k} value={k}>
                                    {v}
                                  </option>
                                ))}
                              </select>
                            </label>
                          )}
                        </label>
                        {field("执行队列", "queue")}
                        <label>
                          业务分类
                          <select
                            value={draft.category}
                            onChange={(e) =>
                              setDraft({ ...draft, category: e.target.value })
                            }
                          >
                            <option value="general">通用</option>
                            <option value="recruitment">求职</option>
                          </select>
                        </label>
                        <label>
                          执行类型
                          <select
                            value={draft.cadence}
                            onChange={(e) =>
                              setDraft({ ...draft, cadence: e.target.value })
                            }
                          >
                            <option value="one_off">一次性</option>
                            <option value="recurring">
                              周期性（尚未调度）
                            </option>
                          </select>
                        </label>
                        {field(
                          "验收证据（完成时必填）",
                          "evidence",
                          true,
                          "实际结果、测试输出、交付物链接…",
                        )}
                        <p className="wide form-help">
                          状态由你手动更新；不代表已启动
                          Runner。修改约定会创建新修订版本。
                        </p>
                      </>
                    )}
                    {field("补充说明", "notes", true)}
                    {draft.id && (
                      <details className="wide origin">
                        <summary>修订历史</summary>
                        {rows
                          .filter(
                            (r) =>
                              r.kind === "history" && r.recordId === draft.id,
                          )
                          .map((r) => (
                            <p key={r.id}>
                              v{r.previousRevision} ·{" "}
                              {new Date(r.created).toLocaleString("zh-CN")}
                              <br />
                              {r.snapshot?.title}
                              <br />
                              {r.snapshot?.goal || r.snapshot?.text}
                            </p>
                          ))}
                      </details>
                    )}
                  </>
                )}
              </div>
              {error && (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
              <div className="modal-footer">
                {draft.id && draft.kind === "ticket" && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() =>
                      setDraft({
                        ...empty("run"),
                        title: draft.title,
                        ticketId: draft.id,
                        project: draft.project,
                      })
                    }
                  >
                    追加执行记录
                  </button>
                )}
                <span />
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setDraft(null)}
                  disabled={saving}
                >
                  取消
                </button>
                <button className="primary" disabled={saving}>
                  {saving ? "保存中…" : "保存到云端"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
