# クライアントはプラットフォーム依存のコードを含まないため、BUILDPLATFORMでビルドした結果を
# 全てのTARGETPLATFORMで再利用できる。これによりビルド時間を短縮できる。
FROM --platform=$BUILDPLATFORM node:18-bookworm AS client-builder
COPY client/package*.json /app/client/
WORKDIR /app/client
RUN npm config set fetch-retries 10 \
    && npm config set fetch-retry-mintimeout 100000 \
    && npm config set fetch-retry-maxtimeout 600000
# どこで時間が掛かっているのか確認できるようにログレベルを変更。
RUN npm install --no-save --loglevel=info
# clientフォルダー外にビルドに必要なファイルが存在するため、全てコピーする。
COPY . /app/
RUN npm run build --loglevel=info

# サーバーはsqlite3のようなプラットフォーム依存のネイティブ・アドオンを含んでいる。そのため、各
# TARGETPLATFORMごとにソースをビルドしなければならない。BUILDPLATFORM以外のTARGETPLATFORMでは、QEMU
# 上でnpmコマンドを実行することになるため、どうしても時間が掛かる。
#
# `npm install`時にネイティブ・アドオンをクロスビルドできればビルド時間を短縮できるが、現時点では明
# 確な手順は存在しない。https://github.com/mapbox/node-pre-gyp/issues/348を見ればそれが分かる。
#
# `npm run build-server`はプラットフォーム依存処理を含まないため、これをBUILDPLATFORMで実行すること
# でビルド時間をさらに短縮可能だが、手順が煩雑で面倒なので現時点では行っていない。
FROM node:18-bookworm AS server-builder
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update
RUN apt-get install -y build-essential python3
WORKDIR /app
COPY package*.json /app/
ENV DOCKER="YES"
RUN npm config set fetch-retries 10 \
    && npm config set fetch-retry-mintimeout 100000 \
    && npm config set fetch-retry-maxtimeout 600000
RUN npm install --no-save --loglevel=info
# 最終イメージのサイズ削減のため、すべてコピーした後でclientフォルダーを削除。clientフォルダー以外
# をコピーする方法は，ファイルが追加された場合に変更する必要があるため採用しない。
COPY . .
RUN rm -rf client
RUN npm run build-server --loglevel=info

FROM node:18-bookworm AS ffmpeg-builder
ENV DEV="make gcc git g++ automake curl wget autoconf build-essential libass-dev libfreetype6-dev libsdl1.2-dev libtheora-dev libtool libva-dev libvdpau-dev libvorbis-dev libxcb1-dev libxcb-shm0-dev libxcb-xfixes0-dev pkg-config texinfo zlib1g-dev"
ENV FFMPEG_VERSION=7.0
RUN apt-get update && \
    apt-get -y install $DEV && \
    apt-get -y install yasm libx264-dev libmp3lame-dev libopus-dev libvpx-dev && \
    apt-get -y install libx265-dev libnuma-dev && \
    apt-get -y install libasound2 libass9 libvdpau1 libva-x11-2 libva-drm2 libxcb-shm0 libxcb-xfixes0 libxcb-shape0 libvorbisenc2 libtheora0 libaribb24-dev
RUN mkdir ffmpeg_sources && \
    cd ffmpeg_sources && \
    curl -fsSL http://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.bz2 | tar -xj --strip-components=1 && \
    ./configure \
      --prefix=/usr/local \
      --disable-shared \
      --pkg-config-flags=--static \
      --enable-gpl \
      --enable-libass \
      --enable-libfreetype \
      --enable-libmp3lame \
      --enable-libopus \
      --enable-libtheora \
      --enable-libvorbis \
      --enable-libvpx \
      --enable-libx264 \
      --enable-libx265 \
      --enable-version3 \
      --enable-libaribb24 \
      --enable-nonfree \
      --disable-debug \
      --disable-doc \
    && \
    make -j$(nproc) && \
    make install

FROM node:18-bookworm-slim
RUN apt-get update && \
    apt-get -y install yasm libx264-dev libmp3lame-dev libopus-dev libvpx-dev && \
    apt-get -y install libx265-dev libnuma-dev && \
    apt-get -y install libasound2 libass9 libvdpau1 libva-x11-2 libva-drm2 libxcb-shm0 libxcb-xfixes0 libxcb-shape0 libvorbisenc2 libtheora0 libaribb24-dev && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*
COPY --from=server-builder /app /app/
COPY --from=client-builder /app/client /app/client/
COPY --from=ffmpeg-builder /usr/local/bin/ffmpeg /usr/local/bin/
COPY --from=ffmpeg-builder /usr/local/bin/ffprobe /usr/local/bin/
EXPOSE 8888
WORKDIR /app
ENTRYPOINT ["npm"]
CMD ["start"]
