#!/bin/sh
# ============================================================
#  Capri - DeepSeek Harness portable launcher (macOS / Linux)
#
#  Layout this script expects:
#    <volume>/
#      start.sh         <- this file
#      Capri/           <- runtime, data, plugins
#
#  On Linux the sandbox uses bwrap or Landlock, both path-based, so an exFAT
#  volume works. On macOS the sandbox uses seatbelt, also path-based, but
#  macOS mounts NTFS read-only without extra drivers, so a Mac needs exFAT or
#  APFS for DSH_HOME to be writable.
# ============================================================

set -eu

# Resolve this script's directory even through a symlink.
SCRIPT_PATH=$0
while [ -h "$SCRIPT_PATH" ]; do
  LINK_TARGET=$(readlink "$SCRIPT_PATH")
  case $LINK_TARGET in
    /*) SCRIPT_PATH=$LINK_TARGET ;;
    *)  SCRIPT_PATH=$(dirname "$SCRIPT_PATH")/$LINK_TARGET ;;
  esac
done
SCRIPT_DIR=$(cd "$(dirname "$SCRIPT_PATH")" && pwd)

# --- Locate the content folder --------------------------------------
CONTENT_ROOT=""
if [ -d "$SCRIPT_DIR/Capri/dsh" ]; then
  CONTENT_ROOT="$SCRIPT_DIR/Capri"
elif [ -d "$SCRIPT_DIR/dsh" ]; then
  CONTENT_ROOT="$SCRIPT_DIR"
fi

if [ -z "$CONTENT_ROOT" ]; then
  echo ""
  echo "  [Capri] Cannot find the Capri folder."
  echo ""
  echo "  Expected one of:"
  echo "    $SCRIPT_DIR/Capri/dsh"
  echo "    $SCRIPT_DIR/dsh"
  echo ""
  echo "  Keep start.sh beside the Capri folder, then try again."
  exit 1
fi

# --- Portable roots --------------------------------------------------
DSH_HOME="$CONTENT_ROOT/home"
export DSH_HOME
DSH_RESOURCE_CACHE="$CONTENT_ROOT/home/cache"
export DSH_RESOURCE_CACHE
: "${DSH_TELEMETRY_DISABLED:=1}"
export DSH_TELEMETRY_DISABLED

# --- Detect OS and CPU ----------------------------------------------
UNAME_S=$(uname -s)
case $UNAME_S in
  Darwin) OS_NAME=darwin ;;
  Linux)  OS_NAME=linux ;;
  *)
    echo "  [Capri] Unsupported operating system: $UNAME_S"
    exit 1
    ;;
esac

UNAME_M=$(uname -m)
case $UNAME_M in
  x86_64|amd64)   ARCH=x64 ;;
  arm64|aarch64)  ARCH=arm64 ;;
  *)
    echo "  [Capri] Unsupported CPU architecture: $UNAME_M"
    exit 1
    ;;
esac

TARGET="$OS_NAME-$ARCH"
RUNTIME_DIR="$CONTENT_ROOT/dsh/$TARGET"
CLI_ENTRY="$RUNTIME_DIR/lib/bin.js"

if [ ! -f "$CLI_ENTRY" ]; then
  echo "  [Capri] Runtime missing: $CLI_ENTRY"
  echo "  [Capri] Build it on a $TARGET machine, then copy it into dsh/$TARGET/."
  exit 1
fi

# --- Pick the bundled Node, else fall back to the system one ---------
NODE_EXE=""
BUNDLED_NODE_DIR="$CONTENT_ROOT/node/$TARGET"
for candidate in "$BUNDLED_NODE_DIR/bin/node" "$BUNDLED_NODE_DIR/node"; do
  if [ -x "$candidate" ]; then
    NODE_EXE=$candidate
    break
  fi
done
if [ -z "$NODE_EXE" ] && command -v node >/dev/null 2>&1; then
  NODE_EXE=node
fi

if [ -z "$NODE_EXE" ]; then
  echo "  [Capri] No Node.js found."
  echo "  [Capri] Put a Node runtime under node/$TARGET/ inside Capri,"
  echo "  [Capri] or install Node.js 24.9+ on this machine."
  exit 1
fi

# exFAT and some NTFS mounts drop the executable bit.
chmod +x "$NODE_EXE" 2>/dev/null || true

# --- Bundled pnpm for plugin installs --------------------------------
BUNDLED_PNPM=""
for candidate in "$BUNDLED_NODE_DIR/bin/pnpm" "$BUNDLED_NODE_DIR/pnpm"; do
  if [ -x "$candidate" ]; then
    BUNDLED_PNPM=$candidate
    break
  fi
done
if [ -n "$BUNDLED_PNPM" ]; then
  CAPRI_PNPM=$BUNDLED_PNPM
  export CAPRI_PNPM
  PATH="$(dirname "$BUNDLED_PNPM"):$PATH"
  export PATH
fi

# --- Default workspace on the host disk ------------------------------
# The web profile has no workspace flag; the Web UI starts in the process
# working directory. Point that at a folder on this machine, then pick the
# real project folder in the UI.
WORKSPACE=${CAPRI_WORKSPACE:-"$HOME/CapriWorkspace"}
mkdir -p "$WORKSPACE" 2>/dev/null || true

mkdir -p "$DSH_HOME/profiles/web" "$DSH_HOME/cache" 2>/dev/null || true

echo ""
echo "  Capri  -  DeepSeek Harness"
echo "  --------------------------"
echo "  platform  : $TARGET"
echo "  content   : $CONTENT_ROOT"
echo "  home      : $DSH_HOME"
echo "  runtime   : $RUNTIME_DIR"
echo "  workspace : $WORKSPACE"
echo ""
echo "  Pick your real project folder in the Web UI."
echo ""

# --- Launch -----------------------------------------------------------
cd "$WORKSPACE"
exec "$NODE_EXE" "$CLI_ENTRY" web "$@"
