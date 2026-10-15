# Golden values of the toshiba-ac library

`golden.json` is what the Python library
[toshiba-ac](https://github.com/KaSroka/Toshiba-AC-control) (Kamil Sroka,
Apache License 2.0), version 0.3.13 (the one the Home Assistant integration
pins), computes on hand-made inputs: decoded unit states, partial updates,
encoded fields, supported features per `MeritFeature` / `ACModelId`, the
commands its `ToshibaAcDevice` sends (state and exact message text) and the
heartbeat decoding. `test/protocol.test.js` checks that `src/protocol.js`
computes the same.

The library has no test data of its own and no state comes from a real
account: `generate.py` builds the 19-byte states field by field. It runs the
library's code and prints JSON; regenerate after a library update:

```bash
docker run --rm -v "$PWD/test/fixtures/toshiba-ac:/work:ro" python:3.12-slim \
  sh -c 'pip install -q toshiba-ac==0.3.13 >/dev/null 2>&1 && python -I /work/generate.py 2>/dev/null' \
  > test/fixtures/toshiba-ac/golden.json
```

The folder is left out of Prettier: the file stays as the library printed it.
