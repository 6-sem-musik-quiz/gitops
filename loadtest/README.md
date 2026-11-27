# Stresstest med k6 (SCRUM-197, 198 og 199)

> **Skal du bare vise testen (fx til eksamen)?** Følg [EKSAMEN.md](EKSAMEN.md). Kort version, fra `gitops/`:
>
> ```powershell
> powershell -ExecutionPolicy Bypass -File .\loadtest\stress.ps1 -Check   # prøve (2-3 min)
> powershell -ExecutionPolicy Bypass -File .\loadtest\stress.ps1          # demoen
> ```
>
> Første gang spørger scriptet efter bot-passwordet fra **OpenBao `kv/quiz/loadtest` → `bot-password`**.
> Resten af denne side er detaljerne bag.

To k6-scripts til eksamensdemoen af autoscaling (SCRUM-196):

- `bots.js` (SCRUM-197): bots, der spiller rigtige Slopster-spil, så belastningen rammer hele kæden
  User → Lobby → Game → RabbitMQ → Statistics. Beslutningen er beskrevet i Platform ADR-0005.
- `http.js` (SCRUM-198): et fast antal HTTP-requests i sekundet mod de læsetunge endpoints, så HPA'en
  skalerer hurtigt op, og så svartiden kan måles. Se [HTTP-load](#http-load-scrum-198).

`stress.ps1` (SCRUM-199) starter begge med én kommando.

Flux rører ikke denne mappe: den er ikke med i nogen `kustomization.yaml`.

| Fil | Hvad |
|---|---|
| `bots.js` | Botterne. Én k6-VU styrer én privat lobby med 2–8 bots (`loadbot_N`) og spiller spil efter spil med "Spil igen". |
| `stress.ps1` | Én kommando til eksamensdemoen: `-Check` (prøve), standard (demo i tre vinduer), `-Cleanup`. Se [EKSAMEN.md](EKSAMEN.md). |
| `EKSAMEN.md` | Trin for trin til eksamen for alle i gruppen. |
| `http.js` | HTTP-load: `RATE` requests/s fordelt på leaderboard, egne stats, egen profil og playlister. |
| `cleanup.js` | Sletter alle `loadbot_`-brugere (også `loadbot_h*` fra `http.js`) og deres stats via admin-endpoints. |
| `lib/http-logic.js` | Endpoints og vægte, brugernavne, tjek af parametrene og opsummeringen til `http.js`. |
| `results/` | Her gemmer `http.js` sit resultat (`http-<tid>Z.txt` og `.json`). |
| `lib/signalr.js` | SignalR JSON-protokollen i hånden (handshake, `\x1e`, invocations, ping). |
| `lib/bot-logic.js` | Hvor botten lægger sangen, hvornår den svarer, backoff til "Spil igen", brugernavne. |

## Forudsætninger

- k6: `winget install GrafanaLabs.k6` (eller https://grafana.com/docs/k6/latest/set-up/install-k6/)
- Edge'en tæller rate-limit pr. bruger (EdgeService, SCRUM-197). Uden den deler alle bots fra én maskine
  én kvote på 100 requests / 10 s.
- Admin-endpoints i UserService og StatisticService (SCRUM-197) for at kunne rydde op.

## Bot-passwordet

Alle testbrugere (`loadbot_N` fra botterne og `loadbot_h*` fra HTTP-loaden) har **samme password**, og
gruppen deler det i **OpenBao: `kv/quiz/loadtest` → `bot-password`**. Det kommer aldrig i git.

- `stress.ps1` spørger efter det første gang og gemmer det i `%USERPROFILE%\.slopster-loadtest`.
- Kører du k6 direkte, så sæt det som miljøvariabel i terminalen (k6 læser den selv), så det ikke står i
  kommandohistorikken:

  ```powershell
  $env:BOT_PASSWORD = Get-Content "$HOME\.slopster-loadtest"   # eller indsæt det fra OpenBao
  ```

- Ændres passwordet i OpenBao, har de eksisterende testbrugere stadig det gamle. Kør så oprydningen
  (`stress.ps1 -Cleanup`) én gang, så oprettes de på ny med det nye.

## Kør botterne direkte (bots.js)

Fra `gitops/`, med `$env:BOT_PASSWORD` sat (se ovenfor):

```powershell
k6 run loadtest/bots.js
```

| Variabel | Standard | Betydning |
|---|---|---|
| `BASE_URL` | `https://quiz.munkcloud.dk` | Hvor botterne går ind (edge'en) |
| `BOTS` | `50` | Antal bots i alt |
| `BOTS_PER_LOBBY` | `4` | Bots pr. lobby (2–8) |
| `RAMP_UP` | `1m` | Tid til at starte alle lobbyer |
| `DURATION` | `5m` | Hvor længe alle lobbyer spiller |
| `BOT_PASSWORD` | – | Påkrævet. Det fælles password fra OpenBao (se [Bot-passwordet](#bot-passwordet)) |

Lille prøvekørsel først:

```powershell
k6 run -e BOTS=2 -e BOTS_PER_LOBBY=2 -e RAMP_UP=5s -e DURATION=1m loadtest/bots.js
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

## HTTP-load (SCRUM-198)

Botterne giver ikke nok CPU-belastning til, at HPA'en reagerer hurtigt. `http.js` sender et **fast antal
requests i sekundet** (k6's `ramping-arrival-rate`), uanset hvor hurtigt servicen svarer. Så kan resultatet
siges i tal: "ved 60 requests/s holdt p95 sig under 500 ms, mens statisticservice gik fra 2 til 5 pods".

Fra `gitops/`, med `$env:BOT_PASSWORD` sat (se [Bot-passwordet](#bot-passwordet)):

```powershell
k6 run loadtest/http.js
```

Lille prøvekørsel først:

```powershell
k6 run -e USERS=2 -e RATE=5 -e RAMP_UP=10s -e DURATION=20s loadtest/http.js
```

| Variabel | Standard | Betydning |
|---|---|---|
| `BASE_URL` | `https://quiz.munkcloud.dk` | Hvor requests går ind (edge'en) |
| `USERS` | `20` | Testbrugere `loadbot_h1..N`. Hver logger ind én gang, og tokenet genbruges |
| `RATE` | `60` | Requests i sekundet på plateauet |
| `RAMP_UP` | `1m` | Tid fra 0 til `RATE` |
| `DURATION` | `5m` | Plateauet. Derefter 30 s ned til 0 |
| `BOT_PASSWORD` | – | Påkrævet. Det fælles password fra OpenBao |

| Endpoint | Andel | Service |
|---|---|---|
| `GET /api/statisticservice/statistics/weekly` (leaderboard) | 40 % | statisticservice (Redis-cache, SCRUM-195) |
| `GET /api/statisticservice/statistics/me` | 25 % | statisticservice |
| `GET /api/userservice/users/me` | 20 % | userservice |
| `GET /api/musicservice/playlists` | 15 % | musicservice |

**Grænserne i edge'en**, og hvorfor scriptet ser ud, som det gør:

- Uden token tæller edge'en pr. IP (100 / 10 s). Derfor er login ikke en del af belastningen: hver bruger
  logger ind én gang i `setup()`, og ved 429 venter scriptet 10 s og prøver igen.
- Med token tæller den pr. bruger (100 / 10 s). Scriptet afviser derfor `RATE` over 9 × `USERS`.
- Alt fra én maskine har et loft på 1000 / 10 s, altså ca. 100 requests/s **inklusive botterne**, hvis de
  kører samtidig. Kør fx `bots.js` med 50 bots og `http.js` med `RATE=60` hver i sin terminal.
- Tokens lever 15 min og fornyes ikke, så en kørsel må højst vare 14 min i alt.

**Leaderboardet læser kun fra Redis**, når StatisticService har sin Redis connection string
(`apps/statisticservice.yaml`, SCRUM-195). Ellers måles Postgres.

### Hvad du skal se

**I terminalen og i `results/http-<tid>Z.txt`** (tiden er UTC):

```
1200 requests (59.8/s), failed 0.20 %, 429 from the edge: 0

  weekly     avg   41 ms   p95  120 ms   OK
  my_stats   ...
Thresholds: all held
```

Thresholds: fejlrate < 1 %, p95 < 500 ms pr. endpoint og ingen 429. k6 afslutter med exit-kode 99, hvis en
threshold fejler. `results/http-<tid>Z.json` er k6's fulde opsummering. Gem den kørsel, I vil vise ved
eksamen (plan B, hvis live-demoen driller).

**I Grafana**, dashboardet "Slopster Autoscaling": CPU stiger, og statisticservice skalerer fra 2 mod 5
pods, efterfulgt af userservice og musicservice. Efter testen skalerer de ned efter ca. 2 minutter.

## Ryd op bagefter

Kræver en Slopster-konto med rollen **Admin** (den man logger ind med på siden). Scriptet spørger efter
brugernavn og password, så de ikke står i kommandohistorikken:

```powershell
powershell -ExecutionPolicy Bypass -File .\loadtest\stress.ps1 -Cleanup
```

Sletter først bot-stats, derefter bot-brugere. Endpoints accepterer kun præfikset `loadbot_`. Bot-spillene
forsvinder også fra ugens leaderboard. Ikke nødvendigt mellem kørsler, kun hvis bot-passwordet er ændret.

## Test af hjælpefunktionerne

```powershell
cd loadtest; node --test "lib/*.test.js"
```
