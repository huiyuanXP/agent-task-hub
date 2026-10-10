import Link from "next/link";
import { configuredOrigin } from "../../lib/local-auth.mts";

export const dynamic = "force-dynamic";

export default function InstallGuide() {
  const origin = configuredOrigin();
  return <main className="install-guide">
    <Link href="/">← 返回点子工坊</Link><h1>安装点子工坊 MCP 与 CLI</h1>
    <p>将一个 Git 项目接入工坊，让该项目的 Agent 提交点子和 Ticket、生成规划并执行已批准的任务。</p>
    <ol>
      <li><h2>在网页创建安装授权码</h2><p>登录“连接与执行”，填写项目与连接名称，选择客户端能力，生成十分钟有效的一次性授权码。</p></li>
      <li><h2>下载并解包客户端</h2><p>需要 Node.js 22.23.3 或更新版本；无需单独安装 npm 依赖。</p><a className="primary" href="/api/connectors/download" download>下载 MCP / CLI 包</a><pre>{`curl -fL '${origin}/api/connectors/download' -o agent-task-hub-connector.tgz\ntar -xzf agent-task-hub-connector.tgz`}</pre></li>
      <li><h2>关联本机项目</h2><pre>{`node agent-task-hub-connector/cli.mjs install --url '${origin}' --workspace '/你的Git项目绝对路径'`}</pre><p>按提示输入授权码。安装器保存独立的客户端凭据，并在项目中添加 MCP 配置，保留已有的其他连接配置。</p></li>
      <li><h2>启动 MCP 和开发 Agent</h2><p>安装完成会打印确切的启动命令。重启或刷新你的 Agent 的 MCP 配置后，用诊断命令检查连接。</p><pre>{`node agent-task-hub-connector/cli.mjs doctor --workspace '/你的Git项目绝对路径'\nnode agent-task-hub-connector/cli.mjs agent --workspace '/你的Git项目绝对路径'\n# 或选择现有的本机 Profile\nnode agent-task-hub-connector/cli.mjs agent --workspace '/你的Git项目绝对路径' --profile mimo`}</pre><p>默认继承本机 Codex 的模型、provider 和认证配置；已有 API 网关或 Profile 可以直接使用，无需重新 Device 登录。仅使用官方账户认证方式而尚未登录时，才需要在本机运行 codex login。</p></li>
      <li><h2>核对后台连接并开始迭代</h2><p>回到“连接与执行”，查看项目、客户端版本和最近通信；常驻进程启动后显示在线。保存点子后，Agent 领取规划任务并生成 Plan 和 Tickets。</p><p>在 Ticket 看板申请并批准开发执行，查看进度、代码变更与测试输出，再点击“验收通过”。</p></li>
    </ol>
    <h2>让你的 Agent 安装</h2><p>把本页地址、项目路径和一次性授权码交给你的 Agent。它可以读取下面的机器可读说明，下载安装包，运行安装器，再检查注册与 MCP 协议。浏览器页面不会直接修改你的本机文件。</p>
    <p><a className="text-btn" href="/install/manifest">读取安装接口说明（JSON）</a></p>
    <h2>状态与撤销</h2><p>后台区分 MCP 最近使用和常驻 Agent 在线。停止进程后，心跳超过阈值会变为离线；重启保留同一个连接标识。网页撤销连接会停止后续访问与任务续租。</p>
    <p>当前服务地址：<code>{origin}</code>。临时隧道地址变化时，使用安装器的 <code>set-url</code> 命令更新，保留原有连接。</p>
    <p><a href="https://developers.openai.com/codex/mcp/">Codex MCP 配置文档</a> · <a href="https://developers.openai.com/codex/noninteractive/">Codex 非交互执行文档</a></p>
  </main>;
}
