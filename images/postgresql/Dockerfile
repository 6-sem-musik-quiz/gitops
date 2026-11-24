ARG BASE_IMAGE=registry-1.docker.io/bitnami/postgresql@sha256:ec2ef1dfb067c66aa83081405438e80786b4fae4647ca94330e0fc94398b9207

FROM ${BASE_IMAGE} AS builder
USER 0
RUN tdnf install -y \
    gcc \
    make \
    glibc-devel \
    linux-api-headers \
    binutils \
    git \
    ca-certificates

RUN test -f /usr/include/linux/errno.h
RUN git clone --depth 1 --branch v0.8.7 \
    https://github.com/pgvector/pgvector.git /tmp/pgvector

WORKDIR /tmp/pgvector
RUN make OPTFLAGS="" with_llvm=no \
    PG_CONFIG=/opt/bitnami/postgresql/bin/pg_config

FROM ${BASE_IMAGE}
USER 0
COPY --from=builder /tmp/pgvector/vector.so \
    /opt/bitnami/postgresql/lib/vector.so
USER 1001
