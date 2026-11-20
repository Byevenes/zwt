#!/usr/bin/env bash
# Two short Bombadil campaigns. Not a CI gate. Limits sum to 90s.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$root"

bombadil_bin="${BOMBADIL:-bombadil}"
missing=0
if [[ "$bombadil_bin" == */* ]]; then
  [[ -x "$bombadil_bin" ]] || missing=1
else
  command -v "$bombadil_bin" >/dev/null 2>&1 || missing=1
fi
if [[ "$missing" -eq 1 ]]; then
  echo "bombadil 0.8.0 is not available."
  echo "https://github.com/antithesishq/bombadil/releases/download/v0.8.0/bombadil-aarch64-darwin"
  echo "https://github.com/antithesishq/bombadil/releases/download/v0.8.0/bombadil-x86_64-linux"
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/home" "$tmp/config" "$tmp/state" "$tmp/traces"
cp examples/zwt.toml "$tmp/zwt.toml"
: > "$tmp/gitconfig"

export HOME="$tmp/home"
export XDG_CONFIG_HOME="$tmp/config"
export XDG_STATE_HOME="$tmp/state"
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL="$tmp/gitconfig"
unset GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL || true

run_campaign() {
  local name="$1"
  local limit="$2"
  shift 2
  echo "=== campaign: $name time-limit-fuzz $limit ==="
  "$bombadil_bin" terminal fuzz \
    --specification bombadil/cli.spec.ts \
    --time-limit-fuzz "$limit" \
    --time-limit-run 5s \
    --output-path "$tmp/traces/$name" \
    -- "$@"
}

set +e
run_campaign help 45s bun src/main.ts --help
help_code=$?
run_campaign wizard 45s bun src/main.ts --dry-run --wizard --config "$tmp/zwt.toml"
wizard_code=$?
set -e

echo "help exit: $help_code"
echo "wizard exit: $wizard_code"
if [[ "$help_code" -ne 0 ]]; then
  exit "$help_code"
fi
exit "$wizard_code"
