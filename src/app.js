// -----------------------------------------------------------------------------
// The integration: one Toshiba Home AC Control account, its units as Gladys
// devices, their live state through the IoT Hub link, the commands sent back
// through it, and the status shown in Gladys. index.js only wires the SDK
// handlers to it (src/handlers.js).
//
//   start ─► API: login (kept session) ─► device list ─► devices + states
//                └► live link: SAS token (kept, or RegisterMobileDevice)
//                       └► MQTT to the IoT Hub ─► unit reports, commands
//   timers: state reload over HTTP (30 min, 5 min while the live link is
//   down), energy of the year (30 min), retries with backoff.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './config.js';
import { TIMINGS } from './constants.js';
import { buildDevice, changeOf, idsOf, statesOf } from './devices.js';
import { T } from './i18n.js';
import { IotHubLink, IotHubRefused, parseSasToken } from './iothub.js';
import {
  commandMessage,
  commandState,
  emptyState,
  mergeHeartbeat,
  mergeState,
  parseHeartbeat,
  parseState,
  pythonRepr,
  readState,
  supportedOf,
} from './protocol.js';
import { StatePublisher } from './publisher.js';
import { Storage } from './storage.js';
import { ToshibaAuthError, ToshibaClient, ToshibaRateLimited } from './toshiba.js';

/** A short reason for a status message: never a token, a password or a header. */
const reasonOf = (err) => String(err?.message ?? err ?? 'error').slice(0, 120);

export class ToshibaApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'toshiba-ac' }),
    storage,
    createClient = (options) => new ToshibaClient(options),
    createLink = (options) => new IotHubLink(options),
    now = Date.now,
    timers = globalThis,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.storage = storage ?? new Storage({ logger });
    this.createClient = createClient;
    this.createLink = createLink;
    this.now = now;
    this.timers = timers;
    this.publisher = new StatePublisher({ gladys, logger, now, timers });
    this.config = normalizeConfig();
    this.configKey = undefined;
    this.generation = 0;
    this.client = null;
    this.link = null;
    /** unique id -> { unit, supported, raw, energy, ids, unknown } */
    this.units = new Map();
    /** feature external id -> { entry, key } */
    this.routes = new Map();
    this.apiOk = false;
    this.liveUp = false;
    this.liveRefused = false;
    this.liveDownSince = undefined;
    this.liveConnecting = undefined;
    this.retryDelay = 0;
    this.refused = false;
    this.rawConfig = {};
    this.scheduled = new Map();
    this.backoff = { api: 0, rate: 0, live: 0, refused: 0 };
    this.lastStatus = undefined;
    /** device external id -> transport entry last published (JSON) */
    this.transports = new Map();
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * @param {object} raw the configuration
   * @param {{ force?: boolean }} options force: start again even with the same
   * configuration (the user saved it), instead of a resync
   */
  async start(raw = {}, { force = false } = {}) {
    const config = normalizeConfig(raw);
    const key = JSON.stringify(config);
    if (!force && key === this.configKey && this.client) {
      // Gladys reconnected, same configuration: resend what Gladys may have lost.
      await this.resync();
      return;
    }
    this.stop();
    this.config = config;
    this.configKey = key;
    this.rawConfig = raw;
    if (config.missing.length > 0) {
      await this.setStatus(false, T.notConfigured);
      return;
    }
    await this.setStatus(false, T.connecting);
    const generation = this.generation;
    const installId = await this.storage.installId();
    const session = await this.storage.session(config.username, config.password);
    if (generation !== this.generation) {
      return;
    }
    this.client = this.newClient(installId, session);
    this.publisher.start();
    await this.connectApi(generation);
  }

  newClient(installId, session = null) {
    const { username, password } = this.config;
    return this.createClient({
      username,
      password,
      installId,
      session,
      onSession: (s) =>
        this.storage
          .setSession(username, password, s)
          .catch((err) => this.logger.warn(`Keeping the session failed: ${err.message}`)),
      logger: this.logger,
      now: this.now,
    });
  }

  stop() {
    this.generation += 1;
    for (const timer of this.scheduled.values()) {
      this.timers.clearTimeout(timer);
    }
    this.scheduled.clear();
    this.closeLink();
    this.publisher.stop();
    this.publisher.clear();
    this.client = null;
    this.units.clear();
    this.routes.clear();
    this.apiOk = false;
    this.liveUp = false;
    this.liveRefused = false;
    this.liveDownSince = undefined;
    this.liveConnecting = undefined;
    this.retryDelay = 0;
    this.refused = false;
    this.backoff = { api: 0, rate: 0, live: 0, refused: 0 };
    this.configKey = undefined;
  }

  closeLink() {
    if (this.link) {
      this.link.removeAllListeners();
      this.link.close();
      this.link = null;
    }
  }

  /** Runs `fn` after `delay`, once per name, unless the app was restarted meanwhile. */
  schedule(name, delay, fn) {
    this.timers.clearTimeout(this.scheduled.get(name));
    const generation = this.generation;
    this.scheduled.set(
      name,
      this.timers.setTimeout(() => {
        this.scheduled.delete(name);
        if (generation === this.generation) {
          Promise.resolve()
            .then(fn)
            .catch((err) => this.logger.error(`${name} failed: ${err.message}`));
        }
      }, delay),
    );
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  /** The status once the API answered: the live link decides. */
  async reportStatus() {
    if (!this.liveUp && this.units.size > 0) {
      const wait = this.retryDelay;
      await this.setStatus(false, this.liveRefused ? T.liveRefused(wait) : T.liveDown(wait));
    } else {
      await this.setStatus(true, this.units.size > 0 ? T.connected(this.units.size) : T.noUnit);
    }
  }

  // --- REST API --------------------------------------------------------------

  /** Logs in when needed, lists the units, publishes them, then opens the live link. */
  async connectApi(generation) {
    const client = this.client;
    let units;
    try {
      units = await client.listUnits();
    } catch (err) {
      if (generation === this.generation) {
        await this.apiFailed(err, () => this.connectApi(generation));
      }
      return;
    }
    if (generation !== this.generation) {
      return;
    }
    this.apiOk = true;
    this.refused = false;
    this.backoff.api = 0;
    this.backoff.rate = 0;
    this.setUnits(units);
    this.logger.info(`Toshiba Home AC Control: ${units.length} unit(s) on the account`);
    await this.publishDevices();
    await this.publishAllStates();
    this.scheduleStateReload();
    this.scheduleEnergy(0);
    if (this.units.size === 0) {
      await this.reportStatus();
      await this.publishTransports();
      return;
    }
    if (!this.link && !this.liveConnecting && !this.scheduled.has('live link')) {
      await this.connectLive(generation);
    } else {
      await this.reportStatus();
      await this.publishTransports();
    }
  }

  /** The units of the device list: kept entries keep their state. */
  setUnits(units) {
    const entries = new Map();
    for (const unit of units) {
      const known = this.units.get(unit.uniqueId);
      const parsed = parseState(unit.state);
      if (!parsed && unit.state) {
        this.logger.warn(`"${unit.name}": unreadable state in the device list`);
      }
      const raw = known
        ? parsed
          ? mergeState(known.raw, parsed).state
          : known.raw
        : (parsed ?? emptyState());
      entries.set(unit.uniqueId, {
        unit,
        supported: supportedOf(unit.merit, unit.model),
        raw,
        energy: known?.energy ?? null,
        ids: idsOf(this.gladys, unit),
        unknown: known?.unknown ?? new Set(),
      });
    }
    this.units = entries;
    this.routes.clear();
    for (const entry of entries.values()) {
      for (const feature of buildDevice(this.gladys, entry, this.config.language).features) {
        this.routes.set(feature.external_id, {
          entry,
          key: feature.external_id.slice(entry.ids.device.length + 1),
        });
      }
    }
  }

  async apiFailed(err, retry) {
    this.apiOk = false;
    if (err instanceof ToshibaAuthError) {
      // Never retried on its own: two refused logins can lock the account for hours.
      this.refused = true;
      this.logger.warn(`Toshiba refused the credentials: ${reasonOf(err)}`);
      await this.setStatus(false, T.refused);
    } else if (err instanceof ToshibaRateLimited) {
      this.backoff.rate = this.backoff.rate
        ? Math.min(this.backoff.rate * 3, TIMINGS.rateLimitMax)
        : TIMINGS.rateLimitMin;
      const wait = Math.max(err.retryAfter ?? 0, this.backoff.rate);
      this.logger.warn(
        `Toshiba rate limit (${reasonOf(err)}): next attempt in ${Math.round(wait / 1000)} s`,
      );
      if (!this.liveUp) {
        await this.setStatus(false, T.rateLimited(wait));
      }
      this.schedule('api', wait, retry);
    } else {
      this.backoff.api = this.backoff.api
        ? Math.min(this.backoff.api * 2, TIMINGS.retryMax)
        : TIMINGS.retryMin;
      const wait = this.backoff.api;
      this.logger.warn(`Toshiba API: ${reasonOf(err)}`);
      if (!this.liveUp) {
        await this.setStatus(false, T.unreachable(reasonOf(err), wait));
      }
      this.schedule('api', wait, retry);
    }
    await this.publishTransports();
  }

  scheduleStateReload() {
    const delay =
      this.liveUp || this.units.size === 0 ? TIMINGS.stateReload : TIMINGS.stateReloadDegraded;
    this.schedule('state reload', delay, () => this.reloadStates());
  }

  /** Reads every unit over HTTP: the safety net of the live link. */
  async reloadStates() {
    const generation = this.generation;
    try {
      for (const entry of [...this.units.values()]) {
        const { state } = await this.client.unitState(entry.unit.id);
        if (generation !== this.generation) {
          return;
        }
        this.applyState(entry, state, 'HTTP');
      }
      this.apiOk = true;
      this.backoff.api = 0;
      this.backoff.rate = 0;
      await this.publishTransports();
      this.scheduleStateReload();
    } catch (err) {
      if (generation === this.generation) {
        await this.apiFailed(err, () => this.reloadStates());
      }
    }
  }

  scheduleEnergy(delay = TIMINGS.energyReload) {
    if ([...this.units.values()].some((e) => e.supported.energy)) {
      this.schedule('energy', delay, () => this.reloadEnergy());
    }
  }

  async reloadEnergy() {
    const generation = this.generation;
    const entries = [...this.units.values()].filter((e) => e.supported.energy);
    try {
      const energy = await this.client.energyThisYear(entries.map((e) => e.unit.uniqueId));
      if (generation !== this.generation) {
        return;
      }
      for (const entry of entries) {
        if (energy.has(entry.unit.uniqueId)) {
          entry.energy = energy.get(entry.unit.uniqueId);
          this.pushStates(entry);
        }
      }
    } catch (err) {
      if (generation !== this.generation) {
        return;
      }
      if (err instanceof ToshibaAuthError) {
        await this.apiFailed(err);
        return;
      }
      // Not worth more requests to a rate-limited API: the next reading will do.
      this.logger.warn(`Reading the energy failed: ${reasonOf(err)}`);
    }
    this.scheduleEnergy();
  }

  // --- Live link -------------------------------------------------------------

  /** A SAS token: the kept one while it is valid, else a new registration. */
  async sasToken({ fresh = false } = {}) {
    const { username } = this.config;
    if (!fresh) {
      const kept = await this.storage.sasToken(username);
      const sas = parseSasToken(kept);
      if (sas && (!sas.expiresAt || sas.expiresAt - TIMINGS.sasMargin > this.now())) {
        return { token: kept, fresh: false };
      }
    }
    const token = await this.client.registerMobileDevice();
    if (!parseSasToken(token)) {
      throw new Error('Toshiba returned an unreadable SAS token');
    }
    await this.storage.setSasToken(username, token);
    return { token, fresh: true };
  }

  /** Opens the live link; a second call while one is under way waits for it. */
  connectLive(generation, options) {
    if (!this.liveConnecting) {
      this.liveConnecting = this.openLive(generation, options).finally(() => {
        this.liveConnecting = undefined;
      });
    }
    return this.liveConnecting;
  }

  async openLive(generation, { fresh = false } = {}) {
    this.closeLink();
    let sas;
    let link;
    try {
      sas = await this.sasToken({ fresh });
      if (generation !== this.generation) {
        return;
      }
      link = this.createLink({ sasToken: sas.token, logger: this.logger });
      this.link = link;
      link.on('unit', (message) => this.onUnitMessage(message));
      link.on('close', () => this.liveLost(link));
      await link.connect();
    } catch (err) {
      if (generation !== this.generation) {
        return;
      }
      if (this.link === link) {
        this.closeLink();
      }
      await this.liveFailed(err, generation, sas?.fresh);
      return;
    }
    if (generation !== this.generation) {
      link.close();
      return;
    }
    const reconnected = this.liveDownSince !== undefined;
    this.liveUp = true;
    this.liveRefused = false;
    this.liveDownSince = undefined;
    this.backoff.live = 0;
    this.backoff.refused = 0;
    this.logger.info('Live link to the Toshiba IoT Hub up');
    await this.reportStatus();
    await this.publishTransports();
    this.scheduleStateReload();
    if (reconnected) {
      // What changed while the link was down.
      this.schedule('state reload', 0, () => this.reloadStates());
    }
  }

  async liveFailed(err, generation, fresh) {
    this.liveUp = false;
    this.liveDownSince ??= this.now();
    if (err instanceof IotHubRefused && !fresh) {
      // The kept token is refused: register again, once.
      this.logger.warn(`${reasonOf(err)}: registering a new SAS token`);
      await this.storage.setSasToken(this.config.username, null);
      await this.openLive(generation, { fresh: true });
      return;
    }
    if (err instanceof ToshibaAuthError || err instanceof ToshibaRateLimited) {
      await this.apiFailed(err, () => this.connectLive(generation));
      return;
    }
    let wait;
    if (err instanceof IotHubRefused) {
      // Refused with a token Toshiba just issued: not a token problem.
      this.liveRefused = true;
      this.backoff.refused = this.backoff.refused
        ? Math.min(this.backoff.refused * 2, TIMINGS.rateLimitMax)
        : TIMINGS.liveRefusedRetry;
      wait = this.backoff.refused;
      this.logger.error(`${reasonOf(err)}, even with a new SAS token: is another client using it?`);
    } else {
      this.backoff.live = this.backoff.live
        ? Math.min(this.backoff.live * 2, TIMINGS.retryMax)
        : TIMINGS.retryMin;
      wait = this.backoff.live;
      this.logger.warn(`Live link: ${reasonOf(err)}`);
    }
    this.retryDelay = wait;
    await this.reportStatus();
    await this.publishTransports();
    this.scheduleStateReload();
    this.schedule('live link', wait, () => this.connectLive(this.generation));
  }

  /** The hub closed an established link: reconnect soon. */
  liveLost(link) {
    if (link !== this.link) {
      return;
    }
    this.closeLink();
    this.logger.warn('Live link to the Toshiba IoT Hub lost');
    this.liveFailed(new Error('connection lost'), this.generation, true).catch((err) =>
      this.logger.error(`Reconnection failed: ${err.message}`),
    );
  }

  /** A report of a unit: CMD_FCU_FROM_AC (state) or CMD_HEARTBEAT (temperatures). */
  onUnitMessage({ cmd, sourceId, payload }) {
    const entry = this.units.get(sourceId);
    if (!entry) {
      this.logger.debug(`Report of an unknown unit ignored (${cmd})`);
      return;
    }
    if (cmd === 'CMD_FCU_FROM_AC') {
      if (typeof payload.data !== 'string') {
        this.logger.warn(`"${entry.unit.name}": malformed state report`);
        return;
      }
      this.applyState(entry, payload.data, 'live');
    } else if (cmd === 'CMD_HEARTBEAT') {
      const { state, changed } = mergeHeartbeat(entry.raw, parseHeartbeat(payload));
      if (changed) {
        entry.raw = state;
        this.pushStates(entry);
      }
    } else {
      this.logger.debug(`Unhandled unit command ${String(cmd).slice(0, 40)}`);
    }
  }

  applyState(entry, hex, source) {
    const parsed = parseState(hex);
    if (!parsed) {
      this.logger.warn(`"${entry.unit.name}": unreadable ${source} state`);
      return;
    }
    const { state, changed } = mergeState(entry.raw, parsed);
    entry.raw = state;
    if (changed) {
      this.logger.debug(`"${entry.unit.name}": ${source} state ${hex.slice(0, 38)}`);
      this.pushStates(entry);
    }
  }

  // --- Publication -----------------------------------------------------------

  createdDevices() {
    return new Set((this.gladys.devices ?? []).map((d) => d.external_id));
  }

  async publishDevices() {
    const devices = [...this.units.values()].map((entry) =>
      buildDevice(this.gladys, entry, this.config.language),
    );
    await this.gladys
      .publishDiscoveredDevices(devices)
      .catch((err) => this.logger.warn(`Publishing the discovered devices failed: ${err.message}`));
  }

  /** Queues the states of a unit the user added (Gladys drops the others). */
  pushStates(entry) {
    if (!this.createdDevices().has(entry.ids.device)) {
      return;
    }
    const { fields, unknown } = readState(entry.raw);
    for (const field of unknown) {
      const key = `${field}=${entry.raw[field]}`;
      if (!entry.unknown.has(key)) {
        entry.unknown.add(key);
        this.logger.warn(
          `"${entry.unit.name}": unknown ${field} value 0x${entry.raw[field].toString(16)}`,
        );
      }
    }
    for (const [key, value] of statesOf(entry, fields, entry.energy)) {
      this.publisher.push(entry.ids.feature(key), value);
    }
  }

  async publishAllStates() {
    for (const entry of this.units.values()) {
      this.pushStates(entry);
    }
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending the states failed: ${err.message}`));
  }

  transportOf() {
    if (this.liveUp) {
      return { transport: DEVICE_TRANSPORTS.CLOUD };
    }
    if (this.apiOk) {
      return { transport: DEVICE_TRANSPORTS.CLOUD, degraded: true, message: T.badge.liveDown };
    }
    return { transport: DEVICE_TRANSPORTS.UNREACHABLE };
  }

  async publishTransports() {
    const created = this.createdDevices();
    const entries = [];
    for (const entry of this.units.values()) {
      const externalId = entry.ids.device;
      const transport = { external_id: externalId, ...this.transportOf() };
      const key = JSON.stringify(transport);
      if (created.has(externalId) && this.transports.get(externalId) !== key) {
        this.transports.set(externalId, key);
        entries.push(transport);
      }
    }
    if (entries.length > 0) {
      await this.gladys
        .publishTransports(entries)
        .catch((err) => this.logger.warn(`Transport badges failed: ${err.message}`));
    }
  }

  /** Gladys reconnected: publish again what it may have lost. */
  async resync() {
    this.transports.clear();
    this.lastStatus = undefined;
    if (this.refused) {
      await this.setStatus(false, T.refused);
      return;
    }
    if (!this.apiOk && !this.liveUp) {
      return;
    }
    await this.publishDevices();
    this.gladys.forgetPublishedStates();
    await this.publishAllStates();
    await this.reportStatus();
    await this.publishTransports();
  }

  // --- Devices created by the user -----------------------------------------

  entryOfDevice(externalId) {
    return [...this.units.values()].find((e) => e.ids.device === externalId);
  }

  async deviceCreated(device) {
    const entry = this.entryOfDevice(device?.external_id);
    if (entry) {
      this.transports.delete(entry.ids.device);
      this.pushStates(entry);
      await this.publisher
        .flush()
        .catch((err) => this.logger.warn(`Sending the states failed: ${err.message}`));
      await this.publishTransports();
    }
  }

  async deviceDeleted(device) {
    if (device?.external_id) {
      this.transports.delete(device.external_id);
      this.publisher.forget(device.external_id);
    }
  }

  /** The Discovery screen asks for the units: list them again. */
  async scan() {
    if (!this.client || this.refused) {
      return;
    }
    await this.connectApi(this.generation);
  }

  // --- Commands --------------------------------------------------------------

  async setValue(device, feature, value) {
    const route = this.routes.get(feature?.external_id);
    if (!route) {
      throw new Error('unknown Toshiba feature: scan the units again');
    }
    if (!this.liveUp || !this.link) {
      throw new Error('the live link to Toshiba is down: commands are unavailable for now');
    }
    const { entry, key } = route;
    const { fields } = readState(entry.raw);
    // An UnsupportedError carries the message Gladys shows for the failed command.
    const change = changeOf(entry, key, value, fields);
    const data = commandState(entry.raw, change, entry.supported);
    const body = pythonRepr(
      commandMessage({
        sourceId: this.client.mobileDeviceId,
        targetId: entry.unit.uniqueId,
        data,
      }),
    );
    await this.link.send(body);
    this.logger.info(`"${entry.unit.name}": ${key} set to ${value} (${data})`);
  }

  // --- Configuration screen button -------------------------------------------

  /**
   * Logs in with the saved configuration (a real login: it checks the
   * password) and lists the units. Does not open a second live link: the hub
   * accepts one connection per device, it would cut the running one.
   */
  async testConnection() {
    if (this.config.missing.length > 0) {
      return T.notConfigured;
    }
    const client = this.newClient(await this.storage.installId());
    try {
      const units = await client.listUnits();
      if (this.refused) {
        // The credentials work now: start again.
        this.start(this.rawConfig, { force: true }).catch((e) =>
          this.logger.error(`Start failed: ${e.message}`),
        );
      }
      return T.test.ok(
        units.map((u) => u.name),
        this.liveUp,
      );
    } catch (err) {
      if (err instanceof ToshibaAuthError) {
        return T.test.refused;
      }
      if (err instanceof ToshibaRateLimited) {
        return T.test.rateLimited;
      }
      return T.test.failed(reasonOf(err));
    }
  }
}
