#!/usr/bin/env bash
# Fail if any commit in <range> has an author or committer email outside GitHub noreply
# (committer noreply@github.com, used by web merges, is allowed).
set -euo pipefail
range="${1:?usage: check-commit-emails.sh <base>..<head>}"
bad="$(git log --format='%h %ae %ce' "$range" | awk '$2 !~ /@users\.noreply\.github\.com$/ || ($3 !~ /@users\.noreply\.github\.com$/ && $3 != "noreply@github.com")')"
if [ -n "$bad" ]; then
  echo "commits with non-noreply emails:"; echo "$bad"
  echo "fix: git config user.email <id>+<user>@users.noreply.github.com, then amend"
  exit 1
fi
echo "commit emails ok ($range)"
