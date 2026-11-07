#!/bin/sh
# Install a zwt release binary and verify its SHA-256. POSIX sh.
set -eu

REPO="${ZWT_REPO:-Byevenes/zwt}"
VERSION="${ZWT_VERSION:-latest}"
INSTALL_DIR="${ZWT_INSTALL_DIR:-}"
DRY_RUN="${ZWT_DRY_RUN:-}"
RELEASE_BASE="${ZWT_RELEASE_BASE:-}"
OS_NAME="${ZWT_OS:-}"
ARCH_NAME="${ZWT_ARCH:-}"

usage() {
  cat <<'EOF'
usage: install.sh [--version <latest|vX.Y.Z>] [--dir <path>] [--dry-run]

Downloads the zwt binary for this machine and checks it against checksums.txt
from the same GitHub Release. Uses curl or wget, and sha256sum or shasum.
EOF
}

version_ok() {
  case "$1" in
    latest) return 0 ;;
  esac
  body="${1#v}"
  [ "$body" != "$1" ] || return 1
  old_ifs=$IFS
  IFS=.
  set -f
  # shellcheck disable=SC2086
  set -- $body
  set +f
  IFS=$old_ifs
  [ "$#" -eq 3 ] || return 1
  for part in "$1" "$2" "$3"; do
    case "$part" in
      "" | *[!0-9]*) return 1 ;;
    esac
  done
  return 0
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || { echo "--version needs a tag" >&2; exit 1; }
      VERSION="$2"
      shift 2
      ;;
    --dir)
      [ "$#" -ge 2 ] || { echo "--dir needs a path" >&2; exit 1; }
      INSTALL_DIR="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if ! version_ok "$VERSION"; then
  echo "version must be latest or vX.Y.Z" >&2
  exit 1
fi

if [ -z "$INSTALL_DIR" ]; then
  if [ -z "${HOME:-}" ]; then
    echo "HOME is unset; pass --dir" >&2
    exit 1
  fi
  INSTALL_DIR="$HOME/.local/bin"
fi

if [ -z "$OS_NAME" ]; then
  case "$(uname -s)" in
    Linux) OS_NAME=linux ;;
    Darwin) OS_NAME=darwin ;;
    *)
      echo "unsupported operating system: $(uname -s)" >&2
      exit 1
      ;;
  esac
fi

if [ -z "$ARCH_NAME" ]; then
  case "$(uname -m)" in
    x86_64 | amd64) ARCH_NAME=x64 ;;
    aarch64 | arm64) ARCH_NAME=arm64 ;;
    *)
      echo "unsupported architecture: $(uname -m)" >&2
      exit 1
      ;;
  esac
fi

case "$OS_NAME" in
  linux | darwin) ;;
  *)
    echo "unsupported operating system: $OS_NAME" >&2
    exit 1
    ;;
esac

case "$ARCH_NAME" in
  x64 | arm64) ;;
  *)
    echo "unsupported architecture: $ARCH_NAME" >&2
    exit 1
    ;;
esac

ASSET="zwt-${OS_NAME}-${ARCH_NAME}"

if [ -n "$RELEASE_BASE" ]; then
  base="${RELEASE_BASE%/}"
  ASSET_URL="${base}/${ASSET}"
  CHECKSUM_URL="${base}/checksums.txt"
else
  case "$VERSION" in
    latest) prefix="https://github.com/${REPO}/releases/latest/download" ;;
    *) prefix="https://github.com/${REPO}/releases/download/${VERSION}" ;;
  esac
  ASSET_URL="${prefix}/${ASSET}"
  CHECKSUM_URL="${prefix}/checksums.txt"
fi

DEST="${INSTALL_DIR%/}/zwt"

if [ -n "$DRY_RUN" ]; then
  printf 'would download %s\n' "$ASSET_URL"
  printf 'would verify sha256 using %s\n' "$CHECKSUM_URL"
  printf 'would install %s\n' "$DEST"
  exit 0
fi

download() {
  url="$1"
  dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$dest"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$dest" "$url"
  else
    echo "need curl or wget" >&2
    exit 1
  fi
}

hash_file() {
  file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{ print $1 }'
  else
    echo "need sha256sum or shasum" >&2
    exit 1
  fi
}

tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/zwt-install.XXXXXXXX")"
stage=""
cleanup() {
  rm -rf "$tmpdir"
  if [ -n "$stage" ]; then
    rm -f "$stage"
  fi
}
trap cleanup EXIT

download "$CHECKSUM_URL" "$tmpdir/checksums.txt"
download "$ASSET_URL" "$tmpdir/$ASSET"

expected="$(awk -v asset="$ASSET" '$2 == asset { print $1; exit }' "$tmpdir/checksums.txt")"
if [ -z "$expected" ]; then
  echo "checksums.txt has no entry for $ASSET" >&2
  exit 1
fi
case "$expected" in
  *[!0-9a-f]*)
    echo "checksum for $ASSET is not sha256" >&2
    exit 1
    ;;
esac
if [ "${#expected}" -ne 64 ]; then
  echo "checksum for $ASSET is not sha256" >&2
  exit 1
fi

actual="$(hash_file "$tmpdir/$ASSET")"
if [ "$expected" != "$actual" ]; then
  echo "checksum mismatch for $ASSET" >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"
stage="${INSTALL_DIR}/.zwt.installing"
cp "$tmpdir/$ASSET" "$stage"
chmod +x "$stage"
mv "$stage" "$DEST"
stage=""
printf 'installed %s\n' "$DEST"
case ":${PATH:-}:" in
  *":${INSTALL_DIR}:"*) ;;
  *) printf '%s is not on PATH\n' "$INSTALL_DIR" >&2 ;;
esac
