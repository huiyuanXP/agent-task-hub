# Independent account identity

Built Workers default to Cloudflare Access and reject access when configuration is missing. Configure these non-secret Worker bindings for a **new, separately registered** private Access application:

- `ACCESS_TEAM_DOMAIN`: exact `https://<team>.cloudflareaccess.com` origin.
- `ACCESS_AUDIENCE`: the application's 64-character hexadecimal audience.
- `ACCESS_APPLICATION_ORIGIN`: exact HTTPS application origin.
- `ACCESS_ALLOWED_EMAILS`: JSON array of explicit allowed email addresses.

The Worker verifies RS256 application JWTs using the team's fixed `/cdn-cgi/access/certs` endpoint. It requires issuer, audience, subject, email, application type, issuance and expiration claims, enforces a maximum 24-hour token lifetime, and checks membership. Assertion, `CF_Authorization` cookie and Bearer transports are accepted; conflicting credentials are rejected. Caller-supplied Sites identity headers are stripped. Identity lives in request-scoped storage shared by UI, API and MCP.

Owners are `access:` plus SHA-256 of the JSON pair `[issuer, subject]`. Email changes preserve the owner; identities from other issuers remain separate. There is no mapping from imported Sites owners. Owner reconciliation and production data migration require their own scope.

## Login and logout

GET `/signin-with-chatgpt?return_to=...` redirects to the configured protected application origin plus a validated local return path. Cloudflare Access ingress owns authentication and its callback; this application does not invent an OIDC callback or use an undocumented provider login query. External, encoded cross-origin and reserved authentication return targets normalize to `/`. The protected hostname must be registered with Access, and alternate Worker routes must be disabled or remain inaccessible. The origin-side verifier still denies requests lacking a valid identity if ingress is bypassed.

GET `/api/session` returns `{user, mode, expiresAt}` with `private, no-store`; expiry is Unix milliseconds or `null` for development/explicit compatibility mode. It never returns tokens or raw provider claims. Missing, expired and revoked credentials return authentication errors. In configured independent mode anonymous UI navigations redirect to sign-in, while API/MCP calls return 401.

POST `/signout-with-chatgpt` requires an exact same-origin `Origin`. It atomically records the current token's SHA-256 hash and prunes expired tombstones in D1, clears the application cookie with HttpOnly/Secure/SameSite, and redirects to the documented application-domain `/cdn-cgi/access/logout`. The local hash is denied immediately on every subsequent request. Other tokens require provider revocation; Access documents global session logout and 20–30 second upstream propagation. Local tests do not prove upstream revocation. GET and prefetch requests cannot revoke tokens.

Unsafe browser requests require the configured Origin and reject cross-site fetch metadata. Explicit verified Bearer calls without any cookies may omit Origin; a matching Access assertion is compatible with this transport. Any Cookie header restores the Origin requirement. Records/planning routes retain their stricter mandatory Origin checks. Authentication establishes account access only; execution approval and backend authority remain separately enforced.

## Local and legacy compatibility

Portable development uses the existing loopback mock middleware and identifies sessions as `development`. This branch is absent from production builds and disabled in the managed profile. Built Workers never accept the local mock cookie.

`AUTH_MODE=trusted-sites` requires `AUTH_TRUST_SITES_HEADERS=1`. This explicitly trusts a Sites dispatcher to authenticate the headers before they arrive, so it must never be used on an independently exposed public endpoint. No deployment profile selects it automatically. The isolated integration suite adds these bindings only to its temporary synthetic loopback preview configuration. Standalone execution/authorization regression Workers use the same explicit fixture mode; these baseline tests do not prove independent authentication.

## Verification boundary and sources

`npm run test:auth` verifies the pure token policy. `npm run test:auth:api` builds and runs the actual Vinext Worker in Miniflare with a fresh D1 database, all migrations, ephemeral synthetic RSA keys, and only a synthetic team JWKS outbound response. It covers spoofed headers, two concurrent owners, protected API/UI/MCP/Run/authorization calls, session expiry, Origin checks, safe redirects, logout replay, storage failure, provider outage and explicit compatibility modes. No real tenant, provider signing key, production data, webhook or execution backend is contacted.

The sign-in redirect tests establish local URL construction, **not live SSO**. Provider registration, protected-hostname setup and operational validation remain separately authorized work under issue #5.

Public Cloudflare sources inspected on 2026-10-04:

- [Self-hosted public application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/): Access sits between the end user and origin; only matching users reach the protected application. [Inspected source](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app.mdx).
- [cloudflared token flow](https://github.com/cloudflare/cloudflared/blob/master/token/token.go), `exchangeOrgToken`: initiates the Access SSO flow by requesting the application URL.
- [JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/): origin verification, expected issuer/audience and the fixed team certs endpoint.
- [Session management](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/#log-out-as-a-user): documented application-domain logout URL, global session behavior and upstream propagation delay.
