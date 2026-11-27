// How a bot plays: plain functions without k6 imports, so `node --test` can test them.
// rnd defaults to Math.random; tests pass a fixed one.

// Where to put the song: slot 0 = before the first card, slot n = after the last card
// (GameService accepts 0..timeline.Count).
export function pickSlot(timelineLength, rnd = Math.random) {
  return Math.floor(rnd() * (timelineLength + 1));
}

// A human-ish answer time: at least 1 s after playback starts and at least 2 s before the answer
// time runs out, so the answer never arrives after the server's deadline.
export function answerDelayMs(answerTimeSeconds, rnd = Math.random) {
  const min = 1000;
  const max = (answerTimeSeconds - 2) * 1000;
  return min + Math.floor(rnd() * (max - min));
}

// Waits between "play again" tries. The lobby reopens only after LobbyService has consumed
// game.finished from RabbitMQ, so the first tries get 409. Back off to 2 s, with up to 50 % jitter
// so 50 bots do not hit the edge at the same instant. 15 tries, about 25 s in total.
export function playAgainDelays(rnd = Math.random) {
  const base = [500, 1000, 1000, 1500, 1500, 2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000];
  return base.map((ms) => ms + Math.floor(rnd() * ms * 0.5));
}

// loadbot_1, loadbot_2 ... : each k6 VU (1-based) owns perLobby consecutive numbers.
// Underscore, not hyphen: UserService only allows [A-Za-z0-9_]{3,20}.
export function botName(vu, index, perLobby) {
  return `loadbot_${(vu - 1) * perLobby + index + 1}`;
}
