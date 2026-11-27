# SCRUM-198 HTTP-load Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Et k6-script, der sender en fast rate af autentificerede GETs mod Statistics, User og Music, så HPA'en skalerer op, og som gemmer resultatet som fil.

**Architecture:** Ren logik (parametre, vægtet valg, navne) i `loadtest/lib/http-logic.js`, testet med `node --test` som `bot-logic.js`. `loadtest/http.js` er k6-scriptet: `setup()` logger testbrugere ind, `ramping-arrival-rate` sender requests, `handleSummary` gemmer resultatet.

**Tech Stack:** k6 (JavaScript, ES modules), Node 22+ `node:test` til lib-testene.

**Spec:** `docs/superpowers/specs/2026-11-27-scrum-198-http-load-design.md`

## Global Constraints

- Testbrugere hedder `loadbot_h1..loadbot_hN` (regex `^[A-Za-z0-9_]{3,20}$`, prefix `loadbot_`).
- Env og standarder: `BASE_URL` (`https://quiz.munkcloud.dk`), `BOT_PASSWORD` (påkrævet, ≥ 8 tegn), `USERS` (20), `RATE` (60), `RAMP_UP` (1m), `DURATION` (5m). Ramp-down 30 s.
- Afvis hvis `RATE > 9 × USERS` eller samlet varighed (RAMP_UP + DURATION + 30s) > 14 min.
- Vægte: `weekly` 40, `my_stats` 25, `my_user` 20, `playlists` 15.
- Thresholds: `http_req_failed: rate<0.01`, `http_req_duration{endpoint:<navn>}: p(95)<500` for hvert af de fire, `rate_limited: count==0`.
- Ingen secrets i git. Flux rører ikke `loadtest/` (ikke i nogen kustomization).

## Review Focus

- `RAMP_UP`/`DURATION` med andre enheder end `s`/`m` (fx `90s`, `2m30s`) → skal parses eller afvises med klar besked, ikke give NaN. Test i Task 1.
- `USERS`/`RATE` som ikke-tal eller 0 → klar fejl. Test i Task 1.
- 429 under login i setup (botterne kører samtidig) → vent og prøv igen, op til 5 gange. Håndteres i Task 2.
- `results/`-mappen findes ikke → k6 opretter ikke mapper; mappen committes med `.gitkeep`. Task 2.
- Vægtet valg med `rand()` lige under 1 → sidste endpoint, aldrig `undefined`. Test i Task 1.

---

### Task 1: Ren logik i `lib/http-logic.js`

**Files:**
- Create: `loadtest/lib/http-logic.js`
- Test: `loadtest/lib/http-logic.test.js`

**Interfaces:**
- Produces:
  - `ENDPOINTS: Array<{ name: string, path: string, weight: number }>` (de fire, paths gennem edge'en: `/api/statisticservice/statistics/weekly`, `/api/statisticservice/statistics/me`, `/api/userservice/users/me`, `/api/musicservice/playlists`)
  - `pickEndpoint(rand: () => number = Math.random): { name, path, weight }`
  - `httpUserName(i: number): string` → `loadbot_h${i + 1}` (i er 0-baseret)
  - `durationMs(text: string): number` → `'90s'`→90000, `'1m'`→60000, `'2m30s'`→150000; ugyldig → kaster `Error`
  - `validateOptions({ users, rate, rampUp, duration }): string | null` → fejlbesked eller `null`

- [ ] **Step 1: Skriv testene**: `pickEndpoint(() => 0).name === 'weekly'`, `pickEndpoint(() => 0.39).name === 'weekly'`, `pickEndpoint(() => 0.40).name === 'my_stats'`, `pickEndpoint(() => 0.999999).name === 'playlists'`; vægtene summerer til 100; `httpUserName(0) === 'loadbot_h1'` og matcher regex for i=999; `durationMs` på `'90s'`, `'1m'`, `'2m30s'`, og `assert.throws` på `'abc'` og `''`; `validateOptions` giver `null` for standarderne, fejl for `rate: 200, users: 20`, `users: 0`, `rate: NaN`, og for `rampUp: '10m', duration: '5m'` (> 14 min).
- [ ] **Step 2:** `node --test loadtest/lib/` → FAIL (modul findes ikke).
- [ ] **Step 3:** Implementér. `durationMs` via regex `^(?:(\d+)m)?(?:(\d+)s)?$` med mindst én del.
- [ ] **Step 4:** `node --test loadtest/lib/` → alle tests (også bot-logic) PASS.
- [ ] **Step 5:** Commit `SCRUM-198: pure logic for the HTTP load test`.

### Task 2: `loadtest/http.js`, README og results-mappen

**Files:**
- Create: `loadtest/http.js`, `loadtest/results/.gitkeep`
- Modify: `loadtest/README.md` (nyt afsnit + fil i tabellen), `loadtest/package.json` (description nævner SCRUM-198)

**Interfaces:**
- Consumes: alt fra Task 1.

- [ ] **Step 1: `http.js`**
  - `options.scenarios.http = { executor: 'ramping-arrival-rate', startRate: 0, timeUnit: '1s', preAllocatedVUs: min(RATE, 50), maxVUs: RATE * 2, stages: [{RAMP_UP→RATE}, {DURATION→RATE}, {'30s'→0}] }`, thresholds som Global Constraints. Ugyldige parametre → `exec.test.abort(<besked fra validateOptions>)` i `setup()`.
  - `setup()`: for hver bruger `POST /api/userservice/users` (201/409 ok), derefter `POST /api/userservice/auth/login`; ved 429 `sleep(10)` og prøv igen (max 5). Fejler en bruger → abort. Returnerer `{ tokens: string[] }`.
  - `default(data)`: token = `data.tokens[exec.scenario.iterationInTest % tokens.length]`, endpoint = `pickEndpoint()`, `http.get` med `Authorization: Bearer`, `tags: { endpoint: name }`. `check` på status 200; 429 → `rateLimited.add(1)` (ingen retry).
  - `handleSummary(data)`: brug `textSummary` fra `https://jslib.k6.io/k6-summary/0.1.0/index.js`; returnér `{ stdout, 'loadtest/results/http-<YYYY-MM-DDTHH-mm-ss>.txt', '...json': JSON.stringify(data, null, 2) }`. Første linje i txt: BASE_URL, RATE, USERS, varighed.
- [ ] **Step 2:** `k6 inspect loadtest/http.js` (fra `gitops/`) → JSON med scenariet, ingen syntaksfejl. `node --test loadtest/lib/` stadig PASS.
- [ ] **Step 3: README**: tabelrække for `http.js`; afsnit "HTTP-load (SCRUM-198)": hvorfor, kommando `k6 run -e BOT_PASSWORD=<...> loadtest/http.js`, env-tabel, grænserne (10 req/s pr. bruger, 1000/10 s pr. IP, inkl. botterne), at PR #33 skal være merget for Redis-cachen, hvad man ser (thresholds, Grafana "Slopster Autoscaling": statisticservice + userservice/musicservice skalerer), at resultatet ligger i `results/`, og at `cleanup.js` også fjerner `loadbot_h*`.
- [ ] **Step 4:** Commit `SCRUM-198: k6 HTTP load against leaderboard, stats, profile and playlists`.

### Task 3: Prøvekørsel og PR

- [ ] **Step 1:** Lille kørsel mod clusteret, **kun med brugerens accept** (rammer produktion): `k6 run -e BOT_PASSWORD=<...> -e USERS=2 -e RATE=5 -e RAMP_UP=10s -e DURATION=20s loadtest/http.js` → thresholds grønne, fil i `results/`.
- [ ] **Step 2:** `kubectl kustomize .` renderer uden fejl (AGENTS.md regel 4).
- [ ] **Step 3:** Push branchen `scrum-198-http-load` og åbn PR mod `main`. Ingen auto-merge.
