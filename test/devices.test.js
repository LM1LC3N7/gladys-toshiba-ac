// -----------------------------------------------------------------------------
// A unit -> its Gladys device, its states, and the change each command asks.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { STATE, UNITS } from './fixtures/units.js';
import { AC_FAN_SPEED, AC_MODE, AC_SWING_VERTICAL } from '../src/constants.js';
import { buildDevice, changeOf, idsOf, statesOf, unitId } from '../src/devices.js';
import { UnsupportedError, parseState, readState, supportedOf } from '../src/protocol.js';

const gladys = createFakeGladys();

function entryOf(ac) {
  const unit = {
    id: ac.Id,
    uniqueId: ac.DeviceUniqueId,
    name: ac.Name,
    state: ac.ACStateData,
    merit: ac.MeritFeature,
    model: ac.ACModelId,
  };
  return { unit, supported: supportedOf(unit.merit, unit.model), ids: idsOf(gladys, unit) };
}

const fieldsOf = (hex) => readState(parseState(hex)).fields;
const keysOf = (device) => device.features.map((f) => f.external_id.split(':').at(-1));
const featureOf = (device, key) => device.features.find((f) => f.external_id.endsWith(`:${key}`));

test('the external ids come from DeviceUniqueId, kept to [a-z0-9_-]', () => {
  const { ids } = entryOf(UNITS.living);
  assert.equal(ids.device, 'ext:test-integration:ac:a1b2c3d4e5f6-living');
  assert.equal(unitId({ uniqueId: 'AB:CD ef/12' }), 'ab-cd-ef-12');
  assert.equal(unitId({ uniqueId: '' }), 'unknown');
});

test('a full-featured unit has every feature, with its options', () => {
  const device = buildDevice(gladys, entryOf(UNITS.living), 'en');
  assert.equal(device.name, 'Salon');
  assert.deepEqual(keysOf(device), [
    'binary',
    'mode',
    'target-temperature',
    'fan-speed',
    'swing-vertical',
    'swing-horizontal',
    'power-selection',
    'special-mode',
    'fireplace',
    'air-purifier',
    'indoor-temperature',
    'outdoor-temperature',
    'energy',
  ]);
  const mode = featureOf(device, 'mode');
  assert.equal(mode.category, 'air-conditioning');
  assert.equal(mode.type, 'mode');
  assert.deepEqual(
    mode.supported_options.map((o) => [o.value, o.label]),
    [
      [AC_MODE.AUTO, 'Auto'],
      [AC_MODE.COOLING, 'Cool'],
      [AC_MODE.HEATING, 'Heat'],
      [AC_MODE.DRYING, 'Dry'],
      [AC_MODE.FAN, 'Fan'],
    ],
  );
  assert.deepEqual(
    featureOf(device, 'fan-speed').supported_options.map((o) => o.value),
    [0, 6, 1, 2, 3, 4, 5],
  );
  assert.deepEqual(
    featureOf(device, 'swing-vertical').supported_options.map((o) => o.value),
    [0, 1, 2, 3, 4, 5, 6],
  );
  const setpoint = featureOf(device, 'target-temperature');
  assert.deepEqual([setpoint.min, setpoint.max, setpoint.unit], [5, 30, 'celsius']);
  assert.deepEqual(
    featureOf(device, 'special-mode').supported_options.map((o) => o.value),
    [
      'none',
      'hi-power',
      'eco',
      'silent-1',
      'silent-2',
      'heating-8c',
      'sleep-care',
      'floor',
      'comfort',
    ],
  );
  assert.deepEqual(
    featureOf(device, 'power-selection').supported_options.map((o) => [o.value, o.label]),
    [
      ['50', '50 %'],
      ['75', '75 %'],
      ['100', '100 %'],
    ],
  );
  const energy = featureOf(device, 'energy');
  assert.deepEqual(
    [energy.category, energy.type, energy.unit],
    ['energy-sensor', 'energy', 'kilowatt-hour'],
  );
  assert.equal(featureOf(device, 'indoor-temperature').read_only, true);
  assert.equal(featureOf(device, 'binary').read_only, false);
  for (const f of device.features) {
    assert.equal(typeof f.name, 'string');
    for (const o of f.supported_options ?? []) {
      assert.equal(typeof o.label, 'string', `${f.external_id} labels are strings`);
    }
  }
});

test('a basic unit only gets what it supports, in French', () => {
  const office = buildDevice(gladys, entryOf(UNITS.office), 'fr');
  assert.deepEqual(keysOf(office), [
    'binary',
    'mode',
    'target-temperature',
    'fan-speed',
    'swing-vertical',
    'power-selection',
    'special-mode',
    'indoor-temperature',
    'outdoor-temperature',
  ]);
  assert.deepEqual(
    featureOf(office, 'mode').supported_options.map((o) => o.label),
    ['Auto', 'Froid', 'Déshumidification', 'Ventilation'],
    'a cooling-only unit',
  );
  assert.deepEqual(
    featureOf(office, 'special-mode').supported_options.map((o) => o.label),
    ['Aucun', 'Sommeil', 'Confort'],
  );
  assert.equal(featureOf(office, 'swing-vertical').max, AC_SWING_VERTICAL.SWING);
  assert.equal(featureOf(office, 'target-temperature').min, 17);
  assert.equal(featureOf(office, 'binary').name, 'Marche/arrêt');
});

test('the states of a unit', () => {
  const entry = entryOf(UNITS.living);
  const states = Object.fromEntries(statesOf(entry, fieldsOf(STATE.cool_on), 134500));
  assert.deepEqual(states, {
    binary: { state: 1 },
    mode: { state: AC_MODE.COOLING },
    'target-temperature': { state: 22 },
    'fan-speed': { state: AC_FAN_SPEED.AUTO },
    'swing-vertical': { state: 0 },
    'swing-horizontal': { state: 0 },
    'power-selection': { text: '100' },
    'special-mode': { text: 'none' },
    fireplace: { text: 'off' },
    'air-purifier': { state: 0 },
    'indoor-temperature': { state: 24 },
    'outdoor-temperature': { state: 30 },
    energy: { state: 134.5 },
  });
});

test('the swing, the 8 °C setpoint and the missing values', () => {
  const entry = entryOf(UNITS.living);
  const of = (hex) => Object.fromEntries(statesOf(entry, fieldsOf(hex), null));
  assert.deepEqual(of(STATE.auto_hipower)['swing-horizontal'], { state: 1 });
  assert.deepEqual(of(STATE.auto_hipower)['swing-vertical'], { state: 0 });
  assert.deepEqual(of(STATE.dry_quiet)['swing-vertical'], { state: 1 });
  assert.deepEqual(of(STATE.dry_quiet)['swing-horizontal'], { state: 1 });
  assert.deepEqual(of(STATE.dry_quiet)['fan-speed'], { state: AC_FAN_SPEED.QUIET });
  assert.deepEqual(of(STATE.fan_fixed)['swing-vertical'], { state: AC_SWING_VERTICAL.POSITION_3 });
  assert.deepEqual(of(STATE.fan_fixed)['outdoor-temperature'], { state: -1 });
  assert.deepEqual(of(STATE.heat_8c)['target-temperature'], { state: 8 });
  assert.deepEqual(of(STATE.heat_8c)['special-mode'], { text: 'heating-8c' });
  assert.deepEqual(of(STATE.eco_silent)['special-mode'], { text: 'eco' });
  assert.deepEqual(of(STATE.silent_1)['special-mode'], { text: 'silent-1' });
  assert.deepEqual(of(STATE.heat_8c_merit_b_fireplace).fireplace, { text: 'fireplace-1' });
  assert.equal(of(STATE.comfort_sleep)['outdoor-temperature'], undefined, 'no reading');
  assert.equal(of(STATE.cool_on).energy, undefined, 'no energy yet');
  const partial = of(STATE.partial_status);
  assert.deepEqual(Object.keys(partial), ['binary']);
  const basic = entryOf(UNITS.office);
  const states = Object.fromEntries(statesOf(basic, fieldsOf(STATE.auto_hipower), 1000));
  assert.equal(states['swing-horizontal'], undefined, 'not a feature of this unit');
  assert.equal(states.energy, undefined, 'not a feature of this unit');
  assert.equal(states.fireplace, undefined);
});

test('the commands become protocol changes', () => {
  const entry = entryOf(UNITS.living);
  const cool = fieldsOf(STATE.cool_on);
  const change = (key, value, fields = cool) => changeOf(entry, key, value, fields);
  assert.deepEqual(change('binary', 1), { status: 'ON' });
  assert.deepEqual(change('binary', 0), { status: 'OFF' });
  assert.deepEqual(change('mode', AC_MODE.HEATING), { mode: 'HEAT' });
  assert.deepEqual(change('mode', AC_MODE.DRYING), { mode: 'DRY' });
  assert.deepEqual(change('target-temperature', 21.6), { temperature: 22 });
  assert.deepEqual(change('target-temperature', 8, fieldsOf(STATE.heat_8c)), { temperature: 8 });
  assert.deepEqual(change('fan-speed', AC_FAN_SPEED.QUIET), { fanMode: 'QUIET' });
  assert.deepEqual(change('fan-speed', AC_FAN_SPEED.MID), { fanMode: 'MEDIUM' });
  assert.deepEqual(change('swing-vertical', 1), { swingMode: 'SWING_VERTICAL' });
  assert.deepEqual(change('swing-vertical', AC_SWING_VERTICAL.POSITION_5), {
    swingMode: 'FIXED_5',
  });
  assert.deepEqual(change('swing-horizontal', 1), { swingMode: 'SWING_HORIZONTAL' });
  const vertical = fieldsOf(STATE.dry_quiet); // vertical + horizontal
  assert.deepEqual(change('swing-vertical', 0, vertical), { swingMode: 'SWING_HORIZONTAL' });
  assert.deepEqual(change('swing-horizontal', 0, vertical), { swingMode: 'SWING_VERTICAL' });
  const fixed = fieldsOf(STATE.fan_fixed);
  assert.deepEqual(change('swing-horizontal', 0, fixed), { swingMode: 'FIXED_3' });
  assert.deepEqual(change('swing-horizontal', 1, fixed), { swingMode: 'SWING_HORIZONTAL' });
  assert.deepEqual(change('power-selection', '75'), { powerSelection: 'POWER_75' });
  assert.deepEqual(change('power-selection', '50 %'), { powerSelection: 'POWER_50' });
  assert.deepEqual(change('special-mode', 'eco'), { meritA: 'ECO' });
  assert.deepEqual(change('special-mode', 'none'), { meritA: 'OFF' });
  assert.deepEqual(change('special-mode', 'heating-8c', fieldsOf(STATE.heat_off)), {
    meritA: 'HEATING_8C',
  });
  assert.deepEqual(change('fireplace', 'fireplace-2', fieldsOf(STATE.heat_off)), {
    meritB: 'FIREPLACE_2',
  });
  assert.deepEqual(change('air-purifier', 1), { airPureIon: 'ON' });
});

test('what a unit cannot do is refused with a message', () => {
  const living = entryOf(UNITS.living);
  const office = entryOf(UNITS.office);
  const cool = fieldsOf(STATE.cool_on);
  const refused = (entry, key, value, pattern, fields = cool) =>
    assert.throws(
      () => changeOf(entry, key, value, fields),
      (err) => err instanceof UnsupportedError && pattern.test(err.message),
      `${key}=${value}`,
    );
  refused(office, 'mode', AC_MODE.HEATING, /no Heat mode/);
  refused(living, 'mode', 9, /no 9 mode/);
  refused(living, 'target-temperature', 16, /between 17 and 30/);
  refused(
    living,
    'target-temperature',
    14,
    /between 5 and 13 °C in 8 °C heating/,
    fieldsOf(STATE.heat_8c),
  );
  refused(living, 'target-temperature', 'warm', /must be a number/);
  refused(living, 'fan-speed', AC_FAN_SPEED.TURBO, /unknown fan speed/);
  refused(office, 'swing-vertical', AC_SWING_VERTICAL.POSITION_1, /does not support/);
  refused(office, 'swing-horizontal', 1, /does not support/);
  refused(living, 'swing-vertical', 9, /unknown swing/);
  refused(living, 'power-selection', '60', /unknown power selection/);
  refused(office, 'special-mode', 'eco', /no special mode eco/);
  refused(
    living,
    'special-mode',
    'eco',
    /ECO is not available in Fan mode/,
    fieldsOf(STATE.fan_fixed),
  );
  refused(living, 'special-mode', 'heating-8c', /not available in Cool mode/);
  refused(living, 'fireplace', 'fireplace-1', /only available in heat mode/);
  refused(office, 'air-purifier', 1, /no air purifier/);
  refused(living, 'indoor-temperature', 20, /cannot be controlled/);
});

// --- Every feature passes the Gladys model (issue #6) -------------------------

/**
 * Every capability combination the module knows: the merit bits it reads
 * (0-7, 14, 15, see protocol.js supportedOf) on every model id, plus the
 * units of the fixtures.
 */
function* everyEntry() {
  const used = [0, 1, 2, 3, 4, 5, 6, 7, 14, 15];
  for (const model of ['', '1', '2', '3']) {
    for (let combo = 0; combo < 1 << used.length; combo += 1) {
      let value = 0;
      used.forEach((bit, i) => {
        if (combo & (1 << i)) value |= 1 << (15 - bit);
      });
      const merit = value.toString(16).padStart(4, '0');
      const unit = { uniqueId: `u-${model}-${merit}`, name: `Unit ${merit}`, merit, model };
      yield { unit, supported: supportedOf(merit, model), ids: idsOf(gladys, unit) };
    }
  }
  for (const ac of Object.values(UNITS)) {
    yield entryOf(ac);
  }
}

const values = (map) => new Set(Object.values(map).flatMap((v) => Object.values(v)));
const CATEGORIES = new Set(Object.values(C));
const TYPES = values(T);
const UNITS_LIST = new Set(Object.values(U));

/** The core rules of t_device_feature (server/models/device_feature.js) and supported_options. */
function assertCoreFeature(f, where) {
  for (const key of ['name', 'external_id']) {
    assert.equal(typeof f[key], 'string', `${where}: ${key}`);
    assert.ok(f[key].trim().length > 0, `${where}: ${key} not empty`);
  }
  assert.ok(CATEGORIES.has(f.category), `${where}: category ${f.category}`);
  assert.ok(TYPES.has(f.type), `${where}: type ${f.type}`);
  for (const key of ['read_only', 'has_feedback', 'keep_history']) {
    assert.equal(typeof f[key], 'boolean', `${where}: ${key} is a boolean`);
  }
  for (const key of ['min', 'max']) {
    assert.ok(Number.isFinite(f[key]), `${where}: ${key} is a number (not null), got ${f[key]}`);
  }
  assert.ok(f.min <= f.max, `${where}: min <= max`);
  if (f.unit !== undefined && f.unit !== null) {
    assert.ok(UNITS_LIST.has(f.unit), `${where}: unit ${f.unit}`);
  }
  if (f.step !== undefined && f.step !== null) {
    assert.ok(Number.isFinite(f.step) && f.step > 0, `${where}: step > 0`);
  }
  if (f.supported_options !== undefined) {
    const select = f.category === C.TEXT && f.type === T.TEXT.SELECT;
    assert.ok(f.supported_options.length > 0, `${where}: options`);
    const seen = new Set();
    for (const o of f.supported_options) {
      assert.deepEqual(Object.keys(o).sort(), ['label', 'sort_order', 'value'], `${where}: keys`);
      assert.equal(typeof o.label, 'string', `${where}: label is a string`);
      assert.ok(o.label.length > 0 && o.label === o.label.trim(), `${where}: label "${o.label}"`);
      assert.ok(Number.isInteger(o.sort_order), `${where}: sort_order`);
      assert.ok(
        Number.isInteger(o.value) || (select && typeof o.value === 'string' && o.value.trim()),
        `${where}: value ${o.value}`,
      );
      assert.ok(!seen.has(String(o.value)), `${where}: value ${o.value} unique`);
      seen.add(String(o.value));
    }
  }
}

/** The core's own checks, when its clone is on the machine (dev VM; skipped on the CI). */
function coreChecks() {
  const server = join(homedir(), 'code', 'Gladys', 'server');
  if (!existsSync(join(server, 'node_modules', 'joi'))) {
    return null;
  }
  const require = createRequire(join(server, 'index.js'));
  const constants = require('./utils/constants.js');
  const { normalizeSupportedOptions } = require('./utils/normalizeSupportedOptions.js');
  return { constants, normalizeSupportedOptions };
}

test('every feature of every buildable device has what the Gladys model needs (issue #6)', () => {
  const core = coreChecks();
  let devices = 0;
  for (const entry of everyEntry()) {
    for (const language of ['en', 'fr']) {
      const device = buildDevice(gladys, entry, language);
      devices += 1;
      assert.equal(typeof device.name, 'string');
      assert.equal(typeof device.external_id, 'string');
      const ids = new Set();
      for (const f of device.features) {
        const where = `${entry.unit.merit ?? entry.unit.uniqueId}/${entry.unit.model}/${language} ${f.external_id}`;
        assert.ok(!ids.has(f.external_id), `${where}: unique external id`);
        ids.add(f.external_id);
        assertCoreFeature(f, where);
        if (core) {
          assert.ok(core.constants.DEVICE_FEATURE_CATEGORIES_LIST.includes(f.category), where);
          assert.ok(core.constants.DEVICE_FEATURE_TYPES_LIST.includes(f.type), where);
          if (f.unit) assert.ok(core.constants.DEVICE_FEATURE_UNITS_LIST.includes(f.unit), where);
          if (f.supported_options) {
            const allowStringValues = f.category === C.TEXT && f.type === T.TEXT.SELECT;
            assert.doesNotThrow(
              () => core.normalizeSupportedOptions(f.supported_options, { allowStringValues }),
              where,
            );
          }
        }
      }
    }
  }
  assert.equal(devices, (4 * 1024 + Object.keys(UNITS).length) * 2);
});

test('the selects have min 0 and max 0, like the other text/select features of Gladys', () => {
  const device = buildDevice(gladys, entryOf(UNITS.living), 'fr');
  for (const key of ['power-selection', 'special-mode', 'fireplace']) {
    const f = featureOf(device, key);
    assert.deepEqual([f.category, f.type, f.min, f.max], ['text', 'select', 0, 0], key);
  }
});
