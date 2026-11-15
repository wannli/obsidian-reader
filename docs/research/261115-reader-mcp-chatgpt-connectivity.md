---
created: 2026-11-15
---

# Reader MCP: secure ChatGPT connectivity to bwd

## Answer and recommendation

**Two current documented routes can connect ChatGPT to a private bwd MCP: Secure MCP Tunnel, or a publicly reachable HTTPS endpoint/proxy. Neither establishes Wannes's account entitlement, caller authorization or permission to disclose Reader data.** No route has been selected or tested. [CUSTOM][CONNECT][TUNNEL]

**Recommendation, not a deployment decision:** investigate Secure MCP Tunnel first, with OAuth-authenticated, read-only synthetic tools and no public bwd listener. Use controlled public HTTPS only if Wannes chooses its ingress obligations or tunnel eligibility blocks the first route. An anonymous demo would prove transport, not the authenticated Reader boundary.

The next gate is human authorization to verify the intended ChatGPT account/workspace and Platform permissions, then choose transport and authentication. This report does not authorize that check or any setup. The smallest proof is below; it does not require Sync, a personal vault or desktop Obsidian on bwd.

## Authority and evidence limits

This independent research serves already-claimed [Reader #99][TICKET] under [map #98][MAP]. The map and ticket were read in full, including comments. Source authority is `research/reader-mcp-chatgpt-connectivity`; only this report belongs to this work. No subagents were used.

Starting evidence: `/home/whl/code/w/docs/research/261114-obsidian-mcp-scheduled-research-feasibility.md`. Moving claims were refreshed from official OpenAI/MCP documentation and the owning tunnel repository on **2026-11-15**. Earlier research is context, not proof of today's entitlement.

- **W's chosen allocation:** trusted bwd holds/processes private synced material using Headless Sync and direct files, with no desktop Obsidian/CLI dependency. Local enforcement mediates MCP; scheduling is independent of chat. Secure MCP Tunnel remains a candidate, not a chosen deployment. This W decision is relevant evidence, not permission to import W's model or install its allocation in Reader. [HOST]
- **Accepted privacy:** assistance must be explicitly enabled; permitted public sources/public-text highlights exclude private writing, questions, connections and activity history. Uncertainty fails closed; private-derived output stays protected. Processing is not publication or permission for external actions. Membership and tool annotations confer no disclosure authority. [PRIVACY][MAP]
- **Reader's stricter initial scope:** no private-excerpt support. A server cannot retract previously disclosed text from a persistent ChatGPT transcript. Selected-source versus collection-wide authority remains human-led; use explicitly approved fictional fixtures, not a collection sweep. [MAP][HOST]
- **Not performed:** account/credential inspection, dependency installation, host contact/configuration, service or tunnel setup, Sync, vault access, model tool calls or device acceptance. Documentation availability is not measured security or runtime evidence.

## Connection options: reachability is only the first gate

| Route | Current documented capability | Obligations and limits |
| --- | --- | --- |
| Secure MCP Tunnel | A client inside bwd's boundary polls OpenAI over outbound HTTPS, forwards MCP requests to local stdio/HTTP and returns responses. No inbound public listener is needed. ChatGPT custom-server creation has a Tunnel option. [TUNNEL] | Requires an available running client, runtime API key, tunnel associations and permissions. OpenAI handles tool traffic; private ingress is not private processing. OAuth remains a separate layer. |
| Public HTTPS | ChatGPT accepts a Server URL; supported protocols include SSE and streaming HTTP. The connection guide describes Streamable HTTP, typically `/mcp`, through public HTTPS. A development tunnel/HTTPS forwarding service is also documented. [CUSTOM][CONNECT] | Operate valid TLS, authentication/discovery and a bounded gateway. An HTTPS forwarding product is not equivalent to Secure MCP Tunnel. Wannes must approve provider, ingress and operational ownership; none is chosen. |
| Local client | ChatGPT desktop's Codex host, Codex CLI and IDE support stdio and Streamable HTTP; HTTP supports bearer tokens/OAuth. [LOCAL] | These are local/Codex-host capabilities, not proof that a hosted ChatGPT chat can reach bwd. ChatGPT web does not read local Codex configuration. Do not add a broad local-computer bridge as a shortcut. |
| Loopback/tailnet URL alone | No cited product documentation establishes direct hosted-ChatGPT access to bwd's localhost or private tailnet hostname. [CONNECT][LOCAL] | A user's ability to browse that address does not establish OpenAI routing, authentication or authorization. A separate supported connection is needed. |

Private custom testing does not require public plugin submission. Public submission/distribution, unlike a private tunnel connection, requires a stable public HTTPS MCP endpoint. No public listing or distribution is proposed. [TUNNEL]

### Tunnel prerequisites and new findings

The current official guide separates Platform and ChatGPT controls: [TUNNEL]

1. Tunnel creation/editing requires organization-level **Tunnels Read + Manage**.
2. Running the client/selecting the tunnel requires **Tunnels Read + Use**; a restricted runtime key authenticates the client to OpenAI's control plane.
3. Associate the tunnel with the intended ChatGPT workspace as well as the owning Platform organization. A personal Platform association does not automatically grant Enterprise/Edu visibility.
4. bwd must reach the private MCP and `api.openai.com:443` (`/v1/tunnel/*`), or the documented mTLS control-plane endpoint when configured. A healthy polling process must remain available for discovery and calls.
5. OAuth discovery can traverse the tunnel, but **the authorization server is not automatically tunneled**. Its browser authorization and back-channel discovery/token routes need independently workable reachability. Prove this topology rather than assuming a private IdP works.

The owning release API now reports **v0.0.21, published 2026-11-14**, superseding the earlier report's v0.0.20 snapshot. Its release notes add regional endpoint selection but explicitly say **EU Tunnel residency is currently unavailable as a supported customer deployment**. Flags do not establish residency entitlement, assignment, retention or EU-only processing. No region has been selected. [RELEASE]

The release also adds an option to disable OAuth discovery for static-credential upstream servers. That is a tunnel-client capability, **not evidence that ChatGPT custom MCP supports arbitrary user API-key headers**, and not a reason to disable OAuth in this proof. [RELEASE][AUTH]

Documented tunnel defaults include 600 requests/minute, 10 MiB serialized envelopes, 120 seconds absolute request deadline including queue time, and 1,000 pending requests/tunnel. They are service protections, not latency guarantees or a durable work queue. Keep proof calls short and bounded. [TUNNEL]

## Account/workspace eligibility: documented versus unverified

Custom MCP setup is documented through **ChatGPT web → Plugins → Add custom MCP server**, followed by authentication, risk acknowledgement, creation and installation. Workspace permissions and security restrictions, including Lockdown, apply. No mandatory `search`/`fetch` pair is required. [CUSTOM]

Managed-workspace documentation lists separate controls for using plugins, uploading plugins with custom MCP servers, and creating plugins with MCPs/developer mode. The applicable role and installation controls must permit the actual connection; Platform tunnel permission alone is insufficient. [CONTROLS][TUNNEL]

Generic plugins are documented across web, desktop and mobile, with desktop-only exceptions. That does not certify this custom integration, its OAuth UX, or a particular account's availability. Initial acceptance should use ChatGPT web in a real desktop browser, as the map permits. [PLUGINS][MAP]

**Unverified:** Wannes's plan, region, workspace, role, Lockdown settings, custom-MCP creation/use, tunnel availability, organization/workspace linkage and runtime-key permission. Pricing and Help Center articles 12584461, 20001256 and 11487775 returned HTTP 403 during this refresh. Do not reproduce the earlier generic pricing matrix as a current custom-MCP entitlement table or recommend purchasing a plan from it.

A later authorized account check should record only non-secret pass/block evidence for those prerequisites. It must distinguish “feature documented,” “account allowed,” “route selected,” and “authenticated call observed.” This research establishes only the first.

## Authentication and disclosure contract to prove

**Keep three checks independent:** (1) authorized tunnel/transport context, (2) authenticated caller and allowed operation, (3) current source-specific disclosure permission. A trusted OpenAI client or successful OAuth login does not authorize all vault content. [AUTH][TUNNEL][PRIVACY]

Recommended authentication path, without selecting an IdP, client registration or durable identity format:

- Use an established OAuth provider supporting MCP's OAuth 2.1 authorization-code flow with **PKCE S256**. OpenAI's guide recommends an existing provider over home-grown authentication. [AUTH]
- Expose protected-resource metadata (`/.well-known/oauth-protected-resource`, or its URL in `WWW-Authenticate`), authorization-server OAuth/OIDC metadata, correct canonical resource/issuer identifiers and usable authorization/token endpoints. Discovery contains no private Reader metadata. [AUTH]
- Choose CIMD, DCR or a predefined OAuth client deliberately. ChatGPT supports CIMD token exchange with `none` or `private_key_jwt` when advertised. “Static credentials” in custom-server setup means OAuth client credentials, not an arbitrary tool API key. [CUSTOM][AUTH]
- Copy the exact callback URI from the actual connection's management page. Current documentation distinguishes callback-ID-specific redirects from stable redirects when issuer identification requirements are met; do not hard-code an old example. Honor resource binding through authorization and token exchange. [AUTH]
- Validate tokens on every protected request: signature/introspection as applicable, issuer, intended resource/audience, expiry/not-before, scopes and server-side user/capability policy. Never trust a model-supplied identity or permission argument. Never accept unrelated provider tokens or pass them through as downstream authority. [AUTH][MCP-AUTH]
- HTTP authentication failures use `401` with a discoverable Bearer challenge; insufficient scope/permission uses `403`. For ChatGPT tool-level linking, publish tool security schemes and the documented `_meta["mcp/www_authenticate"]` runtime challenge. Sanitize both paths. [AUTH][MCP-AUTH]
- OpenAI-managed client mTLS or published egress ranges can identify/harden the public client path, not authenticate the end user. ChatGPT does not support customer API keys, customer-provided mTLS certificates or machine-to-machine OAuth grants in this custom-plugin flow. Codex HTTP bearer-token support must not be transposed here. [AUTH][LOCAL]
- Tunnel control-plane mTLS and MCP-side mTLS are separately documented options. Do not assume an OpenAI edge certificate, forwarded header or tunnel session automatically establishes a validated end-user identity on the local hop. Verify the chosen forwarding/token path. [TUNNEL][AUTH]

The refreshed MCP 2026-07-28 specification has transport/version changes and explicitly describes compatibility with initialization-based revisions. OpenAI's custom guide still advertises SSE/streaming HTTP. **Protocol publication is not client support:** select a mutually supported SDK/protocol revision and prove discovery/calls, rather than assuming ChatGPT implements the newest revision. [MCP-TRANSPORT][CUSTOM]

## Threat model and minimum operational safeguards

Protected assets include local private text, private-derived output, titles/paths/links, secrets and write authority. Treat the hosted model, retrieved source instructions and tool arguments as untrusted callers; external delivery remains disclosure even through a private tunnel. [PRIVACY][SECURITY]

| Threat | Recommended enforcing control and proof |
| --- | --- |
| Stolen/forged token, wrong user/audience or overbroad grant | Least scopes, validated identity mapping and deny-by-default operation/source checks; reject expired, wrong-issuer/audience and insufficient-scope tokens. No model-granted privileges. [AUTH] |
| Public ingress, DNS rebinding, discovery/registration SSRF | Valid TLS with certificate verification; only intended endpoint/methods; bounded requests/rates; local HTTP on loopback with Origin validation; constrain discovery/redirect destinations and block inappropriate private targets. Tunnel private-upstream access is explicit configuration, not arbitrary caller routing. [MCP-HTTP][MCP-SECURITY] |
| Prompt injection or metadata leakage | Fixed narrow capabilities; no shell, SQL, generic CLI, arbitrary paths/writes or permission edits. Filter before constructing every external envelope, including `content`, `structuredContent`, `_meta`, errors, citations and tool descriptions. Hints/approval UI are not enforcement. [MAP][MCP-TOOLS][SECURITY] |
| Secret/log leakage | Use local protected secret injection, never literal keys in commands, report, Git, chat or screenshots. Restrict runtime key permissions; keep admin UI loopback-only and raw HTTP logging off. Use correlation IDs and sanitized error classes, not raw prompts, payloads, bearer headers or private file paths. [TUNNEL][SECURITY] |
| Stale permission or revocation | Recheck local source authority on each call and immediately before disclosure/side effect. Deny when unavailable/stale. Test OAuth grant/refresh revocation and local disable separately; short token lifetime alone is not immediate revocation. Unlinking UI alone is not evidence that existing tokens stopped working. [AUTH][PRIVACY] |
| Tunnel/client outage, timeout or ambiguous write | Fail closed with bounded sanitized errors; never fall back to anonymous/public access. Stop ingress/polling and revoke runtime keys/associations as appropriate to disable transport; separately revoke OAuth and local capability grants. Already delivered transcript content remains delivered. [TUNNEL][PRIVACY] |

For HTTPS, terminate TLS only at an approved gateway and protect any non-loopback upstream hop. For a same-host tunnel upstream, stdio or loopback HTTP reduces exposure, but local process permissions still matter. These are recommendations, not host configuration choices. [TUNNEL][MCP-HTTP]

Tunnel transport events and normal ChatGPT app/compliance logs have different handling; the tunnel guide says app invocation/auth lifecycle logging still applies. No ChatGPT retention, training, compliance-access or residency guarantee was established. API data controls are not automatically ChatGPT controls. Private canaries below are fictional only; do not test with personal secrets. [TUNNEL][PRIVACY]

Future URL capture additionally needs SSRF defenses for target URLs, DNS resolution and redirects, bounded downloads, explicit request authority and Reader-equivalent guarded writes. A retry after uncertain completion must not duplicate or overwrite notes. Keep capture disabled in the connectivity proof; this is a later prerequisite, not a selected write contract. [MAP][SECURITY][MCP-SECURITY]

## Smallest synthetic proof — proposed, not executed

**Gate:** Wannes authorizes eligibility verification and the particular host/transport/auth setup. The parent settles required tool, disclosure, identity and durable-format decisions before implementation. Keep fixtures ephemeral unless an approved persisted contract is required. No new always-on service, Sync or desktop Obsidian dependency is implied.

1. Prepare two fictional permitted public-source texts and adjacent fictional private canaries/private-derived output in an owned synthetic fixture. Approve exactly those sources. Add malicious instructions attempting broader retrieval. Do not scan a collection or mount personal material.
2. Implement only bounded read/list retrieval over the permitted fixture. Return publisher-style citations and an approved article-level synthetic vault return link, without reading-position/bookmark/dog-ear mutations. Keep metadata generic and safe before login. No write tool, scheduler, widget or local-computer bridge.
3. Verify locally: discovery, schema validation, intended identity/scopes and all denial cases. Then, after separate setup authorization, start the chosen transport and verify OAuth discovery, browser login, token audience and local verification end to end. A local Inspector call is not ChatGPT evidence.
4. In ChatGPT web on a real desktop, install/select the custom plugin. Find both permitted articles, fetch text and compare with citations. Inspect expanded JSON inputs/outputs and sanitized server evidence. Confirm the actual caller and only the intended capabilities. Record route, tested client/protocol versions and non-secret pass/block evidence.
5. Attempt unauthenticated access, wrong user/audience, expiry, insufficient scope, forged permission/path arguments, private lookup, malicious content and stale source permission. Inspect entire envelopes, titles, links, errors and relevant logs for every canary, not just the answer. Reject forbidden requests server-side even if ChatGPT attempts them.
6. Revoke local authority and OAuth grants; test existing access/refresh tokens and relinking behavior. Stop the tunnel/upstream or HTTPS route; observe bounded failure without fallback. Confirm transcript reuse cannot be retracted and no reading state or fixture files changed.

**Connectivity pass:** an observed authenticated ChatGPT tool call, permitted two-source comparison, denied unauthorized requests, no synthetic-canary leakage in inspected surfaces, effective tested revocation and accurate outage behavior. A finite test suite is not a general security proof. Do not claim capture, headless/Sync, scheduling, mobile or production acceptance.

The map's later full prototype additionally requires explicit guarded URL capture and the approved desktop read/compare/capture journey. Completing this smaller connectivity proof would not complete #98. Parent decisions still include transport, IdP/registration, disclosure scope, host integration and any required persistent contracts. No choices are made by this report. [MAP]

## Validation and handoff

Official pages below were fetched successfully on 2026-11-15 except the explicitly recorded pricing/Help Center failures. The tunnel latest-release API and W #72/#66 bodies/comments were refreshed. Report checks cover frontmatter, fewer than 200 lines, citation definitions/use and whitespace. No application build/test, installation, runtime or account validation is implied. Publish this report only on its research branch; the parent reviews the evidence and records any resolution.

## Sources

[TICKET]: https://github.com/wannli/obsidian-reader/issues/99
[MAP]: https://github.com/wannli/obsidian-reader/issues/98
[HOST]: https://github.com/wannli/W/issues/72#issuecomment-6878459386
[PRIVACY]: https://github.com/wannli/W/issues/66#issuecomment-6836843205
[CUSTOM]: https://developers.openai.com/api/docs/guides/custom-mcp-server.md
[CONNECT]: https://developers.openai.com/plugins/deploy/connect-chatgpt.md
[TUNNEL]: https://developers.openai.com/api/docs/guides/secure-mcp-tunnels.md
[RELEASE]: https://github.com/openai/tunnel-client/releases/tag/v0.0.21
[AUTH]: https://developers.openai.com/plugins/build/auth.md
[CONTROLS]: https://learn.chatgpt.com/docs/enterprise/apps-and-connectors.md
[PLUGINS]: https://learn.chatgpt.com/docs/plugins.md
[LOCAL]: https://learn.chatgpt.com/docs/extend/mcp.md
[SECURITY]: https://developers.openai.com/plugins/guides/security-privacy.md
[MCP-AUTH]: https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization.md
[MCP-TRANSPORT]: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports.md
[MCP-HTTP]: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http.md
[MCP-TOOLS]: https://modelcontextprotocol.io/specification/2026-07-28/server/tools.md
[MCP-SECURITY]: https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices.md
