#!/usr/bin/env bash
# Build, checksum, and publish the GitHub Release binaries named in release-targets.tsv.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
targets="$root/scripts/release-targets.tsv"
SCRATCH=""
cleanup() {
  if [ -n "${SCRATCH:-}" ] && [ -f "$SCRATCH" ]; then
    rm -f "$SCRATCH"
  fi
}
trap cleanup EXIT

die() {
  printf '%s\n' "$1" >&2
  exit 1
}

each_target() {
  callback="$1"
  count=0
  while IFS=$'\t' read -r target asset os arch || [ -n "${target:-}" ]; do
    case "$target" in
      "" | \#*) continue ;;
    esac
    if [ -z "$asset" ] || [ -z "$os" ] || [ -z "$arch" ]; then
      die "bad release target row: $target"
    fi
    "$callback" "$target" "$asset" "$os" "$arch"
    count=$((count + 1))
  done < "$targets"
  [ "$count" -gt 0 ] || die "no release targets"
}

package_version() {
  awk -F'"' '/"version":/ { print $4; exit }' "$root/package.json"
}

require_version_tag() {
  tag="${ZWT_TAG:-${GITHUB_REF_NAME:-}}"
  [ -n "$tag" ] || die "set ZWT_TAG or GITHUB_REF_NAME"
  version="$(package_version)"
  [ -n "$version" ] || die "package.json has no version"
  [ "$tag" = "v$version" ] || die "tag $tag does not match package.json version $version"
}

hash_file() {
  file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{ print $1 }'
  else
    die "need sha256sum or shasum"
  fi
}

on_plan() {
  printf 'target %s asset %s os %s arch %s\n' "$1" "$2" "$3" "$4"
}

on_build() {
  if [ "$DRY" -eq 1 ]; then
    printf 'would build %s -> %s/%s\n' "$1" "$OUT" "$2"
    return 0
  fi
  bun build "$root/src/main.ts" --compile --target="$1" --outfile "$OUT/$2"
  [ -f "$OUT/$2" ] || die "bun did not write $OUT/$2"
}

on_checksum() {
  file="$DIR/$2"
  [ -f "$file" ] || die "missing $file"
  hash="$(hash_file "$file")"
  printf '%s  %s\n' "$hash" "$2" >> "$SCRATCH"
}

on_collect() {
  file="$DIR/$2"
  [ -f "$file" ] || die "missing $file"
  ASSETS+=("$file")
}

cmd_plan() {
  each_target on_plan
}

cmd_check_tag() {
  require_version_tag
  printf 'tag %s\n' "$tag"
}

cmd_build() {
  DRY=0
  OUT=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) DRY=1; shift ;;
      *) OUT="$1"; shift ;;
    esac
  done
  OUT="${OUT:-$root/dist/release}"
  if [ "$DRY" -eq 0 ]; then
    command -v bun >/dev/null 2>&1 || die "bun is required to build release binaries"
    mkdir -p "$OUT"
  fi
  each_target on_build
}

cmd_checksums() {
  DIR="${1:-}"
  [ -n "$DIR" ] || die "usage: release.sh checksums DIR"
  SCRATCH="$(mktemp "${TMPDIR:-/tmp}/zwt-checksums.XXXXXXXX")"
  : > "$SCRATCH"
  each_target on_checksum
  mv "$SCRATCH" "$DIR/checksums.txt"
  SCRATCH=""
}

cmd_publish() {
  DRY=0
  DIR=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) DRY=1; shift ;;
      *) DIR="$1"; shift ;;
    esac
  done
  [ -n "$DIR" ] || die "usage: release.sh publish [--dry-run] DIR"
  require_version_tag
  [ -f "$DIR/checksums.txt" ] || die "missing $DIR/checksums.txt"
  ASSETS=()
  each_target on_collect
  if [ "$DRY" -eq 1 ]; then
    printf 'would publish %s\n' "$tag"
    for file in "${ASSETS[@]}"; do
      printf 'would upload %s\n' "$(basename "$file")"
    done
    printf 'would upload checksums.txt\n'
    return 0
  fi
  [ -n "${GH_TOKEN:-}" ] || die "GH_TOKEN is required"
  [ -n "${GITHUB_REPOSITORY:-}" ] || die "GITHUB_REPOSITORY is required"
  if gh release view "$tag" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1; then
    gh release upload "$tag" "${ASSETS[@]}" "$DIR/checksums.txt" --repo "$GITHUB_REPOSITORY" --clobber
  else
    gh release create "$tag" "${ASSETS[@]}" "$DIR/checksums.txt" \
      --repo "$GITHUB_REPOSITORY" \
      --title "$tag" \
      --verify-tag \
      --generate-notes
  fi
}

usage() {
  die "usage: release.sh plan|check-tag|build|checksums|publish ..."
}

cmd="${1:-}"
[ -n "$cmd" ] || usage
shift
case "$cmd" in
  plan) cmd_plan "$@" ;;
  check-tag) cmd_check_tag "$@" ;;
  build) cmd_build "$@" ;;
  checksums) cmd_checksums "$@" ;;
  publish) cmd_publish "$@" ;;
  *) usage ;;
esac
