# SCRUM-197 Stresstest med k6 – Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 50+ k6-bots spiller rigtige Slopster-spil mod clusteret fra en terminal, og admin kan bagefter slette alle `loadbot_*`-brugere og deres stats.

**Architecture:** Et k6-script (`gitops/loadtest/`) taler REST og den rå SignalR JSON-protokol over WebSocket gennem EdgeService. Edge'en tæller rate-limit pr. JWT-`sub` i stedet for pr. IP. To nye admin-endpoints (UserService, StatisticService) sletter bot-data. Kontrakten kommer først i Platform.

**Tech Stack:** k6 (JavaScript, ES modules), Node 24 `node --test` til rene helpers, .NET 10 / xUnit 2.9.3 / NSubstitute / WebApplicationFactory.

**Spec:** `gitops/docs/superpowers/specs/2026-11-27-scrum-197-loadtest-design.md`

## Global Constraints

- Branch `scrum-197-loadtest` i hvert repo, commits med prefix `SCRUM-197:`, PR til human review. Intet push til `main`, ingen auto-merge, og Jira sættes ikke til Done.
- Platform-PR'en (Task 1) åbnes før service-PR'erne. Service-PR'erne nævner den i beskrivelsen ("afventer Platform#N").
- Bot-brugernavn: `loadbot_<N>` (regex `^[A-Za-z0-9_]{3,20}$`). Admin-sletning accepterer **kun** præfikset `loadbot_`. Alt andet giver 400.
- Rate-limit uændret: 100 requests / 10 s pr. partition.
- Ingen hemmeligheder i git: `BOT_PASSWORD`, `ADMIN_USER`, `ADMIN_PASSWORD` kommer kun fra env.
- Admin-check: `RoleClaimType = "role"` + policy `AdminOnly` = `RequireRole("Admin")` (samme mønster som `MusicService/src/MusicService.Api/Auth/JwtAuthenticationExtensions.cs:35-42`).

## Review Focus

1. Forfalsket/ugyldig JWT til edge'en → falder tilbage til IP-partition og crasher ikke (test i Task 2).
2. Player-token (ikke admin) på DELETE → 403. Uden token → 401 (tests i Task 3 og 4).
3. `prefix=` tom, `prefix=a` eller `prefix=loadbot` (uden `_`) → 400, intet slettes (tests i Task 3 og 4).
4. SignalR-frame med flere beskeder adskilt af `\x1e` i én WebSocket-besked, og ping (type 6) → parses korrekt (test i Task 5).
5. "Spil igen" svarer 409 de første gange → botten prøver igen med backoff og tæller det ikke som fejl (dækket af `playAgainDelays`-test i Task 5).

---

### Task 1: Platform – kontrakt og ADR

**Files:**
- Modify: `Platform/docs/contracts/UserService/UserService.openapi.v2.json` (ny path `DELETE /api/admin/users`)
- Create: `Platform/docs/contracts/StatisticService/StatisticService.admin.openapi.json` (OpenAPI 3.1, kun `DELETE /api/admin/stats`)
- Create: `Platform/docs/decisions/0005-loadtest-k6-per-user-rate-limit.md` (status *proposed*)

**Interfaces:**
- Produces: `DELETE /api/admin/users?prefix=loadbot_` og `DELETE /api/admin/stats?prefix=loadbot_`. Begge kræver Admin. Svar `200 {"deleted": <int>}`, `400` ProblemDetails, `401`, `403`.

- [ ] **Step 1:** `git switch -c scrum-197-loadtest` i Platform.
- [ ] **Step 2:** Tilføj path, parameter `prefix` (query, required, `pattern: "^loadbot_$"`), svar-schema `DeleteResult { deleted: integer }` og et eksempel i begge OpenAPI-filer.
- [ ] **Step 3:** ADR 0005: kontekst (eksamensdemo af HPA), beslutning (k6 fra terminal; edge-partition pr. `sub` læst uden signaturtjek, IP-fallback; admin-oprydning via to endpoints), alternativer (.NET-bot, LoadTestService + admin-side, SQL-oprydning) og konsekvenser.
- [ ] **Step 4:** Validér JSON: `node -e "JSON.parse(require('fs').readFileSync(process.argv[1]))" <fil>` for begge filer → ingen fejl.
- [ ] **Step 5:** Commit `SCRUM-197: contract for admin cleanup endpoints + ADR 0005`, push branch, `gh pr create`.

### Task 2: EdgeService – rate-limit pr. bruger

**Files:**
- Modify: `EdgeService/src/EdgeService.Api/Program.cs:27-40` (policy-nøgle)
- Create: `EdgeService/src/EdgeService.Api/RateLimitKey.cs`
- Test: `EdgeService/tests/EdgeService.Api.Tests/ProxyTests.cs` (nye facts)

**Interfaces:**
- Produces: `public static class RateLimitKey { public static string For(HttpContext ctx); }`. Returnerer `"user:<sub>"`, når `Authorization: Bearer <jwt>` eller query `access_token` indeholder en JWT, der kan læses og har `sub`. Ellers `"ip:<RemoteIpAddress ?? unknown>"`. Policy-navnet `per-ip` beholdes, så appsettings ikke ændres.

- [ ] **Step 1: Skriv de fejlende tests** i `ProxyTests` (brug `Edge(permitLimit: 2)` og en lokal helper `Jwt(string sub)`, der laver en usigneret/vilkårligt signeret JWT med `JwtSecurityTokenHandler`):
  - `TwoUsers_FromSameIp_HaveSeparateLimits`: 2 kald med `Jwt("1")` + 1 kald med `Jwt("2")` → det tredje kald (bruger 2) er 200.
  - `SameUser_IsLimited`: 3 kald med `Jwt("1")` → tredje kald er 429.
  - `AccessTokenQuery_CountsAsUser`: 2× `/api/gameservice/hubs/game/negotiate?access_token=<Jwt("1")>`, derefter et kald med `Jwt("2")` → 200.
  - `GarbageToken_FallsBackToIp`: `Bearer not.a.jwt` 3 gange → 429 og ingen 500.
- [ ] **Step 2:** `dotnet test -c Release --filter "FullyQualifiedName~ProxyTests"` → de 3 nye bruger-tests fejler.
- [ ] **Step 3:** Implementér `RateLimitKey.For` med `JwtSecurityTokenHandler.CanReadToken` + `ReadJwtToken` (ingen validering, try/catch → IP). Tilføj pakke `System.IdentityModel.Tokens.Jwt` (samme version som UserService' csproj). Indsæt kommentar: nøglen fordeler kun kvoter, servicen validerer selve tokenen. Brug `RateLimitKey.For(context)` som partition-nøgle i `Program.cs`.
- [ ] **Step 4:** `dotnet test -c Release` → alle tests grønne (inkl. eksisterende `TooManyRequests_Returns429`).
- [ ] **Step 5:** Opdatér README's afsnit om rate-limit med én linje. Commit `SCRUM-197: rate limit per user (JWT sub) with IP fallback`, push, PR.

### Task 3: UserService – admin-sletning af bot-brugere

**Files:**
- Modify: `UserService/src/UserService.Api/Program.cs:37-60` (`RoleClaimType = "role"`, policy `AdminOnly`)
- Create: `UserService/src/UserService.Api/Controllers/AdminUsersController.cs`
- Modify: `UserService/src/UserService.Repository/Interfaces/IUserRepository.cs` + `Repositories/UserRepository.cs`
- Modify: `UserService/src/UserService.Service/Interfaces/IUserService.cs` + `Services/UserService.cs`
- Test: `UserService/tests/UserService.Api.Tests/AdminUsersEndpointTests.cs` (ny fil, rør ikke `Integration/AuthControllerTests.cs`, se SCRUM-144), `UserService/tests/UserService.Service.Tests/UserServiceDeleteTests.cs`

**Interfaces:**
- Produces: `Task<int> IUserRepository.DeleteByUserNamePrefixAsync(string prefix, CancellationToken ct = default)`, `Task<int> IUserService.DeleteLoadBotsAsync(string prefix, CancellationToken ct = default)` (kaster `UserValidationException`, hvis `prefix != "loadbot_"`). Route `DELETE api/admin/users?prefix=` → `200 { deleted }`.

- [ ] **Step 1: Fejlende tests** (`AdminUsersEndpointTests`, `IClassFixture<UserServiceApiFactory>`, token signeret med `UserServiceApiFactory.TestJwtSigningKey`, issuer `slopster-userservice`, audience `slopster`, claim `role`):
  - `Delete_AsAdmin_RemovesOnlyLoadBots`: opret `loadbot_1`, `loadbot_2`, `alice` via `POST /api/users` → DELETE med admin-token → `200`, `deleted == 2`, `GET /api/users/{aliceId}` er 200 og `loadbot_1` er 404.
  - `Delete_AsPlayer_Returns403`, `Delete_WithoutToken_Returns401`.
  - `Delete_WithOtherPrefix_Returns400` (`prefix=a`, `prefix=loadbot`, `prefix=`).
- [ ] **Step 2:** `dotnet test -c Release --filter "FullyQualifiedName~AdminUsers"` → FAIL (404).
- [ ] **Step 3:** Implementér. Repository: indlæs matchende brugere (`UserName.ToLower().StartsWith(prefix)`) og `RemoveRange` + `SaveChangesAsync` (ikke `ExecuteDeleteAsync`, da EF InMemory i testene ikke understøtter det; RefreshTokens cascader allerede). Controller med `[Authorize(Policy = "AdminOnly")]`.
- [ ] **Step 4:** `dotnet test -c Release` → alt grønt.
- [ ] **Step 5:** Commit `SCRUM-197: admin endpoint to delete loadbot_ users`, push, PR (nævn Platform-PR).

### Task 4: StatisticService – admin-sletning af bot-stats

**Files:**
- Modify: `StatisticService/src/StatisticService.Api/Program.cs:31-51` (`RoleClaimType = "role"`, policy `AdminOnly`)
- Create: `StatisticService/src/StatisticService.Api/Controllers/AdminStatsController.cs`
- Create: `StatisticService/src/StatisticService.Repository/Interfaces/IAdminStatsRepository.cs` + `Repositories/AdminStatsRepository.cs` (registreres i `RepositoryLayerExtensions`)
- Create: `StatisticService/src/StatisticService.Service/Interfaces/IAdminStatsService.cs` + `Services/AdminStatsService.cs` (registreres i `ServiceLayerExtensions`)
- Test: `StatisticService/tests/StatisticService.Api.Tests/AdminStatsEndpointTests.cs` (mønster fra `MyStatsEndpointTests`: NSubstitute-service), `StatisticService/tests/StatisticService.Service.Tests/Postgres/AdminStatsRepositoryTests.cs` (mønster fra `PostgresQueryTests`)

**Interfaces:**
- Produces: `Task<int> IAdminStatsRepository.DeleteUserStatsByUserNamePrefixAsync(string prefix, CancellationToken ct)`, `Task<int> IAdminStatsService.DeleteLoadBotStatsAsync(string prefix, CancellationToken ct)` (kaster `ArgumentException` ved andet præfiks end `loadbot_`). Route `DELETE api/admin/stats?prefix=` → `200 { deleted }`.

- [ ] **Step 1: Fejlende tests:**
  - API: `Delete_AsAdmin_Returns200_WithCount` (service returnerer 7 → `deleted == 7`), `Delete_AsPlayer_Returns403`, `Delete_WithoutToken_Returns401`, `Delete_WithOtherPrefix_Returns400` (service kaster `ArgumentException`).
  - Repository (Postgres/Testcontainers som `PostgresQueryTests`): to `UserStats` for `loadbot_1`/`loadbot_2` og én for `alice` i samme spil → `deleted == 2`, alice' række findes stadig, `GameStats` er urørt.
- [ ] **Step 2:** Kør testene → FAIL.
- [ ] **Step 3:** Implementér. Repository med `ExecuteDeleteAsync` på `UserStats.Where(s => s.UserName.StartsWith(prefix))` (Postgres i testen, så det er fint her).
- [ ] **Step 4:** `dotnet test -c Release` → alt grønt (kræver Docker til Testcontainers).
- [ ] **Step 5:** Commit `SCRUM-197: admin endpoint to delete loadbot_ stats`, push, PR (nævn Platform-PR).

### Task 5: gitops – k6-bots, oprydning og vejledning

**Files:**
- Create: `gitops/loadtest/lib/signalr.js` (rene funktioner, ingen k6-imports)
- Create: `gitops/loadtest/lib/bot-logic.js` (rene funktioner: slot-valg, svartid, backoff)
- Create: `gitops/loadtest/lib/signalr.test.js`, `gitops/loadtest/lib/bot-logic.test.js` (`node --test`)
- Create: `gitops/loadtest/bots.js`, `gitops/loadtest/cleanup.js`, `gitops/loadtest/README.md`
- Commit også: `gitops/docs/superpowers/specs/...design.md` og denne plan

**Interfaces:**
- Produces (signalr.js): `RS = '\x1e'`, `handshake(): string`, `invocation(target: string, args: any[], invocationId?: string): string`, `parseFrames(data: string): object[]` (splitter på `RS` og dropper tomme), `MessageType = { Invocation: 1, StreamItem: 2, Completion: 3, Ping: 6, Close: 7 }`.
- Produces (bot-logic.js): `pickSlot(timelineLength: number, rnd = Math.random): number` (0..timelineLength), `answerDelayMs(answerTimeSeconds: number, rnd): number` (mellem 1000 og (answerTime-2)·1000), `playAgainDelays(): number[]` (backoff med jitter, fx 500, 1000, 2000, 2000 … i alt ≤ 20 forsøg), `botName(vu: number, index: number, perLobby: number): string` → `loadbot_<(vu-1)*perLobby+index+1>`.

- [ ] **Step 1: Fejlende node-tests:**
  - `parseFrames('{"type":6}\x1e{"type":1,"target":"RoundStarted","arguments":[{}]}\x1e')` → 2 objekter, type 6 og 1.
  - `invocation('SubmitAnswer',['g',3,2],'7')` ender på `\x1e` og parser til `{type:1,invocationId:'7',target:'SubmitAnswer',arguments:['g',3,2]}`.
  - `handshake() === '{"protocol":"json","version":1}\x1e'`.
  - `pickSlot(1, () => 0.999) === 1`, `pickSlot(3, () => 0) === 0`. `answerDelayMs(15, () => 0) === 1000`.
  - `botName(2, 0, 4) === 'loadbot_5'` og matcher `/^[A-Za-z0-9_]{3,20}$/`.
- [ ] **Step 2:** `node --test gitops/loadtest/lib/` → FAIL (modul mangler).
- [ ] **Step 3:** Implementér `signalr.js` og `bot-logic.js` → `node --test gitops/loadtest/lib/` PASS.
- [ ] **Step 4: `bots.js`.** `options.scenarios.lobbies = { executor: 'ramping-vus', stages: [{duration: RAMP_UP, target: ceil(BOTS/BOTS_PER_LOBBY)}, {duration: DURATION, target: same}, {duration: '30s', target: 0}] }`, `thresholds: { bot_errors: ['count==0'], checks: ['rate>0.99'] }`. Én iteration = én lobby:
  1. Pr. bot: `POST {BASE}/api/userservice/users` (201/409 ok) → `POST /api/userservice/auth/login` → gem `accessToken`, `refreshToken`, `accessTokenExpiresAt`.
  2. Én gang pr. VU: `GET /api/musicservice/playlists` → vælg et playlist med `songCount >= 6`. Host: `POST /api/lobbyservice/lobbies {categoryId, answerTimeSeconds:15, rounds:5, maxPlayers:BOTS_PER_LOBBY, isPrivate:true}` → `code`. Andre: `POST lobbies/join-by-code {code}`. Alle: `POST lobbies/{id}/ready {ready:true}`. Host: `POST lobbies/{id}/start` → `gameId`.
  3. Åbn én `k6/experimental/websockets` WebSocket pr. bot mod `{WS_BASE}/api/gameservice/hubs/game?access_token=…`. Ved open: `handshake()`, derefter `invocation('JoinGame',[gameId],'1')`. Ved `Prefetch` (target): send `Ready(gameId, round)` for hver nyeste runde. Ved `RoundStarted`: efter `StartsInMs + answerDelayMs` send `SubmitAnswer(gameId, round, pickSlot(myTimeline.length))` og mål `answer_rtt` til completion (type 3). Ved `RoundEnded`: opdatér `myTimeline` fra `results[].timeline` for egen `userId`. Ved `GameEnded`: `games_completed.add(1)` (host-bot), luk sockets. Send ping hvert 15. sekund. Uventet close/fejl → `bot_errors.add(1)`.
  4. "Spil igen": hver bot `POST lobbies/{id}/play-again` efter `playAgainDelays()` indtil 200. Derefter ready, og den, der nu er host (`hostUserId` i svaret), starter. Gentag spil, indtil VU'ens iteration-tid er brugt.
  5. Før hvert REST-kald: forny token, hvis `accessTokenExpiresAt - now < 60 s` (`POST /api/userservice/auth/refresh`). Ved 429: vent 1–3 s og prøv igen (tælles ikke som fejl, men i `rate_limited` Counter).
  - Env: `BASE_URL` (default `https://quiz.munkcloud.dk`), `BOTS` (50), `BOTS_PER_LOBBY` (4), `DURATION` (`5m`), `RAMP_UP` (`1m`), `BOT_PASSWORD` (påkrævet, ≥ 8 tegn). `WS_BASE` = `BASE_URL` med `http`→`ws`.
- [ ] **Step 5: `cleanup.js`.** Én iteration: login med `ADMIN_USER`/`ADMIN_PASSWORD`, `DELETE /api/statisticservice/admin/stats?prefix=loadbot_` og `DELETE /api/userservice/admin/users?prefix=loadbot_`. Check 200 og log `deleted` for begge.
- [ ] **Step 6: `README.md`:** installation (`winget install k6`), kørsel lokalt, kørsel i clusteret (`kubectl run k6 --rm -i --restart=Never -n quiz --image=grafana/k6 -- run - < bots.js` med `-e BASE_URL=http://edgeservice:8080`), hvad man ser i Grafana "Slopster Autoscaling", leaderboard-tjek og oprydning. Bemærk: kræver at Task 2 er deployet, før man kører 50 bots.
- [ ] **Step 7: Lokal syntaks-check:** `k6 inspect loadtest/bots.js` og `k6 inspect loadtest/cleanup.js` → ingen fejl. `kubectl kustomize .` (PowerShell) → renderer som før (loadtest/ er ikke med).
- [ ] **Step 8: Smoke-test (kun med brugerens OK, rammer produktion):** `k6 run -e BOTS=2 -e BOTS_PER_LOBBY=2 -e DURATION=2m -e RAMP_UP=5s -e BOT_PASSWORD=… loadtest/bots.js` → mindst ét `games_completed`, `bot_errors == 0`.
- [ ] **Step 9:** Commit `SCRUM-197: k6 load bots, cleanup script and runbook`, push, PR.

### Task 6: Afslutning

- [ ] **Step 1:** Kommentér på SCRUM-197 med links til de 5 PR'er og rækkefølgen for merge: Platform → Edge/User/Statistic → gitops.
- [ ] **Step 2:** Efter merge og deploy (af mennesker): 50-bot-kørsel + `GET /api/statisticservice/statistics/weekly` viser `loadbot_`-spillere → done-kriteriet. Derefter `cleanup.js`.
