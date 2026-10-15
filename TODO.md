# TODO — Toshiba Home AC Control v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`,
  `npm run audit`, then update README, `docs/en.md`, `docs/fr.md`,
  `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only (before, the store would list an empty integration).
- No forum topic of its own, ever, and no forum post from a module session:
  the batch claimed in /t/10385 (post #178) gets one recap message there, with
  a link to each repo, once the ten are published.

## Status

- [x] **Milestone 1 — core** (2026-10-15): REST client (login, kept session,
      device list, unit state, energy of the year, RegisterMobileDevice),
      IoT Hub live link over MQTT (unit reports, heartbeats, commands, SAS
      token kept and registered again when refused, reconnection), port of
      the toshiba-ac state field map / supported features / command rules
      checked against the library's own output, AIR_CONDITIONING device with
      on/off, mode, setpoint, 7 fan speeds, vertical swing + 5 louver
      positions, horizontal swing, power selection, special mode, fireplace,
      air purifier, indoor/outdoor temperatures, energy; status messages,
      transport badges, test button, manifest, docs en/fr. 92 tests (golden
      values of the Python library, fake REST API, fake IoT Hub with the real
      `mqtt` client); the Docker image (184 MB) passes a smoke run over real
      TLS against the fakes, read-only under 256 MB / 0.5 CPU (RSS 94 MB):
      `~/gladys-integrations/e2e/toshiba-smoke.sh`. No real account yet.
- [ ] **Milestone 2 — a real account**: see "To check on a real account";
      collect `GetConsumerACMapping` answers (MeritFeature, ACModelId,
      states) from testers as fixtures; fix what differs.
- [ ] **Milestone 3 — more**: self-cleaning as a read-only binary, the
      indoor/outdoor model names as device params, MQTT over WebSockets (443)
      for networks that block 8883, the BrandId login parameter (library
      0.3.13+ master) if some accounts need it, daily energy if an endpoint
      gives it (`Type` other than `EnergyYear`).
- [ ] **Milestone 4 — first release**: cover image, Docker image build check,
      `npx github:GladysAssistant/integration-store .`, Release workflow,
      topic (the forum recap is the main session's, see Working method).

## To check on a real account

- The login: user name vs e-mail, the app User-Agent + Device-ID headers
  together (each one was measured alone), `expires_in`, the session reuse
  after a restart.
- The SAS token: its `sr` device id (expected `<user>_<install id>`), its
  expiry (Home Assistant: about a century), a second Gladys on the same
  account (each has its own install id: do they coexist? does the phone app
  still get its reports?).
- The IoT Hub: CONNECT with api-version 2019-10-01 and `clean: false`, the
  QoS 1 subscription, the method answers (status 0, body `null`), the
  property bag of the commands, and the Python-literal body (the library's
  format; JSON was never confirmed and is not used).
- How often `CMD_HEARTBEAT` arrives, and whether an unit that is off reports
  anything (Home Assistant: no).
- The energy: unit (Wh observed by homebridge-toshiba-home-ac), the
  `EnergyConsumption` list (months?), the reset on January 1st, which units
  set merit bit 15.
- Units with unknown raw values (logged once per value): firmware updates
  added merit B 0x01 before.
- Fixed louver positions: are they the vertical flap (as mapped) on every
  model 3 unit?
- 8 °C heating: the +16 offset of the setpoint, the 5–13 °C range.

## Decisions

- **No duplicate**: nothing in the Gladys core covers Toshiba
  (`server/services` on master ff59ad8: no toshiba/midea/msmart service;
  release notes 4.80 → 5.2.1: no Toshiba entry; MELCloud and Matter are the
  only AC services). The store (393 entries) has no Toshiba integration;
  `guim31/gladys-midea` covers the North American **Toshiba AC NA** units
  (Midea-made, Midea cloud, LAN), a different backend and different units:
  complementary, said in the docs.
- **Own client, no Toshiba dependency** (Louis's reuse rule): no npm library
  exists for the Toshiba Home AC Control API (`toshiba-ac`, `toshiba-ac-api`,
  `toshiba-home-ac`… all 404). Four Homebridge plugins embed a port
  (homebridge-toshiba-home-ac MIT 1.1.3, homebridge-toshiba-plugin
  Apache-2.0, @jonaskpb/homebridge-toshiba-ac Apache-2.0 0.1.0,
  homebridge-toshiba-smart-ac 2023): plugins, not libraries, with 3 to 12
  downloads a week, two of them on Microsoft's azure-iot-device SDK (AMQP or
  MQTT, many dependencies). The reference is the Python library
  `toshiba-ac` (Kamil Sroka, Apache-2.0, 0.3.13 of 2026-05-13, commits to
  July 2026, pinned by the Home Assistant integration): ported (~400 lines
  of protocol), credited in NOTICE and README, checked against its output.
- **Live link with `mqtt`** (already used by gladys-rtl433, 0 audit issue)
  rather than azure-iot-device: the library itself only uses the IoT Hub as a
  plain MQTT device (direct methods in, telemetry out); the topics, the
  api-version, the QoS and the property bag are those of the Python
  azure-iot-device SDK, as @jonaskpb/homebridge-toshiba-ac also does.
- **node:https, not fetch, with an app User-Agent and Device-ID**: Home
  Assistant added a `Device-ID` header in July 2026 (firewall, else 429);
  homebridge-toshiba-home-ac measured in August 2026 that the library's
  Chrome User-Agent, okhttp and Node's `fetch` (which adds `sec-fetch-mode`)
  get 429, `SmartAC/3.4.0 (iPhone; iOS 18.0; Scale/3.00)` over bare
  node:https gets through. Both headers are sent.
- **The session is kept, refused logins are not retried**: the access token
  lives ~3 years; two refused logins lock the account for hours. The session
  is stored with an HMAC of user + password (keyed by the install id) so a
  credential change logs in again; the password is never written.
- **One install id** (16 hex, /data): the mobile device `<user>_<id>` like
  the library (whose default suffix is a fixed value shared by everyone) and
  Home Assistant (random per entry); also the Device-ID header.
- **Command body = Python literal** (`str(dict)` of the library), byte for
  byte, with the JSON content type: the only format confirmed to work
  (homebridge-toshiba-home-ac keeps it as its default for that reason).
- **Feature mapping**: Gladys AC_FAN_SPEED has a value for each of the 7
  Toshiba speeds (quiet = QUIET, medium low = LOW_MID…). The single Toshiba
  swing setting is split into swing-vertical (off, swing, POSITION_1..5 = the
  fixed louver positions) and swing-horizontal (off, swing), each command
  rebuilding the combined value. Merit A is ONE value (Hi-POWER, ECO,
  silent 1/2, 8 °C, sleep, floor, comfort are exclusive): a text/select
  "special mode", not switches. Power selection and fireplace are selects,
  air purifier a switch. Options are restricted to what the unit supports
  (supported_options); a value the unit or its current mode does not allow is
  refused with a message (the library would silently send merit OFF).
- **Setpoint** 17–30 °C (the app), 5–13 °C in 8 °C heating; the feature
  minimum is 5 on units that have 8 °C heating. Whole degrees (rounded).
- **Reloads**: HTTP state every 30 minutes like the library, 5 minutes while
  the live link is down, right after it comes back; energy every 30 minutes
  (library: 10) to spare the rate-limited API.
- **Status**: `connected` only when the live link is up (commands work); the
  live link down shows `cloud` + degraded badges with a message (the SDK
  shows a message only with `degraded: true`).
