import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const dynamic = "force-dynamic";

// Public executable artifact only; no owner records or installation secrets.
export async function GET() {
  try {
    const file = resolve(/* turbopackIgnore: true */ process.cwd(), "build/connector/agent-task-hub-connector.tgz");
    const bytes = await readFile(/* turbopackIgnore: true */ file);
    return new Response(new Uint8Array(bytes), { headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": 'attachment; filename="agent-task-hub-connector.tgz"',
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    } });
  } catch {
    return Response.json({ error: "客户端包尚未构建，请运行 npm run package:connector。" }, { status: 503 });
  }
}
