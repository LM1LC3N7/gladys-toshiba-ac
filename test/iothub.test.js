// -----------------------------------------------------------------------------
// The live link: SAS token parsing, the direct method topics, and a real
// `mqtt` client against a fake IoT Hub on the loopback (test/helpers).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeIotHub, until } from './helpers/fakeIotHub.js';
import { USERNAME, sasToken } from './fixtures/units.js';
import {
  IotHubError,
  IotHubLink,
  IotHubRefused,
  parseMethodTopic,
  parseSasToken,
  parseUnitMessage,
} from '../src/iothub.js';

const DEVICE_ID = `${USERNAME}_0123456789abcdef`;
const silent = { debug() {}, info() {}, warn() {}, error() {} };

test('a SAS token gives the hub, the device id and the expiry', () => {
  assert.deepEqual(parseSasToken(sasToken()), {
    host: 'toshibahub.azure-devices.net',
    deviceId: DEVICE_ID,
    expiresAt: 4102444800 * 1000,
  });
  assert.deepEqual(
    parseSasToken(sasToken('user@example.com_abc')).deviceId,
    'user@example.com_abc',
  );
  assert.equal(parseSasToken(sasToken(DEVICE_ID, 'never')).expiresAt, null);
  for (const bad of [
    '',
    null,
    'Bearer abc',
    'SharedAccessSignature sig=abc&se=1',
    'SharedAccessSignature sr=host%2Fmodules%2Fx&sig=a',
    'SharedAccessSignature sr=%E0%A4%A&sig=a',
    'SharedAccessSignature sr=bad%20host%2Fdevices%2Fx&sig=a',
  ]) {
    assert.equal(parseSasToken(bad), null, String(bad));
  }
});

test('the direct method topics and the unit messages', () => {
  assert.deepEqual(parseMethodTopic('$iothub/methods/POST/smmobile/?$rid=42'), {
    name: 'smmobile',
    rid: '42',
  });
  assert.equal(parseMethodTopic('$iothub/methods/POST/smmobile/'), null);
  assert.equal(parseMethodTopic('devices/x/messages/devicebound/'), null);
  const message = {
    sourceId: 'unit',
    messageId: '1',
    targetId: ['me'],
    cmd: 'CMD_FCU_FROM_AC',
    payload: { data: '30' },
    timeStamp: '0',
  };
  assert.deepEqual(parseUnitMessage(message), {
    cmd: 'CMD_FCU_FROM_AC',
    sourceId: 'unit',
    payload: { data: '30' },
  });
  for (const field of ['sourceId', 'messageId', 'targetId', 'payload', 'timeStamp', 'cmd']) {
    assert.equal(parseUnitMessage({ ...message, [field]: 5 }), null, field);
  }
  assert.equal(parseUnitMessage({ ...message, payload: [] }), null);
  assert.equal(parseUnitMessage('text'), null);
});

test('connects like the azure-iot-device SDK and receives the unit reports', async (t) => {
  const hub = await startFakeIotHub();
  t.after(() => hub.close());
  const link = new IotHubLink({ sasToken: sasToken(), url: hub.url, logger: silent });
  t.after(() => link.close());
  await link.connect();
  assert.deepEqual(hub.connects[0], {
    clientId: DEVICE_ID,
    username: `toshibahub.azure-devices.net/${DEVICE_ID}/?api-version=2019-10-01`,
    password: sasToken(),
    clean: false,
    keepalive: 60,
    protocolVersion: 4,
  });
  assert.deepEqual(hub.subscriptions, [
    { clientId: DEVICE_ID, topic: '$iothub/methods/POST/#', qos: 1 },
  ]);

  const units = [];
  link.on('unit', (u) => units.push(u));
  hub.callMethod(
    'smmobile',
    {
      sourceId: 'A1',
      messageId: '0000001',
      targetId: [DEVICE_ID],
      cmd: 'CMD_HEARTBEAT',
      payload: { iTemp: '16', oTemp: 'fe' },
      timeStamp: '0000000',
    },
    'r1',
  );
  hub.callMethod('other', { a: 1 }, 'r2');
  hub.callMethod('smmobile', 'not json', 'r3');
  hub.callMethod('smmobile', { cmd: 'CMD_FCU_FROM_AC' }, 'r4');
  await until(() => hub.methodResponses.length === 4, 'the method answers');
  assert.deepEqual(units, [
    { cmd: 'CMD_HEARTBEAT', sourceId: 'A1', payload: { iTemp: '16', oTemp: 'fe' } },
  ]);
  assert.deepEqual(
    hub.methodResponses.map((r) => [r.topic, r.payload, r.qos]),
    ['r1', 'r2', 'r3', 'r4'].map((rid) => [`$iothub/methods/res/0/?$rid=${rid}`, 'null', 1]),
    'every call is answered, status 0, like the library',
  );
});

test('a command is a device-to-cloud message with type=mob, acknowledged', async (t) => {
  const hub = await startFakeIotHub();
  t.after(() => hub.close());
  const link = new IotHubLink({ sasToken: sasToken(), url: hub.url, logger: silent });
  t.after(() => link.close());
  await link.connect();
  await link.send("{'cmd': 'CMD_FCU_TO_AC'}");
  assert.deepEqual(hub.events, [
    {
      clientId: DEVICE_ID,
      topic: `devices/${DEVICE_ID}/messages/events/%24.ct=application%2Fjson&%24.ce=utf-8&type=mob`,
      payload: "{'cmd': 'CMD_FCU_TO_AC'}",
      qos: 1,
    },
  ]);
});

test('a refused SAS token is told apart', async (t) => {
  const hub = await startFakeIotHub({ accept: () => 5 });
  t.after(() => hub.close());
  const link = new IotHubLink({ sasToken: sasToken(), url: hub.url, logger: silent });
  await assert.rejects(link.connect(), IotHubRefused);
  hub.accept = () => 4;
  const again = new IotHubLink({ sasToken: sasToken(), url: hub.url, logger: silent });
  await assert.rejects(again.connect(), IotHubRefused);
  hub.accept = () => 3;
  const unavailable = new IotHubLink({ sasToken: sasToken(), url: hub.url, logger: silent });
  await assert.rejects(unavailable.connect(), (err) => !(err instanceof IotHubRefused));
});

test('a lost connection is reported once, and sending fails', async (t) => {
  const hub = await startFakeIotHub();
  t.after(() => hub.close());
  const link = new IotHubLink({ sasToken: sasToken(), url: hub.url, logger: silent });
  t.after(() => link.close());
  await link.connect();
  let closed = 0;
  link.on('close', () => (closed += 1));
  hub.dropClients();
  await until(() => closed === 1, 'the close event');
  await assert.rejects(link.send('x'), IotHubError);
});

test('an unreachable hub fails the connection', async () => {
  const hub = await startFakeIotHub();
  const { url } = hub;
  await hub.close();
  const link = new IotHubLink({ sasToken: sasToken(), url, logger: silent });
  await assert.rejects(link.connect(), IotHubError);
});

test('a command not acknowledged in time fails', async (t) => {
  const hub = await startFakeIotHub();
  t.after(() => hub.close());
  hub.holdPubacks = true;
  const link = new IotHubLink({ sasToken: sasToken(), url: hub.url, logger: silent });
  t.after(() => link.close());
  await link.connect();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent = link.send('x');
  t.mock.timers.tick(10_000);
  await assert.rejects(sent, /did not acknowledge/);
});

test('an unreadable SAS token is refused before connecting', () => {
  assert.throws(() => new IotHubLink({ sasToken: 'nope' }), IotHubError);
});
