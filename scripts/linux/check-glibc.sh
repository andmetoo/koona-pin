#!/usr/bin/env bash
# The newest glibc the release binaries need, against the oldest glibc of the test matrix (Debian 13, 2.41):
#   bash scripts/linux/check-glibc.sh <binary>...
#   bash scripts/linux/check-glibc.sh --libraries <file>...   the libraries an AppImage carries: one with
#                                                            no glibc versions passes, only failures and a
#                                                            summary are printed
# They are compiled once on Void Linux, a rolling distribution (scripts/build-linux-packages.mjs --stage
# compile), and a binary linked on a newer glibc does not start on an older one. Without this check an
# update of the Void image would break Debian quietly. KOONAPIN_GLIBC_FLOOR sets another floor.
set -euo pipefail

floor=${KOONAPIN_GLIBC_FLOOR:-2.41}

# The newest GLIBC_x.y a binary's dynamic symbols ask for (GLIBC_PRIVATE is not a version); empty if none.
needed() {
  objdump -T "$1" | grep -o 'GLIBC_[0-9][0-9.]*' | sed 's/^GLIBC_//' | sort -u -V | tail -n 1
}

# True when version $1 is newer than version $2.
newer() {
  [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n 1)" = "$1" ]
}

main() {
  local libraries=false
  if [ "${1:-}" = --libraries ]; then
    libraries=true
    shift
  fi
  if [ "$#" -eq 0 ]; then
    echo "usage: $0 [--libraries] <binary>..." >&2
    return 2
  fi
  local failed=0 newest="" binary version
  for binary in "$@"; do
    version=$(needed "$binary") || version=
    if [ -z "$version" ]; then
      $libraries && continue
      echo "$binary: no GLIBC_ symbol versions (not a dynamic glibc binary?)" >&2
      failed=1
    elif newer "$version" "$floor"; then
      echo "$binary: needs GLIBC_$version, newer than the floor $floor: it would not start on the oldest distribution of the matrix" >&2
      failed=1
    else
      $libraries || echo "ok: $binary needs GLIBC_$version (floor $floor)"
    fi
    if [ -n "$version" ] && { [ -z "$newest" ] || newer "$version" "$newest"; }; then newest=$version; fi
  done
  $libraries && [ "$failed" = 0 ] && echo "ok: $# libraries need at most GLIBC_${newest:-none} (floor $floor)"
  return "$failed"
}

# Sourced (tests of the functions), nothing runs.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
