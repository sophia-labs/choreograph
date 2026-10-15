FROM debian:bookworm-slim AS python-runtime-builder

ARG PYTHON_ASSET=cpython-3.12.13+20260510-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz
ARG PYTHON_URL=https://github.com/astral-sh/python-build-standalone/releases/download/20260510/cpython-3.12.13%2B20260510-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz
ARG PYTHON_SHA256=d480f5d5878910ecbae212bf23bd7c25d7b209eb8cf5e98823c977384d272e88
ARG UV_ASSET=uv-x86_64-unknown-linux-gnu.tar.gz
ARG UV_URL=https://github.com/astral-sh/uv/releases/download/0.11.28/uv-x86_64-unknown-linux-gnu.tar.gz
ARG UV_SHA256=e490a6464492183c5d4534a5527fb4440f7f2bb2f228162ad7e4afe076dc0224

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl \
	&& rm -rf /var/lib/apt/lists/*
COPY deploy/python-runtime-requirements.lock /build/python-runtime-requirements.lock
RUN mkdir -p /opt/runtime/python /tmp/uv \
	&& curl --fail --location --retry 3 --output "/tmp/${PYTHON_ASSET}" "${PYTHON_URL}" \
	&& echo "${PYTHON_SHA256}  /tmp/${PYTHON_ASSET}" | sha256sum --check --status \
	&& curl --fail --location --retry 3 --output "/tmp/${UV_ASSET}" "${UV_URL}" \
	&& echo "${UV_SHA256}  /tmp/${UV_ASSET}" | sha256sum --check --status \
	&& tar xzf "/tmp/${PYTHON_ASSET}" -C /opt/runtime/python --strip-components=1 \
	&& tar xzf "/tmp/${UV_ASSET}" -C /tmp/uv \
	&& UV_BIN="$(find /tmp/uv -type f -name uv -perm /111 -print -quit)" \
	&& test -n "${UV_BIN}" \
	&& UV_SYSTEM_PYTHON=1 "${UV_BIN}" pip install \
		--python /opt/runtime/python/bin/python3 \
		--system \
		--require-hashes \
		--no-deps \
		--only-binary :all: \
		-r /build/python-runtime-requirements.lock \
	&& test "$(head -n 1 /opt/runtime/python/bin/ipython)" = '#!/opt/runtime/python/bin/python3' \
	&& PYTHONNOUSERSITE=1 PYTHONDONTWRITEBYTECODE=1 /opt/runtime/python/bin/python3 -I -c \
		'import sys, ipykernel, jupyter_client, zmq; assert sys.version_info[:2] == (3, 12)' \
	&& find /opt/runtime/python -type d -name __pycache__ -prune -exec rm -rf {} + \
	&& find /opt/runtime/python -type f \( -name '*.pyc' -o -name '*.pyo' \) -delete \
	&& rm -rf /tmp/${PYTHON_ASSET} /tmp/${UV_ASSET} /tmp/uv

FROM debian:bookworm-slim AS julia-runtime-builder

# Pinned portable Julia. The sha256 is the one published for this exact asset in
# https://julialang-s3.julialang.org/bin/versions.json — verified below, so a
# swapped tarball fails the build instead of reaching the sandbox.
ARG JULIA_ASSET=julia-1.11.9-linux-x86_64.tar.gz
ARG JULIA_URL=https://julialang-s3.julialang.org/bin/linux/x64/1.11/julia-1.11.9-linux-x86_64.tar.gz
ARG JULIA_SHA256=b36363356d7a05eaf8b7b9e7a91c710f6bd3d2940be4d4e6d14b9a9f2927de35
ARG IJULIA_VERSION=1.34.4

ENV JULIA_RUNTIME_ROOT=/opt/runtime/julia
ENV IJULIA_VERSION=${IJULIA_VERSION}

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl \
	&& rm -rf /var/lib/apt/lists/*
# Kept as its own layer so editing the depot recipe below does not re-download
# 273 MB of Julia on every iteration.
RUN mkdir -p "${JULIA_RUNTIME_ROOT}" \
	&& curl --fail --location --retry 3 --output "/tmp/${JULIA_ASSET}" "${JULIA_URL}" \
	&& echo "${JULIA_SHA256}  /tmp/${JULIA_ASSET}" | sha256sum --check --status \
	&& tar xzf "/tmp/${JULIA_ASSET}" -C "${JULIA_RUNTIME_ROOT}" --strip-components=1 \
	&& rm -f "/tmp/${JULIA_ASSET}"
COPY deploy/julia-runtime/ /build/julia-runtime/
RUN install -m 0644 /build/julia-runtime/launch_kernel.jl "${JULIA_RUNTIME_ROOT}/launch_kernel.jl" \
	&& bash /build/julia-runtime/build-depot.sh

FROM debian:bookworm-slim AS ocaml-runtime-builder

# ocaml-jupyter (akabe). Pinned by tag AND by the commit that tag resolves to,
# so a moved tag fails the build instead of reaching the sandbox.
ARG OCAML_JUPYTER_VERSION=3.0.1
ARG OCAML_JUPYTER_COMMIT=295c9f994fce18e22134ed04e99b3e2d94e6c9f7
ARG OCAML_JUPYTER_URL=https://github.com/akabe/ocaml-jupyter.git
# The newest compiler ocaml-jupyter supports: v3.0.1 is the release that added
# 5.4.0 to its CI matrix and to the compiler-libs shims in src/repl/*.cppo.ml.
ARG OCAML_VERSION=5.4.0
# opam-repository is pinned by commit — for git, the sha is the checksum, and
# git verifies it. This is what fixes every transitive dependency version.
ARG OPAM_REPOSITORY_URL=https://github.com/ocaml/opam-repository.git
ARG OPAM_REPOSITORY_COMMIT=4f41495f12b15921ce982ac208c41b257d295515
ARG OPAM_URL=https://github.com/ocaml/opam/releases/download/2.5.2/opam-2.5.2-x86_64-linux
ARG OPAM_SHA256=edfca2630c373b44b7ee1c2f81cd8dcf67468d0db57d6c02158de553ac63dbd4
# The sandbox carries no system libraries, so the libzmq the OCaml zmq stubs
# link travels inside the bundle rather than being borrowed from the host.
ARG ZEROMQ_ASSET=zeromq-4.3.5.tar.gz
ARG ZEROMQ_URL=https://github.com/zeromq/libzmq/releases/download/v4.3.5/zeromq-4.3.5.tar.gz
ARG ZEROMQ_SHA256=6653ef5910f17954861fe72332e68b03ca6e4d9c7160eb3a8de5a5a913bfab43

ENV OCAML_RUNTIME_ROOT=/opt/runtime/ocaml
ENV OCAML_JUPYTER_SRC=/build/ocaml-jupyter
ENV OCAML_JUPYTER_VERSION=${OCAML_JUPYTER_VERSION}
ENV OCAML_JUPYTER_COMMIT=${OCAML_JUPYTER_COMMIT}
ENV OCAML_VERSION=${OCAML_VERSION}
ENV PATCH_DIR=/build/ocaml-runtime
# Build-only scaffolding: download cache, repository clone, package metadata.
# Only ${OCAML_RUNTIME_ROOT} is copied into the image.
ENV OPAMROOT=/build/opamroot
ENV OPAMYES=1
ENV OPAMCOLOR=never
ENV OPAMROOTISOK=1
# Point the C toolchain at the bundled libzmq so conf-zmq's pkg-config probe and
# the zmq stubs both resolve the copy that ships, not one from /usr.
ENV PKG_CONFIG_PATH=${OCAML_RUNTIME_ROOT}/lib/pkgconfig
ENV C_INCLUDE_PATH=${OCAML_RUNTIME_ROOT}/include
ENV LIBRARY_PATH=${OCAML_RUNTIME_ROOT}/lib

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		build-essential ca-certificates curl git libgmp-dev m4 patch patchelf \
		pkg-config rsync unzip zlib1g-dev \
	&& rm -rf /var/lib/apt/lists/*
RUN curl --fail --location --retry 3 --output /tmp/opam "${OPAM_URL}" \
	&& echo "${OPAM_SHA256}  /tmp/opam" | sha256sum --check --status \
	&& install -m 0755 /tmp/opam /usr/local/bin/opam \
	&& rm -f /tmp/opam \
	&& opam --version
# Installed into the bundle root, not /usr: this shared object has to be inside
# the read-only mount the sandbox gets, because nothing else will be.
RUN mkdir -p /build/zeromq \
	&& curl --fail --location --retry 3 --output "/tmp/${ZEROMQ_ASSET}" "${ZEROMQ_URL}" \
	&& echo "${ZEROMQ_SHA256}  /tmp/${ZEROMQ_ASSET}" | sha256sum --check --status \
	&& tar xzf "/tmp/${ZEROMQ_ASSET}" -C /build/zeromq --strip-components=1 \
	&& cd /build/zeromq \
	&& ./configure --prefix="${OCAML_RUNTIME_ROOT}" --disable-static --disable-Werror \
		--disable-curve --without-docs \
	&& make -j"$(nproc)" \
	&& make install \
	&& rm -rf /build/zeromq "/tmp/${ZEROMQ_ASSET}"
# Shallow single-commit fetches: opam-repository's full history is gigabytes and
# none of it is evidence. The requested sha is what git verifies on arrival.
RUN mkdir -p /build/opam-repository \
	&& git -C /build/opam-repository init --quiet \
	&& git -C /build/opam-repository remote add origin "${OPAM_REPOSITORY_URL}" \
	&& git -C /build/opam-repository fetch --quiet --depth 1 origin "${OPAM_REPOSITORY_COMMIT}" \
	&& git -C /build/opam-repository checkout --quiet FETCH_HEAD \
	&& opam init --bare --no-setup --disable-sandboxing --yes default /build/opam-repository
RUN mkdir -p "${OCAML_JUPYTER_SRC}" \
	&& git -C "${OCAML_JUPYTER_SRC}" init --quiet \
	&& git -C "${OCAML_JUPYTER_SRC}" remote add origin "${OCAML_JUPYTER_URL}" \
	&& git -C "${OCAML_JUPYTER_SRC}" fetch --quiet --depth 1 origin "${OCAML_JUPYTER_COMMIT}" \
	&& git -C "${OCAML_JUPYTER_SRC}" checkout --quiet FETCH_HEAD
# The compiler build is minutes. Kept in layers of its own so iterating on the
# patches below never repeats it.
RUN opam switch create "${OCAML_RUNTIME_ROOT}" "ocaml-base-compiler.${OCAML_VERSION}" --yes
RUN cd "${OCAML_JUPYTER_SRC}" \
	&& opam install --switch "${OCAML_RUNTIME_ROOT}" --yes --no-depexts --deps-only ./jupyter.opam
COPY deploy/ocaml-runtime/ /build/ocaml-runtime/
RUN bash /build/ocaml-runtime/build-switch.sh

FROM rust:1.95-bookworm AS jupyter-bridge-builder

RUN apt-get update \
	&& apt-get install -y --no-install-recommends file musl-tools \
	&& rm -rf /var/lib/apt/lists/*
WORKDIR /build/jupyter-bridge
COPY crates/jupyter-bridge/ ./
COPY packages/canonical-json/golden-vectors.json /packages/canonical-json/golden-vectors.json
RUN cargo fmt -- --check \
	&& cargo clippy --locked -- -D warnings \
	&& cargo test --locked \
	&& cargo build --locked --release --target x86_64-unknown-linux-musl \
	&& file target/x86_64-unknown-linux-musl/release/choreograph-jupyter-bridge \
		| grep -Eq 'ELF 64-bit.*x86-64.*(statically linked|static-pie linked)'

FROM node:22-bookworm

RUN apt-get update \
	&& apt-get install -y --no-install-recommends bubblewrap \
	&& rm -rf /var/lib/apt/lists/*
RUN npm install -g tsx

COPY --from=python-runtime-builder /opt/runtime/python /opt/runtime/python
# Mounted at the same guest path it was baked at: Julia's precompile caches
# record the absolute paths of the sources they were built from.
COPY --from=julia-runtime-builder /opt/runtime/julia /opt/runtime/julia
# Same reason, one layer deeper: an opam switch does not merely validate the
# paths it recorded, it executes them — the kernel's shebang, lib/ocaml/ld.conf
# and the stubs' RUNPATH all name this exact directory.
COPY --from=ocaml-runtime-builder /opt/runtime/ocaml /opt/runtime/ocaml
COPY --from=jupyter-bridge-builder \
	/build/jupyter-bridge/target/x86_64-unknown-linux-musl/release/choreograph-jupyter-bridge \
	/opt/choreograph-runtime/bridges/jupyter-bridge
COPY packages/sophia-kernel-runtime /opt/choreograph-runtime/sophia-kernel-runtime
RUN /opt/choreograph-runtime/bridges/jupyter-bridge --version \
	&& PYTHONNOUSERSITE=1 PYTHONDONTWRITEBYTECODE=1 /opt/runtime/python/bin/python3 -I -c \
		'import sys, ipykernel, jupyter_client, zmq; assert sys.version_info[:2] == (3, 12)' \
	&& PYTHONPATH=/opt/choreograph-runtime/sophia-kernel-runtime/src /opt/runtime/python/bin/python3 -c \
		'import dill, httpx, mcp, rlm, rlm.mcp_base, rlm.skill, tyro' \
	&& JULIA_DEPOT_PATH=/tmp/julia-depot:/opt/runtime/julia/depot \
		/opt/runtime/julia/bin/julia -i --color=yes --startup-file=no --history-file=no \
		--project=/opt/runtime/julia/depot/environments/v1.11 \
		-e 'import IJulia; println("julia ", VERSION, " | IJulia ", pkgversion(IJulia), " | ZMQ ", pkgversion(IJulia.ZMQ))' \
		< /dev/null \
	&& /opt/runtime/ocaml/_opam/bin/ocaml-jupyter-kernel -version
# The OCaml check above is not cosmetic. This image never installs libzmq or
# libgmp, and ocamlrun dlopens every C stub before main — so a kernel that
# prints its version here has proven the bundle carries its own shared objects
# and finds them through the RUNPATH baked at the guest path.

WORKDIR /app

# Install OTEL dependencies at /app level (src/ is bind-mounted read-only).
COPY src/package.json src/package-lock.json* /app/
RUN npm install --omit=dev
