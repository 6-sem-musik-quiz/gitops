# Stresstest med k6 (SCRUM-197)

k6-bots, der spiller rigtige Slopster-spil, så belastningen rammer hele kæden
User → Lobby → Game → RabbitMQ → Statistics. Bruges til eksamensdemoen af autoscaling (SCRUM-196).
Beslutningen er beskrevet i Platform ADR-0005.

Flux rører ikke denne mappe: den er ikke med i nogen `kustomization.yaml`.

| Fil | Hvad |
|---|---|
| `bots.js` | Botterne. Én k6-VU styrer én privat lobby med 2–8 bots (`loadbot_N`) og spiller spil efter spil med "Spil igen". |
| `cleanup.js` | Sletter alle `loadbot_`-brugere og deres stats via admin-endpoints. |
| `lib/signalr.js` | SignalR JSON-protokollen i hånden (handshake, `\x1e`, invocations, ping). |
| `lib/bot-logic.js` | Hvor botten lægger sangen, hvornår den svarer, backoff til "Spil igen", brugernavne. |

## Forudsætninger

- k6: `winget install GrafanaLabs.k6` (eller https://grafana.com/docs/k6/latest/set-up/install-k6/)
- Edge'en tæller rate-limit pr. bruger (EdgeService, SCRUM-197). Uden den deler alle bots fra én maskine
  én kvote på 100 requests / 10 s.
- Admin-endpoints i UserService og StatisticService (SCRUM-197) for at kunne rydde op.

## Kør stresstesten

Fra `gitops/`, med et password du selv vælger til botterne (mindst 8 tegn, kommer aldrig i git):

```powershell
k6 run -e BOT_PASSWORD=<vælg-et> loadtest/bots.js
```

| Variabel | Standard | Betydning |
|---|---|---|
| `BASE_URL` | `https://quiz.munkcloud.dk` | Hvor botterne går ind (edge'en) |
| `BOTS` | `50` | Antal bots i alt |
| `BOTS_PER_LOBBY` | `4` | Bots pr. lobby (2–8) |
| `RAMP_UP` | `1m` | Tid til at starte alle lobbyer |
| `DURATION` | `5m` | Hvor længe alle lobbyer spiller |
| `BOT_PASSWORD` | – | Påkrævet. Samme password hver gang, ellers kan eksisterende bots ikke logge ind |

Lille prøvekørsel først:

```powershell
k6 run -e BOTS=2 -e BOTS_PER_LOBBY=2 -e RAMP_UP=5s -e DURATION=1m -e BOT_PASSWORD=<...> loadtest/bots.js
```

### Inde i clusteret (ikke sat op)

Testen køres fra en terminal mod den offentlige adresse, så trafikken går gennem Cloudflare og edge'en
ligesom rigtige spillere. Skal den en dag køre inde i clusteret (mod `http://edgeservice:8080`), skal
det være et Kubernetes Job lagt ind via en PR i dette repo. Ændringer i clusteret sker kun gennem gitops
(AGENTS.md), ikke med `kubectl run`. `k6 archive loadtest/bots.js` pakker scriptet og `lib/` i én
`archive.tar`, som et sådant Job kan køre med `k6 run archive.tar`.

## Hvad du skal se

**I terminalen** (k6's opsummering til sidst):

- `bot_errors` ........ **0** (done-kriteriet: ingen fejl i bot-loggen; thresholden fejler ellers)
- `games_completed` ... antal færdige spil
- `answer_rtt` ........ svartid fra `SubmitAnswer` til serverens svar (avg, p95)
- `http_req_duration` . REST-kald gennem edge'en
- `rate_limited` ...... antal 429, som botten ventede ud (ikke en fejl)
- `checks` ............ ≥ 99 %

Fejl skrives med `[VU n]` og årsag, fx `start game: HTTP 409 ...`.

**I Grafana**, dashboardet "Slopster Autoscaling": CPU stiger, og HPA'en skalerer
gameservice/lobbyservice/edgeservice fra 2 op mod 5 pods. Når testen stopper, skalerer de ned efter
ca. 2 minutter (scale-down-vinduet).

**På leaderboardet:** `loadbot_`-spillere i ugens top (Slopster → Leaderboard, eller
`GET /api/statisticservice/statistics/weekly`). Det viser, at `game.finished` er nået gennem RabbitMQ til
StatisticService under load.

## Ryd op bagefter

Med en admin-bruger:

```powershell
k6 run -e ADMIN_USER=<admin> -e ADMIN_PASSWORD=<...> loadtest/cleanup.js
```

Sletter først bot-stats, derefter bot-brugere. Endpoints accepterer kun præfikset `loadbot_`.

## Test af hjælpefunktionerne

```powershell
cd loadtest; node --test "lib/*.test.js"
```
