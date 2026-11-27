# Load-test af Slopster

Vi presser Slopster med k6 og ser Kubernetes skalere op (flere pods) og ned igen.
**Til eksamen:** følg [EKSAMEN.md](EKSAMEN.md) trin for trin.

## Før første gang

1. Installér k6: `winget install GrafanaLabs.k6` (åbn en ny terminal bagefter).
2. Find bot-passwordet i **OpenBao: `kv/quiz/loadtest` → `bot-password`**. Scriptet spørger efter det
   første gang og husker det (i `%USERPROFILE%\.slopster-loadtest`, ikke i git).
3. Stå i `gitops`-mappen i PowerShell. Alle kommandoer herunder køres derfra.

> ⚠️ Kun én i gruppen kører ad gangen: alle bruger de samme testbrugere.

## Kommandoer

Alle starter med `powershell -ExecutionPolicy Bypass -File .\loadtest\stress.ps1`. Herunder forkortet til `stress.ps1`.

| Jeg vil … | Kommando | Tid |
|---|---|---|
| **tjekke, at alt virker** (dagen før) | `stress.ps1 -Check` | 3 min |
| **køre hele demoen** (bots + HTTP + HPA-vindue) | `stress.ps1` | 8 min |
| køre en **kortere demo** | `stress.ps1 -Duration 3m` | 5 min |
| kun vise **svartid under pres** (HTTP-load) | `stress.ps1 -Only http` | 7 min |
| kun vise **rigtige spil** (bots, RabbitMQ → statistik) | `stress.ps1 -Only bots` | 7 min |
| køre **let** (svagt net, eller rigtige spillere er inde) | `stress.ps1 -Rate 30 -Bots 20` | 8 min |
| køre **hårdt** (hvis pods ikke skalerer op) | `stress.ps1 -Rate 80 -Bots 20` | 8 min |
| **rydde op** (sletter alle testbrugere, kræver Slopster-admin) | `stress.ps1 -Cleanup` | 10 s |

Kopiér direkte:

```powershell
powershell -ExecutionPolicy Bypass -File .\loadtest\stress.ps1 -Check
powershell -ExecutionPolicy Bypass -File .\loadtest\stress.ps1
powershell -ExecutionPolicy Bypass -File .\loadtest\stress.ps1 -Duration 3m
powershell -ExecutionPolicy Bypass -File .\loadtest\stress.ps1 -Only http
powershell -ExecutionPolicy Bypass -File .\loadtest\stress.ps1 -Only bots
powershell -ExecutionPolicy Bypass -File .\loadtest\stress.ps1 -Rate 30 -Bots 20
powershell -ExecutionPolicy Bypass -File .\loadtest\stress.ps1 -Rate 80 -Bots 20
powershell -ExecutionPolicy Bypass -File .\loadtest\stress.ps1 -Cleanup
```

**Parametre:** `-Rate` HTTP-requests i sekundet (standard 60) · `-Bots` antal bots (standard 50) ·
`-RampUp` tid til fuld last (standard `1m`) · `-Duration` tid på fuld last (standard `5m`).
Hold `-Rate` under ca. 90: alt fra én maskine deler edge'ens grænse på 1000 requests / 10 s.

## Hvad du ser

| Hvor | Godt tegn |
|---|---|
| **HPA-vinduet** (`kubectl get hpa -w`) eller **Grafana → [Quiz Overview](https://grafana-quiz.tail5a1bc5.ts.net/d/quiz-overview/quiz-overview)** (kræver Tailscale) | `REPLICAS` går fra 2 mod 5, og ned igen ca. 2 min efter testen |
| **HTTP-vinduet**, til sidst | `failed 0.00 %`, `429 from the edge: 0`, p95 under 500 ms pr. endpoint, `Thresholds: all held` |
| **Bots-vinduet**, til sidst | `bot_errors` = 0, `games_completed` > 0, `checks` ≥ 99 % |
| **`loadtest/results/`** | HTTP-resultatet gemt som `http-<tid>Z.txt` og `.json` (tiden er UTC). Gem den kørsel, I vil vise |
| **Leaderboardet** på siden | `loadbot_`-spillere i ugens top: spillene er nået via RabbitMQ til statistikken |

## Hvis noget fejler

Se tabellen i [EKSAMEN.md](EKSAMEN.md#6-hvis-noget-fejler). De to hyppigste:

- `HTTP 401` ved login → forkert bot-password. Slet `%USERPROFILE%\.slopster-loadtest` og kør igen.
- `409` og så `401` → testbrugerne findes med et andet password. Kør `stress.ps1 -Cleanup` én gang.

---

## Detaljer (til den, der vil ændre testene)

### Filerne

| Fil | Hvad |
|---|---|
| `stress.ps1` | Kommandoen ovenfor. Starter k6-scripts i egne vinduer og giver passwordet videre som miljøvariabel |
| `bots.js` | SCRUM-197: bots, der spiller rigtige spil. Én k6-VU styrer én privat lobby med 2–8 bots (`loadbot_N`) |
| `http.js` | SCRUM-198: et fast antal GET/s mod leaderboard (40 %), egne stats (25 %), egen profil (20 %) og playlister (15 %), med testbrugerne `loadbot_h1..N` |
| `cleanup.js` | Sletter alle `loadbot_`-brugere og deres stats via admin-endpoints |
| `lib/` | Ren logik med tests: SignalR-protokollen, bot-adfærd, endpoints og vægte, opsummering |
| `results/` | Gemte resultater fra `http.js` |

### Sådan virker de

- **Botterne** går gennem hele kæden: User → Lobby → Game (SignalR over WebSocket) → RabbitMQ → Statistics.
  De giver realistisk last, men ikke meget CPU. Beslutningen står i Platform ADR-0005.
- **HTTP-loaden** bruger k6's `ramping-arrival-rate`: et fast antal requests i sekundet, uanset svartiden.
  Så kan resultatet siges i tal: "ved 60 requests/s holdt p95 sig under 500 ms".
- Hver testbruger logger ind **én gang** og genbruger sit token. Uden token tæller edge'en pr. IP
  (100 / 10 s), med token pr. bruger (100 / 10 s). Derfor afviser `http.js` en `RATE` over 9 × `USERS`,
  og en kørsel må højst vare 14 min (tokens lever 15 min).
- Leaderboardet læses fra Redis (SCRUM-195).
- Flux rører ikke denne mappe: den er ikke med i nogen `kustomization.yaml`.

### Kør k6 direkte

`stress.ps1` er nemmest, men scripts kan køres direkte. Sæt passwordet som miljøvariabel først:

```powershell
$env:BOT_PASSWORD = Get-Content "$HOME\.slopster-loadtest"
k6 run -e BOTS=10 -e BOTS_PER_LOBBY=2 -e DURATION=2m loadtest/bots.js
k6 run -e USERS=20 -e RATE=60 -e RAMP_UP=1m -e DURATION=5m loadtest/http.js
```

| Variabel | Script | Standard |
|---|---|---|
| `BASE_URL` | alle | `https://quiz.munkcloud.dk` |
| `BOT_PASSWORD` | bots, http | – (påkrævet) |
| `BOTS`, `BOTS_PER_LOBBY` | bots | `50`, `4` (2–8) |
| `USERS`, `RATE` | http | `20`, `60` |
| `RAMP_UP`, `DURATION` | bots, http | `1m`, `5m` |
| `ADMIN_USER`, `ADMIN_PASSWORD` | cleanup | – (påkrævet) |

Ændres bot-passwordet i OpenBao, har de eksisterende testbrugere stadig det gamle: kør `stress.ps1 -Cleanup` én gang.

### Test af hjælpefunktionerne

```powershell
cd loadtest; node --test "lib/*.test.js"
```
