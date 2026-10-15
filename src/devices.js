// -----------------------------------------------------------------------------
// The Gladys device of a Toshiba unit, its states, and the commands its
// features take (pure).
//
// One AIR_CONDITIONING device per unit of the account, with the features the
// unit supports (from its MeritFeature and ACModelId, see protocol.js
// supportedOf):
//   - `binary`              air-conditioning/binary: on/off;
//   - `mode`                air-conditioning/mode: AC_MODE, the unit's modes
//                           as supported_options;
//   - `target-temperature`  air-conditioning/target-temperature (°C, whole
//                           degrees; 5–13 in 8 °C heating, else 17–30);
//   - `fan-speed`           air-conditioning/fan-speed: AC_FAN_SPEED (the 7
//                           Toshiba speeds have a Gladys value each);
//   - `swing-vertical`      air-conditioning/swing-vertical: off, swing, and
//                           the 5 fixed louver positions when supported;
//   - `swing-horizontal`    air-conditioning/swing-horizontal: off / swing,
//                           when supported (Toshiba has one swing setting:
//                           both features write it together);
//   - `power-selection`     text/select: 50 / 75 / 100 %;
//   - `special-mode`        text/select: the "merit A" feature, ONE of none,
//                           Hi-POWER, ECO, silent 1/2, 8 °C heating, sleep
//                           care, floor, comfort, as the unit supports;
//   - `fireplace`           text/select: the "merit B" feature, when supported;
//   - `air-purifier`        switch/binary: Air Pure Ion, when supported;
//   - `indoor-temperature`, `outdoor-temperature`
//                           temperature-sensor/decimal (°C);
//   - `energy`              energy-sensor/energy (kWh since January 1st),
//                           when the unit reports it.
// The Gladys enums (server/utils/constants.js) are copied in constants.js.
// Feature external ids end with the keys of constants.js FEATURES: never
// rename one; the option values of the selects are frozen too (scenes).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import {
  AC_FAN_SPEED,
  AC_MODE,
  AC_SWING_HORIZONTAL,
  AC_SWING_VERTICAL,
  DEVICE_TYPE,
  FEATURES,
  SETPOINT,
} from './constants.js';
import { texts } from './i18n.js';
import { meritsForMode, setpointOf, UnsupportedError } from './protocol.js';

/** Toshiba mode -> Gladys AC_MODE, in the order of the options. */
const MODES = {
  AUTO: AC_MODE.AUTO,
  COOL: AC_MODE.COOLING,
  HEAT: AC_MODE.HEATING,
  DRY: AC_MODE.DRYING,
  FAN: AC_MODE.FAN,
};

/** Toshiba fan mode -> Gladys AC_FAN_SPEED, from the slowest. */
const FAN_SPEEDS = {
  AUTO: AC_FAN_SPEED.AUTO,
  QUIET: AC_FAN_SPEED.QUIET,
  LOW: AC_FAN_SPEED.LOW,
  MEDIUM_LOW: AC_FAN_SPEED.LOW_MID,
  MEDIUM: AC_FAN_SPEED.MID,
  MEDIUM_HIGH: AC_FAN_SPEED.MID_HIGH,
  HIGH: AC_FAN_SPEED.HIGH,
};

const FIXED = ['FIXED_1', 'FIXED_2', 'FIXED_3', 'FIXED_4', 'FIXED_5'];
const FIXED_VERTICAL = {
  FIXED_1: AC_SWING_VERTICAL.POSITION_1,
  FIXED_2: AC_SWING_VERTICAL.POSITION_2,
  FIXED_3: AC_SWING_VERTICAL.POSITION_3,
  FIXED_4: AC_SWING_VERTICAL.POSITION_4,
  FIXED_5: AC_SWING_VERTICAL.POSITION_5,
};

/** Select option values (frozen) of the power selection. */
const POWER_SELECTIONS = { POWER_50: '50', POWER_75: '75', POWER_100: '100' };
/** …of the special mode (merit A). */
const SPECIAL_MODES = {
  OFF: 'none',
  HIGH_POWER: 'hi-power',
  ECO: 'eco',
  CDU_SILENT_1: 'silent-1',
  CDU_SILENT_2: 'silent-2',
  HEATING_8C: 'heating-8c',
  SLEEP_CARE: 'sleep-care',
  FLOOR: 'floor',
  COMFORT: 'comfort',
};
/** …of the fireplace mode (merit B). */
const FIREPLACES = { OFF: 'off', FIREPLACE_1: 'fireplace-1', FIREPLACE_2: 'fireplace-2' };

const invert = (map) => Object.fromEntries(Object.entries(map).map(([k, v]) => [String(v), k]));
const MODE_OF = invert(MODES);
const FAN_OF = invert(FAN_SPEEDS);
const POWER_OF = invert(POWER_SELECTIONS);
const SPECIAL_OF = invert(SPECIAL_MODES);
const FIREPLACE_OF = invert(FIREPLACES);

/** The id of a unit in the external ids: its DeviceUniqueId, kept to [a-z0-9_-]. */
export function unitId(unit) {
  const id = String(unit.uniqueId ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-');
  return id || 'unknown';
}

export const idsOf = (gladys, unit) => gladys.externalIds(DEVICE_TYPE, unitId(unit));

const command = (feature) => ({
  read_only: false,
  has_feedback: true,
  keep_history: true,
  ...feature,
});
const sensor = (feature) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...feature,
});

/** True when the unit supports 8 °C heating (the setpoint goes down to 5 °C). */
const has8c = (supported) => supported.meritA.includes('HEATING_8C');

const hasHorizontal = (supported) => supported.swingModes.includes('SWING_HORIZONTAL');
const hasFixed = (supported) => supported.swingModes.includes('FIXED_1');

/**
 * @param {object} gladys the SDK client (external ids)
 * @param {{ unit: object, supported: object }} entry
 * @param {'en' | 'fr'} language
 */
export function buildDevice(gladys, entry, language) {
  const { unit, supported } = entry;
  const ids = idsOf(gladys, unit);
  const t = texts(language);
  const named = (key, feature) => ({
    name: t.features[key],
    external_id: ids.feature(key),
    ...feature,
  });
  const options = (values, labels, valueOf) =>
    values.map((v, i) => ({ value: valueOf(v), label: labels[v] ?? v, sort_order: i }));

  const modes = Object.keys(MODES).filter((m) => supported.modes.includes(m));
  const fans = Object.keys(FAN_SPEEDS).filter((f) => supported.fanModes.includes(f));
  const vertical = [
    { value: AC_SWING_VERTICAL.OFF, label: t.options.swing.OFF },
    { value: AC_SWING_VERTICAL.SWING, label: t.options.swing.SWING },
    ...(hasFixed(supported)
      ? FIXED.map((f) => ({ value: FIXED_VERTICAL[f], label: t.options.swing[f] }))
      : []),
  ].map((o, i) => ({ ...o, sort_order: i }));

  const features = [
    named(
      FEATURES.POWER,
      command({ category: C.AIR_CONDITIONING, type: T.AIR_CONDITIONING.BINARY, min: 0, max: 1 }),
    ),
    named(
      FEATURES.MODE,
      command({
        category: C.AIR_CONDITIONING,
        type: T.AIR_CONDITIONING.MODE,
        min: AC_MODE.AUTO,
        max: AC_MODE.FAN,
        supported_options: options(modes, t.options.mode, (m) => MODES[m]),
      }),
    ),
    named(
      FEATURES.SETPOINT,
      command({
        category: C.AIR_CONDITIONING,
        type: T.AIR_CONDITIONING.TARGET_TEMPERATURE,
        unit: U.CELSIUS,
        min: has8c(supported) ? SETPOINT.heating8cMin : SETPOINT.min,
        max: SETPOINT.max,
      }),
    ),
    named(
      FEATURES.FAN,
      command({
        category: C.AIR_CONDITIONING,
        type: T.AIR_CONDITIONING.FAN_SPEED,
        min: AC_FAN_SPEED.AUTO,
        max: AC_FAN_SPEED.QUIET,
        supported_options: options(fans, t.options.fanMode, (f) => FAN_SPEEDS[f]),
      }),
    ),
    named(
      FEATURES.SWING_VERTICAL,
      command({
        category: C.AIR_CONDITIONING,
        type: T.AIR_CONDITIONING.SWING_VERTICAL,
        min: AC_SWING_VERTICAL.OFF,
        max: hasFixed(supported) ? AC_SWING_VERTICAL.POSITION_5 : AC_SWING_VERTICAL.SWING,
        supported_options: vertical,
      }),
    ),
  ];
  if (hasHorizontal(supported)) {
    features.push(
      named(
        FEATURES.SWING_HORIZONTAL,
        command({
          category: C.AIR_CONDITIONING,
          type: T.AIR_CONDITIONING.SWING_HORIZONTAL,
          min: AC_SWING_HORIZONTAL.OFF,
          max: AC_SWING_HORIZONTAL.SWING,
          supported_options: [
            { value: AC_SWING_HORIZONTAL.OFF, label: t.options.swing.OFF, sort_order: 0 },
            { value: AC_SWING_HORIZONTAL.SWING, label: t.options.swing.SWING, sort_order: 1 },
          ],
        }),
      ),
    );
  }
  const select = (key, values, labels, valueOf) =>
    named(
      key,
      command({
        category: C.TEXT,
        type: T.TEXT.SELECT,
        keep_history: false,
        supported_options: options(values, labels, valueOf),
      }),
    );
  features.push(
    select(
      FEATURES.POWER_SELECTION,
      supported.powerSelections,
      t.options.powerSelection,
      (p) => POWER_SELECTIONS[p],
    ),
    select(
      FEATURES.SPECIAL_MODE,
      Object.keys(SPECIAL_MODES).filter((m) => supported.meritA.includes(m)),
      t.options.meritA,
      (m) => SPECIAL_MODES[m],
    ),
  );
  if (supported.meritB.length > 1) {
    features.push(
      select(
        FEATURES.FIREPLACE,
        Object.keys(FIREPLACES).filter((m) => supported.meritB.includes(m)),
        t.options.meritB,
        (m) => FIREPLACES[m],
      ),
    );
  }
  if (supported.airPureIon.includes('ON')) {
    features.push(
      named(
        FEATURES.AIR_PURIFIER,
        command({ category: C.SWITCH, type: T.SWITCH.BINARY, min: 0, max: 1 }),
      ),
    );
  }
  const temperature = (key) =>
    named(
      key,
      sensor({
        category: C.TEMPERATURE_SENSOR,
        type: T.SENSOR.DECIMAL,
        unit: U.CELSIUS,
        min: -60,
        max: 60,
      }),
    );
  features.push(temperature(FEATURES.INDOOR), temperature(FEATURES.OUTDOOR));
  if (supported.energy) {
    features.push(
      named(
        FEATURES.ENERGY,
        sensor({
          category: C.ENERGY_SENSOR,
          type: T.ENERGY_SENSOR.ENERGY,
          unit: U.KILOWATT_HOUR,
          min: 0,
          max: 1_000_000,
        }),
      ),
    );
  }
  return {
    name: unit.name,
    external_id: ids.device,
    model: 'toshiba-home-ac',
    features,
  };
}

/** The vertical and horizontal parts of the single Toshiba swing setting. */
function swingParts(swingMode) {
  switch (swingMode) {
    case 'OFF':
      return { vertical: AC_SWING_VERTICAL.OFF, horizontal: AC_SWING_HORIZONTAL.OFF };
    case 'SWING_VERTICAL':
      return { vertical: AC_SWING_VERTICAL.SWING, horizontal: AC_SWING_HORIZONTAL.OFF };
    case 'SWING_HORIZONTAL':
      return { vertical: AC_SWING_VERTICAL.OFF, horizontal: AC_SWING_HORIZONTAL.SWING };
    case 'SWING_VERTICAL_AND_HORIZONTAL':
      return { vertical: AC_SWING_VERTICAL.SWING, horizontal: AC_SWING_HORIZONTAL.SWING };
    default:
      return swingMode in FIXED_VERTICAL
        ? { vertical: FIXED_VERTICAL[swingMode], horizontal: AC_SWING_HORIZONTAL.OFF }
        : null;
  }
}

/**
 * The states of a unit, from its fields (protocol.js readState) and its
 * energy (Wh), as [featureKey, { state } | { text }] pairs. Fields without a
 * value (unit off, no reading) are left out.
 */
export function statesOf(entry, fields, energy) {
  const states = [];
  const add = (key, value) => {
    if (value !== null && value !== undefined) {
      states.push([key, value]);
    }
  };
  const { supported } = entry;
  add(FEATURES.POWER, fields.status === null ? null : { state: fields.status === 'ON' ? 1 : 0 });
  add(FEATURES.MODE, fields.mode in MODES ? { state: MODES[fields.mode] } : null);
  const setpoint = setpointOf(fields);
  add(FEATURES.SETPOINT, setpoint === null ? null : { state: setpoint });
  add(FEATURES.FAN, fields.fanMode in FAN_SPEEDS ? { state: FAN_SPEEDS[fields.fanMode] } : null);
  const swing = swingParts(fields.swingMode);
  if (swing) {
    add(FEATURES.SWING_VERTICAL, { state: swing.vertical });
    if (hasHorizontal(supported)) {
      add(FEATURES.SWING_HORIZONTAL, { state: swing.horizontal });
    }
  }
  add(
    FEATURES.POWER_SELECTION,
    fields.powerSelection ? { text: POWER_SELECTIONS[fields.powerSelection] } : null,
  );
  add(FEATURES.SPECIAL_MODE, fields.meritA ? { text: SPECIAL_MODES[fields.meritA] } : null);
  if (supported.meritB.length > 1) {
    add(FEATURES.FIREPLACE, fields.meritB ? { text: FIREPLACES[fields.meritB] } : null);
  }
  if (supported.airPureIon.includes('ON')) {
    add(
      FEATURES.AIR_PURIFIER,
      fields.airPureIon === null ? null : { state: fields.airPureIon === 'ON' ? 1 : 0 },
    );
  }
  add(
    FEATURES.INDOOR,
    fields.indoorTemperature === null ? null : { state: fields.indoorTemperature },
  );
  add(
    FEATURES.OUTDOOR,
    fields.outdoorTemperature === null ? null : { state: fields.outdoorTemperature },
  );
  if (supported.energy && Number.isFinite(energy)) {
    add(FEATURES.ENERGY, { state: Math.round(energy) / 1000 });
  }
  return states;
}

const fail = (message) => {
  throw new UnsupportedError(message);
};

/**
 * The change a Gladys command asks for, as protocol fields ({ mode: 'HEAT' },
 * { temperature: 22 }…), checked against what the unit supports in its
 * current mode. Throws UnsupportedError with a message for the user (in
 * English, like every command error).
 * @param {{ supported: object }} entry
 * @param {object} fields the current fields of the unit (readState)
 */
export function changeOf(entry, key, value, fields) {
  const { supported } = entry;
  const t = texts('en');
  const text = String(value ?? '').trim();
  const n = Number(value);
  switch (key) {
    case FEATURES.POWER:
      return { status: n === 0 ? 'OFF' : 'ON' };
    case FEATURES.MODE: {
      const mode = MODE_OF[String(n)];
      if (!mode || !supported.modes.includes(mode)) {
        fail(`this unit has no ${t.options.mode[mode] ?? value} mode`);
      }
      return { mode };
    }
    case FEATURES.SETPOINT: {
      if (!Number.isFinite(n)) {
        fail('the setpoint must be a number');
      }
      const celsius = Math.round(n);
      const frost = fields.mode === 'HEAT' && fields.meritA === 'HEATING_8C';
      const [min, max] = frost
        ? [SETPOINT.heating8cMin, SETPOINT.heating8cMax]
        : [SETPOINT.min, SETPOINT.max];
      if (celsius < min || celsius > max) {
        fail(`the setpoint must be between ${min} and ${max} °C${frost ? ' in 8 °C heating' : ''}`);
      }
      return { temperature: celsius };
    }
    case FEATURES.FAN: {
      const fan = FAN_OF[String(n)];
      if (!fan || !supported.fanModes.includes(fan)) {
        fail(`unknown fan speed ${value}`);
      }
      return { fanMode: fan };
    }
    case FEATURES.SWING_VERTICAL:
    case FEATURES.SWING_HORIZONTAL: {
      const current = swingParts(fields.swingMode) ?? {
        vertical: AC_SWING_VERTICAL.OFF,
        horizontal: AC_SWING_HORIZONTAL.OFF,
      };
      const vertical = key === FEATURES.SWING_VERTICAL ? n : current.vertical;
      const horizontal = key === FEATURES.SWING_HORIZONTAL ? n : current.horizontal;
      let swingMode;
      const fixed = Object.keys(FIXED_VERTICAL).find((f) => FIXED_VERTICAL[f] === vertical);
      if (fixed && key === FEATURES.SWING_HORIZONTAL && horizontal === AC_SWING_HORIZONTAL.SWING) {
        // A louver position and the horizontal swing cannot go together.
        swingMode = 'SWING_HORIZONTAL';
      } else if (fixed) {
        swingMode = fixed;
      } else if (![0, 1].includes(vertical) || ![0, 1].includes(horizontal)) {
        fail(`unknown swing value ${value}`);
      } else {
        swingMode = [
          ['OFF', 'SWING_HORIZONTAL'],
          ['SWING_VERTICAL', 'SWING_VERTICAL_AND_HORIZONTAL'],
        ][vertical][horizontal];
      }
      if (!supported.swingModes.includes(swingMode)) {
        fail('this unit does not support this swing setting');
      }
      return { swingMode };
    }
    case FEATURES.POWER_SELECTION: {
      const power = POWER_OF[text.replace(/\s*%$/, '')];
      if (!power || !supported.powerSelections.includes(power)) {
        fail(`unknown power selection ${text}`);
      }
      return { powerSelection: power };
    }
    case FEATURES.SPECIAL_MODE: {
      const merit = SPECIAL_OF[text];
      if (!merit || !supported.meritA.includes(merit)) {
        fail(`this unit has no special mode ${text}`);
      }
      if (fields.mode && !meritsForMode(supported, fields.mode).meritA.includes(merit)) {
        fail(`${t.options.meritA[merit]} is not available in ${t.options.mode[fields.mode]} mode`);
      }
      return { meritA: merit };
    }
    case FEATURES.FIREPLACE: {
      const merit = FIREPLACE_OF[text];
      if (!merit || !supported.meritB.includes(merit)) {
        fail(`unknown fireplace mode ${text}`);
      }
      if (fields.mode && !meritsForMode(supported, fields.mode).meritB.includes(merit)) {
        fail(`${t.options.meritB[merit]} is only available in heat mode`);
      }
      return { meritB: merit };
    }
    case FEATURES.AIR_PURIFIER:
      if (!supported.airPureIon.includes('ON')) {
        fail('this unit has no air purifier');
      }
      return { airPureIon: n === 0 ? 'OFF' : 'ON' };
    default:
      return fail(`${key} cannot be controlled`);
  }
}
