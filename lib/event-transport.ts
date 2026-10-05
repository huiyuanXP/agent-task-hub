import type {
  Subscription,
  PlanningEvent,
  RpcParams,
} from "./types";
export const EVENT = "idea.planning_requested";
export function safeCallback(value: string) {
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    (u.port && u.port !== "443") ||
    !(
      u.hostname === "chatgpt.com" ||
      u.hostname.endsWith(".chatgpt.com") ||
      u.hostname === "openai.com" ||
      u.hostname.endsWith(".openai.com")
    )
  )
    throw new Error("Callback must use a trusted OpenAI HTTPS host");
  return u.href;
}
export function secretBytes(secret: string) {
  if (!secret?.startsWith("whsec_")) throw Error("Invalid signing secret");
  const b = Uint8Array.from(atob(secret.slice(6)), (c) => c.charCodeAt(0));
  if (b.length < 24 || b.length > 64) throw Error("Invalid signing key length");
  return b;
}
async function signature(secret: string, message: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return "v1," + btoa(String.fromCharCode(...new Uint8Array(signed)));
}
export async function signedPost(
  sub: Subscription,
  event: PlanningEvent | { type: string; challenge: string },
  id: string,
) {
  try { safeCallback(sub.url); secretBytes(sub.secret); if (sub.previousSecret && sub.rotationUntil && sub.rotationUntil > Date.now()) secretBytes(sub.previousSecret); }
  catch { throw new CallbackError("invalid_callback_or_secret"); }
  const body = JSON.stringify(event);
  if (new TextEncoder().encode(body).length > 262144)
    throw new CallbackError("event_too_large");
  const timestamp = String(Math.floor(Date.now() / 1000));
  const message = `${id}.${timestamp}.${body}`;
  let sig = await signature(sub.secret, message);
  if (sub.previousSecret && sub.rotationUntil && sub.rotationUntil > Date.now())
    sig += " " + (await signature(sub.previousSecret, message));
  console.info(
    JSON.stringify({ component: "events", stage: "signature_ready" }),
  );
  const response = await fetch(safeCallback(sub.url), {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(8000),
    headers: {
      "Content-Type": "application/json",
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": sig,
      "X-MCP-Subscription-Id": sub.id,
    },
    body,
  });
  if (response.status >= 300 && response.status < 400)
    throw new CallbackError("redirect", response.status);
  return response;
}
export async function subId(
  owner: string,
  p: RpcParams & { delivery: { mode: string; url: string; secret: string } },
) {
  const args = p.arguments || {};
  const canonical = JSON.stringify(
    Object.fromEntries(
      Object.entries(args).sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify([owner, p.delivery.url, p.name, canonical]),
    ),
  );
  return (
    "sub_" +
    Array.from(new Uint8Array(hash))
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("")
  );
}

export class CallbackError extends Error {
  constructor(public reason: string, public status: number | null = null) { super(reason); }
}
