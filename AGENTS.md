# Agent Task Hub collaboration

## Project direction

The project is changing from the first implementation—ChatGPT reading the project,
creating plugins, Cloudflare hosting and OpenAI OAS/OAuth identity—to a fully local
server deployment. Implement and document the local server as the sole application
architecture. This paragraph is the only place to retain that direction-change
context; remove the previous hosting/authentication setup from application code,
configuration, tests and other documentation instead of marking it deprecated.

## Repository skills

Read `.agents/skills/using-superpowers/SKILL.md` and relevant repository skills
before working. Resolve `superpowers:<name>` to the repository skill of that name;
use the repository copy once, without repeating the global plugin workflow.
Vendored skill examples are tooling, not application source. Keep their provenance
and third-party notices. User scope and authorization take precedence over skills.

## Local application boundaries

- Use Node.js 22.23.3 or newer, native Next.js/React and persistent local SQLite.
  Install from `package-lock.json` with `npm run install:ci`; update the lock only
  for intentional dependency changes and retain unrelated locked versions.
- Default listeners to `127.0.0.1`; use real local account sessions and API tokens.
  Local deployment must not require external identity, hosting, database or plugin
  registration. Keep frontend assets and planning callbacks local.
- Preserve Ideas, Plans, Tickets, revision history, planning recovery, MCP reads,
  execution approvals and the signed local Docker execution backend.
- Planning output and manual snapshots grant no execution permission; real starts
  require a bound approval, registered operation, resource budget and backend.
- The user has authorized the local self-improvement workflow and a real test
  project. Execute Tickets only within their approved project/workspace and
  operation scope; installation alone grants no Ticket execution approval.
- Preserve existing working-tree edits and local state. Keep databases, account
  hashes, tokens, private keys, sessions, build/test output and caches out of Git.
- Do not import private/production data or replace an existing database to make a
  test pass; initialize a fresh temporary database for integration checks.

## Verification and documentation

Run `npm run build`, `npx --no-install tsc --noEmit`, `npm run lint` and relevant
local API/MCP/browser tests. Database setup must track applied SQL and verify its
checksums, so normal restarts never reapply schema statements. Docker-backed tests
require a real local daemon and pinned image; record missing prerequisites and
retain the full CI checks without inventing passing results.

Maintain `docs/FEATURES.md` from actual source behavior, grouped by the application's
navigation or functional section, with one sentence per feature. Documents describe
only the current local architecture and do not retain project migration/version
histories. Read `docs/DEPLOYMENT.md`, `docs/AUTHENTICATION.md`, `docs/PLANNING.md`,
`docs/EXECUTION.md`, `docs/RUNNER.md` and `docs/TESTING.md` for current contracts.

## 用户补充的 Agent 执行约定

### 执行方式

用户表示要开始新工作或修复现有问题时，持续推进，直到用户的目标完成，在目标方向上自主推进。
向用户提问之前，先完成上下文里已经授权、并且能把下一步变成可审查结果的工作。用户批准的应该是具体、可检查的结果。
用户建议不适合目标时直接说，不要迎合。
不要因为假想风险，主动加警告、免责声明、审批流程或安全/合规清单。

### 测试与验证

不要为可逆、影响小、只是复述实现的改动写测试。
跑与本次改动相称的测试，并完成必要检查。这些通过之后，只有出现新改动、新失败或尚未解决的疑点时，才扩大或重复测试；否则继续把任务做完。
收尾删掉本次产生、之后用不上的临时文件。
禁止做无意义的校验，仅允许传输文件中断后校验完整性。仅可以对极关键操作(如删除、项目全盘、底层、极重大改动)做包括但不限于任何类型的“门禁”、复核操作，在门禁措施上花费的token、思考和等待时间(包括等待门禁的编译、构建、从互联网获取相关门禁有关的代码资源)都不能超过项目总耗时的3%，所消耗token的4%，且在每一次工作开始时你都必须提前规划好分配给门禁措施的相关限额，而不是做到这一部分了才开始现场规划，对于门禁耗时超过规划限额的，在每次结束后到要全面复盘，并在下次工作中避免。

### 工具与并行

搜索文件或文本优先使用 rg、rg --files；独立的读取和查询尽量批量执行。
网页控制台无 CLI/API 时用已登录的Chrome浏览器；飞书优先 lark-cli。
共享状态、连续决策和简单任务由当前 Agent 直接完成；
在复杂/长程任务中, 积极使用子 Agent. 你作为orchestrator, 负责与用户对话, 理清需求和边界, 并给出实现效果蓝图, 将复杂任务实现下发给子agent.
委派任务必须有明确输入、输出和完成判据，最终结论由主 Agent 汇总并验证。
复杂任务使用gpt-6.1-sol high/xhigh, 简单任务使用gpt-6.1-sol low, 简单但长程任务使用gpt-5.6-luna xhigh
用户经常指派完成ticket/issue任务, 则先规划整体实现架构/衔接, 并使用subagent并行实行.

本轮适用说明：用户已批准 2026-10-08 workspace-loop 设计和并行实现；用户约定优先于仓库技能中的串行实现或重复评审要求。功能测试与必要构建用于证明实际交付行为，不另设重复门禁。当前工具没有 gpt-5.6-luna，简单长程任务使用可用的 gpt-6.1-sol；不得声称调用不存在的模型。
