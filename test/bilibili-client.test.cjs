'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BilibiliLiveClient,
  signRequest,
  createStartBody,
  createEndBody,
} = require('../src/lib/bilibili-client.cjs');
const { encodePacket, Operation } = require('../src/lib/bili-protocol.cjs');

test('produces deterministic Bilibili HMAC headers', () => {
  const body = JSON.stringify({ game_id: 'demo' });
  const headers = signRequest(body, 'demo-key', 'demo-secret', {
    timestamp: 1710000000,
    nonce: 'fixed-nonce',
  });
  assert.equal(headers['x-bili-content-md5'], 'cc1d0731a0c97bb0111709cb25de25f2');
  assert.equal(headers.Authorization, 'f08b008d4b385afdd853d7569543279b43a21ff75606f4f266136d8d79ad11d3');
  assert.equal(headers['Content-Type'], 'application/json');
});

test('preserves int64 app ids without numeric conversion', () => {
  assert.equal(
    createStartBody('ABC', '9223372036854775807'),
    '{"code":"ABC","app_id":9223372036854775807}',
  );
  assert.equal(
    createEndBody('game', '9223372036854775807'),
    '{"game_id":"game","app_id":9223372036854775807}',
  );
});

test('rejects malformed app ids', () => {
  assert.throws(() => createStartBody('ABC', '1e6'), /纯数字/);
});

test('rejects a missing identity code or developer credentials before starting', async () => {
  const client = new BilibiliLiveClient({ appId: '', accessKey: '', accessSecret: '' });
  await assert.rejects(client.start(''), /身份码/);
  await assert.rejects(client.start('anchor-code'), /请先填写并保存/);
  assert.equal(client.gameId, '');
});

test('reports malformed HTTP responses and Bilibili API errors', async () => {
  const originalFetch = globalThis.fetch;
  const client = new BilibiliLiveClient({ appId: '123', accessKey: 'key', accessSecret: 'secret' });
  try {
    globalThis.fetch = async () => ({ status: 502, text: async () => '<html>gateway error</html>' });
    await assert.rejects(client.request('/v2/app/start', '{}'), /非 JSON 内容（HTTP 502）/);
    globalThis.fetch = async () => ({ status: 200,
      text: async () => JSON.stringify({ code: 7001, message: '身份码无效' }) });
    await assert.rejects(client.request('/v2/app/start', '{}'), (error) =>
      error.code === 7001 && /身份码无效/.test(error.message));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('ends a started Bilibili session if the websocket cannot connect', async () => {
  const client = new BilibiliLiveClient({ appId: '123', accessKey: 'key', accessSecret: 'secret' });
  const calls = [];
  client.request = async (route) => {
    calls.push(route);
    if (route === '/v2/app/start') return {
      game_info: { game_id: 'game-1' },
      websocket_info: { auth_body: '{}', wss_link: ['wss://example.test'] },
    };
    return {};
  };
  client.connectSocket = async () => { throw new Error('长连接失败'); };
  await assert.rejects(client.start('anchor-code'), /长连接失败/);
  assert.deepEqual(calls, ['/v2/app/start', '/v2/app/end']);
  assert.equal(client.gameId, '');
  assert.equal(client.appHeartbeat, null);
});

test('retains a started game id if cleanup fails after websocket connection failure', async () => {
  const client = new BilibiliLiveClient({ appId: '123', accessKey: 'key', accessSecret: 'secret' });
  client.request = async (route) => {
    if (route === '/v2/app/start') return {
      game_info: { game_id: 'game-needs-cleanup' },
      websocket_info: { auth_body: '{}', wss_link: ['wss://example.test'] },
    };
    throw new Error('end endpoint offline');
  };
  client.connectSocket = async () => { throw new Error('websocket unavailable'); };
  await assert.rejects(client.start('anchor-code'), /websocket unavailable/);
  assert.equal(client.gameId, 'game-needs-cleanup');
  assert.equal(client.closedByUser, true);
  assert.equal(client.appHeartbeat, null);
});

test('rejects websocket authentication errors immediately without scheduling reconnect', async () => {
  const originalWebSocket = globalThis.WebSocket;
  let socket;
  class FakeWebSocket {
    constructor() { this.listeners = new Map(); socket = this; }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    send() {}
    close() { this.listeners.get('close')?.({ code: 1000 }); }
    fire(name, event) { this.listeners.get(name)?.(event); }
  }
  globalThis.WebSocket = FakeWebSocket;
  try {
    const client = new BilibiliLiveClient({ appId: '123', accessKey: 'key', accessSecret: 'secret' });
    client.gameId = 'game-1';
    client.websocketInfo = { auth_body: '{}', wss_link: ['wss://example.test'] };
    const connecting = client.openSocket('wss://example.test');
    socket.fire('open', {});
    socket.fire('message', { data: encodePacket(Operation.AUTH_REPLY, JSON.stringify({ code: 1 })) });
    await assert.rejects(connecting, /鉴权失败：1/);
    assert.equal(client.reconnectTimer, null);
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});

test('a late websocket authentication cannot reconnect after the user stops', async () => {
  const originalWebSocket = globalThis.WebSocket;
  let socket;
  class FakeWebSocket {
    constructor() { this.listeners = new Map(); socket = this; }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    send() {}
    close() { this.listeners.get('close')?.({ code: 1000 }); }
    fire(name, event) { this.listeners.get(name)?.(event); }
  }
  globalThis.WebSocket = FakeWebSocket;
  const client = new BilibiliLiveClient({ appId: '123', accessKey: 'key', accessSecret: 'secret' });
  try {
    client.gameId = 'game-1';
    client.websocketInfo = { auth_body: '{}', wss_link: ['wss://example.test'] };
    client.request = async () => ({});
    const statuses = [];
    client.on('state', ({ status }) => statuses.push(status));
    const connecting = client.openSocket('wss://example.test');
    await client.stop();
    socket.fire('open', {});
    socket.fire('message', { data: encodePacket(Operation.AUTH_REPLY, JSON.stringify({ code: 0 })) });
    const outcome = await connecting.then(() => 'connected', () => 'canceled');
    assert.equal(outcome, 'canceled');
    assert.deepEqual(statuses, ['disconnected']);
    assert.equal(client.socket, null);
    assert.equal(client.socketHeartbeat, null);
    assert.equal(client.reconnectTimer, null);
  } finally {
    client.handleInteractionEnd();
    globalThis.WebSocket = originalWebSocket;
  }
});

test('stopping during the first websocket attempt does not try another node', async () => {
  const originalWebSocket = globalThis.WebSocket;
  const sockets = [];
  class FakeWebSocket {
    constructor(url) { this.url = url; this.listeners = new Map(); sockets.push(this); }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    close() { this.listeners.get('close')?.({ code: 1000 }); }
  }
  globalThis.WebSocket = FakeWebSocket;
  const client = new BilibiliLiveClient({ appId: '123', accessKey: 'key', accessSecret: 'secret' });
  try {
    client.gameId = 'game-1';
    client.websocketInfo = { auth_body: '{}', wss_link: ['wss://first.test', 'wss://second.test'] };
    client.request = async () => ({});
    const connecting = client.connectSocket();
    await client.stop();
    await assert.rejects(connecting, /结束/);
    assert.deepEqual(sockets.map((socket) => socket.url), ['wss://first.test']);
    assert.equal(client.socket, null);
    assert.equal(client.reconnectTimer, null);
  } finally {
    client.handleInteractionEnd();
    globalThis.WebSocket = originalWebSocket;
  }
});

test('stops heartbeats and reconnecting after Bilibili ends the interaction', async () => {
  const originalWebSocket = globalThis.WebSocket;
  let socket;
  class FakeWebSocket {
    constructor() { this.listeners = new Map(); this.closeCount = 0; socket = this; }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    send() {}
    close() { this.closeCount += 1; this.listeners.get('close')?.({ code: 1000 }); }
    fire(name, event) { this.listeners.get(name)?.(event); }
  }
  globalThis.WebSocket = FakeWebSocket;
  const client = new BilibiliLiveClient({ appId: '123', accessKey: 'key', accessSecret: 'secret' });
  try {
    client.gameId = 'game-1';
    client.websocketInfo = { auth_body: '{}', wss_link: ['wss://example.test'] };
    const states = [];
    client.on('state', ({ status }) => states.push(status));
    const connecting = client.openSocket('wss://example.test');
    socket.fire('open', {});
    socket.fire('message', { data: encodePacket(Operation.AUTH_REPLY, JSON.stringify({ code: 0 })) });
    await connecting;
    client.startAppHeartbeat();
    socket.fire('message', { data: encodePacket(Operation.MESSAGE,
      JSON.stringify({ cmd: 'LIVE_OPEN_PLATFORM_INTERACTION_END' })) });
    assert.deepEqual(states, ['connected', 'ended']);
    assert.equal(client.gameId, '');
    assert.equal(client.socket, null);
    assert.equal(client.socketHeartbeat, null);
    assert.equal(client.appHeartbeat, null);
    assert.equal(client.reconnectTimer, null);
    assert.equal(socket.closeCount, 1);
  } finally {
    client.handleInteractionEnd();
    globalThis.WebSocket = originalWebSocket;
  }
});

test('does not report a successful connection if the interaction ends during authentication', async () => {
  const client = new BilibiliLiveClient({ appId: '123', accessKey: 'key', accessSecret: 'secret' });
  client.request = async (route) => {
    if (route === '/v2/app/start') return {
      game_info: { game_id: 'game-1' },
      websocket_info: { auth_body: '{}', wss_link: ['wss://example.test'] },
    };
    throw new Error(`unexpected request: ${route}`);
  };
  client.connectSocket = async () => client.handleInteractionEnd();
  await assert.rejects(client.start('anchor-code'), /连接期间已结束/);
  assert.equal(client.gameId, '');
  assert.equal(client.appHeartbeat, null);
});

test('starts a normal live session, forwards danmaku, and ends it cleanly', async () => {
  const originalWebSocket = globalThis.WebSocket;
  let socket;
  class FakeWebSocket {
    constructor() { this.listeners = new Map(); socket = this; }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    send(packet) { this.sent = packet; }
    close() { this.listeners.get('close')?.({ code: 1000 }); }
    fire(name, event) { this.listeners.get(name)?.(event); }
  }
  globalThis.WebSocket = FakeWebSocket;
  const client = new BilibiliLiveClient({ appId: '123', accessKey: 'key', accessSecret: 'secret' });
  const routes = [];
  const messages = [];
  client.on('message', (message) => messages.push(message));
  client.request = async (route) => {
    routes.push(route);
    if (route === '/v2/app/start') return {
      game_info: { game_id: 'game-1' },
      websocket_info: { auth_body: '{"token":"test"}', wss_link: ['wss://example.test'] },
      anchor_info: { uname: '测试主播' },
    };
    return {};
  };
  try {
    const starting = client.start('anchor-code');
    for (let retry = 0; retry < 20 && !socket; retry += 1) await Promise.resolve();
    assert.ok(socket, 'did not create websocket');
    socket.fire('open', {});
    assert.equal(socket.sent.readUInt32BE(8), Operation.AUTH);
    socket.fire('message', { data: encodePacket(Operation.AUTH_REPLY, JSON.stringify({ code: 0 })) });
    const started = await starting;
    assert.equal(started.gameId, 'game-1');
    assert.equal(started.anchorInfo.uname, '测试主播');
    socket.fire('message', { data: encodePacket(Operation.MESSAGE,
      JSON.stringify({ cmd: 'LIVE_OPEN_PLATFORM_DM', data: { msg: '#01 8.5', open_id: 'viewer-1' } })) });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].data.open_id, 'viewer-1');
    await client.stop();
    assert.deepEqual(routes, ['/v2/app/start', '/v2/app/end']);
    assert.equal(client.socket, null);
    assert.equal(client.appHeartbeat, null);
    assert.equal(client.socketHeartbeat, null);
    assert.equal(client.reconnectTimer, null);
  } finally {
    client.handleInteractionEnd();
    globalThis.WebSocket = originalWebSocket;
  }
});

test('keeps the game id and allows retry when ending the session fails', async () => {
  const client = new BilibiliLiveClient({ appId: '123', accessKey: 'key', accessSecret: 'secret' });
  client.gameId = 'game-retry';
  const states = [];
  client.on('state', (state) => states.push(state));
  let attempts = 0;
  client.request = async (route) => {
    assert.equal(route, '/v2/app/end');
    attempts += 1;
    if (attempts === 1) throw new Error('network offline');
    return {};
  };
  await assert.rejects(client.stop(), /network offline/);
  assert.equal(client.gameId, 'game-retry');
  assert.equal(states.at(-1).status, 'error');
  assert.equal(states.at(-1).gameId, 'game-retry');
  await client.stop();
  assert.equal(attempts, 2);
  assert.equal(client.gameId, '');
  assert.equal(states.at(-1).status, 'disconnected');
});
