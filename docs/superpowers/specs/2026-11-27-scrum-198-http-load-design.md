# SCRUM-198 – HTTP-load med k6 mod de læsetunge endpoints (design)

Status: godkendt 2026-11-27. Parent: SCRUM-196 (stresstest-script til demo af autoscaling). Søster til SCRUM-197.

## Formål og hvorfor

Botterne fra SCRUM-197 spiller rigtige spil, men giver ikke nok CPU-belastning til at udløse HPA'en
hurtigt. Dette script giver en **kontrolleret, høj HTTP-load** mod de endpoints, der mest læser data, så vi
ved eksamen kan sige: "Ved N requests/s holdt p95 sig under 500 ms, mens Statistics skalerede fra 2 til 5 pods".

**Done når:** scriptet udløser opskalering af mindst Statistics og én anden service, og k6-resultatet
gemmes som fil, så det kan vises ved eksamen, hvis live-demoen driller.

**Ikke-mål:** ændringer i services, kontrakter eller edge'ens rate-limit. Egne k6-tal i Grafana.
**Anti-mål:** at testen måler rate-limiteren (429) i stedet for servicerne, eller at testbrugerne bliver liggende.

## Begrænsninger fundet i koden

- Edge'en (`EdgeService/src/EdgeService.Api/Program.cs`): kald uden token tælles pr. IP (100 / 10 s).
  Kald med token tælles pr. bruger (100 / 10 s), og der er et loft pr. IP på 1000 / 10 s for alt.
  ⇒ Login kan ikke bruges som belastning (højst 10/s fra én maskine). Hver testbruger logger ind én gang.
  ⇒ Samlet rate fra én maskine ≲ 100 requests/s inkl. botterne, og pr. bruger ≲ 10/s.
- Pods har `requests.cpu: 50m` og HPA-mål 70 % ⇒ der skaleres op ved ~35m i gennemsnit. ~60 req/s
  autentificerede GETs fordelt på fire services forventes at være nok.
- Leaderboardet læser fra Redis (SCRUM-195) kun når gitops PR #33 (Redis connection string) er merget.
- Access tokens lever 15 min. Testen holdes under 14 min, så tokens ikke skal fornyes.

## Tilgange

| Tilgang | Vurdering |
|---|---|
| Ekstra scenarie i `bots.js` | Blander to formål i én fil. Ticketen vil kunne køre den alene. Fravalgt. |
| `constant-vus` med `sleep` | Raten afhænger af svartiden, så tallet "N req/s" bliver uklart. Fravalgt. |
| **Ny `loadtest/http.js` med `ramping-arrival-rate` (valgt)** | Fast antal requests/s uanset svartid, så resultatet kan kvantificeres. Kan køres i en ekstra terminal ved siden af botterne. |

## Designet

1. **`loadtest/http.js`**
   - `setup()`: opretter (409 = findes) og logger `USERS` testbrugere ind, `loadbot_h1..N` (prefix `loadbot_`,
     så `cleanup.js` også fjerner dem). Ved 429 ventes og prøves igen. Returnerer access tokens.
   - Scenarie `ramping-arrival-rate`: op til `RATE` på `RAMP_UP`, plateau i `DURATION`, ned på 30 s.
   - Én iteration = ét GET med en token valgt round-robin, endpoint valgt vægtet:
     `statistics/weekly` 40 %, `statistics/me` 25 %, `users/me` 20 %, `musicservice/playlists` 15 %.
     Hver request tagges `endpoint:<navn>`.
   - Thresholds: `http_req_failed rate<0.01`, `http_req_duration{endpoint:X} p(95)<500` for hvert endpoint,
     `rate_limited count==0` (429 tælles, men prøves ikke igen: det er netop det, testen skal afsløre).
   - `handleSummary`: skriver k6's tekstopsummering til terminalen og gemmer `loadtest/results/http-<tid>.txt`
     og `.json`.
   - Env: `BASE_URL`, `BOT_PASSWORD` (påkrævet, samme som botterne), `USERS` (20), `RATE` (60), `RAMP_UP` (1m),
     `DURATION` (5m). Setup afviser, hvis `RATE > 9 × USERS` eller hvis testen er længere end 14 min.
2. **`loadtest/lib/http-logic.js`** + test (`node --test`, som `bot-logic.js`): vægtet valg af endpoint,
   brugernavne, validering af parametrene og varighed i ms.
3. **`loadtest/README.md`**: nyt afsnit om `http.js`, og at `results/` gemmes.

## Overladt til bygherren

Den præcise opsummering i txt-filen og logbeskederne.
