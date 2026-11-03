# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Fixed

- Adding a unit failed with "HTTP 422 … t_device_feature.min cannot be null"
  (issue #6): the power selection, special mode and fireplace lists
  (`text`/`select`) had no `min` and `max`, which Gladys requires. They now
  have 0 and 0, like the other text/select integrations, and a test checks
  every feature of every device the module can build against the Gladys
  model. Gladys saves a device in one transaction, so nothing of the refused
  unit was kept: update, then add the unit again from the Discovery tab.

### Changed

- Integration SDK 0.16 (`^0.16.0`). The module sets no `poll_frequency`, so
  Gladys 5.3 does not poll its devices. The test script stops a stuck test
  after 60 s (`node --test --test-timeout=60000`).

- README: the store install note replaces the work-in-progress notice, and the
  Releasing section no longer says the store topic is still to be added.

## [0.1.1] - 2026-10-16

### Added

- Login to Toshiba Home AC Control with the user name and the password of the
  app; the session (about three years) is kept in `/data`, so a restart does
  not sign in again, and a refused login is never retried on its own (Toshiba
  locks the account after a few refusals).
- One Gladys air conditioner per unit of the account, with the features the
  unit supports: on/off, mode (auto, cool, heat, dry, fan), setpoint, the 7
  fan speeds, vertical swing and the 5 louver positions, horizontal swing,
  power selection 50/75/100 %, special mode (Hi-POWER, ECO, silent 1/2, 8 °C
  heating, sleep, floor, comfort), fireplace mode, air purifier, indoor and
  outdoor temperatures, energy of the year.
- Live states and commands through the Toshiba Azure IoT Hub (MQTT over TLS),
  with the SAS token kept, registered again when refused, and the link
  reconnected with a growing delay.
- States read over HTTP every 30 minutes, every 5 minutes while the live link
  is down, and right after it comes back.
- Connection status and cloud transport badges (degraded while the live link
  is down), the Toshiba rate limit honoured (Retry-After, up to one hour).
- "Test the connection" button.

[Unreleased]: https://github.com/LM1LC3N7/gladys-toshiba-ac/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-toshiba-ac/releases/tag/v0.1.1
