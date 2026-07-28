#!/usr/bin/env bash
# run-grok.sh — launch a non-interactive Grok run with logging, real sandbox
# enforcement, and resume support.
#
# Vendored into master-workflow from luckeyfaraday/delegate-to-grok, with one
# addition: --run-dir, so the caller owns the artifact location.
#
# Usage:
#   run-grok.sh [-C dir] [-m model] [-e effort] [-s sandbox] [-l label]
#               [--run-dir DIR] [--resume <session-id>] [--max-turns N]
#               [--no-sandbox] [--no-pty] [--allow RULE] [--deny RULE]
#               <prompt | ->
#
# Artifacts in RUN_DIR:
#   prompt.md  events.jsonl  last_message.txt  stderr.log  session_id
#   meta.json  sandbox  raw.agent.log
#
# WHY THE PTY: grok applies --sandbox via Landlock, which needs to open
# /dev/tty. Launched from an agent or CI there is no controlling terminal, so
# the profile fails to apply and grok CONTINUES UNSANDBOXED — logged to
# ~/.grok/sandbox-events.jsonl as ApplyFailed, but the command still exits 0 and
# the flag still looks like it worked. We run grok under a PTY so the sandbox
# actually engages, and we verify enforcement afterwards instead of trusting it.
set -euo pipefail

MODEL="${MASTER_WORKFLOW_GROK_MODEL:-}"
EFFORT="${MASTER_WORKFLOW_GROK_EFFORT:-high}"
SANDBOX="workspace"
WORKDIR="$PWD"
LABEL="run"
RUN_DIR=""
RESUME=""
MAX_TURNS=""
USE_SANDBOX=1
USE_PTY=1
declare -a RULES=()

die() { echo "run-grok.sh: $*" >&2; exit 2; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    -C|--cd)       WORKDIR="$2"; shift 2 ;;
    -m|--model)    MODEL="$2"; shift 2 ;;
    -e|--effort)   EFFORT="$2"; shift 2 ;;
    -s|--sandbox)  SANDBOX="$2"; shift 2 ;;
    -l|--label)    LABEL="$2"; shift 2 ;;
    --run-dir)     RUN_DIR="$2"; shift 2 ;;
    --resume)      RESUME="$2"; shift 2 ;;
    --max-turns)   MAX_TURNS="$2"; shift 2 ;;
    --allow)       RULES+=(--allow "$2"); shift 2 ;;
    --deny)        RULES+=(--deny "$2"); shift 2 ;;
    --no-sandbox)  USE_SANDBOX=0; shift ;;
    --no-pty)      USE_PTY=0; shift ;;
    -h|--help)     sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --)            shift; break ;;
    -)             break ;;
    -*)            die "unknown flag: $1" ;;
    *)             break ;;
  esac
done

[[ $# -ge 1 ]] || die "missing prompt (use '-' for stdin)"
command -v grok >/dev/null || die "grok CLI not found — see https://grok.com/cli"
[[ -d "$WORKDIR" ]] || die "working directory does not exist: $WORKDIR"

if [[ -z "$RUN_DIR" ]]; then
  RUNS_ROOT="${MASTER_WORKFLOW_GROK_RUNS:-${TMPDIR:-/tmp}/master-workflow-grok}"
  RUN_DIR="$RUNS_ROOT/$(date +%Y%m%d-%H%M%S)-${LABEL}-$$"
fi
mkdir -p "$RUN_DIR"

if [[ "$1" == "-" ]]; then cat > "$RUN_DIR/prompt.md"; else printf '%s\n' "$1" > "$RUN_DIR/prompt.md"; fi
[[ -s "$RUN_DIR/prompt.md" ]] || die "empty prompt"

# Pre-generate the session id so the caller can resume without parsing events.
# -s creates a NEW session and errors if the id exists; --resume continues one.
if [[ -n "$RESUME" ]]; then
  SESSION_ID="$RESUME"
  session_args=(--resume "$SESSION_ID")
else
  if [[ -r /proc/sys/kernel/random/uuid ]]; then SESSION_ID="$(cat /proc/sys/kernel/random/uuid)"
  elif command -v uuidgen >/dev/null; then SESSION_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
  else die "cannot generate a UUID (need uuidgen or /proc/sys/kernel/random/uuid)"; fi
  session_args=(-s "$SESSION_ID")
fi
printf '%s\n' "$SESSION_ID" > "$RUN_DIR/session_id"

args=(grok
  --prompt-file "$RUN_DIR/prompt.md"
  --output-format streaming-json
  --cwd "$WORKDIR"
  --permission-mode bypassPermissions
  --effort "$EFFORT"
  "${session_args[@]}"
)
[[ -n "$MODEL" ]]     && args+=(-m "$MODEL")
[[ -n "$MAX_TURNS" ]] && args+=(--max-turns "$MAX_TURNS")
[[ $USE_SANDBOX -eq 1 ]] && args+=(--sandbox "$SANDBOX")
[[ ${#RULES[@]} -gt 0 ]] && args+=("${RULES[@]}")

echo "RUN_DIR=$RUN_DIR"
echo "model=${MODEL:-<grok default>} effort=$EFFORT sandbox=$([[ $USE_SANDBOX -eq 1 ]] && echo "$SANDBOX" || echo off) workdir=$WORKDIR${RESUME:+ resume=$RESUME}"

SB_LOG="${HOME}/.grok/sandbox-events.jsonl"
sb_before=0
[[ -f "$SB_LOG" ]] && sb_before=$(wc -l < "$SB_LOG")

cmd_str="$(printf '%q ' "${args[@]}")2> $(printf '%q' "$RUN_DIR/stderr.log")"
set +e
if [[ $USE_PTY -eq 1 ]] && command -v script >/dev/null; then
  if script --version 2>/dev/null | grep -q util-linux; then
    script -qec "$cmd_str" /dev/null > "$RUN_DIR/raw.agent.log"     # util-linux
  else
    script -q /dev/null /bin/bash -c "$cmd_str" > "$RUN_DIR/raw.agent.log"  # BSD/macOS
  fi
else
  /bin/bash -c "$cmd_str" > "$RUN_DIR/raw.agent.log"
fi
status=$?
set -e

# A PTY turns \n into \r\n; strip CR and keep only JSON lines.
tr -d '\r' < "$RUN_DIR/raw.agent.log" | grep '^{' > "$RUN_DIR/events.jsonl" || true

if command -v jq >/dev/null; then
  jq -j 'select(.type=="text") | .data' "$RUN_DIR/events.jsonl" > "$RUN_DIR/last_message.txt" 2>/dev/null || true
  jq -c 'select(.type=="end")' "$RUN_DIR/events.jsonl" 2>/dev/null | tail -1 > "$RUN_DIR/meta.json" || true
fi
[[ -s "$RUN_DIR/last_message.txt" ]] || tr -d '\r' < "$RUN_DIR/raw.agent.log" > "$RUN_DIR/last_message.txt"

# Verify the sandbox actually engaged instead of assuming it did.
sandbox_state="off"
if [[ $USE_SANDBOX -eq 1 ]]; then
  sandbox_state="unknown"
  if [[ -f "$SB_LOG" ]]; then
    new_events=$(tail -n +$((sb_before + 1)) "$SB_LOG" 2>/dev/null || true)
    if grep -q '"event_type":"ApplyFailed"' <<< "$new_events"; then sandbox_state="NOT ENFORCED"
    elif grep -q '"event_type":"ProfileApplied"' <<< "$new_events"; then sandbox_state="enforced"; fi
  fi
fi
printf '%s\n' "$sandbox_state" > "$RUN_DIR/sandbox"

echo "exit_code=$status"
echo "session_id=$SESSION_ID"
echo "sandbox=$sandbox_state"
[[ "$sandbox_state" == "NOT ENFORCED" ]] && \
  echo "WARNING: grok ran WITHOUT sandbox enforcement — its writes were not confined to $WORKDIR" >&2
exit "$status"
