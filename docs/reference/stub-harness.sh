#!/bin/sh
# Stub harness for ralph-exec: saves each prompt it is handed, does no work.
# ralph-exec passes the prompt twice: as the last argument and in $RALPH_PROMPT_FILE.
# Runs with cwd = the project dir (app/).
#
# Options (before the prompt, which ralph-exec always appends last):
#   --pause <seconds>  hold each turn before it ends (default 5, 0 = no pause)
#   --board <name>     board folder name (default: the board id from the prompt header, or "local")
#
# Output: $STUB_OUT (default ./prompts next to this script)
#   <board>/<chapter>/<slice>/<ts>.{md,env,slice.json}   slice build turns
#   <board>/_tasks/<ts>.{md,env}                          queued-task and curation turns
# STUB_STATUS overrides the outcome recorded on build turns (default Done).

here="$(cd "$(dirname "$0")" && pwd)"
pause=5
board=""
while [ $# -gt 1 ]; do
  case "$1" in
    --pause) pause="$2"; shift 2 ;;
    --board) board="$2"; shift 2 ;;
    *) shift ;;
  esac
done

prompt="$RALPH_PROMPT_FILE"
[ -n "$board" ] || board=$(sed -n 's/^board=\([^ ]*\) .*/\1/p' "$prompt" | head -1)
[ -n "$board" ] || board="local"

# A build turn names its slice in the task line: (id=<uuid>, context="...").
# index.json maps the id to its folder; slice.json gives the chapter and title.
slice_id=$(sed -n 's/.*Your task now: build the .*(id=\([^,]*\),.*/\1/p' "$prompt" | head -1)
slice_file=""; chapter=""; title=""
if [ -n "$slice_id" ]; then
  info=$(SLICE_ID="$slice_id" node -e '
    const fs = require("fs"), path = require("path");
    const root = ".build-kit/.slices";
    const safe = (s) => String(s || "unknown").replace(/[\/\\:]/g, "-").trim();
    for (const ctx of fs.readdirSync(root)) {
      const idx = path.join(root, ctx, "index.json");
      if (!fs.existsSync(idx)) continue;
      const e = (JSON.parse(fs.readFileSync(idx, "utf8")).slices || []).find((x) => x.id === process.env.SLICE_ID);
      if (!e) continue;
      const file = path.join(root, ctx, e.folder, "slice.json");
      let s = {};
      try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
      console.log([file, safe(s.chapterTitle || s.contextName || e.contextName), safe(s.title || e.slice)].join("\t"));
      break;
    }')
  slice_file=$(printf '%s' "$info" | cut -f1)
  chapter=$(printf '%s' "$info" | cut -f2)
  title=$(printf '%s' "$info" | cut -f3)
fi

out="${STUB_OUT:-$here/prompts}/$board"
if [ -n "$title" ]; then dir="$out/$chapter/$title"; else dir="$out/_tasks"; fi
mkdir -p "$dir"
base="$dir/$(date +%Y%m%d-%H%M%S)-$$"

cp "$prompt" "$base.md"
# Also keep the env the loop sets for the harness (token masked).
env | grep -E '^(RALPH_|EVENTMODELERS_)' | sed 's/\(TOKEN=\).*/\1***/' > "$base.env"
echo "[stub] prompt saved to $base.md"

# The slice.json the loop refreshed from the board just before this turn.
if [ -n "$slice_id" ]; then
  if [ -n "$slice_file" ] && [ -f "$slice_file" ]; then
    cp "$slice_file" "$base.slice.json"
    echo "[stub] slice saved to $base.slice.json"
  else
    echo "[stub] no slice.json found for slice $slice_id"
  fi
fi

if [ "$pause" != "0" ]; then
  echo "[stub] pausing ${pause}s"
  sleep "$pause"
fi

# On a slice build turn, record an outcome so the loop settles the slice instead of retrying it.
# Queued-task and curation turns have no claimed slice, so they are skipped.
if [ -n "$slice_id" ]; then
  eventmodelers slice-status "${STUB_STATUS:-Done}"
fi
