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
printf 'keep\n' > .gitignore
ignore_sum=$(cksum .gitignore)
exclude="$(git rev-parse --git-path info/exclude)"
case "$exclude" in
  /*) ;;
  *) exclude="$PWD/$exclude" ;;
esac
exclude_sum=$(cksum "$exclude")
dry="$tmp/dry-planned.txt"
"$ZWT" --dry-run new planned --config "$tmp/zwt.toml" > "$dry"
grep -q "would create" "$dry"
grep -q "info/exclude" "$dry"
test "$(cksum "$exclude")" = "$exclude_sum" || { echo "dry-run wrote info/exclude"; exit 1; }
test "$(cksum .gitignore)" = "$ignore_sum" || { echo "dry-run changed .gitignore"; exit 1; }
test ! -e "$wt/planned" || { echo "dry-run wrote a worktree"; exit 1; }
if git rev-parse -q --verify refs/heads/planned >/dev/null; then echo "dry-run created a branch"; exit 1; fi
"$ZWT" new demo --config "$tmp/zwt.toml"
test -d "$wt/demo" || { echo "worktree not created"; exit 1; }
test "$(git -C "$wt/demo" config --get user.email)" = "ci@example.com"
git -C "$wt/demo" config --show-origin --get user.email | grep -q config.worktree
"$ZWT" identity check --config "$tmp/zwt.toml" "$wt/demo" | grep -q "effective: ci@example.com"
grep -qx '.scratch' "$exclude" || { echo "scratch dir missing from info/exclude"; exit 1; }
test "$(grep -cx '.scratch' "$exclude")" = "1" || { echo "scratch dir duplicated in info/exclude"; exit 1; }
test "$(cksum .gitignore)" = "$ignore_sum" || { echo ".gitignore changed"; exit 1; }
"$ZWT" new demo --config "$tmp/zwt.toml" | grep -q exists
test "$(grep -cx '.scratch' "$exclude")" = "1" || { echo "re-run duplicated scratch dir"; exit 1; }
test "$(cksum .gitignore)" = "$ignore_sum" || { echo ".gitignore changed on re-run"; exit 1; }
exclude_sum=$(cksum "$exclude")
other="$tmp/dry-other.txt"
"$ZWT" --dry-run new other --config "$tmp/zwt.toml" > "$other"
grep -q "would create" "$other"
if grep -q "info/exclude" "$other"; then echo "dry-run planned a duplicate exclude write"; exit 1; fi
test "$(cksum "$exclude")" = "$exclude_sum" || { echo "dry-run wrote info/exclude"; exit 1; }
test ! -e "$wt/other" || { echo "dry-run wrote a worktree"; exit 1; }
if git rev-parse -q --verify refs/heads/other >/dev/null; then echo "dry-run created a branch"; exit 1; fi
set +e
miss=$("$ZWT" new nope --config "$tmp/empty.toml" 2>&1)
code=$?
set -e
test "$code" -ne 0
printf '%s\n' "$miss" | grep -q "non-interactive"
echo "smoke-new ok"
