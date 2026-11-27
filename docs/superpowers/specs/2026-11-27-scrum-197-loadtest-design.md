# SCRUM-197 – Stresstest med k6-bots (design)

Status: godkendt 2026-11-27. Parent: SCRUM-196 (stresstest-script til demo af autoscaling).

## Formål og hvorfor

Til eksamen skal vi vise, at Slopster kan holde til belastning. Én terminal kører k6 med 50+ bots,
der spiller rigtige spil. Ved siden af viser Grafana-dashboardet "Slopster Autoscaling", at pods
skalerer op. Bagefter dukker bot-spillene op på leaderboardet, og det beviser, at hele kæden
User → Lobby → Game → RabbitMQ → Statistics virker under load.

**Done når:** 50+ bots spiller samtidig mod clusteret uden fejl i k6-outputtet (checks ≈ 100 %),
og færdige spil dukker op i `GET /api/statisticservice/statistics/weekly`.

**Ikke-mål:** admin-side eller knap i Slopster, en ny service, egne k6-tal i Grafana (kun hvis det er nemt).
**Anti-mål:** at belastningen ikke ligner rigtige spillere (fx kun `/health`-kald), eller at
bot-brugere og bot-statistik bliver liggende uden en måde at fjerne dem på.

## Valgt tilgang og de fravalgte

| Tilgang | Hvorfor fravalgt / valgt |
|---|---|
| .NET-konsolapp med SignalR.Client (ticketens forslag) | Ramp-up, p95, checks og thresholds skal bygges selv. k6 giver det gratis og er industristandard. |
| LoadTestService i clusteret + admin-side | Krævede en ny service (et browservindue kan ikke starte k6, og k6 i en eksisterende service ville forvride dens HPA). Fravalgt, da terminal + Grafana er nok. |
| **k6-script fra terminalen (valgt)** | Mindst at bygge, ingen ny service eller ny pipeline. Kræver at SignalR-JSON-protokollen skrives i hånden (handshake, `\x1e`-afgrænsning, invocations, ping). |

## Delene

1. **`gitops/loadtest/bots.js`** (k6, JavaScript)
   - Én k6-VU styrer én lobby med `BOTS_PER_LOBBY` bots (2–8), fordi k6-VU'er ikke deler state.
     Antal VU'er = `ceil(BOTS / BOTS_PER_LOBBY)`. Ramp-up via `stages`.
   - Pr. bot: `POST /api/userservice/users` (409 = findes allerede) → `POST /api/userservice/auth/login`.
     Brugernavn `loadbot_N` (regex `^[A-Za-z0-9_]{3,20}$` tillader ikke bindestreg), fast password fra env.
   - Host opretter privat lobby (`POST /api/lobbyservice/lobbies`, kategori fra `GET /api/musicservice/playlists`
     med nok sange). De andre joiner via `join-by-code`. Alle sender `ready`, og host sender `start`.
   - Spil via WebSocket til `/api/gameservice/hubs/game?access_token=…` (SignalR JSON-protokol):
     `JoinGame`, `Ready(round)` ved `Prefetch`, `SubmitAnswer(round, slot)` efter en tilfældig svartid
     ved `RoundStarted` (slot tilfældig i `0..timeline.Count`), indtil `GameEnded`.
   - "Spil igen" (SCRUM-172): `POST lobbies/{id}/play-again` med backoff og jitter ved 409. Derefter ready og start igen.
   - Token fornyes via `auth/refresh` før udløb (15 min). Ved 429 venter botten og prøver igen.
   - Metrikker: custom `games_completed` (Counter), `bot_errors` (Counter), `answer_rtt` (Trend)
     plus k6's egne `http_req_duration` og checks. Thresholds: `bot_errors count==0`.
   - Parametre (env): `BASE_URL` (default `https://quiz.munkcloud.dk`), `BOTS`, `BOTS_PER_LOBBY`,
     `DURATION`, `RAMP_UP`, `BOT_PASSWORD`.
2. **EdgeService: rate-limit pr. bruger.** Partitionsnøglen er JWT-`sub`, når en gyldig bearer-token
   eller `access_token` er med, ellers IP som i dag. Edge'en validerer ikke tokens i dag. Nøglen
   læses uden signaturtjek, og det er acceptabelt, fordi den kun bruges til at fordele kvoter (en
   forfalsket `sub` giver ikke adgang til noget, servicen afviser den). Grænsen er uændret (100/10 s).
   *Bygherrens valg:* den præcise udtrækning og tests i `EdgeService.Api.Tests`.
3. **Oprydning** (først kontrakt i Platform, derefter services)
   - UserService: `DELETE /api/admin/users?prefix=loadbot_` → `[Authorize(Roles="Admin")]`. Sletter kun
     brugere, hvis navn starter med `loadbot_` (prefix er hårdkodet og valideret, så endpointet ikke kan
     slette rigtige brugere). Returnerer antal slettede.
   - StatisticService: `DELETE /api/admin/stats?prefix=loadbot_` → samme regel, sletter `UserStats` for
     de brugernavne. `GameStats` røres ikke.
   - `gitops/loadtest/cleanup.js`: logger ind med `ADMIN_USER`/`ADMIN_PASSWORD` (env, aldrig i git)
     og kalder begge.
4. **`gitops/loadtest/README.md`:** sådan køres det lokalt og inde i clusteret
   (`kubectl run k6 --rm -i --image=grafana/k6 … ` mod `http://edgeservice:8080`), hvad man ser i
   Grafana, og oprydning.

## Begrænsninger

- Alt sker på branches med PR til human review. Intet push til `main` (gitops-`main` = deploy).
- Kontraktændringer (admin-endpoints) kommer i en Platform-PR før service-PR'erne.
- Blackboard-claims oprettes af den lokale worker, ikke af denne session.
- Ingen hemmeligheder i git. `loadtest/` er ikke med i nogen `kustomization.yaml`, så Flux ignorerer mappen.

## Overladt til bygherren

Filstruktur i `bots.js`, timeouts og backoff-tal, testfixtures, og hvordan SignalR-protokollen
pakkes i en lille helper.
