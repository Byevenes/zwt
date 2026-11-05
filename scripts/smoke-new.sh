#!/usr/bin/env bash
# Binary smoke for `zwt new`: create, idempotent re-run, dry-run writes nothing.
set -euo pipefail
ZWT="$(cd "$(dirname "$1")" && pwd -P)/$(basename "$1")"
tmp="$(mktemp -d)"; tmp="$(cd "$tmp" && pwd -P)"
trap 'rm -rf "$tmp"' EXIT
git init -q -b main "$tmp/src/r"
git -C "$tmp/src/r" -c user.name=ci -c user.email=ci@example.com commit -q --allow-empty -m init
cat > "$tmp/zwt.toml" <<TOML
version = 1
worktrees_dir = "worktrees"
[identity.ci]
name = "CI"
email = "ci@example.com"
[[profile]]
match = "$tmp/src/**"
identity = "ci"
base_branch = "main"
TOML
cat > "$tmp/empty.toml" <<TOML
version = 1
[identity.ci]
name = "CI"
email = "ci@example.com"
TOML
cd "$tmp/src/r"
wt="$tmp/src/worktrees/r"
"$ZWT" new demo --config "$tmp/zwt.toml"
test -d "$wt/demo" || { echo "worktree not created"; exit 1; }
test "$(git -C "$wt/demo" config --get user.email)" = "ci@example.com"
git -C "$wt/demo" config --show-origin --get user.email | grep -q config.worktree
"$ZWT" identity check --config "$tmp/zwt.toml" "$wt/demo" | grep -q "effective: ci@example.com"
"$ZWT" new demo --config "$tmp/zwt.toml" | grep -q exists
"$ZWT" --dry-run new other --config "$tmp/zwt.toml" | grep -q "would create"
test ! -e "$wt/other" || { echo "dry-run wrote a worktree"; exit 1; }
if git rev-parse -q --verify refs/heads/other >/dev/null; then echo "dry-run created a branch"; exit 1; fi
set +e
miss=$("$ZWT" new nope --config "$tmp/empty.toml" 2>&1)
code=$?
set -e
test "$code" -ne 0
printf '%s\n' "$miss" | grep -q "non-interactive"
echo "smoke-new ok"
