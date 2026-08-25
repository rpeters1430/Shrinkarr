#!/usr/bin/env bash
# ==============================================================================
# Shrinkarr Docker Hardware Acceleration & Render Info Diagnostic Tool
# ==============================================================================
# Run from the host to inspect a running Shrinkarr Docker container's GPU passthrough,
# render nodes, driver state, and hardware transcoding performance.
# ==============================================================================

set -euo pipefail

# ANSI color codes
if [ -t 1 ] && [ "${NO_COLOR:-}" = "" ]; then
  C_RESET="\033[0m"
  C_BOLD="\033[1m"
  C_DIM="\033[2m"
  C_RED="\033[31m"
  C_GREEN="\033[32m"
  C_YELLOW="\033[33m"
  C_BLUE="\033[34m"
  C_MAGENTA="\033[35m"
  C_CYAN="\033[36m"
  C_WHITE="\033[37m"
else
  C_RESET=""
  C_BOLD=""
  C_DIM=""
  C_RED=""
  C_GREEN=""
  C_YELLOW=""
  C_BLUE=""
  C_MAGENTA=""
  C_CYAN=""
  C_WHITE=""
fi

CONTAINER_NAME=""
PASSTHROUGH_ARGS=()
WATCH_MODE=0

print_usage() {
  cat <<EOF
Shrinkarr Docker Hardware Acceleration & Render Info Diagnostic Tool

Usage:
  ./scripts/docker-check-hardware.sh [container_name] [options]

Arguments:
  container_name         Name or ID of running container (default: shrinkarr)

Options:
  -b, --benchmark        Run live transcode speed benchmarks inside container
  -w, --watch            Launch live GPU & transcode monitor (shrinkarr-top)
  -j, --json             Output container diagnostic in JSON format
  -d, --device <path>    Specify a specific DRM render node (e.g. /dev/dri/renderD128)
  -v, --verbose          Show verbose debug logs
  -h, --help             Show this help message

Examples:
  ./scripts/docker-check-hardware.sh
  ./scripts/docker-check-hardware.sh shrinkarr --benchmark
  ./scripts/docker-check-hardware.sh shrinkarr --watch
  ./scripts/docker-check-hardware.sh my-custom-container
EOF
}

# Parse options
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      print_usage
      exit 0
      ;;
    -w|--watch)
      WATCH_MODE=1
      shift
      ;;
    -b|--benchmark|-j|--json|-v|--verbose)
      PASSTHROUGH_ARGS+=("$1")
      shift
      ;;
    -d|--device)
      PASSTHROUGH_ARGS+=("$1" "$2")
      shift 2
      ;;
    -*)
      echo "Unknown option: $1" >&2
      print_usage >&2
      exit 1
      ;;
    *)
      if [ -z "$CONTAINER_NAME" ]; then
        CONTAINER_NAME="$1"
      else
        PASSTHROUGH_ARGS+=("$1")
      fi
      shift
      ;;
  esac
done

print_header() {
  echo -e "\n${C_BOLD}${C_CYAN}=== $1 ===${C_RESET}"
}

print_ok() {
  echo -e "  ${C_GREEN}[✓]${C_RESET} $1"
}

print_warn() {
  echo -e "  ${C_YELLOW}[!]${C_RESET} $1"
}

print_fail() {
  echo -e "  ${C_RED}[✗]${C_RESET} $1"
}

print_info() {
  echo -e "  ${C_DIM}[i]${C_RESET} $1"
}

# 1. Check Docker binary and daemon
if ! command -v docker >/dev/null 2>&1; then
  print_fail "docker command not found on host. Please install Docker."
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  print_fail "Docker daemon is not running or current user cannot connect to docker socket."
  exit 1
fi

# 2. Identify Target Container
if [ -z "$CONTAINER_NAME" ]; then
  # Try finding a running shrinkarr container automatically
  RUNNING_SHRINKARR=$(docker ps --filter "name=shrinkarr" --format "{{.Names}}" | head -n1 || true)
  if [ -n "$RUNNING_SHRINKARR" ]; then
    CONTAINER_NAME="$RUNNING_SHRINKARR"
  else
    # Fallback to default name
    CONTAINER_NAME="shrinkarr"
  fi
fi

# Check if container exists
if ! docker inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  print_fail "Docker container '${C_BOLD}${CONTAINER_NAME}${C_RESET}' was not found."
  echo -e "\n  ${C_BOLD}Active running containers:${C_RESET}"
  docker ps --format "    • {{.Names}} (Image: {{.Image}}, Status: {{.Status}})" || true
  echo -e "\n  ${C_YELLOW}Start the container first with:${C_RESET} ${C_BOLD}docker compose up -d${C_RESET}"
  exit 1
fi

# Check if container is running
IS_RUNNING=$(docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null || echo "false")
if [ "$IS_RUNNING" != "true" ]; then
  STATE_STATUS=$(docker inspect -f '{{.State.Status}}' "$CONTAINER_NAME" 2>/dev/null || echo "stopped")
  print_fail "Container '${C_BOLD}${CONTAINER_NAME}${C_RESET}' exists but is not running (Current status: ${STATE_STATUS})."
  echo -e "  ${C_YELLOW}Start it with:${C_RESET} ${C_BOLD}docker start ${CONTAINER_NAME}${C_RESET}"
  exit 1
fi

# If Watch mode requested, launch shrinkarr-top directly
if [ "$WATCH_MODE" = "1" ]; then
  # Check if shrinkarr-top exists in container
  if docker exec "$CONTAINER_NAME" which shrinkarr-top >/dev/null 2>&1; then
    exec docker exec -it "$CONTAINER_NAME" shrinkarr-top
  else
    # Copy host script and run
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    docker cp "${SCRIPT_DIR}/shrinkarr-top.sh" "${CONTAINER_NAME}:/tmp/shrinkarr-top.sh"
    docker exec "$CONTAINER_NAME" chmod +x /tmp/shrinkarr-top.sh
    exec docker exec -it "$CONTAINER_NAME" /tmp/shrinkarr-top.sh
  fi
fi

# Only print host pre-flight if not in json mode
IS_JSON=0
for arg in "${PASSTHROUGH_ARGS[@]:-}"; do
  if [ "$arg" = "-j" ] || [ "$arg" = "--json" ]; then
    IS_JSON=1
    break
  fi
done

if [ "$IS_JSON" = "0" ]; then
  echo -e "${C_BOLD}${C_MAGENTA}"
  cat << 'BANNER'
  ____  _            _             _                              
 / ___|| |__  _ __ (_)_ __  _ __ | | _____ _ __ _ __              
 \___ \| '_ \| '__|| | '_ \| |/ /| |/ / _ \ '__| '__|             
  ___) | | | | |   | | | | |   < |   <  __/ |  | |                
 |____/|_| |_|_|   |_|_| |_|_|\_\|_|\_\___|_|  |_|  DOCKER INSPECTOR
BANNER
  echo -e "${C_RESET}"

  print_header "Host Docker Container Inspection"
  echo -e "  ${C_BOLD}Container Name:${C_RESET}     ${C_GREEN}${CONTAINER_NAME}${C_RESET}"
  
  IMAGE_NAME=$(docker inspect -f '{{.Config.Image}}' "$CONTAINER_NAME")
  echo -e "  ${C_BOLD}Container Image:${C_RESET}    $IMAGE_NAME"

  # Check host vs container /dev/dri devices
  HOST_DEVICES=$(docker inspect -f '{{range .HostConfig.Devices}}{{.PathOnHost}}:{{.PathInContainer}} {{end}}' "$CONTAINER_NAME")
  echo -e "  ${C_BOLD}Mapped Devices:${C_RESET}     ${HOST_DEVICES:-None}"

  if [ -d /dev/dri ]; then
    if echo "$HOST_DEVICES" | grep -q "/dev/dri"; then
      print_ok "Host /dev/dri is mapped into container"
    else
      print_warn "Host has /dev/dri available, but it is NOT mapped to container '${CONTAINER_NAME}'!"
      echo -e "      ${C_YELLOW}→ Add ${C_BOLD}devices: - /dev/dri:/dev/dri${C_RESET}${C_YELLOW} to docker-compose.yml${C_RESET}"
    fi
  else
    print_info "Host does not have /dev/dri (no local Intel/AMD DRM GPU found)"
  fi
fi

# Execute check-hardware inside the container
# If check-hardware is in /usr/local/bin, execute it directly
if docker exec "$CONTAINER_NAME" which check-hardware >/dev/null 2>&1; then
  docker exec -i "$CONTAINER_NAME" check-hardware "${PASSTHROUGH_ARGS[@]}"
else
  # Otherwise copy our script into container /tmp and execute
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  docker cp "${SCRIPT_DIR}/check-hardware.sh" "${CONTAINER_NAME}:/tmp/check-hardware.sh" >/dev/null 2>&1
  docker exec "$CONTAINER_NAME" chmod +x /tmp/check-hardware.sh >/dev/null 2>&1
  docker exec -i "$CONTAINER_NAME" /tmp/check-hardware.sh "${PASSTHROUGH_ARGS[@]}"
fi
