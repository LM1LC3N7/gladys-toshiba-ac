// -----------------------------------------------------------------------------
// Keys shared with the manifest (frozen: users store them in their
// configuration and scenes) and the tuning of the integration.
// -----------------------------------------------------------------------------

/** Manifest `actions` keys. */
export const ACTIONS = {
  TEST: 'test_connection',
};

/** The REST API of the Toshiba Home AC Control app. */
export const TOSHIBA_API = 'https://mobileapi.toshibahomeaccontrols.com';

/** Device type of the external ids: ext:<selector>:ac:<DeviceUniqueId>. */
export const DEVICE_TYPE = 'ac';

/** Feature keys, the end of the feature external ids: never rename one. */
export const FEATURES = {
  POWER: 'binary',
  MODE: 'mode',
  SETPOINT: 'target-temperature',
  FAN: 'fan-speed',
  SWING_VERTICAL: 'swing-vertical',
  SWING_HORIZONTAL: 'swing-horizontal',
  POWER_SELECTION: 'power-selection',
  SPECIAL_MODE: 'special-mode',
  FIREPLACE: 'fireplace',
  AIR_PURIFIER: 'air-purifier',
  INDOOR: 'indoor-temperature',
  OUTDOOR: 'outdoor-temperature',
  ENERGY: 'energy',
};

/** Gladys core values (server/utils/constants.js, the SDK does not export them). */
export const AC_MODE = { AUTO: 0, COOLING: 1, HEATING: 2, DRYING: 3, FAN: 4 };
export const AC_FAN_SPEED = {
  AUTO: 0,
  LOW: 1,
  LOW_MID: 2,
  MID: 3,
  MID_HIGH: 4,
  HIGH: 5,
  QUIET: 6,
  TURBO: 7,
};
export const AC_SWING_VERTICAL = {
  OFF: 0,
  SWING: 1,
  POSITION_1: 2,
  POSITION_2: 3,
  POSITION_3: 4,
  POSITION_4: 5,
  POSITION_5: 6,
};
export const AC_SWING_HORIZONTAL = {
  OFF: 0,
  SWING: 1,
  POSITION_1: 2,
  POSITION_2: 3,
  POSITION_3: 4,
  POSITION_4: 5,
  POSITION_5: 6,
  SWING_OPPOSITE: 7,
};

/** Setpoint bounds (°C), as in the Toshiba app; 8 °C heating has its own. */
export const SETPOINT = { min: 17, max: 30, heating8cMin: 5, heating8cMax: 13 };

export const LIMITS = {
  /** Gladys accepts 300 states per minute: keep a margin. */
  statesPerMinute: 250,
  /** Size of a Toshiba API answer (bytes). */
  responseBytes: 4 * 1024 * 1024,
  /** Units handled for one account. */
  units: 50,
};

export const TIMINGS = {
  /** One HTTP request to the Toshiba API (the library: 20 s total). */
  httpTimeout: 20_000,
  /** Minimum spacing of two requests, plus a random jitter (the library). */
  requestSpacing: 150,
  requestJitter: 250,
  /** The states are read over HTTP this often, a safety net for the live link (the library: 30 min). */
  stateReload: 30 * 60_000,
  /** …and this often while the live link is down. */
  stateReloadDegraded: 5 * 60_000,
  /** Energy of the year, for the units that report it. */
  energyReload: 30 * 60_000,
  /** Connection of the live link (the HA integration bounds it to 30 s). */
  mqttConnectTimeout: 30_000,
  mqttKeepalive: 60,
  mqttPublishTimeout: 10_000,
  /** A SAS token is registered again this long before it expires. */
  sasMargin: 5 * 60_000,
  /** A kept access token is replaced this long before it expires (it lives ~3 years). */
  sessionMargin: 24 * 3600_000,
  /** Reconnection delays of the live link and of the API (doubled each time, up to the max). */
  retryMin: 5000,
  retryMax: 5 * 60_000,
  /** The live link refused even a fresh SAS token: try again this late. */
  liveRefusedRetry: 5 * 60_000,
  /**
   * HTTP 403/429: the Toshiba firewall slows us down and "holds a grudge":
   * wait longer each time (×3), or what Retry-After says.
   */
  rateLimitMin: 5 * 60_000,
  rateLimitMax: 60 * 60_000,
  /** The pending states are sent at this pace. */
  flushInterval: 1000,
  /** An unchanged value is re-sent this often, so it stays recently dated in Gladys. */
  stateHeartbeat: 30 * 60_000,
};
