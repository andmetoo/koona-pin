# NP-008: Android build environment for the probe — JDK 17, Android SDK and
# NDK, Rust with the Android targets, Node for the Tauri CLI. Licences of the
# Android SDK were accepted by the owner for this build (4 October 2026).
FROM ubuntu:24.04
ARG RUST_VERSION=1.98.1
ARG CMDLINE_TOOLS=11076708
ARG NDK_VERSION=27.2.12479018
ENV DEBIAN_FRONTEND=noninteractive \
    ANDROID_HOME=/opt/android \
    NDK_HOME=/opt/android/ndk/${NDK_VERSION} \
    RUSTUP_HOME=/opt/rustup \
    CARGO_HOME=/opt/cargo \
    JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 \
    PATH=/opt/cargo/bin:/opt/android/cmdline-tools/latest/bin:/opt/android/platform-tools:$PATH
RUN apt-get update && apt-get install -y --no-install-recommends \
      openjdk-17-jdk-headless curl unzip git ca-certificates file \
      build-essential pkg-config libssl-dev nodejs npm \
    && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /opt/android/cmdline-tools \
    && curl -sSfo /tmp/tools.zip https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS}_latest.zip \
    && unzip -q /tmp/tools.zip -d /opt/android/cmdline-tools \
    && mv /opt/android/cmdline-tools/cmdline-tools /opt/android/cmdline-tools/latest \
    && rm /tmp/tools.zip
RUN yes | sdkmanager --licenses > /dev/null \
    && sdkmanager --install "platform-tools" "platforms;android-35" "build-tools;35.0.0" "ndk;${NDK_VERSION}" > /dev/null
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain ${RUST_VERSION} \
    && rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
WORKDIR /work
