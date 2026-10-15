// -----------------------------------------------------------------------------
// The Toshiba Home AC Control unit protocol (pure, no I/O).
//
// Port of the field map of the toshiba-ac Python library (KaSroka/
// Toshiba-AC-control, Apache-2.0: toshiba_ac/device/fcu_state.py,
// features.py and the command logic of device/__init__.py). A unit state is
// a hex string of 19 bytes: status, mode, setpoint, fan, swing, power
// selection, merit B | merit A (one nibble each), air pure ion, indoor
// temperature, outdoor temperature, 4 unknown bytes, self cleaning, 4 unknown
// bytes. 0xff (0xf for a nibble, -1 for a signed byte) means "no value": the
// live reports only carry what changed, and a command only what it sets.
// test/fixtures/toshiba-ac/golden.json holds what the Python library computes
// for the same inputs.
// -----------------------------------------------------------------------------

const NONE = 0xff;
const NONE_HALF = 0x0f;
const NONE_SIGNED = -1;

/** Raw value -> name; a raw value mapped to null means "none" (unit off, no reading). */
const TABLES = {
  status: { 0x30: 'ON', 0x31: 'OFF', 0x02: null },
  mode: { 0x41: 'AUTO', 0x42: 'COOL', 0x43: 'HEAT', 0x44: 'DRY', 0x45: 'FAN', 0x00: null },
  fanMode: {
    0x41: 'AUTO',
    0x31: 'QUIET',
    0x32: 'LOW',
    0x33: 'MEDIUM_LOW',
    0x34: 'MEDIUM',
    0x35: 'MEDIUM_HIGH',
    0x36: 'HIGH',
    0x00: null,
  },
  swingMode: {
    0x31: 'OFF',
    0x41: 'SWING_VERTICAL',
    0x42: 'SWING_HORIZONTAL',
    0x43: 'SWING_VERTICAL_AND_HORIZONTAL',
    0x50: 'FIXED_1',
    0x51: 'FIXED_2',
    0x52: 'FIXED_3',
    0x53: 'FIXED_4',
    0x54: 'FIXED_5',
    0x00: null,
  },
  powerSelection: { 0x32: 'POWER_50', 0x4b: 'POWER_75', 0x64: 'POWER_100' },
  // 0x01 is reported by recent firmwares (library comment: "nothing found in 3.4.0 APK").
  meritB: { 0x02: 'FIREPLACE_1', 0x03: 'FIREPLACE_2', 0x01: 'OFF', 0x00: 'OFF' },
  meritA: {
    0x01: 'HIGH_POWER',
    0x02: 'CDU_SILENT_1',
    0x03: 'ECO',
    0x04: 'HEATING_8C',
    0x05: 'SLEEP_CARE',
    0x06: 'FLOOR',
    0x07: 'COMFORT',
    0x0a: 'CDU_SILENT_2',
    0x00: 'OFF',
  },
  airPureIon: { 0x18: 'ON', 0x10: 'OFF' },
  selfCleaning: { 0x18: 'ON', 0x10: 'OFF' },
};

/** Name -> raw value sent in a command (the first raw value of each name). */
const RAW = Object.fromEntries(
  Object.entries(TABLES).map(([field, table]) => {
    const inverse = {};
    for (const [raw, name] of Object.entries(table)) {
      if (name !== null && !(name in inverse)) {
        inverse[name] = Number(raw);
      }
    }
    return [field, inverse];
  }),
);

export const ENUM_FIELDS = Object.keys(TABLES);
export const TEMPERATURE_FIELDS = ['temperature', 'indoorTemperature', 'outdoorTemperature'];

/** Every name a field can take (in the order of the tables). */
export const VALUES = Object.fromEntries(
  Object.entries(RAW).map(([field, inverse]) => [field, Object.keys(inverse)]),
);

/** Where each field sits in the hex string: [first char, chars, kind]. */
const LAYOUT = {
  status: [0, 2, 'byte'],
  mode: [2, 2, 'byte'],
  temperature: [4, 2, 'signed'],
  fanMode: [6, 2, 'byte'],
  swingMode: [8, 2, 'byte'],
  powerSelection: [10, 2, 'byte'],
  meritB: [12, 1, 'nibble'],
  meritA: [13, 1, 'nibble'],
  airPureIon: [14, 2, 'byte'],
  indoorTemperature: [16, 2, 'signed'],
  outdoorTemperature: [18, 2, 'signed'],
  selfCleaning: [28, 2, 'byte'],
};

/** A unit state is 38 hex characters; longer ones are cut, like the library does. */
export const STATE_LENGTH = 38;

const absent = (kind) => (kind === 'nibble' ? NONE_HALF : kind === 'signed' ? NONE_SIGNED : NONE);

/**
 * Reads the raw values of a hex unit state.
 * @returns {Record<string, number> | null} null when the text is not a state
 */
export function parseState(hex) {
  const text = String(hex ?? '');
  if (text.length < STATE_LENGTH || !/^[0-9a-f]+$/i.test(text)) {
    return null;
  }
  const raw = {};
  for (const [field, [start, length, kind]] of Object.entries(LAYOUT)) {
    const value = parseInt(text.slice(start, start + length), 16);
    raw[field] = kind === 'signed' && value > 127 ? value - 256 : value;
  }
  return raw;
}

/** The raw values of a state where nothing is set (every field "no value"). */
export function emptyState() {
  return Object.fromEntries(
    Object.entries(LAYOUT).map(([field, [, , kind]]) => [field, absent(kind)]),
  );
}

/** Raw values -> hex, the unknown bytes as "no value" (what the library sends). */
export function encodeState(raw) {
  const hex = 'f'.repeat(STATE_LENGTH).split('');
  for (const [field, [start, length, kind]] of Object.entries(LAYOUT)) {
    const value = raw[field] ?? absent(kind);
    const byte = kind === 'signed' ? (value + 256) % 256 : value;
    const text = byte.toString(16).padStart(length, '0').slice(-length);
    hex.splice(start, length, ...text.split(''));
  }
  return hex.join('');
}

/** The library's "update": fields with a value replace the current ones. */
export function mergeState(current, update) {
  const next = { ...current };
  let changed = false;
  for (const [field, [, , kind]] of Object.entries(LAYOUT)) {
    const value = update[field];
    const skip = kind === 'signed' ? [NONE_SIGNED] : [NONE, NONE_HALF];
    if (value === undefined || skip.includes(value) || value === current[field]) {
      continue;
    }
    next[field] = value;
    changed = true;
  }
  return { state: next, changed };
}

/** A temperature byte: 127, -128 and -1 mean no reading, 126 means -1 °C. */
export function temperatureOf(raw) {
  if (raw === undefined || raw === 127 || raw === -128 || raw === NONE_SIGNED) {
    return null;
  }
  return raw === 126 ? -1 : raw;
}

const temperatureRaw = (celsius) => (celsius === -1 ? 126 : celsius);

/**
 * Raw values -> names. A raw value the library does not know is reported in
 * `unknown` (the Python library would raise) and read as null.
 */
export function readState(raw) {
  const fields = {};
  const unknown = [];
  for (const field of ENUM_FIELDS) {
    const value = raw[field];
    const table = TABLES[field];
    if (value === absent(LAYOUT[field][2])) {
      fields[field] = null;
    } else if (value in table) {
      fields[field] = table[value];
    } else {
      fields[field] = null;
      unknown.push(field);
    }
  }
  for (const field of TEMPERATURE_FIELDS) {
    fields[field] = temperatureOf(raw[field]);
  }
  return { fields, unknown };
}

/**
 * The setpoint as the user sees it: in 8 °C heating (merit A HEATING_8C in
 * heat mode) the unit reports 16 degrees more than the real setpoint.
 */
export function setpointOf(fields) {
  const t = fields.temperature;
  if (t === null || t === undefined) {
    return null;
  }
  return fields.mode === 'HEAT' && fields.meritA === 'HEATING_8C' ? t - 16 : t;
}

/**
 * The live heartbeat (CMD_HEARTBEAT): { iTemp: "16", oTemp: "fe" }, one hex
 * byte per value, signed for the temperatures.
 * @returns {{ indoorTemperature?: number, outdoorTemperature?: number }} raw bytes
 */
export function parseHeartbeat(payload) {
  const out = {};
  const keys = { iTemp: 'indoorTemperature', oTemp: 'outdoorTemperature' };
  for (const [key, field] of Object.entries(keys)) {
    const text = payload?.[key];
    if (typeof text === 'string' && /^[0-9a-f]{2}$/i.test(text)) {
      const value = parseInt(text, 16);
      out[field] = value > 127 ? value - 256 : value;
    }
  }
  return out;
}

/** The library's update_from_hbt: the heartbeat values replace the temperatures. */
export function mergeHeartbeat(current, heartbeat) {
  const next = { ...current };
  let changed = false;
  for (const [field, value] of Object.entries(heartbeat)) {
    if (value !== current[field]) {
      next[field] = value;
      changed = true;
    }
  }
  return { state: next, changed };
}

// --- What a unit supports ----------------------------------------------------

const ALL_MODES = ['AUTO', 'COOL', 'DRY', 'FAN', 'HEAT'];

/** Merit A / B values a mode does not allow (features.py). */
const DISABLED_MERIT_A = {
  AUTO: ['HEATING_8C', 'SLEEP_CARE', 'FLOOR'],
  COOL: ['HEATING_8C', 'SLEEP_CARE', 'FLOOR'],
  DRY: ['HIGH_POWER', 'ECO', 'CDU_SILENT_1', 'CDU_SILENT_2', 'HEATING_8C', 'SLEEP_CARE', 'FLOOR'],
  HEAT: [],
  FAN: ['HIGH_POWER', 'ECO', 'CDU_SILENT_1', 'CDU_SILENT_2', 'HEATING_8C', 'SLEEP_CARE', 'FLOOR'],
};
const DISABLED_MERIT_B = {
  AUTO: ['FIREPLACE_1', 'FIREPLACE_2'],
  COOL: ['FIREPLACE_1', 'FIREPLACE_2'],
  DRY: ['FIREPLACE_1', 'FIREPLACE_2'],
  HEAT: [],
  FAN: ['FIREPLACE_1', 'FIREPLACE_2'],
};

/**
 * The 16 bits of the MeritFeature hex string of the device list, most
 * significant first. The string is padded with "0" or cut to 4 characters.
 */
export function meritBits(merit) {
  const text = `${String(merit ?? '')}0000`.slice(0, 4);
  const value = /^[0-9a-f]{4}$/i.test(text) ? parseInt(text, 16) : 0;
  return Array.from({ length: 16 }, (_, i) => Boolean(value & (1 << (15 - i))));
}

/**
 * What a unit supports, from the MeritFeature and ACModelId of the device
 * list (features.py from_merit_string_and_model).
 */
export function supportedOf(merit, modelId) {
  const bits = meritBits(merit);
  const model = String(modelId ?? '');
  const modes = {
    'false,false': ALL_MODES,
    'false,true': ['HEAT'],
    'true,false': ['AUTO', 'COOL', 'DRY', 'FAN'],
    'true,true': ALL_MODES,
  }[`${bits[6]},${bits[7]}`];
  const swingModes = ['OFF', 'SWING_VERTICAL'];
  const meritA = ['OFF', 'SLEEP_CARE', 'COMFORT'];
  const meritB = ['OFF'];
  const airPureIon = ['OFF'];
  let energy = false;
  if (model === '2' || model === '3') {
    meritA.push('HIGH_POWER', 'ECO');
    if (bits[0]) meritA.push('FLOOR');
    if (bits[1]) swingModes.push('SWING_HORIZONTAL', 'SWING_VERTICAL_AND_HORIZONTAL');
    if (bits[2]) meritA.push('CDU_SILENT_1', 'CDU_SILENT_2');
    if (bits[3]) airPureIon.push('ON');
    if (bits[4]) meritB.push('FIREPLACE_1', 'FIREPLACE_2');
    if (bits[5]) meritA.push('HEATING_8C');
  }
  if (model === '3') {
    if (bits[14]) swingModes.push('FIXED_1', 'FIXED_2', 'FIXED_3', 'FIXED_4', 'FIXED_5');
    if (bits[15]) energy = true;
  }
  return {
    status: [...VALUES.status],
    modes: [...modes],
    fanModes: [...VALUES.fanMode],
    swingModes,
    powerSelections: [...VALUES.powerSelection],
    meritA,
    meritB,
    airPureIon,
    selfCleaning: [...VALUES.selfCleaning],
    energy,
  };
}

/** The merit values allowed in a mode (features.py for_ac_mode). */
export function meritsForMode(supported, mode) {
  return {
    meritA: supported.meritA.filter((m) => !(DISABLED_MERIT_A[mode] ?? []).includes(m)),
    meritB: supported.meritB.filter((m) => !(DISABLED_MERIT_B[mode] ?? []).includes(m)),
  };
}

// --- Commands ----------------------------------------------------------------

export class UnsupportedError extends Error {}

/**
 * The state a command sends, from the current state of the unit and the
 * fields to change ({ mode: 'HEAT' }, { temperature: 22 }…), as the library's
 * send_state_to_ac builds it:
 * - a mode or status the unit does not support is refused;
 * - a fan, swing, power, ion or cleaning value it does not support is dropped;
 * - a merit the (new) mode does not allow is turned OFF (switching to dry
 *   mode clears eco, switching to cool clears 8 °C heating);
 * - turning on clears the self-cleaning flag;
 * - in 8 °C heating the setpoint is sent 16 degrees higher.
 * @returns {string} the hex state to send
 */
export function commandState(currentRaw, change, supported) {
  const command = emptyState();
  for (const [field, value] of Object.entries(change)) {
    if (TEMPERATURE_FIELDS.includes(field)) {
      command[field] = temperatureRaw(value);
    } else if (value !== null && value !== undefined) {
      const raw = RAW[field]?.[value];
      if (raw === undefined) {
        throw new UnsupportedError(`unknown ${field} ${value}`);
      }
      command[field] = raw;
    }
  }
  const future = readState(mergeState(currentRaw, command).state).fields;
  if (future.status !== null && !supported.status.includes(future.status)) {
    throw new UnsupportedError(`unsupported status ${future.status}`);
  }
  if (future.mode !== null && !supported.modes.includes(future.mode)) {
    throw new UnsupportedError(`unsupported mode ${future.mode}`);
  }
  const drop = (field, list) => {
    if (future[field] !== null && !list.includes(future[field])) {
      command[field] = absent(LAYOUT[field][2]);
    }
  };
  drop('fanMode', supported.fanModes);
  drop('swingMode', supported.swingModes);
  drop('powerSelection', supported.powerSelections);
  const allowed = future.mode ? meritsForMode(supported, future.mode) : supported;
  if (future.meritB !== null && !allowed.meritB.includes(future.meritB)) {
    command.meritB = RAW.meritB.OFF;
  }
  if (future.meritA !== null && !allowed.meritA.includes(future.meritA)) {
    command.meritA = RAW.meritA.OFF;
  }
  drop('airPureIon', supported.airPureIon);
  drop('selfCleaning', supported.selfCleaning);
  const current = readState(currentRaw).fields;
  if (change.status === 'ON' && current.selfCleaning === 'ON') {
    command.selfCleaning = RAW.selfCleaning.OFF;
  }
  if (
    change.temperature !== undefined &&
    future.mode === 'HEAT' &&
    future.meritA === 'HEATING_8C'
  ) {
    command.temperature = temperatureRaw(change.temperature + 16);
  }
  return encodeState(command);
}

/** The message a command is, sent to the IoT Hub (device/__init__.py). */
export function commandMessage({ sourceId, targetId, data }) {
  return {
    sourceId,
    messageId: '0000000',
    targetId: [targetId],
    cmd: 'CMD_FCU_TO_AC',
    payload: { data },
    timeStamp: '0000000',
  };
}

/** Python's repr() of a str: single quotes unless the text has one and no double quote. */
function reprString(text) {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (ch === '\\' || ch === quote) {
      out += `\\${ch}`;
    } else if (ch === '\n') {
      out += '\\n';
    } else if (ch === '\r') {
      out += '\\r';
    } else if (ch === '\t') {
      out += '\\t';
    } else if (code < 0x20 || (code >= 0x7f && code <= 0xa0)) {
      out += `\\x${code.toString(16).padStart(2, '0')}`;
    } else {
      out += ch;
    }
  }
  return quote + out + quote;
}

/**
 * The text of a command as the library sends it: str() of a Python dict, not
 * JSON. It is the only format known to work with the Toshiba cloud (a JSON
 * body was never confirmed), so it is reproduced byte for byte.
 */
export function pythonRepr(value) {
  if (typeof value === 'string') {
    return reprString(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(pythonRepr).join(', ')}]`;
  }
  if (value === null || value === undefined) {
    return 'None';
  }
  if (typeof value === 'boolean') {
    return value ? 'True' : 'False';
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value).map(([k, v]) => `${reprString(k)}: ${pythonRepr(v)}`);
    return `{${entries.join(', ')}}`;
  }
  return String(value);
}
