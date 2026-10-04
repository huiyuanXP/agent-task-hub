# Independent Cloudflare Access identity design

Issue #3 is a prerequisite for #11. The selected seven issues are #1, #2, #3, #4, #9, #10 and #11. User authorization delegates design choices and issue-specific pushes; it does not authorize provider registration, public deployment, production data import or reconnecting the original Site.

## Provider and architecture

Choose Cloudflare Access, which fits the existing Worker/D1 deployment. A generic OIDC authorization-code service would add client-secret/state/session lifecycle and a separate provider registration; a local password service would add password-reset/MFA obligations. Access supplies managed identity-provider sign-in, application JWTs and its upstream session cookie. This repository supplies origin-side JWT verification, owner/membership policy, CSRF protection, immediate local logout revocation and one trusted request identity shared by UI/API/MCP.

Use pinned `jose` 6.2.12, observed in the npm registry on 2026-10-04, for JWT/JWKS verification with native WebCrypto. Add this dependency deliberately and preserve all pre-existing locked package versions; do not run an audit fix or blanket upgrade. No custom cryptographic signature implementation is needed. JOSE and provider documentation license obligations remain in their upstream packages; do not grant an application license.

Default built authentication is Access and fails closed. Required non-secret deployment settings are Access team HTTPS origin, exact application audience, exact HTTPS application origin and an explicit nonempty allowed-email list. Unconfigured independent endpoints must reject data access and spoofed Sites headers. Missing configuration does not enable development identity. The separately authorized resource work in #5 must register the new private Access application and disable unprotected alternate Worker routes.

Explicit compatibility mode `trusted-sites` additionally requires an explicit trust flag. It is for an existing trusted Sites dispatcher or the loopback synthetic test fixture, not an independent public endpoint. Portable development remains the existing loopback-only mock middleware and is enabled only in development builds. Both runtime profiles continue to bind loopback. No production mode accepts the development cookie.

## Verified identity

Accept an Access assertion header or application cookie; also support the same Access JWT as an explicit Bearer token for programmatic MCP clients. Reject ambiguous transports that assert different identities/tokens. Always strip caller-supplied `oai-authenticated-user-*` headers before passing the request to the application. Independent account identity comes exclusively from a validated token and request-scoped AsyncLocalStorage, not reconstructed client headers.

Team configuration accepts only a single `https://<team>.cloudflareaccess.com` origin without credentials, non-default ports, query, fragment or path. Fetch only its fixed `/cdn-cgi/access/certs` JWKS endpoint; ignore token-provided URLs. Verify RS256, issuer, audience, signature, expiration, not-before and issuance time, and require an application/user token with nonempty subject and provider-verified email. Enforce safe numeric claims and a documented maximum 24-hour application token age/duration. Reject unknown algorithms/keys, malformed/oversized JWTs, wrong issuer/audience and provider failures. Use JOSE's bounded timeout/cache/refresh cooldown; cache configurations with a finite size rather than an unbounded request-controlled map.

Membership requires the verified email to appear in the configured allowlist. Derive the record owner as `access:` plus SHA-256 of the verified issuer and subject. The issuer prevents cross-tenant collisions; email changes do not silently move records. Sites IDs are not automatically mapped to Access owners. Production owner reconciliation stays separately authorized under #7. Each admitted member has a private owner partition; collaborative sharing is not added.

## Sessions and logout

All protected application calls obtain the same request identity. Preserve `getChatGPTUser()` for existing callers but change its implementation to read only the trusted context. Expose an authenticated, no-store session endpoint with display name/email, mode, stable owner and expiry; never return tokens, signing keys or raw claims.

Add a D1 token-revocation table containing only token hash, owner and expiry. Check it after JWT verification on each request. A same-origin POST logout atomically revokes the current token before clearing the application cookie and redirecting to the documented application-domain Access logout endpoint. Replaying the token after local logout must fail immediately. Access manages its own global session; its documented upstream logout propagation is not represented as locally verified behavior. Prune expired local tombstones without touching unrelated owner data.

Sign-in builds the Access login URL for the configured application audience and safe application-relative return path. Reject external, protocol-relative, encoded/normalized cross-origin and reserved auth return targets. Auth routes are no-store. Anonymous protected UI redirects to sign-in; API and MCP data calls return authentication errors. Discovery can remain public only when it contains no owner data. Protect the configured application origin and reject alternate independent request origins; local built-fixture compatibility is explicit.

Unsafe cookie/session requests require same-origin Origin and reject cross-site fetch metadata. Explicit verified Bearer calls without cookies can omit Origin; any supplied Origin must still match. Existing records/planning API origin checks remain. Logout is POST-only in independent mode; prefetch and GET cannot revoke a session. Authentication supplies account access, never execution approval, budget or permission to run generated Tickets.

## UI and compatibility

Display the authenticated identity and offer an actual POST logout action. Mark development identity clearly. On 401/expired session, clear rows, draft and prior-account state so private data is not left rendered. Keep network-error behavior separate from expired authentication. Original planning tools and protocol versions remain compatible.

Update #4's built-preview fixtures to opt explicitly into trusted synthetic Sites mode in their temporary generated configuration. Add independent-mode tests instead of treating those header fixtures as authentication proof. Keep all test identities, token keys and D1 state synthetic and isolated.

## Verification

Unit tests exercise provider configuration, redirect/origin policy, stable owner derivation, token transport ambiguity and real JOSE-signed ephemeral JWTs with valid/invalid claims. Mock only the external JWKS HTTP response. No provider signing credential or production key is copied or persisted.

Use the actual built Worker under local Miniflare with isolated D1 and an outbound JWKS service that serves a newly generated synthetic RSA public key and rejects every other outbound destination. Exercise anonymous/spoofed identity denial, legitimate authorized CRUD and MCP, two different verified owners, fake Sites headers accompanying a valid JWT, wrong signature/issuer/audience/algorithm, expired/future tokens, email membership denial, cookie/Bearer CSRF rules, protected UI sign-in redirect, safe return targets, logout revocation/replay and provider outage. Apply every committed migration once to the fresh test database. Verify the request identity survives Vinext handling and does not leak between overlapping owners.

Finish with lint, tsc, build, unit tests and the isolated API/browser CI suite. Test actual UI session display, navigation and logout/expiry behavior. Review the complete issue diff, retain exact test evidence, commit and push this issue separately. Provider registration/live login and public operational acceptance require #5's separately authorized resources and are not claimed by synthetic verification.

## Documentation sources inspected

Fetched the public Cloudflare documentation source through GitHub after the documentation website returned HTTP 403:

- cloudflare/cloudflare-docs, production branch, `src/content/docs/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json.mdx`: origins must validate the JWT, expected issuer/audience, RS256 and the fixed team JWKS endpoint; the assertion header is recommended over assuming a cookie is present.
- `application-token.mdx`: provider-verified email, application audience, expiration, issuer, stable account-scoped subject and application token shape.
- `access-settings/session-management.mdx`: application-domain and team-domain `/cdn-cgi/access/logout`, application/global expiry behavior and upstream revocation timing.

The fetched copies and npm metadata are external verification artifacts in `strix-validation/`, not repository credentials or provider configuration.
