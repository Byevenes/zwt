#!/usr/bin/env bash
# Binary smoke for `zwt doctor`: mismatch exits non-zero, a match exits zero, dry-run writes nothing.
set -euo pipefail
ZWT="$(cd "$(dirname "$1")" && pwd -P)/$(basename "$1")"
tmp="$(mktemp -d)"; tmp="$(cd "$tmp" && pwd -P)"
trap 'rm -rf "$tmp"' EXIT
git init -q -b main "$tmp/repo"
git -C "$tmp/repo" config user.name "Jane Doe"
git -C "$tmp/repo" config user.email "other@example.com"
top="$(git -C "$tmp/repo" rev-parse --show-toplevel)"
cat > "$tmp/zwt.toml" <<TOML
version = 1
[identity.personal]
name = "Jane Doe"
email = "jane@example.com"
[[profile]]
match = "$top/**"
identity = "personal"
TOML
cd "$tmp/repo"
set +e
bad=$("$ZWT" doctor --config "$tmp/zwt.toml" 2>&1)
code=$?
set -e
test "$code" -ne 0
printf '%s\n' "$bad" | grep -q "identity fail"
printf '%s\n' "$bad" | grep -q "fix:"
printf '%s\n' "$bad" | grep -q "config --worktree user.email jane@example.com"
test "$(git config --get user.email)" = "other@example.com"
git config user.email "jane@example.com"
"$ZWT" doctor --config "$tmp/zwt.toml" | grep -q "identity ok matches jane@example.com"
before=$(git config --local --list | cksum)
dry=$("$ZWT" --dry-run doctor --config "$tmp/zwt.toml")
printf '%s\n' "$dry" | grep -q "dry-run: nothing to write"
test "$(git config --local --list | cksum)" = "$before"
test "$(git config --get user.email)" = "jane@example.com"
echo "smoke-doctor ok"
