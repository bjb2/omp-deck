# omp-deck whisper sidecar

Self-contained whisper-cpp image that the deck server invokes via shell for
`POST /api/transcribe`. Multilingual `ggml-base.bin` model covers Farsi +
English out of the box; swap to `ggml-small.bin` or `ggml-medium.bin` for
higher accuracy at the cost of size + latency.

## Build

```bash
docker build -t omp-deck/whisper:base apps/whisper
```

Extract the binary if you want to run whisper natively without Docker:

```bash
docker run --rm omp-deck/whisper:base cat /usr/local/bin/whisper > /usr/local/bin/whisper
chmod +x /usr/local/bin/whisper
docker run --rm -v "$PWD/models:/out" omp-deck/whisper:base cp /models/ggml-base.bin /out/
```

## Env

The deck server reads `WHISPER_BIN` to decide whether the sidecar is wired.
If unset, `POST /api/transcribe` returns `501`.

| Var | Purpose |
|-----|---------|
| `WHISPER_BIN` | Absolute path to `whisper-cli`. The deck server picks this up at request time. |
| `WHISPER_MODEL` | Optional. Passed as `--model` to whisper. Default: `/models/ggml-base.bin`. |

## Sample invocation

```bash
whisper-cli \
  --language fa \
  --output-json - \
  -f /tmp/clip.webm
```

stdout is a single JSON object: `{ "text": "...", "language": "fa", "duration": 12.4 }`.
The deck parses it; non-zero exit → 500.

## Model swap

Edit the `MODEL_URL` ARG in the Dockerfile (default `ggml-base.bin`) and rebuild.
Available multilingual models: `ggml-tiny.bin`, `ggml-base.bin`, `ggml-small.bin`,
`ggml-medium.bin`, `ggml-large-v3.bin`.