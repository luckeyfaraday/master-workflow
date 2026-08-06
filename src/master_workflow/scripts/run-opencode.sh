#!/usr/bin/env bash
# run-opencode.sh — launch a non-interactive opencode run with logging,
# auto-permissions, and resume support.
#
# Vendored into master-workflow from luckeyfaraday/delegate-to-opencode, with
# one addition: --run-dir, so the caller owns the artifact location.
#
# Usage:
#   run-opencode.sh [-C dir] [-m provider/model] [--variant name] [-l label]
#                   [--run-dir DIR] [--resume <session-id>] [--fork]
#                   [--agent <name>] [--no-auto] <prompt | ->
#
# Artifacts in RUN_DIR:
#   prompt.md  events.jsonl  last_message.txt  stderr.log  session_id
#   meta.json  raw.agent.log
set -euo pipefail

MODEL="${MASTER_WORKFLOW_OPENCODE_MODEL:-}"
VARIANT="${MASTER_WORKFLOW_OPENCODE_VARIANT:-}"
WORKDIR="$PWD"
LABEL="run"
RUN_DIR=""
RESUME=""
FORK=0
AGENT=""
AUTO=1

die() { echo "run-opencode.sh: $*" >&2; exit 2; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    -C|--cd)       WORKDIR="$2"; shift 2 ;;
    -m|--model)    MODEL="$2"; shift 2 ;;
    --variant)     VARIANT="$2"; shift 2 ;;
    -l|--label)    LABEL="$2"; shift 2 ;;
    --run-dir)     RUN_DIR="$2"; shift 2 ;;
    --resume)      RESUME="$2"; shift 2 ;;
    --fork)        FORK=1; shift ;;
    --agent)       AGENT="$2"; shift 2 ;;
    --no-auto)     AUTO=0; shift ;;
    -h|--help)     sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --)            shift; break ;;
    -)             break ;;
    -*)            die "unknown flag: $1" ;;
    *)             break ;;
  esac
done

[[ $# -ge 1 ]] || die "missing prompt (use '-' for stdin)"
command -v opencode >/dev/null || die "opencode CLI not found — see https://opencode.ai"
[[ -d "$WORKDIR" ]] || die "working directory does not exist: $WORKDIR"

if [[ -z "$RUN_DIR" ]]; then
  RUNS_ROOT="${MASTER_WORKFLOW_OPENCODE_RUNS:-${TMPDIR:-/tmp}/master-workflow-opencode}"
  RUN_DIR="$RUNS_ROOT/$(date +%Y%m%d-%H%M%S)-${LABEL}-$$"
fi
mkdir -p "$RUN_DIR"

if [[ "$1" == "-" ]]; then cat > "$RUN_DIR/prompt.md"; else printf '%s\n' "$1" > "$RUN_DIR/prompt.md"; fi
[[ -s "$RUN_DIR/prompt.md" ]] || die "empty prompt"

args=(opencode run --format json --dir "$WORKDIR" --title "$LABEL")
# Older builds spelled this --auto; current ones only accept the long form.
[[ $AUTO -eq 1 ]]   && args+=(--dangerously-skip-permissions)
[[ -n "$MODEL" ]]   && args+=(-m "$MODEL")
[[ -n "$VARIANT" ]] && args+=(--variant "$VARIANT")
[[ -n "$AGENT" ]]   && args+=(--agent "$AGENT")
[[ -n "$RESUME" ]]  && args+=(-s "$RESUME")
[[ $FORK -eq 1 ]]   && args+=(--fork)
args+=("$(cat "$RUN_DIR/prompt.md")")

echo "RUN_DIR=$RUN_DIR"
echo "model=${MODEL:-<opencode default>} variant=${VARIANT:-<opencode default>} workdir=$WORKDIR${RESUME:+ resume=$RESUME}"

set +e
"${args[@]}" > "$RUN_DIR/raw.agent.log" 2> "$RUN_DIR/stderr.log"
status=$?
set -e

grep '^{' "$RUN_DIR/raw.agent.log" > "$RUN_DIR/events.jsonl" || true

if command -v jq >/dev/null; then
  jq -r 'select(.sessionID) | .sessionID' "$RUN_DIR/events.jsonl" 2>/dev/null | head -1 > "$RUN_DIR/session_id" || true
  jq -j 'select(.type=="text") | .text // .data // empty' "$RUN_DIR/events.jsonl" > "$RUN_DIR/last_message.txt" 2>/dev/null || true
  jq -c 'select(.type=="end" or .type=="done" or .type=="error")' "$RUN_DIR/events.jsonl" 2>/dev/null | tail -1 > "$RUN_DIR/meta.json" || true
fi
[[ -s "$RUN_DIR/last_message.txt" ]] || cp "$RUN_DIR/raw.agent.log" "$RUN_DIR/last_message.txt"
[[ -s "$RUN_DIR/session_id" ]] || printf '%s\n' "${RESUME:-unknown}" > "$RUN_DIR/session_id"

echo "exit_code=$status"
echo "session_id=$(cat "$RUN_DIR/session_id")"
exit "$status"
