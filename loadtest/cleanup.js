// SCRUM-197: removes the load-test bots and their stats after a run (Platform ADR-0005).
//
//   k6 run -e ADMIN_USER=... -e ADMIN_PASSWORD=... loadtest/cleanup.js
//
// Logs in as an Admin and calls the two admin endpoints, which only accept the prefix "loadbot_".
// Stats first: if the user delete failed halfway, the stats would otherwise point at nobody.

import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';

const BASE_URL = (__ENV.BASE_URL || 'https://quiz.munkcloud.dk').replace(/\/$/, '');

export const options = { vus: 1, iterations: 1, thresholds: { checks: ['rate==1'] } };

export default function () {
  if (!__ENV.ADMIN_USER || !__ENV.ADMIN_PASSWORD)
    exec.test.abort('Set ADMIN_USER and ADMIN_PASSWORD, e.g. k6 run -e ADMIN_USER=... -e ADMIN_PASSWORD=... cleanup.js');

  const login = http.post(`${BASE_URL}/api/userservice/auth/login`,
    JSON.stringify({ userName: __ENV.ADMIN_USER, password: __ENV.ADMIN_PASSWORD }),
    { headers: { 'Content-Type': 'application/json' } });
  if (!check(login, { 'admin login ok': (r) => r.status === 200 })) {
    console.error(`Login failed: HTTP ${login.status}`);
    return;
  }
  const headers = { Authorization: `Bearer ${login.json().accessToken}` };

  for (const [what, path] of [
    ['stats', '/api/statisticservice/admin/stats?prefix=loadbot_'],
    ['users', '/api/userservice/admin/users?prefix=loadbot_'],
  ]) {
    const res = http.del(`${BASE_URL}${path}`, null, { headers });
    if (check(res, { [`delete ${what} ok`]: (r) => r.status === 200 }))
      console.log(`Deleted ${res.json().deleted} loadbot_ ${what}`);
    else
      console.error(`Delete ${what} failed: HTTP ${res.status} ${String(res.body).slice(0, 200)}` +
        (res.status === 403 ? ' (is ADMIN_USER an Admin?)' : ''));
  }
}
