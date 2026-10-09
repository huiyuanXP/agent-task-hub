# Ticket 看板交互设计

来源核对日期：2026-10-09。本文是源码支持的评估与设计合同，供后续功能 Tickets 实施；现役执行流程见 [EXECUTION.md](EXECUTION.md)，已交付能力见 [FEATURES.md](FEATURES.md)。本文分别记录当前应用事实、参考源码行为和拟采用的衔接条件。

## 结论与适配范围

采用 `@dnd-kit/core` 的 `DndContext`、`useDraggable`、`useDroppable`、鼠标/触屏/键盘传感器，在五个固定业务状态列上做拖放意图；通过一个业务动作解析函数将拖放、Ticket 详情按钮和键盘可见动作菜单连接到现有开发/授权/验收流程。显示顺序由优先级或时间比较器决定；同列释放结束交互，手工位置字段和 Sortable 重排属于范围外。

拖到进行中打开开发申请流程；申请、批准、领取和真实子进程启动分别展示。拖到完成打开与当前修订绑定的待验收 workspace Run；owner 确认验收后由既有 API/数据库触发器更新 Ticket。待开始、等待、异常的手工状态保存复用 Ticket 修订 CAS 与历史。活动 Run 优先使用 Run 操作，冻结 Ticket 内容保持稳定。

DSH 的准确仓库、插件及版本仍为待提供项。本次外部来源采用 Ticket 允许的 dnd-kit 官方多容器看板式示例，来源名称始终记为 dnd-kit MultipleContainers。

## 当前应用事实与源码位置

以下行为已按当前隔离 worktree 的源码核对；设计建议在后文单独列出。

| 事实 | 精确位置 | 对设计的含义 |
| --- | --- | --- |
| 五列为 todo/running/waiting/done/error；等待原因为 clarification/approval/review/external/recovery | `app/page.tsx:48`、`:55` | 列 ID 和业务状态统一，展示中文标签 |
| 看板按 records 读取顺序逐列展示；列表与看板复用相同渲染；详情状态可手工保存 | `app/page.tsx:921`、`:1187`；`app/api/records/route.ts:15` | 目前排序来源是 `created DESC`；排序和拖动是设计交付 |
| 详情保存使用完整 draft；保存成功 reload records，失败保留输入 | `app/page.tsx:256` | 状态写入应复用保存逻辑，保留业务 body，避免把展示 DTO 字段写回 |
| 修改 records 要求当前 `revision`；事务插入 history 并 revision+1；冲突返回 409 | `app/api/records/route.ts:93`、`:118` 的 POST 更新分支 | 手工状态确认同样绑定冻结修订；409 后刷新并由用户重新确认目标动作 |
| waiting 要求合法等待原因；手工 done 要求 evidence | `app/api/records/route.ts:78`、`:86` | 拖到等待需选择原因；完成拖动走 Run 验收，其证据来自 Run 交付 |
| 开发面板选择同项目、未撤销、带 execute capability 的连接，申请绑定 Ticket 修订和期限 | `components/workspace-runs/development-panel.tsx:45`、`:60` | 详情和拖动应传入确定的 Ticket ID/修订，复用同一个选择与申请 UI |
| 开发 Run 为 pending/approved/running/review/succeeded/failed/cancelled | `lib/workspace-runs/types.mts:3` | 与 Ticket status 使用两个独立命名空间 |
| prepare 冻结完整 Ticket body、revision、project、connection、workspace、timeout；prepare 校验 Ticket status，done 申请返回 scope conflict | `lib/workspace-runs/service.mts:65` 的 prepare、`:14` 的 ticketScope | 申请后的状态变化应来自展示投影；手工改 body/revision 会影响后续批准/领取/续租/回报/验收 |
| pending/approved/running/review 在 workspace 领域占用同 Ticket；物理 Ticket 和连接占用由 generation、physical_closed_at 控制 | `migrations/005_workspace_runs.sql:32` | 逻辑取消与可再次启动分别处理；活动记录优先复用 |
| approved 领取检查依赖全部 done、租约、同连接物理占用，领取后标 running | `lib/workspace-runs/service.mts:149` | 排序只影响用户查看；Agent 领取现为 `created_at,id`，依赖等待由事件说明 |
| Agent 领取后创建 worktree、调用模型进程，续租取消时中止受管进程 | `connector/agent.mjs:81`、`:111`、`:115` | `running` 表示已领取，事件可进一步显示 preparing/agent；真实启动证据来自 agent 阶段与受管进程 |
| complete 报告实际 diff/tests/result 并进入 review、确认物理结束；accept 检查固定 body/修订和连接 | `lib/workspace-runs/service.mts:219`、`:93` | 拖动完成先读交付、再确认 accept |
| accept 的数据库触发器原子写 history、Ticket status=done、revision+1 | `migrations/005_workspace_runs.sql:87` | 验收直接调用 accept，records reload 得到完成状态；状态写入由 accept 触发器承担 |
| workspace cancel 支持 pending/approved/running/review；rework 支持 review/failed/cancelled，并创建稳定 successor | `lib/workspace-runs/service.mts:93` | 取消和返工复用业务 API；历史结果持续保留 |
| Docker Run 为 queued/running/waiting/succeeded/failed/cancelled，授权有 pending/approved/rejected/revoked/expired/stale_revision/stale_definition | `lib/execution/types.mts:14`；`lib/execution/authorization-types.mts:20`、`:21` | Docker 授权与开发审批保留各自输入、状态和证据 |
| Docker 申请与批准独立于 dispatch start；真实结果来自后端签名收据 | `components/execution/authorization-panel.tsx:107`、`:125`、`:149`；`lib/execution/dispatch.mts`；`docs/EXECUTION.md` | 拖放只选择/打开流程，启动按钮承担明确 owner 操作 |
| 手工 records kind=run 是追加不可改快照，source=manual | `app/api/records/route.ts:107`、`:196`；`app/page.tsx:950` | 手工快照、Docker succeeded 和 workspace review 分别保留含义 |

代码事实：现有 UI 展示独立面板，Ticket 卡片详情的保存和手工快照与真实执行分开。设计状态：本文的拖动、显式排序、详情预选入口和 Run 状态投影由后续功能 Tickets 实施并验证。

## 可复核外部来源

来源是 [clauderic/dnd-kit](https://github.com/clauderic/dnd-kit)，官方 Storybook 的 `Presets/Sortable/Multiple Containers` 多容器 React 示例。固定提交 [`e9215e820798459ae036896fce7fd9a6fe855772`](https://github.com/clauderic/dnd-kit/commit/e9215e820798459ae036896fce7fd9a6fe855772)。本轮依据已实际取得的固定源码、package.json 与 LICENSE 核对，来源清单 `SOURCE.json` 记录获取日期 2026-10-09，文件留存在项目私有 `.local/evidence/parallel-tickets-20261009/board-sources/dnd-kit/`。来源复核范围以该清单和留存文件为准。

固定源码版本为 `@dnd-kit/core 6.3.1` 和 `@dnd-kit/sortable 10.0.0`，来自各自 package.json；本应用依赖以现役 package.json 为准，后续实施时再有意更新依赖与锁文件。core 的 React peer 为 `>=16.8.0`，安装兼容和 React 19 实际运行需后续实施验证。

许可证为 [MIT](https://github.com/clauderic/dnd-kit/blob/e9215e820798459ae036896fce7fd9a6fe855772/LICENSE)，copyright (c) 2021 Claudéric Demers；复制源码或实质片段时保留版权与许可声明。概念复用加来源链接即可清楚记录归属。

| 固定提交关键源码 | 实际读到的行为 |
| --- | --- |
| [MultipleContainers.tsx](https://github.com/clauderic/dnd-kit/blob/e9215e820798459ae036896fce7fd9a6fe855772/stories/2%20-%20Presets/Sortable/MultipleContainers.tsx#L170) | useState 存储 `{containerId: itemIds[]}`，容器序列另存 React state |
| [传感器与取消](https://github.com/clauderic/dnd-kit/blob/e9215e820798459ae036896fce7fd9a6fe855772/stories/2%20-%20Presets/Sortable/MultipleContainers.tsx#L258) | MouseSensor/TouchSensor/KeyboardSensor；开始复制 state；取消恢复复制内容 |
| [跨列事件](https://github.com/clauderic/dnd-kit/blob/e9215e820798459ae036896fce7fd9a6fe855772/stories/2%20-%20Presets/Sortable/MultipleContainers.tsx#L316) | onDragOver 将 item ID 从源数组移入目标数组，是本地交互预览 |
| [完成事件](https://github.com/clauderic/dnd-kit/blob/e9215e820798459ae036896fce7fd9a6fe855772/stories/2%20-%20Presets/Sortable/MultipleContainers.tsx#L373) | onDragEnd 用 arrayMove 重排、支持容器排序/新增/删除演示；业务状态保存、授权或进程启动由集成方设计 |
| [多容器键盘坐标](https://github.com/clauderic/dnd-kit/blob/e9215e820798459ae036896fce7fd9a6fe855772/stories/2%20-%20Presets/Sortable/multipleContainersKeyboardCoordinates.ts#L17) | 根据方向、可用 droppable rectangles 和 closestCorners 求目标；过滤 disabled 区域 |
| [键盘默认键位](https://github.com/clauderic/dnd-kit/blob/e9215e820798459ae036896fce7fd9a6fe855772/packages/core/src/sensors/keyboard/defaults.ts#L3) | Space/Enter 开始，Escape 取消，Space/Enter/Tab 结束；方向键默认 25px 位移 |
| [TouchSensor](https://github.com/clauderic/dnd-kit/blob/e9215e820798459ae036896fce7fd9a6fe855772/packages/core/src/sensors/touch/TouchSensor.ts#L26) | touchstart/touchmove/touchend/touchcancel；iOS Safari 非 passive touchmove 处理 |
| [useDraggable](https://github.com/clauderic/dnd-kit/blob/e9215e820798459ae036896fce7fd9a6fe855772/packages/core/src/hooks/useDraggable.ts#L43) 和 [Accessibility defaults](https://github.com/clauderic/dnd-kit/blob/e9215e820798459ae036896fce7fd9a6fe855772/packages/core/src/components/Accessibility/defaults.ts#L3) | 可聚焦属性、aria-describedBy、开始/经过/结束/取消的屏幕阅读器播报 |

已阅读的示例组件完整实现把拖动结果写入 React state；该文件的业务副作用范围是数组/容器变化。它提供拖动与重排机制，持久化需接本项目 API，执行权限及进程生命周期由本项目领域服务承担。本研究结论的外部范围限于固定提交的上述源码；线上演示、DSH 和其他项目产品语义属于待核实项。

## 技术选项与最小方案

| 方案 | 键盘 | 触屏 | 维护成本 | 适配判断 |
| --- | --- | --- | --- | --- |
| 原生 HTML draggable/dragstart/drop | 需设计键盘等价路径、目标选择与播报 | 需处理移动端拖动、滚动冲突和浏览器差异 | 复用浏览器 API；应用承担输入适配与无障碍维护 | 简单桌面拖动可用；满足本 Ticket 的键盘与触屏需要更多应用代码 |
| dnd-kit core | 已有 KeyboardSensor、焦点属性与播报；仍需按列的坐标 getter | 已有 TouchSensor/PointerSensor；需设拖动手柄与激活阈值 | 引入 core 及其传递依赖；应用保持较小业务适配层 | 推荐，只使用固定列 droppable 与卡片 draggable |
| core + sortable 多容器示例 | 提供 item/column 重排与相关坐标策略 | 同 core | 引入 sortable 与多个顺序数组、重排/撤销/碰撞逻辑 | 手工重排属于后续明确需求；首期保持显示排序比较器 |

具体适配：

1. 固定列 ID 为 `ticket-state:todo` 等，卡片 ID 为 `ticket:<id>`；data 含 `{ticketId, revision, project, sourceStatus}`。board 列始终可接收空列拖动，目标只解析固定列。
2. 使用 core 的 MouseSensor（distance 约 6px）、TouchSensor（长按约 200ms、tolerance 约 8px）和 KeyboardSensor。激活参数是推荐初值，实际设备验证决定最终数值。拖动监听绑定专门可聚焦按钮手柄，卡片详情按钮保留独立点击语义。
3. 键盘坐标 getter 按当前可见列方向寻找 enabled droppable，返回目标中心；列表模式按垂直列顺序工作，空列也能选择。默认 25px 位移需替换成按列移动。Enter/Space 放下、Escape 取消，中文播报 Ticket 标题、目标列以及“打开申请/等待确认”的实际动作。
4. `onDragStart/onDragOver` 只保存本次手势和高亮列；`onDragEnd` 解析意图后打开执行或状态确认 UI。Ticket 真正移动取决于 records 保存或 Run 状态；显示顺序继续由排序比较器决定。`onDragCancel`、列外释放和已失效 Ticket 结束临时 UI。
5. 将 `resolveTicketAction(ticket, target, workspaceRuns, dockerRuns)` 提取为可测试的纯函数；输入操作上下文，返回 no-op/open-execution/open-review/open-status/open-active/completed-info。手工状态 action 与现有保存逻辑连接，详情执行按钮与拖到 running 返回同一个 `open-execution(ticket.id, ticket.revision)`。
6. 默认路径为 workspace Agent；固定 Docker 操作通过明确选择打开现有 AuthorizationPanel，并显示注册 operation 与资源预算。后端 API、账号审批和 SQLite 数据结构沿用现役合同。
7. 使用可见动作菜单提供“发起开发”“改为待开始”“标记等待”“标记异常”“查看待验收”的等价入口；触屏与辅助技术也能完整完成业务流程。

## 动作矩阵

以下为后续实现设计。判定顺序：身份/当前修订与项目有效 → 同列/列外结束 → 已完成来源规则 → 活动 Run 规则 → 目标列规则。来源为 `done` 的 Ticket 拖动到任意其他列时统一返回 `completed-info`，保持持久 `status=done`，只说明完成记录与既有返工入口。`completed-info` 是信息动作，业务写入仍由明确的既有操作承担。跨项目、改变项目、排序策略、审批与操作类型均通过其独立入口。

### 各来源列到各目标列（有效 Ticket，done 来源先返回信息动作，其余来源优先处理活动 Run）

| 来源 / 目标 | 待开始 todo | 进行中 running | 等待 waiting | 完成 done | 异常 error |
| --- | --- | --- | --- | --- | --- |
| todo | 结束手势 | 打开同 Ticket 开发申请 | 原因确认后保存 waiting | 打开待验收 Run；缺少候选时说明验收前提 | 异常说明确认后保存 error |
| running（手工） | 确认保存 todo | 结束手势 | 原因确认后保存 waiting | 打开待验收 Run | 异常说明确认后保存 error |
| waiting（手工） | 确认保存 todo，保留此前等待原因字段 | 打开同 Ticket 开发申请 | 结束手势 | 打开待验收 Run | 异常说明确认后保存 error |
| done | 保持完成状态，说明完成记录与既有返工入口 | 保持完成状态，说明完成记录与既有返工入口 | 保持完成状态，说明完成记录与既有返工入口 | 结束手势 | 保持完成状态，说明完成记录与既有返工入口 |
| error（手工） | 确认保存 todo | 打开同 Ticket 开发申请/查看停止记录后重新申请 | 原因确认后保存 waiting | 打开待验收 Run | 结束手势 |

手工 running 的含义是 Ticket 文本进度，展示标注“手工状态”；真实 Run 与其独立显示。状态保存沿用 `POST /api/records` 的完整业务 body + id/kind/revision，更新 status；waiting 同时保存合法 waitingReason；error 的说明进入既有 notes，保存前要求用户填写有用原因。异常说明必填是此设计的交互规则，现役 API 对 error 仅校验状态合法性。

同列手势只结束拖动，明确动作按钮仍可打开当前执行详情。完成卡片的信息动作展示关联完成证据，并说明现役“要求返工”按钮位于 workspace `review` Run；服务的 `rework` 适用状态为 `review/failed/cancelled`。完成目标通过同 Ticket、同修订、同项目的 workspace `review` 候选选择/确认；pending/approved/running、Docker succeeded 与手工快照各自在所属记录区域呈现。

### 活动 Run、取消与验收

| 执行上下文 | 拖到进行中 | 拖到完成 | 拖到 todo/waiting/error | 详情可用操作 |
| --- | --- | --- | --- | --- |
| workspace pending | 打开当前申请 | 打开当前申请及待验收前提 | 打开当前 Run；用户明确取消或拒绝后再处理状态 | approve/reject/cancel |
| workspace approved | 展示等待 Agent/依赖事件 | 展示当前 Run 进度 | 打开当前 Run；取消后等待执行占用处理 | cancel |
| workspace running | 展示真实进度与事件 | 展示进度，交付进入 review 后出现验收 | 打开当前 Run 的取消入口；停止与修订变更分步进行 | cancel |
| workspace review | 展示交付与返工入口 | 展示 diff、files、tests、summary 并等待 accept 确认 | 打开验收/返工 UI；保留固定 Ticket 修订 | accept/rework；API 另支持 cancel |
| workspace failed/cancelled | 展示错误/取消记录，使用明确 rework 或新申请 | 有当前 review 候选才进入验收 | 逻辑终态和物理占用分别显示/由服务检查，再确认状态 | rework 的 API 支持需由后续 UI 显式暴露 |
| Docker queued/running/waiting | 打开现有授权/运行详情 | 展示签名执行结果与 workspace 验收前提 | 打开现有取消 Run/dispatch cancel，展示后端物理停止状态 | 授权决定、撤销、启动、取消、下载证据 |
| 活动 Run 读取/修订/身份发生冲突 | 刷新当前上下文并保留操作说明 | 刷新交付候选 | 刷新后重新确认 | 显示 401/403/409/503 实际结果 |

工作区 `rework` 使用 `previous_run_id` 和 `requestId=rework:<runId>` 保证重复请求指向同一后继；review 返工先取消 review，再为当前修订创建 pending 后继。返工仍需 owner 批准。

取消窗口/执行申请弹层只结束本次 UI 意图；在显式提交前保持业务数据。显式提交后的 cancel/reject/rework 属于真实业务写入，显示返回记录。请求响应丢失时按原请求身份查询/重试，并显示等待核实的实际结果。

### Run 展示投影建议

卡片保留 Ticket 的持久 `status`，展示主状态可由与当前 Ticket 修订/项目对应的有效 workspace Run 投影；历史修订的结果留在证据区：pending→等待/需要授权；approved→待开始/等待 Agent（依赖 waiting 事件单独显示）；running→进行中；review→等待/等待验收；failed→异常；succeeded 由 accept 触发器的 Ticket done 决定；cancelled 展示取消记录并保留 Ticket 文本状态。投影字段只存在读取模型中，waitingReason 的 Run 展示原因与 Ticket 手工原因各自保留。

投影是本文推荐设计，现役主界面按持久 status 分列。若后续 Ticket 维持持久列方式，至少在卡片展示 Run 徽标并按 Run 规则解析业务动作，确保 pending/approved 真实语义可见。

## 现役 API 与字段准确映射

| 业务步骤 | 现役接口与 payload | 返回/约束 |
| --- | --- | --- |
| 当前 Ticket 列表/修订 | `GET /api/records` | `{records}`，owner 隔离；Row 包括 id/kind/revision/created/updated 与 body |
| 手工状态保存 | `POST /api/records {id,kind:"ticket",revision,title,...业务body,status,waitingReason?,notes?}` | `{id,revision}`；修订 CAS、history；409 提醒刷新 |
| 连接选择 | `GET /api/connectors` | `connections` 按 Ticket project、!revokedAt、capabilities execute 筛选；agentReady 作为显示状态 |
| workspace 相关 Runs | `GET /api/workspace-runs?ticketId=<id>&limit=100`，续读 nextCursor | `{runs,nextCursor}`；Run 含 ticketId/revision/connectionId/project/workspace/operation/state/result/events |
| workspace 指定 Run | `GET /api/workspace-runs?runId=<id>` | `{run}`；与 ticketId 等列表筛选互斥 |
| 申请开发 | `POST /api/workspace-runs {action:"prepare",ticketId,revision,connectionId,requestId,timeoutMs}` | `{run}`，pending；requestId 绑定精确输入且幂等；期限 1000..3600000ms，现役 UI 1..60 分钟 |
| owner 决定 | `POST /api/workspace-runs {action:"approve"\|"reject"\|"cancel"\|"accept"\|"rework",runId}` | `{run}`；owner 会话、Origin 校验、内部 version CAS 和 scope 检查；payload 使用 runId |
| Agent 领取 | `POST /api/connector/agent {action:"claim"}` | 已注册连接 execute 身份；`{job:{id,leaseToken,ticketId,revision,body,leaseExpiresAt,timeoutMs}|null}` |
| Agent 续租/交付 | 同接口 `{action:"renew"\|"complete"\|"fail",runId,leaseToken,result?|error?}` | result 为 summary/diff/files/tests/worktree，受租约/修订/取消约束 |
| Docker 目录/授权状态 | `GET /api/authorization?ticketId=<id>&expectedRevision=<revision>` 或 `?id=<authorizationId>` | `{operations,ceilings}` 或 `{authorization}` |
| Docker 申请授权 | `POST /api/authorization {action:"prepare",ticketId,expectedRevision,requestId,attempt,scope:[{operationId,definitionHash}],budget:{timeoutMs,memoryMb,cpus,pids},expiresAt}` | `{run,authorization}`；Run queued，authorization pending |
| Docker 批准/拒绝/撤销 | 同接口 `{action:"decide",authorizationId,decisionId,outcome:"approved"\|"rejected"}` 或 `{action:"revoke",authorizationId,decisionId}` | `{authorization}`；scope、预算和最晚开始冻结 |
| Docker Runs/后端详情 | `GET /api/execution?ticketId=<id>`；`GET /api/execution/dispatch?runId=<id>` | `{runs}`；后端详情含 run/backend/签名 receipts |
| Docker 实际启动 | `POST /api/execution/dispatch {action:"start",runId}` | 有效批准、冻结操作、预算和签名后端检查后 dispatch |
| Docker 取消意图/停止 | `POST /api/execution {action:"cancel",id,expectedVersion}`；随后 `POST /api/execution/dispatch {action:"cancel",runId}` | 领域 Run cancelled 与后端停止收据分别记录；API id 与 workspace runId 字段区分 |

三个后续实现边界必须保留：

- workspace 列表默认只返回最新 20 项，现役面板按全局 GET 加前端筛选。卡片动作应按 ticketId 读取并处理 nextCursor，避免将分页之外的活动 Run 当作可新申请。
- WorkspaceRun DTO 当前包含 state/result/events，物理关闭字段在 RunRow 中；UI 精确展示“可重新启动”若需读取物理占用，应通过后续明确 DTO 设计实现。后端唯一索引与 claim 检查持续承担判定，失败后返回真实占用提示。
- workspace 与 Docker 的活动唯一索引分别存在于各自表；跨两种后端的统一活动占用属于后续服务合同。前端动作解析同时识别两类占用；若要全站强制跨后端互斥，需要后续单独的服务合同，而本文文档交付保留现役边界。

## 排序边界与后续行为验证

支持优先级 P0→P1→P2→P3（紧急优先）或反向、created/updated 时间的新到旧或旧到新；优先级相同用 `created` 降序再 `id` 升序确保稳定；按 `created` 或 `updated` 排序时，相同时间只用 `id` 升序作为次级键。缺失/未知 priority 放末尾；无效时间放末尾，与方向独立，避免 NaN 比较器。排序函数以复制的数组返回结果，同一比较器用于看板每列和列表；项目/关键词/状态过滤先确定可见集合，固定列顺序保持 todo/running/waiting/done/error。

排序偏好只保留当前登录页面会话；刷新持久化、列内手工重排、跨项目移动与执行调度优先级属于范围外。created 保留创建时间，updated 随真实状态/CAS 保存变化；打开申请或取消弹层属于 UI 状态。

后续功能 Tickets 验证有业务价值的行为：鼠标/触屏/键盘到达空列；Space/Enter/Escape 与焦点返回；同列和取消时业务记录数保持；详情与拖动预选相同 id/revision；prepare/approve/claim/agent 事件分层；活动 Run 与 review 修订保持稳定；accept 原子产生一个 history 与 revision+1；状态 POST 409 保留用户意图且 refresh；跨分页活动 Run；Docker 503 取消显示物理停止状态；P0/时间等值和缺失值排序稳定。依赖及 React 19 兼容由真正实施与必要构建、类型、lint、API/浏览器验证给出证据。
