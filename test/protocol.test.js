// -----------------------------------------------------------------------------
// The port of the unit protocol, checked against what the toshiba-ac Python
// library computes for the same inputs (test/fixtures/toshiba-ac/golden.json).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { golden } from './fixtures/units.js';
import {
  STATE_LENGTH,
  UnsupportedError,
  commandMessage,
  commandState,
  emptyState,
  encodeState,
  meritBits,
  meritsForMode,
  mergeHeartbeat,
  mergeState,
  parseHeartbeat,
  parseState,
  pythonRepr,
  readState,
  setpointOf,
  supportedOf,
} from '../src/protocol.js';

/** golden field names (snake_case) -> ours. */
const FIELD = {
  status: 'status',
  mode: 'mode',
  temperature: 'temperature',
  fan_mode: 'fanMode',
  swing_mode: 'swingMode',
  power_selection: 'powerSelection',
  merit_b: 'meritB',
  merit_a: 'meritA',
  air_pure_ion: 'airPureIon',
  indoor_temperature: 'indoorTemperature',
  outdoor_temperature: 'outdoorTemperature',
  self_cleaning: 'selfCleaning',
};

const asGolden = ({ fields, unknown }) =>
  Object.fromEntries(
    Object.entries(FIELD).map(([g, ours]) => [
      g,
      unknown.includes(ours) ? 'UNKNOWN' : fields[ours],
    ]),
  );

const SETTERS = {
  set_ac_status: 'status',
  set_ac_mode: 'mode',
  set_ac_temperature: 'temperature',
  set_ac_fan_mode: 'fanMode',
  set_ac_swing_mode: 'swingMode',
  set_ac_power_selection: 'powerSelection',
  set_ac_merit_a: 'meritA',
  set_ac_merit_b: 'meritB',
  set_ac_air_pure_ion: 'airPureIon',
};

const sorted = (list) => [...list].sort();

test('the golden values come from the Python library', () => {
  assert.match(golden.library, /^toshiba-ac 0\.3\.13$/);
});

test('every state decodes like the library', () => {
  for (const [name, { hex, decoded }] of Object.entries(golden.states)) {
    const raw = parseState(hex);
    assert.ok(raw, name);
    assert.deepEqual(asGolden(readState(raw)), decoded, name);
  }
});

test('the setpoint of 8 °C heating is 16 degrees lower than reported', () => {
  for (const [name, expected] of Object.entries(golden.device_temperature)) {
    const { fields } = readState(parseState(golden.states[name].hex));
    assert.equal(setpointOf(fields), expected, name);
  }
});

test('partial reports update the state like the library', () => {
  let state = null;
  for (const step of golden.updates) {
    state ??= parseState(golden.states[step.start].hex);
    const result = mergeState(state, parseState(golden.states[step.apply].hex));
    assert.equal(result.changed, step.changed, step.apply);
    state = result.state;
    assert.deepEqual(asGolden(readState(state)), step.state, step.apply);
  }
});

test('a single field encodes like the library', () => {
  const all = supportedOf('ffff', '3');
  const cases = {
    status_on: { status: 'ON' },
    mode_cool: { mode: 'COOL' },
    temperature_minus_1: { temperature: -1 },
    temperature_30: { temperature: 30 },
    fan_auto: { fanMode: 'AUTO' },
    swing_off: { swingMode: 'OFF' },
    power_100: { powerSelection: 'POWER_100' },
    merit_a_off: { meritA: 'OFF' },
    merit_b_off: { meritB: 'OFF' },
    pure_ion_off: { airPureIon: 'OFF' },
    empty: {},
  };
  for (const [name, change] of Object.entries(cases)) {
    assert.equal(commandState(emptyState(), change, all), golden.encodings[name], name);
  }
  assert.equal(encodeState(emptyState()), 'f'.repeat(STATE_LENGTH));
});

test('the supported features follow MeritFeature and ACModelId like the library', () => {
  for (const expected of golden.features) {
    const s = supportedOf(expected.merit, expected.model);
    const label = `${expected.merit}/${expected.model}`;
    assert.deepEqual(s.modes, expected.modes, `${label} modes`);
    assert.deepEqual(sorted(s.fanModes), sorted(expected.fan_modes), `${label} fan`);
    assert.deepEqual(s.swingModes, expected.swing_modes, `${label} swing`);
    assert.deepEqual(sorted(s.powerSelections), sorted(expected.power_selections), label);
    assert.deepEqual(s.meritA, expected.merit_a, `${label} merit A`);
    assert.deepEqual(s.meritB, expected.merit_b, `${label} merit B`);
    assert.deepEqual(sorted(s.airPureIon), sorted(expected.air_pure_ion), `${label} ion`);
    assert.equal(s.energy, expected.energy_report, `${label} energy`);
    for (const [mode, merits] of Object.entries(expected.per_mode)) {
      const allowed = meritsForMode(s, mode);
      assert.deepEqual(allowed.meritA, merits.merit_a, `${label} ${mode} merit A`);
      assert.deepEqual(allowed.meritB, merits.merit_b, `${label} ${mode} merit B`);
    }
  }
});

test('every command is the state and the text the library sends', () => {
  assert.ok(golden.commands.length >= 20);
  for (const c of golden.commands) {
    assert.equal(c.error, undefined, c.case);
    const supported = supportedOf(c.merit, c.model);
    const data = commandState(
      parseState(golden.states[c.initial].hex),
      { [SETTERS[c.setter]]: c.value },
      supported,
    );
    assert.equal(data, c.message.payload.data, c.case);
    const message = commandMessage({
      sourceId: 'user@example.com_0123456789abcdef',
      targetId: 'unique-id',
      data,
    });
    assert.deepEqual(message, c.message, c.case);
    assert.equal(pythonRepr(message), c.raw, c.case);
  }
});

test('a mode the unit does not have is refused, not sent', () => {
  const coolOnly = supportedOf('0200', '2');
  assert.throws(
    () => commandState(parseState(golden.states.cool_on.hex), { mode: 'HEAT' }, coolOnly),
    UnsupportedError,
  );
  assert.throws(
    () => commandState(emptyState(), { fanMode: 'TURBO' }, coolOnly),
    /unknown fanMode TURBO/,
  );
});

test('the heartbeat temperatures decode like the library', () => {
  for (const hb of golden.heartbeats) {
    const parsed = parseHeartbeat(hb.payload);
    const expected = {};
    if ('iTemp' in hb.values) expected.indoorTemperature = hb.values.iTemp;
    if ('oTemp' in hb.values) expected.outdoorTemperature = hb.values.oTemp;
    assert.deepEqual(parsed, expected);
    const { state, changed } = mergeHeartbeat(parseState(golden.states.cool_on.hex), parsed);
    assert.equal(changed, hb.changed);
    const { fields } = readState(state);
    assert.equal(fields.indoorTemperature, hb.indoor_temperature);
    assert.equal(fields.outdoorTemperature, hb.outdoor_temperature);
  }
  assert.deepEqual(parseHeartbeat({ iTemp: 'zz', oTemp: 12, other: '10' }), {});
  assert.deepEqual(parseHeartbeat(null), {});
});

test('the command text is the Python literal, quotes and escapes included', () => {
  for (const { object, text } of golden.reprs) {
    assert.equal(pythonRepr(object), text);
  }
  assert.equal(pythonRepr({ a: null, b: true, c: 3 }), "{'a': None, 'b': True, 'c': 3}");
});

test('what is not a unit state is refused', () => {
  assert.equal(parseState(''), null);
  assert.equal(parseState(undefined), null);
  assert.equal(parseState('30'.repeat(10)), null, 'too short');
  assert.equal(parseState(`${'z'.repeat(38)}`), null, 'not hex');
  assert.ok(parseState(golden.states.extra_bytes.hex), 'longer states are cut');
});

test('a state survives an encode/decode round trip', () => {
  for (const { hex } of Object.values(golden.states)) {
    const raw = parseState(hex);
    assert.deepEqual(parseState(encodeState(raw)), raw);
  }
});

test('the merit string is padded and cut to 16 bits', () => {
  assert.deepEqual(meritBits('8'), meritBits('8000'));
  assert.equal(meritBits('8000')[0], true);
  assert.equal(meritBits('0001')[15], true);
  assert.deepEqual(meritBits('12345'), meritBits('1234'));
  assert.deepEqual(meritBits('xyz!'), meritBits('0000'));
  assert.deepEqual(meritBits(null), meritBits(''));
});
