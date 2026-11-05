#!/bin/sh
# Run one check against a generated control.
#
# A missing control is skipped: an installed package without generated builds must still pass.
# A present control must make its check exit 1, because the control carries the defect.
#
# Usage: checks/run-control.sh <control> <url|path> <check command...>
set -u
control="${1:?control path}"
mode="${2:?url or path}"
shift 2
if [ ! -f "$control" ]; then
  echo "skip $(basename "$control"): not generated"
  exit 0
fi
if [ "$mode" = "url" ]; then
  BRIDGE="file://$PWD/$control"
else
  BRIDGE="$PWD/$control"
fi
export BRIDGE
# A crash also exits 1, so require the check's own FAIL line. Without it a broken control reads as
# a control that caught its defect.
out=$("$@" 2>&1)
status=$?
printf '%s\n' "$out"
if [ "$status" -eq 1 ] && printf '%s' "$out" | grep -q '^FAIL'; then
  exit 0
fi
echo "FAIL $(basename "$control"): expected exit 1 with a FAIL line, got exit $status"
exit 1
