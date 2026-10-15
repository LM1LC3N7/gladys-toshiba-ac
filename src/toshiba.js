// -----------------------------------------------------------------------------
// The REST API of Toshiba Home AC Control (mobileapi.toshibahomeaccontrols.com):
// login, registration of this installation as a "mobile device" (which gives
// the SAS token of the live link), the device list, the state of a unit and
// the energy of the year. Commands never go through it: see src/iothub.js.
//
// Written from the toshiba-ac Python library (KaSroka/Toshiba-AC-control,
// Apache-2.0, toshiba_ac/utils/http_api.py), with what the Home Assistant
// integration (h4de5) and the homebridge-toshiba-home-ac plugin (Onur Yuksel,
// MIT) measured on the live service in July-August 2026:
// - a firewall answers 429 to the browser User-Agent of the library and to
//   Node's fetch (which adds browser-only `sec-fetch-*` headers): requests go
//   through bare node:https with an app User-Agent, plus the Device-ID header
//   Home Assistant added;
// - two refused logins in a row can lock the account for hours, and the
//   access token lives about three years: the session is kept (src/storage.js)
//   and a refused login is never retried on its own.
// The password, the tokens and the headers are never logged nor put in an
// error message.
// -----------------------------------------------------------------------------

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { LIMITS, TIMINGS, TOSHIBA_API } from './constants.js';

export class ToshibaError extends Error {}
/** Toshiba refused the user name or the password (InvalidUserNameorPassword). */
export class ToshibaAuthError extends ToshibaError {}
/** HTTP 403/429: the Toshiba firewall slows this client down. */
export class ToshibaRateLimited extends ToshibaError {
  constructor(message, retryAfter = null) {
    super(message);
    /** Milliseconds the server asked to wait, when it said. */
    this.retryAfter = retryAfter;
  }
}
/** The API could not be reached, or did not answer in time. */
export class ToshibaConnectionError extends ToshibaError {}

const PATHS = {
  LOGIN: '/api/Consumer/Login',
  REGISTER: '/api/Consumer/RegisterMobileDevice',
  DEVICES: '/api/AC/GetConsumerACMapping',
  STATE: '/api/AC/GetCurrentACState',
  ENERGY: '/api/AC/GetGroupACEnergyConsumption',
};

/** The app User-Agent the firewall lets through (measured, August 2026). */
export const USER_AGENT = 'SmartAC/3.4.0 (iPhone; iOS 18.0; Scale/3.00)';

const clip = (text, length = 120) => String(text ?? '').slice(0, length);

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One HTTP exchange over bare node:https (node:http for a loopback test
 * server): only the headers given are sent. Settles once: the size limit and
 * the timeout reject before the request is destroyed, and the late events of
 * a destroyed request are ignored.
 * @returns {Promise<{ status: number, headers: object, body: string }>}
 */
export function httpTransport({ method, url, headers, body, timeout, limit }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    let settled = false;
    const settle = (err, value) => {
      if (settled) {
        return;
      }
      settled = true;
      if (err) {
        reject(err);
      } else {
        resolve(value);
      }
    };
    const all = { ...headers };
    if (body !== undefined) {
      all['Content-Length'] = String(Buffer.byteLength(body));
    }
    const send = target.protocol === 'http:' ? httpRequest : httpsRequest;
    const req = send(target, { method, headers: all }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) {
          settle(new ToshibaError(`answer too big (over ${limit} bytes)`));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () =>
        settle(null, {
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
      res.on('error', (err) =>
        settle(new ToshibaConnectionError(`${target.host}: ${clip(err.code ?? err.message, 80)}`)),
      );
    });
    req.setTimeout(timeout, () => {
      settle(new ToshibaConnectionError(`${target.host}: timeout`));
      req.destroy();
    });
    req.on('error', (err) =>
      settle(new ToshibaConnectionError(`${target.host}: ${clip(err.code ?? err.message, 80)}`)),
    );
    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

/** Retry-After in seconds or as an HTTP date -> milliseconds, or null. */
export function retryAfterOf(value, now = Date.now()) {
  const text = String(value ?? '').trim();
  if (text === '') {
    return null;
  }
  if (/^\d+$/.test(text)) {
    return Number(text) * 1000;
  }
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

/** One unit of the device list. */
function unitOf(ac, group) {
  return {
    id: String(ac.Id ?? ''),
    uniqueId: String(ac.DeviceUniqueId ?? ''),
    name: clip(ac.Name || ac.DeviceUniqueId || 'Toshiba AC', 100),
    state: typeof ac.ACStateData === 'string' ? ac.ACStateData : '',
    firmware: ac.FirmwareVersion ? clip(ac.FirmwareVersion, 40) : null,
    merit: typeof ac.MeritFeature === 'string' ? ac.MeritFeature : '',
    model: ac.ACModelId === undefined || ac.ACModelId === null ? '' : String(ac.ACModelId),
    group: group ? clip(group, 100) : null,
  };
}

export class ToshibaClient {
  /**
   * @param {object} options
   * @param {string} options.username user name of the Toshiba Home AC Control account
   * @param {string} options.password
   * @param {string} options.installId 16 hex characters, stable for this installation
   * @param {object} [options.session] a session kept from a previous run
   * @param {(session: object | null) => void} [options.onSession] called when the session changes
   * @param {Function} [options.transport] httpTransport (tests)
   * @param {() => number} [options.now] milliseconds
   * @param {(ms: number) => Promise<void>} [options.sleep]
   * @param {() => number} [options.random] 0..1, for the pacing jitter
   * @param {object} [options.logger]
   */
  constructor({
    username,
    password,
    installId,
    session = null,
    onSession,
    transport = httpTransport,
    now = Date.now,
    sleep = defaultSleep,
    random = Math.random,
    logger,
    baseUrl = TOSHIBA_API,
  }) {
    this.username = username;
    this.password = password;
    this.installId = installId;
    this.session = session;
    this.onSession = onSession;
    this.transport = transport;
    this.now = now;
    this.sleep = sleep;
    this.random = random;
    this.logger = logger;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.queue = Promise.resolve();
    this.notBefore = 0;
    this.loggingIn = undefined;
  }

  /** The id of this installation for the IoT Hub, like the library: `<user>_<16 hex>`. */
  get mobileDeviceId() {
    return `${this.username}_${this.installId}`;
  }

  get consumerId() {
    return this.session?.consumerId ?? null;
  }

  /** A session that can be used: a token not expired (when its lifetime is known). */
  hasSession() {
    const s = this.session;
    return Boolean(s?.token && (!s.expiresAt || s.expiresAt - TIMINGS.sessionMargin > this.now()));
  }

  headers(authenticated) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': USER_AGENT,
      // Asked by the Toshiba firewall since July 2026 (Home Assistant integration).
      'Device-ID': this.installId,
    };
    if (authenticated) {
      headers.Authorization = `${this.session.type} ${this.session.token}`;
    }
    return headers;
  }

  /** Requests one after the other, 150 ms + up to 250 ms apart (like the library). */
  paced(fn) {
    const run = this.queue.then(async () => {
      const wait = this.notBefore - this.now();
      if (wait > 0) {
        await this.sleep(wait);
      }
      this.notBefore =
        this.now() + TIMINGS.requestSpacing + Math.round(this.random() * TIMINGS.requestJitter);
      return fn();
    });
    this.queue = run.catch(() => {});
    return run;
  }

  /** One request -> { status, data, headers }; never logs the headers nor the body. */
  async send(method, path, { query, body, authenticated }) {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, value);
    }
    const response = await this.paced(() =>
      this.transport({
        method,
        url: url.toString(),
        headers: this.headers(authenticated),
        body: body === undefined ? undefined : JSON.stringify(body),
        timeout: TIMINGS.httpTimeout,
        limit: LIMITS.responseBytes,
      }),
    );
    let data = null;
    if (response.body) {
      try {
        data = JSON.parse(response.body);
      } catch {
        data = null;
      }
    }
    this.logger?.debug?.(`${method} ${path} -> ${response.status}`);
    return { status: response.status, data, headers: response.headers ?? {} };
  }

  /** The ResObj of a 200 { IsSuccess: true } answer, or the matching error. */
  resultOf(path, { status, data, headers }) {
    if (status === 403 || status === 429) {
      throw new ToshibaRateLimited(
        `${path}: HTTP ${status}`,
        retryAfterOf(headers['retry-after'], this.now()),
      );
    }
    if (status === 401) {
      throw new ToshibaError(`${path}: access refused (HTTP 401)`);
    }
    if (status !== 200) {
      throw new ToshibaError(`${path}: HTTP ${status}`);
    }
    if (!data || typeof data !== 'object') {
      // An HTML page during outages.
      throw new ToshibaError(`${path}: not a JSON answer`);
    }
    if (data.IsSuccess !== true) {
      if (data.StatusCode === 'InvalidUserNameorPassword') {
        throw new ToshibaAuthError('the user name or the password was refused');
      }
      throw new ToshibaError(`${path}: ${clip(data.Message || data.StatusCode || 'refused')}`);
    }
    return data.ResObj;
  }

  setSession(session) {
    this.session = session;
    this.onSession?.(session);
  }

  async login() {
    const answer = await this.send('POST', PATHS.LOGIN, {
      body: { Username: this.username, Password: this.password },
    });
    const res = this.resultOf(PATHS.LOGIN, answer);
    if (typeof res?.access_token !== 'string' || !res.access_token) {
      throw new ToshibaError(`${PATHS.LOGIN}: no access token`);
    }
    const lifetime = Number(res.expires_in);
    this.setSession({
      type: typeof res.token_type === 'string' && res.token_type ? res.token_type : 'Bearer',
      token: res.access_token,
      consumerId:
        res.consumerId === undefined || res.consumerId === null ? null : String(res.consumerId),
      expiresAt: Number.isFinite(lifetime) && lifetime > 0 ? this.now() + lifetime * 1000 : null,
    });
    this.logger?.info?.('Logged in to Toshiba Home AC Control');
  }

  /** Logs in when there is no usable session; concurrent calls share one login. */
  ensureSession() {
    if (this.hasSession()) {
      return Promise.resolve();
    }
    this.loggingIn ??= this.login().finally(() => {
      this.loggingIn = undefined;
    });
    return this.loggingIn;
  }

  /** An authenticated call: logs in first when needed, and once again on a 401. */
  async call(method, path, { query, body } = {}) {
    await this.ensureSession();
    const used = this.session;
    const run = () => this.send(method, path, { query: query?.(), body, authenticated: true });
    let answer = await run();
    if (answer.status === 401) {
      if (this.session === used) {
        this.logger?.info?.('Toshiba refused the access token: logging in again');
        this.setSession(null);
      }
      await this.ensureSession();
      answer = await run();
    }
    return this.resultOf(path, answer);
  }

  /** Registers this installation: the SAS token of the IoT Hub link. */
  async registerMobileDevice() {
    const res = await this.call('POST', PATHS.REGISTER, {
      body: { DeviceID: this.mobileDeviceId, DeviceType: '1', Username: this.username },
    });
    if (typeof res?.SasToken !== 'string' || !res.SasToken) {
      throw new ToshibaError(`${PATHS.REGISTER}: no SAS token`);
    }
    return res.SasToken;
  }

  /** The units of the account, every group flattened. */
  async listUnits() {
    const res = await this.call('GET', PATHS.DEVICES, {
      query: () => ({ consumerId: this.consumerId ?? '' }),
    });
    const units = [];
    for (const group of Array.isArray(res) ? res : []) {
      for (const ac of Array.isArray(group?.ACList) ? group.ACList : []) {
        const unit = unitOf(ac, group.GroupName);
        if (unit.uniqueId && !units.some((u) => u.uniqueId === unit.uniqueId)) {
          units.push(unit);
        }
      }
    }
    return units.slice(0, LIMITS.units);
  }

  /** The current state of a unit (hex), and the model names of its indoor and outdoor units. */
  async unitState(acId) {
    const res = await this.call('GET', PATHS.STATE, {
      query: () => (this.consumerId ? { ACId: acId, consumerId: this.consumerId } : { ACId: acId }),
    });
    if (typeof res?.ACStateData !== 'string') {
      throw new ToshibaError(`${PATHS.STATE}: no state`);
    }
    const modelName = (part) =>
      typeof part?.model_name === 'string' && part.model_name ? clip(part.model_name, 60) : null;
    return {
      state: res.ACStateData,
      indoorModel: modelName(res.Fcu),
      outdoorModel: modelName(res.Cdu),
    };
  }

  /**
   * The energy of the current year (Wh, as observed) of the given units: the
   * sum of the values the API returns, from January 1st (UTC).
   * @returns {Map<string, number>} unique id -> Wh
   */
  async energyThisYear(uniqueIds) {
    const year = new Date(this.now()).getUTCFullYear();
    const res = await this.call('POST', PATHS.ENERGY, {
      body: {
        ACDeviceUniqueIdList: uniqueIds,
        FromUtcTime: String(year),
        Timezone: 'UTC',
        ToUtcTime: String(year + 1),
        Type: 'EnergyYear',
      },
    });
    const energy = new Map();
    for (const ac of Array.isArray(res) ? res : []) {
      const values = Array.isArray(ac?.EnergyConsumption) ? ac.EnergyConsumption : [];
      const numbers = values.map((v) => Number(v?.Energy));
      if (ac?.ACDeviceUniqueId && numbers.length > 0 && numbers.every(Number.isFinite)) {
        energy.set(
          String(ac.ACDeviceUniqueId),
          numbers.reduce((a, b) => a + b, 0),
        );
      }
    }
    return energy;
  }
}
