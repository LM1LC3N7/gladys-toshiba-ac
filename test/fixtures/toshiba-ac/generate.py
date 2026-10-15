"""Golden values computed by the toshiba-ac Python library.

The library (https://github.com/KaSroka/Toshiba-AC-control, Kamil Sroka,
Apache License 2.0) is the reference of the Toshiba Home AC Control protocol.
This script runs ITS code on hand-made inputs and prints what it computes, as
JSON: the decoded unit states, the encoded commands, the features a unit
supports and the heartbeat decoding. test/protocol.test.js checks that the
JavaScript port computes the same. Nothing of a real account is used.

Run (see README.md):
  docker run --rm -v "$PWD/test/fixtures/toshiba-ac:/work:ro" python:3.12-slim \
    sh -c 'pip install -q toshiba-ac==0.3.13 && python -I /work/generate.py'
"""

import asyncio
import json
import struct

import toshiba_ac
from toshiba_ac.device import ToshibaAcDevice
from toshiba_ac.device.fcu_state import ToshibaAcFcuState
from toshiba_ac.device.features import ToshibaAcFeatures
from toshiba_ac.device.properties import (
    ToshibaAcAirPureIon,
    ToshibaAcFanMode,
    ToshibaAcMeritA,
    ToshibaAcMeritB,
    ToshibaAcMode,
    ToshibaAcPowerSelection,
    ToshibaAcStatus,
    ToshibaAcSwingMode,
)


def enum_name(value):
    return None if value.value is None else value.name


def safe(read):
    """A raw value the library does not know raises KeyError: report it."""
    try:
        value = read()
    except KeyError:
        return "UNKNOWN"
    return enum_name(value) if hasattr(value, "name") else value


def decoded(state):
    return {
        "status": safe(lambda: state.ac_status),
        "mode": safe(lambda: state.ac_mode),
        "temperature": safe(lambda: state.ac_temperature),
        "fan_mode": safe(lambda: state.ac_fan_mode),
        "swing_mode": safe(lambda: state.ac_swing_mode),
        "power_selection": safe(lambda: state.ac_power_selection),
        "merit_b": safe(lambda: state.ac_merit_b),
        "merit_a": safe(lambda: state.ac_merit_a),
        "air_pure_ion": safe(lambda: state.ac_air_pure_ion),
        "indoor_temperature": safe(lambda: state.ac_indoor_temperature),
        "outdoor_temperature": safe(lambda: state.ac_outdoor_temperature),
        "self_cleaning": safe(lambda: state.ac_self_cleaning),
    }


def unit(status, mode, setpoint, fan, swing, power, merit, ion, indoor, outdoor, cleaning="10"):
    """A hand-made unit state (19 bytes): status, mode, setpoint, fan, swing,
    power selection, merit B | merit A (one nibble each), air pure ion, indoor
    temperature, outdoor temperature, 4 unknown bytes, self cleaning, 4
    unknown bytes."""
    return status + mode + setpoint + fan + swing + power + merit + ion + indoor + outdoor + "ff" * 4 + cleaning + "ff" * 4


STATES = {
    "cool_on": unit("30", "42", "16", "41", "31", "64", "00", "10", "18", "1e"),
    "heat_off": unit("31", "43", "15", "34", "41", "4b", "03", "10", "13", "fd"),
    "heat_8c": unit("30", "43", "18", "41", "31", "64", "04", "10", "0f", "02"),
    "heat_8c_merit_b_fireplace": unit("30", "43", "18", "41", "31", "64", "24", "18", "0f", "02"),
    "auto_hipower": unit("30", "41", "18", "36", "42", "4b", "01", "10", "16", "0a"),
    "dry_quiet": unit("30", "44", "1a", "31", "43", "32", "0a", "10", "1a", "1c", "18"),
    "fan_fixed": unit("30", "45", "19", "33", "52", "64", "00", "10", "17", "7e"),
    "eco_silent": unit("30", "42", "1a", "35", "53", "64", "03", "10", "19", "ec"),
    "silent_1": unit("30", "42", "1a", "35", "53", "64", "02", "10", "19", "ec"),
    "merit_b_new_off": unit("30", "42", "1a", "35", "53", "64", "10", "10", "19", "ec"),
    "comfort_sleep": unit("30", "42", "1a", "41", "31", "64", "05", "10", "19", "7f"),
    "floor": unit("30", "43", "1a", "41", "31", "64", "06", "10", "19", "80"),
    "comfort": unit("30", "42", "1a", "41", "31", "64", "07", "10", "19", "ff"),
    "self_cleaning": unit("31", "42", "1a", "41", "31", "64", "00", "10", "19", "ff", "18"),
    "no_mode": unit("02", "00", "00", "41", "31", "64", "00", "10", "19", "14"),
    "partial_status": "30" + "ff" * 18,
    "partial_temperature": "ffff19" + "ff" * 16,
    "partial_merit": "ff" * 6 + "f3" + "ff" * 12,
    "extra_bytes": unit("30", "42", "16", "41", "31", "64", "00", "10", "18", "1e") + "0102030405",
    "unknown_fan": unit("30", "42", "16", "77", "31", "64", "00", "10", "18", "1e"),
}

# Partial updates applied one after the other, like the live reports.
UPDATES = [
    ("cool_on", ["partial_status", "partial_temperature", "partial_merit", "heat_off"]),
]

# MeritFeature strings and ACModelId of the device list.
FEATURES = [
    ("0000", "1"),
    ("0000", "2"),
    ("0000", "3"),
    ("0100", "2"),
    ("0200", "2"),
    ("4000", "2"),
    ("8000", "2"),
    ("2000", "2"),
    ("1000", "2"),
    ("0800", "2"),
    ("0400", "2"),
    ("fc00", "2"),
    ("fc03", "3"),
    ("0003", "3"),
    ("0001", "3"),
    ("0002", "3"),
    ("ffff", "3"),
    ("ff", "2"),
    ("", "1"),
    ("12345", "2"),
]


def supported(merit, model):
    features = ToshibaAcFeatures.from_merit_string_and_model(merit, model)

    def names(values):
        return [enum_name(v) for v in values if v.value is not None]

    def per_mode(mode):
        sub = features.for_ac_mode(mode)
        return {"merit_a": names(sub.ac_merit_a), "merit_b": names(sub.ac_merit_b)}

    return {
        "merit": merit,
        "model": model,
        "modes": names(features.ac_mode),
        "fan_modes": names(features.ac_fan_mode),
        "swing_modes": names(features.ac_swing_mode),
        "power_selections": names(features.ac_power_selection),
        "merit_a": names(features.ac_merit_a),
        "merit_b": names(features.ac_merit_b),
        "air_pure_ion": names(features.ac_air_pure_ion),
        "energy_report": features.ac_energy_report,
        "per_mode": {enum_name(m): per_mode(m) for m in features.ac_mode if m.value is not None},
    }


class CapturedAmqp:
    def __init__(self):
        self.messages = []

    async def send_message(self, message):
        self.messages.append(message)


# Commands sent from a known state: (case, initial state, merit, model,
# setter, value).
COMMANDS = [
    ("on", "heat_off", "fc03", "3", "set_ac_status", ToshibaAcStatus.ON),
    ("off", "cool_on", "fc03", "3", "set_ac_status", ToshibaAcStatus.OFF),
    ("mode_heat", "cool_on", "fc03", "3", "set_ac_mode", ToshibaAcMode.HEAT),
    ("mode_dry_clears_eco", "eco_silent", "fc03", "3", "set_ac_mode", ToshibaAcMode.DRY),
    ("mode_cool_clears_8c", "heat_8c", "fc03", "3", "set_ac_mode", ToshibaAcMode.COOL),
    ("temperature", "cool_on", "fc03", "3", "set_ac_temperature", 23),
    ("temperature_8c", "heat_8c", "fc03", "3", "set_ac_temperature", 10),
    ("fan_quiet", "cool_on", "fc03", "3", "set_ac_fan_mode", ToshibaAcFanMode.QUIET),
    ("fan_high", "cool_on", "fc03", "3", "set_ac_fan_mode", ToshibaAcFanMode.HIGH),
    ("swing_both", "cool_on", "fc03", "3", "set_ac_swing_mode", ToshibaAcSwingMode.SWING_VERTICAL_AND_HORIZONTAL),
    ("swing_fixed_3", "cool_on", "fc03", "3", "set_ac_swing_mode", ToshibaAcSwingMode.FIXED_3),
    ("swing_unsupported", "cool_on", "0000", "1", "set_ac_swing_mode", ToshibaAcSwingMode.SWING_HORIZONTAL),
    ("power_50", "cool_on", "fc03", "3", "set_ac_power_selection", ToshibaAcPowerSelection.POWER_50),
    ("power_75", "cool_on", "fc03", "3", "set_ac_power_selection", ToshibaAcPowerSelection.POWER_75),
    ("eco", "cool_on", "fc03", "3", "set_ac_merit_a", ToshibaAcMeritA.ECO),
    ("hi_power", "cool_on", "fc03", "3", "set_ac_merit_a", ToshibaAcMeritA.HIGH_POWER),
    ("silent_1", "cool_on", "fc03", "3", "set_ac_merit_a", ToshibaAcMeritA.CDU_SILENT_1),
    ("silent_2", "cool_on", "fc03", "3", "set_ac_merit_a", ToshibaAcMeritA.CDU_SILENT_2),
    ("merit_off", "eco_silent", "fc03", "3", "set_ac_merit_a", ToshibaAcMeritA.OFF),
    ("eco_in_fan_mode", "fan_fixed", "fc03", "3", "set_ac_merit_a", ToshibaAcMeritA.ECO),
    ("eco_model_1", "cool_on", "0000", "1", "set_ac_merit_a", ToshibaAcMeritA.ECO),
    ("heating_8c", "heat_off", "fc03", "3", "set_ac_merit_a", ToshibaAcMeritA.HEATING_8C),
    ("fireplace_1", "heat_off", "fc03", "3", "set_ac_merit_b", ToshibaAcMeritB.FIREPLACE_1),
    ("pure_ion_on", "cool_on", "fc03", "3", "set_ac_air_pure_ion", ToshibaAcAirPureIon.ON),
    ("on_clears_self_cleaning", "self_cleaning", "fc03", "3", "set_ac_status", ToshibaAcStatus.ON),
]


async def command(initial, merit, model, setter, value):
    amqp = CapturedAmqp()
    device = ToshibaAcDevice(
        "Unit", "user@example.com_0123456789abcdef", "ac-id", "unique-id",
        STATES[initial], "fw", merit, model, amqp, None,
    )
    try:
        await getattr(device, setter)(value)
    except Exception as err:  # noqa: BLE001 - the error is the golden value
        return {"error": type(err).__name__}
    # The library sends str(dict), a Python literal: keep the exact text and
    # the object it stands for.
    import ast

    return {"raw": amqp.messages[0], "message": ast.literal_eval(amqp.messages[0])}


def device_temperature(name, merit="fc03", model="3"):
    device = ToshibaAcDevice("Unit", "d", "a", "u", STATES[name], "fw", merit, model, None, None)
    return device.ac_temperature


def heartbeat(payload):
    data = {k: struct.unpack("b" if "Temp" in k else "B", bytes.fromhex(v))[0] for k, v in payload.items()}
    state = ToshibaAcFcuState.from_hex_state(STATES["cool_on"])
    changed = state.update_from_hbt(data)
    return {
        "payload": payload,
        "values": data,
        "changed": changed,
        "indoor_temperature": state.ac_indoor_temperature,
        "outdoor_temperature": state.ac_outdoor_temperature,
    }


def updates():
    results = []
    for start, steps in UPDATES:
        state = ToshibaAcFcuState.from_hex_state(STATES[start])
        for step in steps:
            changed = state.update(STATES[step])
            results.append({"start": start, "apply": step, "changed": changed, "state": decoded(state)})
    return results


def encodings():
    """One field set on an empty state: the hex the library sends."""
    out = {}
    cases = {
        "status_on": ("ac_status", ToshibaAcStatus.ON),
        "mode_cool": ("ac_mode", ToshibaAcMode.COOL),
        "temperature_minus_1": ("ac_temperature", -1),
        "temperature_30": ("ac_temperature", 30),
        "fan_auto": ("ac_fan_mode", ToshibaAcFanMode.AUTO),
        "swing_off": ("ac_swing_mode", ToshibaAcSwingMode.OFF),
        "power_100": ("ac_power_selection", ToshibaAcPowerSelection.POWER_100),
        "merit_a_off": ("ac_merit_a", ToshibaAcMeritA.OFF),
        "merit_b_off": ("ac_merit_b", ToshibaAcMeritB.OFF),
        "pure_ion_off": ("ac_air_pure_ion", ToshibaAcAirPureIon.OFF),
    }
    for key, (attr, value) in cases.items():
        state = ToshibaAcFcuState()
        setattr(state, attr, value)
        out[key] = state.encode()
    out["empty"] = ToshibaAcFcuState().encode()
    return out


async def main():
    golden = {
        "library": "toshiba-ac " + toshiba_ac.__version__,
        "states": {name: {"hex": hex_state, "decoded": decoded(ToshibaAcFcuState.from_hex_state(hex_state))}
                   for name, hex_state in STATES.items()},
        "device_temperature": {name: device_temperature(name) for name in ["heat_8c", "heat_8c_merit_b_fireplace", "cool_on", "heat_off"]},
        "updates": updates(),
        "encodings": encodings(),
        "features": [supported(merit, model) for merit, model in FEATURES],
        "commands": [],
        "heartbeats": [heartbeat(p) for p in [{"iTemp": "16", "oTemp": "fe"}, {"iTemp": "7e", "oTemp": "7f"}, {"iTemp": "14"}]],
        # str() of the command dict with unusual user names in sourceId.
        "reprs": [
            {"object": o, "text": str(o)}
            for o in [
                {"sourceId": "o'neil_0123456789abcdef", "targetId": ["a"]},
                {"sourceId": 'say "hi"_0123456789abcdef', "targetId": ["a"]},
                {"sourceId": "both'\"_x", "targetId": ["a"]},
                {"sourceId": "back\\slash\tand\nnew", "targetId": ["a"]},
                {"sourceId": "accentué_0123456789abcdef", "targetId": ["é"]},
            ]
        ],
    }
    for case, initial, merit, model, setter, value in COMMANDS:
        result = await command(initial, merit, model, setter, value)
        golden["commands"].append({"case": case, "initial": initial, "merit": merit, "model": model,
                                   "setter": setter, "value": value if isinstance(value, int) else value.name, **result})
    print(json.dumps(golden, indent=2, sort_keys=False))


asyncio.run(main())
