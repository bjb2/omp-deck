# syntax=docker/dockerfile:1.7
#
# Whisper-cpp sidecar for omp-deck's voice transcription route.
#
# The deck server (`apps/server`) shells out to this image's `whisper-cli`
# once per `POST /api/transcribe` request. Build once, mount the resulting
# image's binary + model into the deck server's runtime.
#
# Build:  docker build -t omp-deck/whisper:base apps/whisper
# Run:    docker run --rm -v $PWD/out:/out omp-deck/whisper:base \
#             cp /usr/local/bin/whisper-cli /out/
#
# Layered: builder compiles whisper.cpp with BLAS=no (alpine's no-glibc
# toolchain makes OpenBLAS a pain); runtime stage is ~500 MB once the
# ggml-base.bin model is added.

ARG BUN_VERSION=1.3.14

FROM oven/bun:${BUN_VERSION}-alpine AS base
RUN apk add --no-cache ca-certificates wget xz git bash build-base cmake

# ─── whisper.cpp build ────────────────────────────────────────────────────
FROM base AS whisper-builder
ARG WHISPER_CPP_REV=v1.7.2
WORKDIR /src
RUN git clone --depth 1 --branch ${WHISPER_CPP_REV} \
        https://github.com/ggerganov/whisper.cpp.git . \
 && cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_SERVER=OFF -DWHISPER_BUILD_TESTS=OFF \
 && cmake --build build --config Release -j"$(nproc)" --target whisper-cli \
 && cp build/bin/whisper-cli /usr/local/bin/whisper-cli

# ─── model: ggml-base.bin (multilingual; covers fa + en) ───────────────────
FROM base AS model-fetch
WORKDIR /models
# Multilingual base covers Farsi + English at modest accuracy. Switch to
# ggml-small.bin (462 MB) or ggml-medium.bin (1.5 GB) for higher accuracy.
ARG MODEL_URL=https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin
RUN wget -q -O ggml-base.bin "${MODEL_URL}" \
 && ls -la ggml-base.bin

# ─── runtime image ──────────────────────────────────────────────────────────
# Ponytail: no PORT exposed — this image is invoked via shell from the deck
# server, never over the network. The only artifact the deck needs is the
# `whisper` binary + the model file under /models.
FROM alpine:3.20 AS runtime
RUN apk add --no-cache ca-certificates libstdc++ libgcc
COPY --from=whisper-builder /usr/local/bin/whisper-cli /usr/local/bin/whisper
COPY --from=model-fetch   /models/ggml-base.bin            /models/ggml-base.bin

ENV WHISPER_BIN=/usr/local/bin/whisper \
    WHISPER_MODEL=/models/ggml-base.bin

# Smoke check: `--help` exits 0 without touching the model.
RUN /usr/local/bin/whisper --help >/dev/null