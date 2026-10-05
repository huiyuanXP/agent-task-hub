# Independent identity implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete issue #3 with real Cloudflare Access JWT identity, protected sessions, owner/membership isolation and authenticated UI/API/MCP behavior.

**Architecture:** A pure JOSE verifier accepts only the configured Access issuer/application and derives a stable owner. The Worker establishes one request-scoped identity, checks D1 logout revocations and CSRF, and delegates to existing Vinext routes. Client UI consumes a no-store session endpoint and clears private state when identity expires.

**Tech Stack:** Cloudflare Worker/D1, Vinext/React, Node 22.23.3, pinned jose 6.2.12, existing isolated Miniflare/Chromium harness.

**Spec:** `docs/superpowers/specs/2026-10-04-independent-identity-design.md`

## Global Constraints

- Default built authentication is Access and fails closed.
- No production mode accepts the development cookie.
- Always strip caller-supplied `oai-authenticated-user-*` headers before passing the request to the application.
- Independent account identity comes exclusively from a validated token and request-scoped AsyncLocalStorage, not reconstructed client headers.
- Authentication supplies account access, never execution approval, budget or permission to run generated Tickets.
- No production owner reconciliation, provider registration, public deployment or reconnecting the original Site is authorized.
- Only jose 6.2.12 may be added deliberately; retain all pre-existing application dependency versions and keep the application/browser lockfiles.
- All test identities, token keys and D1 state are synthetic and isolated.
- Existing Run/authorization features and all tests from main must be preserved.

---

### Task 1: Implement and prove the Access verifier

**Files:** Create `lib/access-identity.mts`, `tests/auth/identity.test.mjs`; modify `package.json`, `package-lock.json` only for pinned JOSE and `test:auth` entrypoint.

**Interfaces:**
- Produces `AccessEnvironment` with optional string settings `ACCESS_TEAM_DOMAIN`, `ACCESS_AUDIENCE`, `ACCESS_APPLICATION_ORIGIN`, `ACCESS_ALLOWED_EMAILS`.
- Produces `AccessConfig {teamDomain:string; audience:string; applicationOrigin:string; allowedEmails:readonly string[]}` and `parseAccessConfig(settings:AccessEnvironment):AccessConfig`.
- Produces `AccessIdentity {userId:string; displayName:string; email:string; fullName:string|null; issuer:string; subject:string; expiresAt:number; tokenHash:string}`.
- Produces `createAccessVerifier(config:AccessConfig, fetcher?:typeof fetch):(token:string, now?:Date)=>Promise<AccessIdentity>`, with JOSE bounded remote JWKS caching and a fixed configured endpoint. `expiresAt` is UTC milliseconds; `tokenHash` is SHA-256 hex of the verified compact token.
- Produces `readAccessToken(headers:Headers):{token:string;transport:'assertion'|'cookie'|'bearer'}|null` with bounded input and ambiguity rejection, and pure helpers `safeAuthReturn(value:string|null, applicationOrigin:string):string` / `allowsSessionWrite(request:Request, applicationOrigin:string, transport:string):boolean` for Task 2.

- [ ] **Step 1: Add real verifier/config/transport tests before code.** A wrong issuer/audience, unsigned token or unapproved identity must not yield a caller identity. The same issuer/subject must retain its owner across token refresh; different subjects must differ. Use literal owner expectations and real ephemeral JOSE signatures, mocking only the remote JWKS response.

```js
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPair, exportJWK, SignJWT} from 'jose';
import {parseAccessConfig, createAccessVerifier} from '../../lib/access-identity.mts';
const settings={ACCESS_TEAM_DOMAIN:'https://synthetic-team.cloudflareaccess.com',ACCESS_AUDIENCE:'a'.repeat(64),ACCESS_APPLICATION_ORIGIN:'https://hub.auth.test',ACCESS_ALLOWED_EMAILS:JSON.stringify(['a@example.test','b@example.test'])};
test('verified Access identity maps to its stable private owner',async()=>{
 const {publicKey,privateKey}=await generateKeyPair('RS256');
 const publicJwk=await exportJWK(publicKey);
 const fetcher=async input=>{
  assert.equal(String(input),'https://synthetic-team.cloudflareaccess.com/cdn-cgi/access/certs');
  return Response.json({keys:[{...publicJwk,kid:'synthetic-key',alg:'RS256',use:'sig'}]});
 };
 const verify=createAccessVerifier(parseAccessConfig(settings),fetcher);
 const token=await new SignJWT({type:'app',email:'a@example.test'})
  .setProtectedHeader({alg:'RS256',kid:'synthetic-key',typ:'JWT'})
  .setIssuer(settings.ACCESS_TEAM_DOMAIN).setAudience(settings.ACCESS_AUDIENCE)
  .setSubject('subject-a').setIssuedAt(1704067200).setExpirationTime(1704067800).sign(privateKey);
 const identity=await verify(token,new Date('2024-01-01T00:00:00.000Z'));
 assert.equal(identity.email,'a@example.test');
 assert.equal(identity.expiresAt,1704067800000);
 assert.equal(identity.userId,'access:b0a46b57b3a36d74bcc02ebf9781abc64395e7d3e656d27d7b0438a579472ec5');
});
```

The owner literal above was independently computed with Python hashlib from compact JSON `[issuer,subject]`. Add table-driven configuration and safe-return/CSRF tests, valid refresh/different-subject tests and rejection cases for altered signatures, wrong issuer/audience/key/algorithm, malformed/oversized tokens, expired/future/missing/unsafe claims, service tokens/missing email, membership and token-transport ambiguity. Read `writing-good-tests.md`; never compute expected owners through the production helper.

- [ ] **Step 2: Install only the deliberate pinned verifier dependency and record RED.** Add JOSE 6.2.12 to dependencies using a package-lock-only update preserving all pre-existing versions, then `npm run install:ci`. Pin `test:auth` to `node --experimental-strip-types --test tests/auth/*.test.mjs`. Run the tests before the verifier exists and retain the expected missing implementation failure; inspect old/new package entries so no existing version silently changes.

- [ ] **Step 3: Implement the verifier and policy helpers.** Validate the exact single-team HTTPS Cloudflare Access origin, audience, application HTTPS origin and nonempty bounded allowed-email JSON list. Use `jose.jwtVerify` with required application/human claims, RS256 only, exact issuer/audience/typ, zero expiry tolerance and fixed `/cdn-cgi/access/certs`. Use JOSE timeout 5000ms, cache 300000ms and refresh cooldown 60000ms; no token URL controls JWKS. Validate safe integral temporal claims, issuance not in future, positive duration at most 86400 seconds and application/human type. Match verified email against normalized exact membership entries. Hash compact JSON issuer/subject for `userId`, hash the compact token for revocation, and return only the explicit identity DTO.

Implement safe return normalization against the configured application origin, rejecting external/protocol-relative/backslash-normalized/auth-reserved destinations. Reject duplicate/malformed/ambiguous credentials; prefer the Access assertion where available and support cookie/Bearer transport without accepting unverified Sites identity. Cookie/implicit requests require matching Origin and reject cross-site fetch metadata; a verified explicit Bearer without cookies may omit Origin, but never accept a supplied foreign Origin. Reject GET/prefetch logout in Task 2.

- [ ] **Step 4: Verify and commit this deliverable.** Run focused auth tests to GREEN, lint and tsc. Inspect root lock diff for only JOSE/package-script metadata, confirm no private key/token/provider credential is tracked, self-review and commit as strix agent. No push/issue close yet; the controller reviews this task.

### Task 2: Enforce one identity at the Worker boundary and implement sessions

**Files:** Create `lib/auth-context.ts`, `lib/authentication.ts`, `lib/auth-environment.d.ts`, `app/api/session/route.ts`, `tests/auth/worker-api.mjs`; modify `build/sites-worker.ts`, `app/chatgpt-auth.ts`, `db/schema.ts`, generated `drizzle` SQL/journal/snapshot, `scripts/test-integration.mjs`, existing `tests/execution/worker-api.mjs` and `authorization-worker.mjs` fixtures, and package test entrypoints.

**Interfaces:**
- Consumes all Task 1 exports and current Worker/D1/Run/authorization interfaces; preserve `getChatGPTUser():Promise<ChatGPTUser|null>` for all callers.
- Produces request-scoped `AuthenticationContext {mode:'access'|'trusted-sites'|'development';user:ChatGPTUser|null;expiresAt:number|null;tokenHash?:string}` and `runWithAuthentication<T>(context,run:()=>T):T` / `getAuthenticationContext():AuthenticationContext|undefined`.
- Produces an authenticated no-store GET `/api/session` response `{user,mode,expiresAt}` without token/raw claims/keys.
- Produces same-origin POST `/signout-with-chatgpt` and GET `/signin-with-chatgpt` behavior in independent mode, plus protected UI/API/MCP dispatch. Existing local middleware and explicitly trusted Sites routes stay compatible.

- [ ] **Step 1: Add actual Worker authentication regression first.** Follow the existing real Miniflare built-Worker test setup, use dynamically allocated loopback ports, fresh D1, all ordered migrations and an outbound service restricted to the synthetic configured JWKS endpoint. Generate ephemeral RSA keys/tokens for two allowed users plus denied variants. Before boundary code, show that unauthenticated/forged Sites identity reaches the old built Worker, while valid JWT identity does not map to the intended owner. Record that failure, then cover authorized records/planning/MCP/Run/authorization calls, two overlapping owners, protected UI redirect, forged Sites headers combined with valid JWT, missing/wrong/expired/future/service/non-member token, origin/CSRF, safe return, no-store session and logout replay denial. Do not contact a real provider, original Site or webhook.

- [ ] **Step 2: Add genuine request context and logout storage.** Use AsyncLocalStorage as in the existing connector binding helper, retaining user across Vinext revalidation contexts. Change `getChatGPTUser()` to return only the trusted context; no built raw-header fallback. At the custom Worker entry, select Access by default; parse verified identity and exact application origin, consult token revocation and normalize errors before delegating. Strip every incoming Sites identity header in all modes, extracting them beforehand only for explicit `AUTH_MODE=trusted-sites` plus `AUTH_TRUST_SITES_HEADERS=1`, or DEV loopback mock requests already filtered by the existing middleware. No deployment profile silently selects header trust. Keep connector behavior unchanged.

Add `auth_revocations` table with token hash primary key, owner, expiry milliseconds and creation time, plus expiry index. Generate the next actual migration after the current main schema rather than choosing a conflicting number or editing existing migrations. Lookup revocation for every verified request; logout atomically writes current-token revocation and prunes expired tombstones before clearing CF_Authorization with HttpOnly/Secure/SameSite and redirecting to application `/cdn-cgi/access/logout`. Protect unsafe cookie requests, POST-only logout and prefetch handling. Sign-in redirects through the configured Access application login URL with safe return target; use the inspected official provider behavior, not a invented callback. Missing/invalid configuration rejects access, never enables mock identity.

- [ ] **Step 3: Keep all real integration fixtures explicit.** In the temporary generated preview configuration used by #4, set trusted-sites and trust flag only for the synthetic loopback baseline. Existing standalone execution/authorization test Workers must set the same explicit fixture bindings; they do not prove independent identity. Add the new independent Worker suite to default `npm test` after its required build, and ensure it creates/removes its own D1 rather than using the checkout database. Verify both portable mock and built default/Access/trusted-sites paths, all protected API families and no cross-request identity contamination.

- [ ] **Step 4: Run relevant checks and commit.** Fresh build, lint, tsc, auth units, actual independent Worker tests, existing execution/authorization Worker API tests and isolated API/browser baseline. Preserve current schema/features, no root state migration or secret copy. Record actual output and append task report, then commit without push for controller review.

### Task 3: Deliver authenticated UI, expiry/logout and operator documentation

**Files:** Modify `app/page.tsx`, shared DTO types, `tests/browser/checks.mjs`, add focused authenticated UI coverage if separate fixtures are needed, update `README.md`, `docs/MIGRATION.md`, `docs/TESTING.md`, `docs/EXECUTION.md` identity boundary and `docs/STRIX-IMPLEMENTATION.md`; create `docs/AUTHENTICATION.md`.

**Interfaces:** Consumes trusted `/api/session` DTO, independent login/logout routes and existing data APIs. Produces real display identity, development labeling, session expiry clearing and documented Access setup/private membership/legacy mode/deployment requirements.

- [ ] **Step 1: Write browser regressions before UI change.** Verify actual development identity name/badge and POST logout, and actual session-expiry state handling through an isolated verified-session fixture. A 401 or membership 403 on session/data refresh must clear rows, draft, old account identity and planning state; a generic 503 does not masquerade as expired identity. Where a deadline is supplied, scheduled expiry clears private state and invalidates pending old refresh results. Preserve capture/history/Run/authorization panels, normal and modified home navigation, filtering and no page errors; browser's network proxy remains active.

- [ ] **Step 2: Implement the account flow.** Read the session endpoint with records/planning, display verified identity/initials, label local development identity clearly and include a genuine same-origin POST logout form. Offer sign-in for denied/expired sessions. Keep user data out of authentication decisions. Apply the expiry/reset behavior above using asynchronous timers with cleanup and load-sequence guards; preserve existing lint rules.

- [ ] **Step 3: Document complete source/config boundary.** Explain required public metadata and approved membership settings, Access application registration/private ingress prerequisites under #5, assertion/cookie/Bearer behavior, expiry/local revocation/provider logout, namespace mapping and separately authorized production owner reconciliation under #7, fail-closed defaults and explicit synthetic Sites compatibility. Update fresh migration reproduction to apply all current SQL once to fresh isolated state; never reapply raw SQL to existing schemas. Explain how to run every new test and what synthetic verification does/does not prove. No credentials, original Site ID or granting an application license.

- [ ] **Step 4: Verify the complete ticket, self-review and commit.** Run lint, tsc, build, `npm test`, standalone execution/authorization API checks and actual auth Worker/UI checks. Verify root lock preserves existing dependency versions plus explicit JOSE addition, browser lock unchanged, no sensitive/generated files tracked and no test listeners remain. Finish all spec requirements with actual evidence, update the implementation record and commit. Controller performs final whole-issue review, its own issue-specific push/PR and hosted CI observation before closing #3; no deployment.
