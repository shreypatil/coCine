#!/usr/bin/env bash
#
# Delete log days past the retention window.
#
# The server prunes at startup, but a process that stays up for months never
# reaches that code again -- so this runs on a timer as well. Kept as a separate
# script rather than folded into the server because it must work whether or not
# the server is running, including when it has been stopped precisely because
# something filled the disk.
#
# By filename rather than mtime: today's file is appended to constantly and an
# old one touched by a backup would otherwise be spared. The date in the name is
# the fact. That also makes this safe to run against a directory the server is
# actively writing to.
set -euo pipefail

DIR="${COCINE_LOG_DIR:-/var/log/cocine}"
KEEP="${COCINE_LOG_KEEP_DAYS:-7}"

[ -d "$DIR" ] || { echo "[logprune] $DIR does not exist yet"; exit 0; }

cutoff=$(date -u -d "${KEEP} days ago" +%Y-%m-%d 2>/dev/null || date -u -v-"${KEEP}"d +%Y-%m-%d)
removed=0
freed=0

# Only files named exactly <YYYY-MM-DD>.log, so anything else somebody has put
# in there is left alone.
while IFS= read -r -d '' file; do
  day="$(basename "$file" .log)"
  # String comparison is correct for ISO dates and needs no date parsing per file.
  [[ "$day" < "$cutoff" ]] || continue
  size=$(stat -c%s "$file" 2>/dev/null || stat -f%z "$file" 2>/dev/null || echo 0)
  rm -f "$file" && removed=$((removed + 1)) && freed=$((freed + size))
done < <(find "$DIR" -type f -regextype posix-extended -regex '.*/[0-9]{4}-[0-9]{2}-[0-9]{2}\.log' -print0 2>/dev/null)

echo "[logprune] keeping ${KEEP} days (before ${cutoff}): removed ${removed} file(s), freed $((freed / 1024)) KB"

# A disk that fills anyway is worth saying out loud, since the next symptom is
# the server failing in ways that look unrelated.
use=$(df --output=pcent "$DIR" 2>/dev/null | tail -1 | tr -dc '0-9' || echo 0)
[ -n "$use" ] && [ "$use" -ge 85 ] && echo "[logprune] WARNING: ${use}% of the disk is used" >&2
exit 0
