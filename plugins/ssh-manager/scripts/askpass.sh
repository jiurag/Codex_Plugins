#!/bin/sh
set -eu
[ -n "${SSH_MANAGER_ASKPASS_FILE:-}" ] || exit 1
[ -f "$SSH_MANAGER_ASKPASS_FILE" ] || exit 1
cat -- "$SSH_MANAGER_ASKPASS_FILE"
printf '\n'
rm -f -- "$SSH_MANAGER_ASKPASS_FILE"