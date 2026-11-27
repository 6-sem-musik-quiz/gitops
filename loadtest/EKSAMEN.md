# Load-test til eksamen – sådan viser du den

Én side til alle fire i gruppen. Følg den fra toppen. Demoen tager ca. 8 minutter.

**Hvad demoen viser:** Vi presser Slopster med rigtige spillere (bots) og mange læse-requests. Kubernetes
starter selv flere pods (autoscaling), mens svartiden holder sig under 500 ms. Bagefter skalerer den ned igen.

> ⚠️ **Kun én kører ad gangen.** Alle bruger de samme bot-navne, så to samtidige kørsler ødelægger hinanden.
> Skriv i gruppen, før du kører.

---

## 1. Gør én gang (10 min)

| | Hvad | Sådan |
|---|---|---|
| ☐ | Hent gitops | `git clone https://github.com/6-sem-musik-quiz/gitops` (eller `git pull` på `main`) |
| ☐ | Installér k6 | `winget install GrafanaLabs.k6`, og åbn en ny terminal |
| ☐ | Hent bot-passwordet | OpenBao → `kv/quiz/loadtest` → `bot-password`. Scriptet spørger efter det første gang og husker det i `%USERPROFILE%\.slopster-loadtest` (ikke i git) |
| ☐ | kubectl virker (valgfrit) | Tailscale kører, og `kubectl get pods` viser pods i `quiz` (se Platform `docs/drift.md`). Uden kubectl bruger du bare Grafana |
| ☐ | Grafana-login | Dashboardet **"Slopster Autoscaling"** i Quiz-org. Adresse og login: _(Asger udfylder)_ |

## 2. Dagen før eksamen (3 min)

I PowerShell i `gitops`-mappen:

```powershell
powershell -ExecutionPolicy Bypass -File .\loadtest\stress.ps1 -Check
```

Den kører en lille udgave af begge tests (2 brugere, 2 bots). Du skal se til sidst:

```
CHECK OK: both tests work. You are ready for the demo.
```

Står der `CHECK FAILED`, så se [Hvis noget fejler](#6-hvis-noget-fejler) og skriv i gruppen.

## 3. Til eksamen (3 trin)

1. **Åbn Grafana** på dashboardet "Slopster Autoscaling", så censor kan se det. Alle services står på 2 pods.
2. **Start demoen:**
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\loadtest\stress.ps1
   ```
   Der åbner tre vinduer: **bots**, **HTTP load** og **HPA** (`kubectl get hpa -w`).
3. **Fortæl, mens det kører** (punkt 4). Efter ca. 1–2 min skalerer de første services op. Efter ca. 7 min
   stopper testen, og HTTP-vinduet viser resultatet. Ca. 2 min senere skalerer pods ned til 2 igen.

## 4. Hvad du peger på, og hvad du siger

| Peg på | Sig | Princip |
|---|---|---|
| **HPA-vinduet / Grafana: pods 2 → 5** | "Kubernetes' HorizontalPodAutoscaler starter flere ens pods, når CPU'en i gennemsnit er over 70 % af det, poden har bedt om. Det kan den, fordi vores services er stateless: spil og lobbier ligger i Redis, ikke i poden." | X-skalering, stateless |
| **HTTP-vinduet: p95 pr. endpoint** | "Vi sender et fast antal requests i sekundet og måler, at 95 % af svarene kommer under 500 ms, også mens der skaleres op. Testen fejler automatisk, hvis kravet ikke holder." | Ydeevne, målt |
| **Leaderboard-endpointet (`weekly`)** | "Leaderboardet læses fra en Redis-cache, så StatisticService ikke rammer Postgres for hver request." | Caching |
| **Bots-vinduet: `games_completed`** | "Bottene spiller rigtige spil. Når et spil slutter, sender GameService en besked via RabbitMQ til StatisticService, så statistikken opdateres asynkront." | Asynkront design |
| **Grafana generelt** | "Alle services sender metrics, logs og traces med OpenTelemetry, så vi kan se det her live." | Design to be monitored |
| **Pods går ned igen** | "Når lasten stopper, skalerer den ned efter 2 minutters ro. Vi har sat det ned fra Kubernetes' standard på 5 minutter, så det kan ses i en demo." | Elasticitet |

## 5. Plan B (hvis klyngen eller nettet driller)

- **Gemte resultater:** `loadtest/results/` indeholder resultatet fra vores rigtige kørsel (txt + json). Åbn txt-filen og vis tallene.
- **Optagelse:** en skærmoptagelse af Grafana under en rigtig kørsel. _(Linkes her, når den er lavet.)_
- Forklar så det samme som i punkt 4 ud fra tallene.

## 6. Hvis noget fejler

| Du ser | Betyder | Gør |
|---|---|---|
| `k6 not found` | k6 er ikke installeret | `winget install GrafanaLabs.k6`, ny terminal |
| `login loadbot_...: HTTP 401` | Forkert bot-password | Slet `%USERPROFILE%\.slopster-loadtest`, kør igen, og indsæt passwordet fra OpenBao |
| `create loadbot_...: HTTP 409` efterfulgt af 401 | Brugerne findes med et andet password | En admin kører `.\loadtest\stress.ps1 -Cleanup`, derefter igen |
| `429` / `rate_limited` > 0 | Edge'ens grænse pr. IP er ramt | Kør med lavere last: `-Rate 40 -Bots 30` |
| `502` / `503` | En service er nede | `kubectl -n quiz get pods`, og skriv i gruppen. Brug plan B |
| Pods skalerer ikke op | Ikke nok CPU-last | Kør igen med `-Rate 80` (højst ca. 90 sammen med bots) |

## Oprydning (valgfrit, kræver admin)

```powershell
powershell -ExecutionPolicy Bypass -File .\loadtest\stress.ps1 -Cleanup
```

Spørger efter en Slopster-konto med rollen Admin og sletter alle `loadbot_`-brugere og deres stats
(bot-spillene forsvinder også fra ugens leaderboard). Ikke nødvendigt mellem kørsler.

---

Detaljer om scripts og parametre: [README.md](README.md). Baggrund: Platform ADR-0005, SCRUM-196–199.
