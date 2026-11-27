// The SignalR JSON hub protocol, written by hand because k6 has WebSockets but no SignalR client.
// https://github.com/dotnet/aspnetcore/blob/main/src/SignalR/docs/specs/HubProtocol.md
//
// Every message is a JSON object followed by the record separator 0x1E. One WebSocket frame can carry
// several messages. Plain functions without k6 imports, so `node --test` can test them.

export const RS = '\x1e';

export const MessageType = {
  Invocation: 1, // a call: client -> server (hub method) or server -> client (event such as RoundStarted)
  StreamItem: 2,
  Completion: 3, // the reply to an invocation that had an invocationId (result or error)
  Ping: 6,       // keep-alive; the server closes the connection after 30 s without anything from us
  Close: 7,
};

// First message after the WebSocket opens. The server answers with "{}" + RS.
export function handshake() {
  return JSON.stringify({ protocol: 'json', version: 1 }) + RS;
}

// Calls a hub method. With an invocationId the server sends a Completion with the result;
// without one it is fire-and-forget.
export function invocation(target, args, invocationId) {
  const message = { type: MessageType.Invocation, target, arguments: args };
  if (invocationId !== undefined) message.invocationId = invocationId;
  return JSON.stringify(message) + RS;
}

export function ping() {
  return JSON.stringify({ type: MessageType.Ping }) + RS;
}

// Splits one WebSocket frame into its messages.
export function parseFrames(data) {
  return data.split(RS).filter((part) => part.length > 0).map((part) => JSON.parse(part));
}
