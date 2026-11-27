// SCRUM-197: k6 load bots that play real Slopster games (Platform ADR-0005).
//
//   k6 run -e BOT_PASSWORD=... loadtest/bots.js
//
// One k6 VU = one private lobby with BOTS_PER_LOBBY bots (k6 VUs share no state, so one VU drives the
// whole lobby). One iteration = one game: the first iteration logs the bots in and creates the lobby,
// later iterations use "play again" (SCRUM-172). Traffic goes through the edge like the Frontend's:
// REST for users/lobbies and the SignalR JSON protocol over a WebSocket for the game.
//
// Env: BASE_URL (https://quiz.munkcloud.dk), BOTS (50), BOTS_PER_LOBBY (4, 2-8), DURATION (5m),
//      RAMP_UP (1m), BOT_PASSWORD (required, at least 8 characters). See README.md.

import http from 'k6/http';
import { check, sleep } from 'k6';
import exec from 'k6/execution';
import { Counter, Trend } from 'k6/metrics';
import { setInterval, clearInterval, setTimeout, clearTimeout } from 'k6/timers';
import { WebSocket } from 'k6/websockets';
import { MessageType, handshake, invocation, parseFrames, ping } from './lib/signalr.js';
import { pickSlot, answerDelayMs, playAgainDelays, botName } from './lib/bot-logic.js';

const BASE_URL = (__ENV.BASE_URL || 'https://quiz.munkcloud.dk').replace(/\/$/, '');
const WS_BASE = BASE_URL.replace(/^http/, 'ws');
const BOTS = toInt(__ENV.BOTS, 50);
const PER_LOBBY = Math.min(8, Math.max(2, toInt(__ENV.BOTS_PER_LOBBY, 4)));
const DURATION = __ENV.DURATION || '5m';
const RAMP_UP = __ENV.RAMP_UP || '1m';
const PASSWORD = __ENV.BOT_PASSWORD || '';
const LOBBIES = Math.ceil(BOTS / PER_LOBBY);

// Short games so a 5-minute run plays several: 5 rounds, 15 s to answer (LobbyService allows
// rounds 5/10/15/20 and answer time 15/30/45/60). The playlist needs rounds + 1 songs.
const ROUNDS = 5;
const ANSWER_TIME = 15;

export const options = {
  scenarios: {
    lobbies: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: RAMP_UP, target: LOBBIES },  // spread logins out (unauthenticated calls count per IP)
        { duration: DURATION, target: LOBBIES },
        { duration: '10s', target: 0 },
      ],
      gracefulRampDown: '3m', // let a game that is running finish instead of cutting it off
      gracefulStop: '3m',
    },
  },
  thresholds: {
    bot_errors: ['count==0'],     // done criterion: no errors in the bot log
    checks: ['rate>0.99'],
    games_completed: ['count>0'],
  },
};

const gamesCompleted = new Counter('games_completed');
const botErrors = new Counter('bot_errors');
const rateLimited = new Counter('rate_limited');
const answerRtt = new Trend('answer_rtt', true); // SubmitAnswer -> server reply, ms

// Per-VU state, kept between iterations.
let bots = null;    // [{ name, userId, access, refresh, expiresAt }]
let lobbyId = null;

export function setup() {
  if (PASSWORD.length < 8)
    exec.test.abort('Set BOT_PASSWORD (at least 8 characters), e.g. k6 run -e BOT_PASSWORD=... bots.js');
  console.log(`${BOTS} bots in ${LOBBIES} lobbies of ${PER_LOBBY} against ${BASE_URL} (ramp-up ${RAMP_UP}, ${DURATION})`);
}

export default async function () {
  if (!bots) bots = loginBots();
  if (!bots) return;

  let hostUserId;
  if (!lobbyId) {
    hostUserId = createLobby();
  } else {
    hostUserId = playAgain();
  }
  if (!hostUserId) { lobbyId = null; return; } // start over with a fresh lobby next iteration

  const gameId = readyAndStart(hostUserId);
  if (!gameId) { lobbyId = null; return; }

  await Promise.all(bots.map((bot) => playGame(bot, gameId, bot.userId === hostUserId)));
}

// ---- REST ---------------------------------------------------------------------------------------

function loginBots() {
  const vu = exec.vu.idInTest;
  const count = Math.max(2, Math.min(PER_LOBBY, BOTS - (vu - 1) * PER_LOBBY));
  const result = [];
  for (let i = 0; i < count; i++) {
    const name = botName(vu, i, PER_LOBBY);
    const created = api(null, 'POST', '/api/userservice/users', { userName: name, password: PASSWORD });
    if (!expect(created, [201, 409], `create ${name}`)) return null; // 409 = exists from an earlier run
    const bot = { name };
    if (!login(bot)) return null;
    result.push(bot);
  }
  return result;
}

function login(bot) {
  const res = api(null, 'POST', '/api/userservice/auth/login', { userName: bot.name, password: PASSWORD });
  if (!expect(res, [200], `login ${bot.name}`)) return false;
  const body = res.json();
  bot.userId = body.user.id;
  setTokens(bot, body);
  return true;
}

function setTokens(bot, body) {
  bot.access = body.accessToken;
  bot.refresh = body.refreshToken;
  bot.expiresAt = Date.parse(body.accessTokenExpiresAt);
}

// Access tokens live 15 minutes; renew one when it has less than a minute left.
function ensureFresh(bot) {
  if (bot.expiresAt - Date.now() > 60_000) return;
  const res = api(null, 'POST', '/api/userservice/auth/refresh', { refreshToken: bot.refresh });
  if (res.status === 200) setTokens(bot, res.json());
  else login(bot);
}

function createLobby() {
  const host = bots[0];
  for (const bot of bots) leaveStaleLobby(bot);

  const playlists = api(host, 'GET', '/api/musicservice/playlists');
  if (!expect(playlists, [200], 'list playlists')) return null;
  const usable = playlists.json().filter((p) => p.songCount >= ROUNDS + 1);
  if (usable.length === 0) exec.test.abort(`No playlist has ${ROUNDS + 1} songs`);
  const categoryId = usable[Math.floor(Math.random() * usable.length)].id;

  const created = api(host, 'POST', '/api/lobbyservice/lobbies', {
    categoryId, answerTimeSeconds: ANSWER_TIME, rounds: ROUNDS, maxPlayers: PER_LOBBY, isPrivate: true,
  });
  if (!expect(created, [201], 'create lobby')) return null;
  const lobby = created.json();

  for (const bot of bots.slice(1)) {
    const joined = api(bot, 'POST', '/api/lobbyservice/lobbies/join-by-code', { code: lobby.code });
    if (!expect(joined, [200], `join ${bot.name}`)) return null;
  }
  lobbyId = lobby.id;
  return lobby.hostUserId;
}

// A bot left in a lobby by an earlier, interrupted run cannot join a new one (one lobby per user).
function leaveStaleLobby(bot) {
  const mine = api(bot, 'GET', '/api/lobbyservice/lobbies/mine');
  if (mine.status === 200) api(bot, 'POST', `/api/lobbyservice/lobbies/${mine.json().id}/leave`);
}

// After GameEnded the lobby reopens only when LobbyService has consumed game.finished, so the
// first tries get 409. Returns the host's user id, or null if the lobby never reopened.
function playAgain() {
  let lobby = null;
  for (const bot of bots) {
    lobby = null;
    for (const delay of playAgainDelays()) {
      const res = api(bot, 'POST', `/api/lobbyservice/lobbies/${lobbyId}/play-again`);
      if (res.status === 200) { lobby = res.json(); break; }
      if (res.status !== 409) break;
      sleep(delay / 1000);
    }
    if (!expect(lobby ? { status: 200 } : { status: 409 }, [200], `play again ${bot.name}`)) return null;
  }
  return lobby.hostUserId;
}

function readyAndStart(hostUserId) {
  for (const bot of bots) {
    const ready = api(bot, 'POST', `/api/lobbyservice/lobbies/${lobbyId}/ready`, { ready: true });
    if (!expect(ready, [200], `ready ${bot.name}`)) return null;
  }
  const host = bots.find((b) => b.userId === hostUserId);
  if (!host) { fail(`host ${hostUserId} is not one of this VU's bots`); return null; }
  const started = api(host, 'POST', `/api/lobbyservice/lobbies/${lobbyId}/start`);
  if (!expect(started, [200], 'start game')) return null;
  return started.json().gameId;
}

// One REST call through the edge. 429 (rate limit) is waited out and retried, not counted as an error.
function api(bot, method, path, body) {
  if (bot) ensureFresh(bot);
  const headers = { 'Content-Type': 'application/json' };
  if (bot) headers.Authorization = `Bearer ${bot.access}`;
  const params = { headers, tags: { name: path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '{id}') } };
  let res;
  for (let attempt = 0; attempt < 5; attempt++) {
    res = http.request(method, BASE_URL + path, body === undefined ? null : JSON.stringify(body), params);
    if (res.status !== 429) return res;
    rateLimited.add(1);
    sleep(1 + Math.random() * 2);
  }
  return res;
}

function expect(res, statuses, what) {
  const ok = check(res, { [`${what.split(' ')[0]} ok`]: (r) => statuses.includes(r.status) });
  if (!ok) fail(`${what}: HTTP ${res.status} ${res.body ? String(res.body).slice(0, 200) : ''}`);
  return ok;
}

function fail(reason) {
  botErrors.add(1);
  console.error(`[VU ${exec.vu.idInTest}] ${reason}`);
}

// ---- Game (SignalR over WebSocket) -------------------------------------------------------------

// Plays one game as one bot. Resolves when GameEnded arrives (or the game fails).
function playGame(bot, gameId, isHost) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${WS_BASE}/api/gameservice/hubs/game?access_token=${bot.access}`);
    const pending = {}; // invocationId -> { target, sentAt, onResult }
    let nextId = 1;
    let timeline = 1;   // every timeline starts with one card
    let ended = false;
    let finished = false;
    let answerTimer = null;

    // The server drops a connection it has not heard from in 30 s.
    const pinger = setInterval(() => ws.send(ping()), 10_000);
    const safety = setTimeout(() => lose(`${bot.name}: game ${gameId} did not end in time`),
      (ROUNDS * (ANSWER_TIME + 15) + 90) * 1000);

    function finish() {
      if (finished) return;
      finished = true;
      clearInterval(pinger);
      clearTimeout(safety);
      if (answerTimer) clearTimeout(answerTimer);
      ws.close();
      resolve();
    }

    function lose(reason) {
      if (finished) return;
      fail(reason);
      finish();
    }

    function call(target, args, onResult) {
      const id = String(nextId++);
      pending[id] = { target, sentAt: Date.now(), onResult };
      ws.send(invocation(target, args, id));
    }

    ws.onopen = () => {
      ws.send(handshake());
      call('JoinGame', [gameId], (state) => { timeline = state.myTimeline.length; });
    };
    ws.onmessage = (e) => { for (const message of parseFrames(e.data)) handle(message); };
    ws.onerror = (e) => lose(`${bot.name}: WebSocket error ${e.error}`);
    ws.onclose = () => { if (!ended) lose(`${bot.name}: connection closed before GameEnded`); };

    function handle(message) {
      if (message.type === MessageType.Completion) {
        const sent = pending[message.invocationId];
        delete pending[message.invocationId];
        if (!sent) return;
        if (message.error) { lose(`${bot.name}: ${sent.target} failed: ${message.error}`); return; }
        if (sent.target === 'SubmitAnswer') answerRtt.add(Date.now() - sent.sentAt);
        if (sent.onResult) sent.onResult(message.result);
      } else if (message.type === MessageType.Close) {
        if (!ended) lose(`${bot.name}: server closed the connection: ${message.error || ''}`);
      } else if (message.type === MessageType.Invocation) {
        onEvent(message.target, message.arguments[0]);
      }
      // Ping and the empty handshake reply need no answer.
    }

    function onEvent(target, payload) {
      switch (target) {
        case 'Prefetch': // like the Frontend: "ready" for every round whose song is ready (GamePage.razor.cs)
          for (const file of payload) ws.send(invocation('Ready', [gameId, file.round]));
          break;
        case 'RoundStarted':
          answerTimer = setTimeout(() => {
            answerTimer = null;
            call('SubmitAnswer', [gameId, payload.round, pickSlot(timeline)]);
          }, payload.startsInMs + answerDelayMs(payload.answerTimeSeconds));
          break;
        case 'RoundEnded': {
          const me = payload.results.find((r) => r.userId === bot.userId);
          if (me) timeline = me.timeline.length;
          break;
        }
        case 'GameEnded':
          ended = true;
          if (isHost) gamesCompleted.add(1);
          finish();
          break;
        // PlayerAnswered: nothing to do.
      }
    }
  });
}

function toInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
