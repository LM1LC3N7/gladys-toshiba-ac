// -----------------------------------------------------------------------------
// The whole integration, wired like the container (src/handlers.js): the SDK's
// fake Gladys, a fake Toshiba REST API, a fake IoT Hub on the loopback with
// the real `mqtt` client, the storage on an in-memory fs and timers run by
// hand. No network.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { ToshibaApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { IotHubLink } from '../src/iothub.js';
import { Storage } from '../src/storage.js';
import { ToshibaClient } from '../src/toshiba.js';
import { AC_MODE } from '../src/constants.js';
import { PASSWORD, STATE, UNITS, USERNAME, sasToken } from './fixtures/units.js';
import { startFakeIotHub, until } from './helpers/fakeIotHub.js';
import { createFakeToshiba, createManualTimers, createMemoryFs } from './helpers/fakeToshiba.js';

const silent = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
const INSTALL = '0123456789abcdef';
const MOBILE_ID = `${USERNAME}_${INSTALL}`;
const CONFIG = { username: USERNAME, password: PASSWORD, language: 'en' };

async function setup(
  t,
  { api = createFakeToshiba(), fs = createMemoryFs(), config = CONFIG } = {},
) {
  const hub = await startFakeIotHub();
  const timers = createManualTimers();
  const gladys = createFakeGladys({ config });
  const storage = new Storage({ fs, randomBytes: () => Buffer.from(INSTALL, 'hex') });
  const app = new ToshibaApp({
    gladys,
    logger: silent,
    storage,
    timers,
    createClient: (options) =>
      new ToshibaClient({
        ...options,
        transport: api.transport,
        sleep: async () => {},
        random: () => 0,
      }),
    createLink: (options) => new IotHubLink({ ...options, url: hub.url }),
  });
  registerHandlers(gladys, app, silent);
  t.after(async () => {
    app.stop();
    await hub.close();
  });
  return { app, gladys, api, hub, fs, timers, storage };
}

const deviceOf = (gladys, ac) =>
  gladys.fake.discoveredDevices.find((d) =>
    d.external_id.endsWith(ac.DeviceUniqueId.toLowerCase()),
  );
const featureOf = (device, key) => device.features.find((f) => f.external_id.endsWith(`:${key}`));

/** The unit report the hub relays, as the library receives it. */
const report = (ac, cmd, payload) => ({
  sourceId: ac.DeviceUniqueId,
  messageId: '0000001',
  targetId: [MOBILE_ID],
  cmd,
  payload,
  timeStamp: '0000000',
});

test('start: login, units in Discovery, live link up', async (t) => {
  const { gladys, api, hub, fs } = await setup(t);
  await gladys.connect();
  assert.equal(gladys.fake.discoveredDevices.length, 3);
  assert.deepEqual(
    gladys.fake.discoveredDevices.map((d) => d.name),
    ['Salon', 'Chambre', 'Bureau'],
  );
  assert.deepEqual(api.counts(), {
    '/api/Consumer/Login': 1,
    '/api/AC/GetConsumerACMapping': 1,
    '/api/Consumer/RegisterMobileDevice': 1,
  });
  assert.equal(hub.connects.length, 1);
  assert.equal(hub.connects[0].clientId, MOBILE_ID);
  assert.equal(hub.connects[0].password, sasToken());
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(gladys.fake.connectionStatus.message.en, /3 air conditioners, live link up/);
  assert.match(gladys.fake.connectionStatus.message.fr, /3 climatiseurs/);
  const kept = JSON.parse(fs.files['/data/toshiba-ac.json']);
  assert.equal(kept.install_id, INSTALL);
  assert.equal(kept.session.token, 'token-1');
  assert.equal(kept.sas.token, sasToken());
  assert.ok(!fs.files['/data/toshiba-ac.json'].includes(PASSWORD), 'never the password');
  assert.deepEqual(gladys.fake.states, [], 'no state for devices not created yet');
});

test('a created device gets its states, then the live reports', async (t) => {
  const { app, gladys, hub } = await setup(t);
  await gladys.connect();
  const living = deviceOf(gladys, UNITS.living);
  await gladys.fake.deviceCreated(living);
  const id = living.external_id;
  assert.equal(gladys.fake.lastState(`${id}:binary`), 1);
  assert.equal(gladys.fake.lastState(`${id}:mode`), AC_MODE.COOLING);
  assert.equal(gladys.fake.lastState(`${id}:target-temperature`), 22);
  assert.equal(gladys.fake.lastState(`${id}:power-selection`), '100');
  assert.equal(gladys.fake.lastState(`${id}:outdoor-temperature`), 30);
  assert.deepEqual(gladys.fake.transports.at(-1), { device_external_id: id, transport: 'cloud' });

  hub.callMethod(
    'smmobile',
    report(UNITS.living, 'CMD_FCU_FROM_AC', { data: STATE.partial_temperature }),
  );
  hub.callMethod('smmobile', report(UNITS.living, 'CMD_HEARTBEAT', { iTemp: '14', oTemp: 'fb' }));
  hub.callMethod('smmobile', report(UNITS.living, 'CMD_FCU_FROM_AC', { data: STATE.eco_silent }));
  hub.callMethod(
    'smmobile',
    report({ DeviceUniqueId: 'someone-else' }, 'CMD_HEARTBEAT', { iTemp: '14' }),
  );
  await until(() => hub.methodResponses.length === 4, 'the reports');
  await app.publisher.flush();
  assert.equal(gladys.fake.lastState(`${id}:indoor-temperature`), 25, 'heartbeat, then the state');
  assert.equal(gladys.fake.lastState(`${id}:outdoor-temperature`), -20);
  assert.equal(gladys.fake.lastState(`${id}:target-temperature`), 26);
  assert.equal(gladys.fake.lastState(`${id}:special-mode`), 'eco');
  assert.equal(gladys.fake.lastState(`${id}:swing-vertical`), 5, 'louver position 4');

  // The other units were not created: nothing published for them.
  const bedroom = deviceOf(gladys, UNITS.bedroom);
  assert.ok(
    !gladys.fake.states.some((s) => s.device_feature_external_id.startsWith(bedroom.external_id)),
  );
});

test('a command goes to the hub as the library sends it', async (t) => {
  const { gladys, hub } = await setup(t);
  await gladys.connect();
  const living = deviceOf(gladys, UNITS.living);
  await gladys.fake.deviceCreated(living);
  const ack = await gladys.fake.setValue(living, featureOf(living, 'mode'), AC_MODE.HEATING);
  assert.deepEqual(ack, { success: true });
  assert.equal(hub.events.length, 1);
  assert.equal(
    hub.events[0].payload,
    `{'sourceId': '${MOBILE_ID}', 'messageId': '0000000', 'targetId': ['${UNITS.living.DeviceUniqueId}'], ` +
      `'cmd': 'CMD_FCU_TO_AC', 'payload': {'data': 'ff43ffffffffffffffffffffffffffffffffff'}, 'timeStamp': '0000000'}`,
  );
  assert.match(hub.events[0].topic, /\/messages\/events\/.*type=mob$/);

  await gladys.fake.setValue(living, featureOf(living, 'special-mode'), 'silent-2');
  assert.match(hub.events[1].payload, /'data': 'fffffffffffffaffffffffffffffffffffffff'/);

  const refused = await gladys.fake.setValue(living, featureOf(living, 'target-temperature'), 35);
  assert.equal(refused.success, false);
  assert.match(refused.error, /between 17 and 30/);
  const unknown = await gladys.fake.setValue(living, { external_id: 'ext:x:ac:nope:mode' }, 1);
  assert.match(unknown.error, /unknown Toshiba feature/);
  assert.equal(hub.events.length, 2, 'nothing sent for refused commands');
});

test('the session and the SAS token are kept: a restart neither logs in nor registers', async (t) => {
  const api = createFakeToshiba();
  const fs = createMemoryFs();
  const first = await setup(t, { api, fs });
  await first.gladys.connect();
  first.app.stop();
  const second = await setup(t, { api, fs });
  await second.gladys.connect();
  assert.deepEqual(api.counts(), {
    '/api/Consumer/Login': 1,
    '/api/AC/GetConsumerACMapping': 2,
    '/api/Consumer/RegisterMobileDevice': 1,
  });
  assert.equal(second.gladys.fake.connectionStatus.connected, true);

  // Another password: the kept session is not used.
  const api2 = createFakeToshiba({ password: 'new-password' });
  const third = await setup(t, { api: api2, fs, config: { ...CONFIG, password: 'new-password' } });
  await third.gladys.connect();
  assert.equal(api2.counts()['/api/Consumer/Login'], 1);
});

test('a refused SAS token is registered again, once', async (t) => {
  const fs = createMemoryFs({
    '/data/toshiba-ac.json': JSON.stringify({
      install_id: INSTALL,
      sas: { user: USERNAME, token: sasToken(MOBILE_ID, 4102444000) },
    }),
  });
  const { gladys, api, hub } = await setup(t, { fs });
  hub.accept = (connect) => (connect.password === sasToken() ? true : 5);
  await gladys.connect();
  assert.equal(api.counts()['/api/Consumer/RegisterMobileDevice'], 1);
  assert.equal(hub.connects.length, 2);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(JSON.parse(fs.files['/data/toshiba-ac.json']).sas.token, sasToken());
});

test('refused even with a new SAS token: status, degraded badge, retry later', async (t) => {
  const { app, gladys, api, hub, timers } = await setup(t);
  hub.accept = () => 5;
  await gladys.connect();
  assert.equal(
    api.counts()['/api/Consumer/RegisterMobileDevice'],
    1,
    'fresh token: no second registration',
  );
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(
    gladys.fake.connectionStatus.message.en,
    /refused the live link even with a new token/,
  );
  assert.ok(timers.delays().includes(5 * 60_000), 'next attempt in 5 minutes');
  const living = deviceOf(gladys, UNITS.living);
  await gladys.fake.deviceCreated(living);
  assert.deepEqual(gladys.fake.transports.at(-1), {
    device_external_id: living.external_id,
    transport: 'cloud',
    degraded: true,
    message: {
      en: 'Live link down: no commands, states every 5 min',
      fr: 'Liaison temps réel coupée : pas de commande, états toutes les 5 min',
    },
  });
  const ack = await gladys.fake.setValue(living, featureOf(living, 'binary'), 0);
  assert.match(ack.error, /live link to Toshiba is down/);

  hub.accept = () => true;
  await timers.fire((delay) => delay === 5 * 60_000);
  await until(() => app.liveUp, 'the live link');
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.deepEqual(gladys.fake.transports.at(-1), {
    device_external_id: living.external_id,
    transport: 'cloud',
  });
});

test('a lost live link: degraded, reconnected, and the states read again', async (t) => {
  const { app, gladys, api, hub, timers } = await setup(t);
  await gladys.connect();
  const living = deviceOf(gladys, UNITS.living);
  await gladys.fake.deviceCreated(living);
  hub.dropClients();
  await until(() => gladys.fake.connectionStatus.connected === false, 'the lost link');
  assert.match(gladys.fake.connectionStatus.message.en, /live link to Toshiba is down.*5 s/);
  assert.equal(gladys.fake.transports.at(-1).degraded, true);
  assert.ok(timers.delays().includes(5000), 'reconnection in 5 s');
  assert.ok(timers.delays().includes(5 * 60_000), 'states read every 5 minutes meanwhile');

  // The unit changed while the link was down.
  api.groups[0].ACList[0].ACStateData = STATE.heat_off;
  await timers.fire((delay) => delay === 5000);
  await until(() => app.liveUp, 'the live link');
  assert.equal(hub.connects.length, 2);
  assert.equal(api.counts()['/api/Consumer/RegisterMobileDevice'], 1, 'the kept token');
  await timers.fire((delay) => delay === 0);
  await until(() => api.counts()['/api/AC/GetCurrentACState'] === 3, 'the catch-up reads');
  await app.publisher.flush();
  assert.equal(gladys.fake.lastState(`${living.external_id}:mode`), AC_MODE.HEATING);
  assert.equal(gladys.fake.lastState(`${living.external_id}:binary`), 0);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.ok(timers.delays().includes(30 * 60_000), 'back to a read every 30 minutes');
});

test('refused credentials: said, and never retried on its own', async (t) => {
  const api = createFakeToshiba({ password: 'the-right-one' });
  const { gladys, timers } = await setup(t, { api });
  await gladys.connect();
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /refused the user name or the password/);
  assert.deepEqual(timers.delays(), [], 'no retry');
  assert.equal(api.requests.length, 1);

  const test1 = await gladys.fake.action('test_connection', {});
  assert.match(test1.data.message.en, /refused the user name or the password/);

  await gladys.fake.configUpdated({ ...CONFIG, password: 'the-right-one' });
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('a rate limit waits what Toshiba asks, then tries again', async (t) => {
  const api = createFakeToshiba();
  api.next.push(() => ({ status: 429, headers: { 'retry-after': '1800' }, body: '{}' }));
  const { app, gladys, timers } = await setup(t, { api });
  await gladys.connect();
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /slowing this connection down.*30 min/);
  assert.ok(timers.delays().includes(1800_000));
  await timers.fire((delay) => delay === 1800_000);
  await until(() => app.liveUp, 'the live link');
  assert.equal(gladys.fake.discoveredDevices.length, 3);
});

test('an unreachable API is retried with a growing delay', async (t) => {
  const api = createFakeToshiba();
  api.down = Object.assign(new Error('mobileapi.toshibahomeaccontrols.com: ENOTFOUND'));
  const { app, gladys, timers } = await setup(t, { api });
  await gladys.connect();
  assert.match(gladys.fake.connectionStatus.message.en, /unreachable \(.*ENOTFOUND\).*5 s/);
  await timers.fire();
  assert.match(gladys.fake.connectionStatus.message.en, /10 s/);
  api.down = null;
  await timers.fire((delay) => delay === 10_000);
  await until(() => app.liveUp, 'the live link');
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('the energy of the units that report it', async (t) => {
  const { app, gladys, api, timers } = await setup(t);
  await gladys.connect();
  const living = deviceOf(gladys, UNITS.living);
  await gladys.fake.deviceCreated(living);
  assert.ok(featureOf(living, 'energy'));
  assert.equal(featureOf(deviceOf(gladys, UNITS.bedroom), 'energy'), undefined);
  await timers.fire((delay) => delay === 0);
  await app.publisher.flush();
  const request = api.requests.find((r) => r.path === '/api/AC/GetGroupACEnergyConsumption');
  assert.deepEqual(request.body.ACDeviceUniqueIdList, [UNITS.living.DeviceUniqueId]);
  assert.equal(gladys.fake.lastState(`${living.external_id}:energy`), 134.5);
  assert.ok(timers.delays().includes(30 * 60_000));

  // A failed reading waits for the next one, nothing else is retried.
  api.failing['/api/AC/GetGroupACEnergyConsumption'] = 429;
  const before = api.requests.length;
  await timers.fire((delay) => delay === 30 * 60_000);
  await until(
    () => timers.delays().filter((d) => d === 30 * 60_000).length === 2,
    'the next energy reading and state reload',
  );
  assert.equal(api.requests.length, before + 4, 'the energy, and the 3 states of the reload');
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.ok(!timers.delays().some((d) => d > 30 * 60_000), 'no rate-limit wait');
});

test('values the library does not know are read as missing and logged once', async (t) => {
  const { app, gladys, hub } = await setup(t);
  const warnings = [];
  app.logger = { ...silent, warn: (m) => warnings.push(m) };
  await gladys.connect();
  const living = deviceOf(gladys, UNITS.living);
  await gladys.fake.deviceCreated(living);
  for (const rid of ['1', '2']) {
    // The second report changes the setpoint, the fan value stays unknown.
    const data = rid === '1' ? STATE.unknown_fan : STATE.unknown_fan.replace(/^(.{4})16/, '$117');
    hub.callMethod('smmobile', report(UNITS.living, 'CMD_FCU_FROM_AC', { data }), rid);
  }
  hub.callMethod('smmobile', report(UNITS.living, 'CMD_FCU_FROM_AC', { data: 'zz' }), '3');
  await until(() => hub.methodResponses.length === 3, 'the reports');
  assert.deepEqual(warnings, [
    '"Salon": unknown fanMode value 0x77',
    '"Salon": unreadable live state',
  ]);
});

test('the test button logs in and lists the units', async (t) => {
  const { gladys, api } = await setup(t);
  await gladys.connect();
  const ack = await gladys.fake.action('test_connection', {});
  assert.equal(ack.success, true);
  assert.equal(
    ack.data.message.en,
    'Login OK: 3 air conditioners ("Salon", "Chambre", "Bureau"). Live link up.',
  );
  assert.equal(api.counts()['/api/Consumer/Login'], 2, 'a real login checks the password');
  api.next.push(403);
  const limited = await gladys.fake.action('test_connection', {});
  assert.match(limited.data.message.en, /slowing this connection down/);
});

test('without credentials, nothing is attempted', async (t) => {
  const { gladys, api, hub } = await setup(t, { config: {} });
  await gladys.connect();
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /Type the user name and the password/);
  assert.equal(api.requests.length, 0);
  assert.equal(hub.connects.length, 0);
  const ack = await gladys.fake.action('test_connection', {});
  assert.match(ack.data.message.en, /Type the user name/);
});

test('Gladys reconnects: the devices and states are sent again', async (t) => {
  const { gladys, api, hub } = await setup(t);
  await gladys.connect();
  const living = deviceOf(gladys, UNITS.living);
  await gladys.fake.deviceCreated(living);
  const before = gladys.fake.states.length;
  await gladys.disconnect();
  await gladys.connect();
  assert.ok(gladys.fake.states.length > before, 'states sent again');
  assert.equal(api.counts()['/api/AC/GetConsumerACMapping'], 1, 'no new read: a resync');
  assert.equal(hub.connects.length, 1, 'the live link stays');
});

test('a scan lists the units again', async (t) => {
  const { gladys, api } = await setup(t);
  await gladys.connect();
  api.groups[0].ACList.push({
    ...UNITS.bedroom,
    Id: '4',
    DeviceUniqueId: 'D4-kitchen',
    Name: 'Cuisine',
  });
  await gladys.fake.scanRequest();
  assert.equal(gladys.fake.discoveredDevices.length, 4);
  assert.equal(api.counts()['/api/Consumer/RegisterMobileDevice'], 1);
});

test('an account without units', async (t) => {
  const api = createFakeToshiba();
  api.groups = [];
  const { gladys, hub } = await setup(t, { api });
  await gladys.connect();
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(gladys.fake.connectionStatus.message.en, /no air conditioner/);
  assert.equal(hub.connects.length, 0, 'no live link to open');
});
