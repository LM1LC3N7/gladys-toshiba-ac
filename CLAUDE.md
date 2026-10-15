# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for
human contributors. Read **[TODO.md](./TODO.md) first**: status, decisions
already taken and the next milestones.

## What this is

A Gladys Assistant **external integration** of type `device`: a Node.js
service (Node 22+, ESM, no build step) in its own sandboxed Docker container,
talking to Gladys through `@gladysassistant/integration-sdk` (v0.15). Its one
other runtime dependency is `mqtt`; HTTP is bare `node:https` (never `fetch`,
see TODO.md Decisions). It signs in to the **Toshiba Home AC Control** cloud
with the account of the app, turns the units into Gladys AIR_CONDITIONING
devices, follows them live through the Toshiba Azure IoT Hub and sends the
commands through it. Unofficial, not affiliated with Toshiba.

The unit protocol is ported from `KaSroka/Toshiba-AC-control` (`toshiba-ac`,
Apache-2.0): keep the NOTICE up to date when porting more. The Home
Assistant integration `h4de5/home-assistant-toshiba_ac` is GPL-3.0: read it,
never copy from it.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run audit                             # npm audit --omit=dev
npx github:GladysAssistant/integration-store .   # store admission checks
```

Run `format:check`, `lint`, `test` and `audit` before every commit. Node only
runs in Docker on the author's machine: `~/bin/nrun gladys-toshiba-ac "<cmd>"`.

## Architecture

```
index.js            SDK bootstrap only
src/handlers.js     every SDK handler -> the app (shared with the tests)
src/app.js          ToshibaApp: login, discovery, live link, reloads, commands,
                    status, transports, connection test
src/toshiba.js      the REST API (node:https): login, units, state, energy,
                    RegisterMobileDevice; errors kinds; pacing
src/iothub.js       the IoT Hub link over MQTT: SAS token, direct methods,
                    device-to-cloud commands
src/protocol.js     unit state hex <-> fields, supported features, commands,
                    the Python literal of a command (pure, port of toshiba-ac)
src/devices.js      unit -> Gladys device, states, command -> change (pure)
src/publisher.js    states within the Gladys rate limit
src/storage.js      install id, session, SAS token in /data/toshiba-ac.json
src/config.js       config_schema normalized
src/constants.js    manifest keys, feature keys, Gladys AC enums, timings
src/i18n.js         runtime texts (en/fr)
test/fixtures/      golden values of the Python library, made-up units
test/helpers/       fake REST API, fake IoT Hub (mqtt-packet), manual timers
```

## Rules

- **External ids are forever**: device = `ac:<DeviceUniqueId lowercased,
[a-z0-9_-]>`, feature = `<device>:<key>` with the keys of `FEATURES`
  (constants.js). The select option values (`none`, `eco`, `hi-power`,
  `silent-1`…, `50`/`75`/`100`, `fireplace-1`…) are frozen too: scenes store
  them.
- Manifest keys are frozen: `username`, `password`, `language`,
  `test_connection`.
- Value conventions: the Gladys side uses the core enums of
  `server/utils/constants.js` (AC_MODE, AC_FAN_SPEED, AC_SWING_*), copied in
  constants.js; the Toshiba side the names of the library (`COOL`,
  `MEDIUM_LOW`, `FIXED_3`, `CDU_SILENT_1`…). Convert in devices.js only.
- **Never sign in more than needed**: a few refused logins lock the account
  for hours. The session is kept in /data; a refused login is never retried
  automatically; the test button is the only extra login.
- Commands only go through the IoT Hub: when the live link is down, a command
  fails with a clear message, it is never queued.
- The command body is the Python literal the library sends (`pythonRepr`),
  not JSON, until JSON is confirmed on a real account.
- Container limits: 256 MB RAM, 0.5 CPU, read-only rootfs, only `/data`
  writable, bridge network. Gladys: 300 states/min (the publisher keeps 250).
- Never log or put in a status message the password, a token, the SAS token
  or a request header; errors never quote a URL with credentials.
- Tests never touch the network: fake REST transport, fake IoT Hub on the
  loopback, SDK fake Gladys. The production image is checked over real TLS
  (node:https, mqtts, SNI) against the same fakes by
  `~/gladys-integrations/e2e/toshiba-smoke.sh` (read-only, 256 MB, 0.5 CPU).
- Code, comments, README in English; `docs/en.md` and `docs/fr.md` kept in sync.
- Every user-visible change adds a line under `## [Unreleased]` in
  `CHANGELOG.md`; versions belong to the Release workflow.
