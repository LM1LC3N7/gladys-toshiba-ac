// -----------------------------------------------------------------------------
// The REST client, against a fake Toshiba API (test/helpers/fakeToshiba.js),
// and its node:http(s) transport against a loopback server.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createFakeToshiba } from './helpers/fakeToshiba.js';
import { PASSWORD, UNITS, USERNAME, sasToken } from './fixtures/units.js';
import {
  ToshibaAuthError,
  ToshibaClient,
  ToshibaConnectionError,
  ToshibaError,
  ToshibaRateLimited,
  USER_AGENT,
  httpTransport,
  retryAfterOf,
} from '../src/toshiba.js';

const INSTALL_ID = '0123456789abcdef';

function client(api, options = {}) {
  const sessions = [];
  let now = Date.UTC(2026, 9, 15, 12);
  const c = new ToshibaClient({
    username: USERNAME,
    password: PASSWORD,
    installId: INSTALL_ID,
    transport: api.transport,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    random: () => 0,
    onSession: (s) => sessions.push(s),
    ...options,
  });
  return { c, sessions, advance: (ms) => (now += ms) };
}

test('logs in, then sends the token, the app User-Agent and the Device-ID', async () => {
  const api = createFakeToshiba();
  const { c, sessions } = client(api);
  const units = await c.listUnits();
  assert.equal(units.length, 3);
  const [login, list] = api.requests;
  assert.equal(login.path, '/api/Consumer/Login');
  assert.deepEqual(login.body, { Username: USERNAME, Password: PASSWORD });
  assert.equal(login.headers.Authorization, undefined);
  assert.equal(list.headers.Authorization, 'Bearer token-1');
  assert.deepEqual(list.query, { consumerId: 'consumer-42' });
  for (const r of api.requests) {
    assert.equal(r.headers['User-Agent'], USER_AGENT);
    assert.equal(r.headers['Device-ID'], INSTALL_ID);
    assert.equal(r.headers['Content-Type'], 'application/json');
    assert.deepEqual(
      Object.keys(r.headers).filter((h) => /^sec-|^origin$|^referer$/i.test(h)),
      [],
      'no browser header',
    );
  }
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].token, 'token-1');
  assert.equal(sessions[0].consumerId, 'consumer-42');
  assert.equal(sessions[0].expiresAt, Date.UTC(2026, 9, 15, 12) + 94607999 * 1000);
});

test('the units of every group, flattened, with their fields', async () => {
  const api = createFakeToshiba();
  api.groups.push({
    GroupName: 'Garage',
    ACList: [{ ...UNITS.living }, { Id: 'x', DeviceUniqueId: '' }],
  });
  const { c } = client(api);
  const units = await c.listUnits();
  assert.deepEqual(
    units.map((u) => u.uniqueId),
    [UNITS.living.DeviceUniqueId, UNITS.bedroom.DeviceUniqueId, UNITS.office.DeviceUniqueId],
    'duplicates and units without id are dropped',
  );
  assert.deepEqual(units[0], {
    id: UNITS.living.Id,
    uniqueId: UNITS.living.DeviceUniqueId,
    name: 'Salon',
    state: UNITS.living.ACStateData,
    firmware: '02.04.28',
    merit: 'fc03',
    model: '3',
    group: 'Maison',
  });
});

test('a kept session is used without logging in', async () => {
  const api = createFakeToshiba();
  api.valid.add('kept-token');
  const { c, sessions } = client(api, {
    session: { type: 'Bearer', token: 'kept-token', consumerId: 'consumer-42', expiresAt: null },
  });
  await c.listUnits();
  assert.deepEqual(
    api.requests.map((r) => r.path),
    ['/api/AC/GetConsumerACMapping'],
  );
  assert.equal(sessions.length, 0);
});

test('an expired kept session, or a refused token, logs in again once', async () => {
  const api = createFakeToshiba();
  const { c } = client(api, {
    session: { type: 'Bearer', token: 'old', consumerId: 'consumer-42', expiresAt: 1 },
  });
  await c.listUnits();
  assert.equal(api.counts()['/api/Consumer/Login'], 1, 'expired: login first');

  api.expireTokens();
  await c.listUnits();
  assert.equal(api.counts()['/api/Consumer/Login'], 2, '401: login again');
  assert.equal(api.counts()['/api/AC/GetConsumerACMapping'], 3, 'and the call again');

  api.next.push(
    () => ({ status: 401, headers: {}, body: '' }),
    undefined,
    () => ({ status: 401, headers: {}, body: '' }),
  );
  await assert.rejects(c.listUnits(), (err) => {
    assert.ok(err instanceof ToshibaError && !(err instanceof ToshibaAuthError));
    assert.match(err.message, /access refused/);
    return true;
  });
});

test('refused credentials are an auth error, never retried', async () => {
  const api = createFakeToshiba({ password: 'other' });
  const { c } = client(api);
  await assert.rejects(c.listUnits(), ToshibaAuthError);
  assert.equal(api.requests.length, 1);
});

test('403 and 429 are a rate limit, with Retry-After', async () => {
  const api = createFakeToshiba();
  const { c } = client(api);
  api.next.push(() => ({ status: 429, headers: { 'retry-after': '120' }, body: '{}' }));
  await assert.rejects(c.listUnits(), (err) => {
    assert.ok(err instanceof ToshibaRateLimited);
    assert.equal(err.retryAfter, 120_000);
    return true;
  });
  api.next.push(403);
  await assert.rejects(
    c.listUnits(),
    (err) => err instanceof ToshibaRateLimited && err.retryAfter === null,
  );
});

test('the browser User-Agent of the library is what the firewall refuses', async () => {
  const api = createFakeToshiba();
  const transport = (req) =>
    api.transport({ ...req, headers: { ...req.headers, 'User-Agent': 'Mozilla/5.0 Chrome/131' } });
  const { c } = client(api, { transport });
  await assert.rejects(c.listUnits(), ToshibaRateLimited);
});

test('errors carry no secret', async () => {
  const api = createFakeToshiba();
  const { c } = client(api);
  api.next.push(500);
  await assert.rejects(c.listUnits(), (err) => {
    assert.match(err.message, /HTTP 500/);
    return !err.message.includes(PASSWORD);
  });
  api.next.push(() => ({ status: 200, headers: {}, body: '<html>maintenance</html>' }));
  await assert.rejects(c.listUnits(), /not a JSON answer/);
  api.next.push(() => ({
    status: 200,
    headers: {},
    body: JSON.stringify({ IsSuccess: false, Message: 'Something broke' }),
  }));
  await assert.rejects(c.listUnits(), /Something broke/);
  api.down = new ToshibaConnectionError('mobileapi.toshibahomeaccontrols.com: ENOTFOUND');
  await assert.rejects(c.listUnits(), ToshibaConnectionError);
});

test('RegisterMobileDevice registers <user>_<install id> and returns the SAS token', async () => {
  const api = createFakeToshiba();
  const { c } = client(api);
  assert.equal(c.mobileDeviceId, `${USERNAME}_${INSTALL_ID}`);
  assert.equal(await c.registerMobileDevice(), sasToken());
  const register = api.requests.find((r) => r.path === '/api/Consumer/RegisterMobileDevice');
  assert.equal(register.method, 'POST');
  assert.deepEqual(register.body, {
    DeviceID: `${USERNAME}_${INSTALL_ID}`,
    DeviceType: '1',
    Username: USERNAME,
  });
  api.next.push(() => ({
    status: 200,
    headers: {},
    body: JSON.stringify({ IsSuccess: true, ResObj: {} }),
  }));
  await assert.rejects(c.registerMobileDevice(), /no SAS token/);
});

test('the state of a unit and the model names', async () => {
  const api = createFakeToshiba();
  const { c } = client(api);
  const state = await c.unitState(UNITS.bedroom.Id);
  assert.deepEqual(state, {
    state: UNITS.bedroom.ACStateData,
    indoorModel: 'RAS-B10N4KVRG-E',
    outdoorModel: 'RAS-10N4AVRG-E',
  });
  const request = api.requests.at(-1);
  assert.deepEqual(request.query, { ACId: UNITS.bedroom.Id, consumerId: 'consumer-42' });
});

test('the energy of the year, summed per unit', async () => {
  const api = createFakeToshiba();
  const { c } = client(api);
  const energy = await c.energyThisYear([UNITS.living.DeviceUniqueId]);
  assert.deepEqual([...energy], [[UNITS.living.DeviceUniqueId, 134500]]);
  const request = api.requests.at(-1);
  assert.deepEqual(request.body, {
    ACDeviceUniqueIdList: [UNITS.living.DeviceUniqueId],
    FromUtcTime: '2026',
    Timezone: 'UTC',
    ToUtcTime: '2027',
    Type: 'EnergyYear',
  });
  api.energy = [
    { ACDeviceUniqueId: 'a', EnergyConsumption: [{ Energy: 'n/a' }] },
    { ACDeviceUniqueId: 'b', EnergyConsumption: [] },
    { ACDeviceUniqueId: 'c', EnergyConsumption: [{ Energy: 12.5 }] },
  ];
  assert.deepEqual([...(await c.energyThisYear(['a', 'b', 'c']))], [['c', 12.5]]);
});

test('requests are spaced like the library (150 ms + jitter)', async () => {
  const api = createFakeToshiba();
  const times = [];
  let now = 0;
  const transport = async (req) => {
    times.push(now);
    return api.transport(req);
  };
  const c = new ToshibaClient({
    username: USERNAME,
    password: PASSWORD,
    installId: INSTALL_ID,
    transport,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    random: () => 1,
  });
  await Promise.all([c.listUnits(), c.unitState(UNITS.living.Id)]);
  assert.deepEqual(times, [0, 400, 800], 'one login shared by both calls, then the calls');
  assert.equal(api.counts()['/api/Consumer/Login'], 1);
});

test('Retry-After in seconds or as a date', () => {
  assert.equal(retryAfterOf('30'), 30_000);
  assert.equal(retryAfterOf('Thu, 15 Oct 2026 12:01:00 GMT', Date.UTC(2026, 9, 15, 12)), 60_000);
  assert.equal(retryAfterOf(''), null);
  assert.equal(retryAfterOf(undefined), null);
  assert.equal(retryAfterOf('soon'), null);
});

// --- The node:http(s) transport, on the loopback -------------------------------

async function loopback(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/x?a=1`;
  return { url, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('the transport sends only the headers it is given', async () => {
  let seen;
  const server = await loopback((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen = { method: req.method, url: req.url, headers: req.headers, body };
      res.setHeader('Retry-After', '5');
      res.end('{"ok":true}');
    });
  });
  try {
    const answer = await httpTransport({
      method: 'POST',
      url: server.url,
      headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/json' },
      body: '{"a":"é"}',
      timeout: 2000,
      limit: 1000,
    });
    assert.equal(answer.status, 200);
    assert.equal(answer.body, '{"ok":true}');
    assert.equal(answer.headers['retry-after'], '5');
    assert.equal(seen.method, 'POST');
    assert.equal(seen.url, '/api/x?a=1');
    assert.equal(seen.body, '{"a":"é"}');
    assert.deepEqual(Object.keys(seen.headers).sort(), [
      'connection',
      'content-length',
      'content-type',
      'host',
      'user-agent',
    ]);
    assert.equal(seen.headers['content-length'], String(Buffer.byteLength('{"a":"é"}')));
  } finally {
    await server.close();
  }
});

test('the transport refuses a too big answer and settles once', async () => {
  const server = await loopback((req, res) => {
    res.write('x'.repeat(600));
    res.write('x'.repeat(600));
    res.end();
  });
  try {
    await assert.rejects(
      httpTransport({ method: 'GET', url: server.url, headers: {}, timeout: 2000, limit: 1000 }),
      /answer too big/,
    );
  } finally {
    await server.close();
  }
});

test('the transport gives up after its timeout', async () => {
  const server = await loopback(() => {
    // never answers
  });
  try {
    await assert.rejects(
      httpTransport({ method: 'GET', url: server.url, headers: {}, timeout: 100, limit: 1000 }),
      (err) => err instanceof ToshibaConnectionError && /timeout/.test(err.message),
    );
  } finally {
    await server.close();
  }
});

test('the transport reports a refused connection', async () => {
  const server = await loopback(() => {});
  const { url } = server;
  await server.close();
  await assert.rejects(
    httpTransport({ method: 'GET', url, headers: {}, timeout: 1000, limit: 1000 }),
    (err) => err instanceof ToshibaConnectionError && /ECONNREFUSED/.test(err.message),
  );
});
