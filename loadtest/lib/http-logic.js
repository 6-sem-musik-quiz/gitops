// SCRUM-198: the pure parts of the HTTP load test (http.js), kept apart so `node --test` can check them.

// The read-heavy endpoints, through the edge, with how often each is called (percent).
// Statistics gets the most: it is the service the test must scale up (SCRUM-196).
export const ENDPOINTS = [
  { name: 'weekly', path: '/api/statisticservice/statistics/weekly', weight: 40 }, // leaderboard, Redis (SCRUM-195)
  { name: 'my_stats', path: '/api/statisticservice/statistics/me', weight: 25 },
  { name: 'my_user', path: '/api/userservice/users/me', weight: 20 },
  { name: 'playlists', path: '/api/musicservice/playlists', weight: 15 },
];

const TOTAL_WEIGHT = ENDPOINTS.reduce((sum, e) => sum + e.weight, 0);

export function pickEndpoint(rand = Math.random) {
  let r = rand() * TOTAL_WEIGHT;
  for (const e of ENDPOINTS) {
    if (r < e.weight) return e;
    r -= e.weight;
  }
  return ENDPOINTS[ENDPOINTS.length - 1]; // rounding when rand() is just under 1
}

// loadbot_ prefix, so cleanup.js removes these users too; "h" keeps them apart from the game bots.
export function httpUserName(i) {
  return `loadbot_h${i + 1}`;
}

// k6 durations as used here: "90s", "1m", "2m30s".
export function durationMs(text) {
  const m = /^(?:(\d+)m)?(?:(\d+)s)?$/.exec(String(text));
  if (!m || (m[1] === undefined && m[2] === undefined)) throw new Error(`Not a duration like 30s, 1m or 2m30s: "${text}"`);
  return (Number(m[1] || 0) * 60 + Number(m[2] || 0)) * 1000;
}

export const RAMP_DOWN = '30s';
const MAX_TOTAL_MS = 14 * 60_000; // access tokens live 15 minutes and are not renewed
const MAX_RATE_PER_USER = 9;      // the edge allows 100 requests / 10 s per user

// Returns an error message, or null when the options are usable.
export function validateOptions({ users, rate, rampUp, duration }) {
  if (!Number.isInteger(users) || users < 1) return `USERS must be a whole number >= 1 (got ${users})`;
  if (!Number.isInteger(rate) || rate < 1) return `RATE must be a whole number >= 1 (got ${rate})`;
  if (rate > MAX_RATE_PER_USER * users)
    return `RATE ${rate}/s is more than ${MAX_RATE_PER_USER}/s per user with ${users} USERS: the edge would answer 429. Raise USERS to at least ${Math.ceil(rate / MAX_RATE_PER_USER)}.`;
  let total = durationMs(RAMP_DOWN);
  for (const [name, value] of [['RAMP_UP', rampUp], ['DURATION', duration]]) {
    try { total += durationMs(value); } catch (e) { return `${name}: ${e.message}`; }
  }
  if (total > MAX_TOTAL_MS) return `RAMP_UP + DURATION + ${RAMP_DOWN} must be at most 14 min (access tokens live 15 min)`;
  return null;
}
