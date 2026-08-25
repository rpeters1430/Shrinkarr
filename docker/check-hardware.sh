#!/usr/bin/env bash
# ==============================================================================
# Shrinkarr Hardware Acceleration & Render Info Diagnostic Tool
# ==============================================================================
# Inspects GPU render nodes, VA-API / QSV / NVENC drivers, FFmpeg capabilities,
# and runs live hardware encoding benchmarks to verify GPU utilization.
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

MODE="report" # report, benchmark, json
TARGET_DEVICE=""
VERBOSE=0

print_usage() {
  cat <<EOF
Shrinkarr Hardware Acceleration & Render Info Diagnostic Tool

Usage:
  check-hardware [options]

Options:
  -b, --benchmark     Run extended multi-resolution hardware encoding benchmarks (1080p & 4K)
  -j, --json          Output full diagnostic report in JSON format
  -d, --device <path> Test a specific DRM render node (e.g. /dev/dri/renderD128)
  -v, --verbose       Show verbose ffmpeg / vainfo debug output
  -h, --help          Show this help message

Examples:
  check-hardware                        # Quick hardware & render info diagnostic
  check-hardware --benchmark            # Run live transcode speed benchmarks
  docker exec -it shrinkarr check-hardware # Run inside Docker container
EOF
}

# Parse command line options
while [[ $# -gt 0 ]]; do
  case "$1" in
    -b|--benchmark)
      MODE="benchmark"
      shift
      ;;
    -j|--json)
      MODE="json"
      shift
      ;;
    -d|--device)
      TARGET_DEVICE="$2"
      shift 2
      ;;
    -v|--verbose)
      VERBOSE=1
      shift
      ;;
    -h|--help)
      print_usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      print_usage >&2
      exit 1
      ;;
  esac
done

# Helper: print section header
print_header() {
  echo -e "\n${C_BOLD}${C_CYAN}=== $1 ===${C_RESET}"
}

print_sub() {
  echo -e "${C_BOLD}${C_BLUE}--- $1 ---${C_RESET}"
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

# Detect environment (container vs host)
IS_CONTAINER=0
if [ -f /.dockerenv ] || grep -q 'docker\|containerd\|kubepods' /proc/1/cgroup 2>/dev/null; then
  IS_CONTAINER=1
fi

# Find all DRM render and card nodes
find_render_nodes() {
  if [ -n "$TARGET_DEVICE" ]; then
    if [ -e "$TARGET_DEVICE" ]; then
      echo "$TARGET_DEVICE"
    fi
    return
  fi

  if [ -d /dev/dri ]; then
    find /dev/dri -name "renderD*" 2>/dev/null | sort || true
  fi
}

find_card_nodes() {
  if [ -d /dev/dri ]; then
    find /dev/dri -name "card*" 2>/dev/null | sort || true
  fi
}

# Parse vainfo profile support
check_va_profile() {
  local vainfo_out="$1"
  local profile_pattern="$2"
  local entrypoint="$3"

  if echo "$vainfo_out" | grep -E "$profile_pattern" | grep -q "$entrypoint"; then
    return 0
  else
    return 1
  fi
}

# Test encoding with a specific ffmpeg configuration
test_encoder() {
  local encoder="$1"
  local extra_args="$2"
  local res="${3:-640x360}"
  local duration="${4:-0.8}"
  local is_10bit="${5:-0}"

  local pix_fmt="yuv420p"
  if [ "$is_10bit" = "1" ]; then
    pix_fmt="yuv420p10le"
  fi

  local cmd=(
    ffmpeg -hide_banner -loglevel error
    -f lavfi -i "testsrc=size=${res}:rate=30:duration=${duration},format=${pix_fmt}"
  )

  # Append extra args if any
  if [ -n "$extra_args" ]; then
    # shellcheck disable=SC2206
    cmd+=($extra_args)
  fi

  cmd+=(
    -c:v "$encoder"
    -f null -
  )

  local output
  if output=$("${cmd[@]}" -stats 2>&1); then
    # Try extracting speed from ffmpeg stats output
    local speed="1.0x"
    local speed_match
    speed_match=$(echo "$output" | grep -o 'speed=[ ]*[0-9.]*x' | tail -n1 | tr -d ' ' || true)
    if [ -n "$speed_match" ]; then
      speed="${speed_match#speed=}"
    fi

    # Try extracting fps
    local fps=""
    local fps_match
    fps_match=$(echo "$output" | grep -o 'fps=[ ]*[0-9.]*' | tail -n1 | tr -d ' ' || true)
    if [ -n "$fps_match" ]; then
      fps="${fps_match#fps=}"
    fi

    echo "OK|${speed}|${fps}"
  else
    if [ "$VERBOSE" = "1" ]; then
      echo "FAIL|$output"
    else
      local first_err
      first_err=$(echo "$output" | head -n 2 | tr '\n' ' ')
      echo "FAIL|$first_err"
    fi
  fi
}

# Output JSON report
if [ "$MODE" = "json" ]; then
  # Gather JSON data
  RENDER_NODES_JSON="[]"
  RENDER_NODES=$(find_render_nodes)
  if [ -n "$RENDER_NODES" ]; then
    RENDER_ITEMS=""
    for rnode in $RENDER_NODES; do
      VA_OUT=$(vainfo --display drm --device "$rnode" 2>&1 || true)
      DRIVER=$(echo "$VA_OUT" | grep -i "Driver version:" | sed 's/.*Driver version:[[:space:]]*//' | tr -d '"\n' || echo "Unknown")
      VA_VER=$(echo "$VA_OUT" | grep -i "VA-API version:" | sed 's/.*VA-API version:[[:space:]]*//' | awk '{print $1}' | tr -d '\n' || echo "Unknown")
      
      H264_DEC=false; check_va_profile "$VA_OUT" "VAProfileH264" "VAEntrypointVLD" && H264_DEC=true
      H264_ENC=false; check_va_profile "$VA_OUT" "VAProfileH264" "VAEntrypointEnc" && H264_ENC=true
      HEVC_DEC=false; check_va_profile "$VA_OUT" "VAProfileHEVCMain" "VAEntrypointVLD" && HEVC_DEC=true
      HEVC_ENC=false; (check_va_profile "$VA_OUT" "VAProfileHEVCMain[[:space:]]" "VAEntrypointEnc" || check_va_profile "$VA_OUT" "VAProfileHEVCMain$" "VAEntrypointEnc") && HEVC_ENC=true
      HEVC10_DEC=false; check_va_profile "$VA_OUT" "VAProfileHEVCMain10" "VAEntrypointVLD" && HEVC10_DEC=true
      HEVC10_ENC=false; check_va_profile "$VA_OUT" "VAProfileHEVCMain10" "VAEntrypointEnc" && HEVC10_ENC=true
      AV1_DEC=false; check_va_profile "$VA_OUT" "VAProfileAV1" "VAEntrypointVLD" && AV1_DEC=true
      AV1_ENC=false; check_va_profile "$VA_OUT" "VAProfileAV1" "VAEntrypointEnc" && AV1_ENC=true
      VP9_DEC=false; check_va_profile "$VA_OUT" "VAProfileVP9" "VAEntrypointVLD" && VP9_DEC=true
      VP9_ENC=false; check_va_profile "$VA_OUT" "VAProfileVP9" "VAEntrypointEnc" && VP9_ENC=true

      CAN_READ=false; [ -r "$rnode" ] && CAN_READ=true
      CAN_WRITE=false; [ -w "$rnode" ] && CAN_WRITE=true

      ITEM=$(cat <<JSONITEM
{
  "path": "$rnode",
  "readable": $CAN_READ,
  "writable": $CAN_WRITE,
  "driver": "$DRIVER",
  "vaapiVersion": "$VA_VER",
  "codecs": {
    "h264": { "decode": $H264_DEC, "encode": $H264_ENC },
    "hevc": { "decode": $HEVC_DEC, "encode": $HEVC_ENC },
    "hevc10": { "decode": $HEVC10_DEC, "encode": $HEVC10_ENC },
    "av1": { "decode": $AV1_DEC, "encode": $AV1_ENC },
    "vp9": { "decode": $VP9_DEC, "encode": $VP9_ENC }
  }
}
JSONITEM
)
      if [ -n "$RENDER_ITEMS" ]; then
        RENDER_ITEMS="$RENDER_ITEMS, $ITEM"
      else
        RENDER_ITEMS="$ITEM"
      fi
    done
    RENDER_NODES_JSON="[$RENDER_ITEMS]"
  fi

  FFMPEG_PATH=$(command -v ffmpeg || echo "")
  FFMPEG_VER=$("$FFMPEG_PATH" -version 2>&1 | head -n1 | awk '{print $3}' || echo "N/A")
  
  cat <<JSONDOC
{
  "timestamp": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "isContainer": $([ "$IS_CONTAINER" = "1" ] && echo "true" || echo "false"),
  "user": {
    "uid": $(id -u),
    "gid": $(id -g),
    "name": "$(id -un)",
    "groups": "$(id -Gn)"
  },
  "renderNodes": $RENDER_NODES_JSON,
  "ffmpeg": {
    "path": "$FFMPEG_PATH",
    "version": "$FFMPEG_VER"
  }
}
JSONDOC
  exit 0
fi

# ==============================================================================
# Interactive / Formatted Diagnostic Report
# ==============================================================================

echo -e "${C_BOLD}${C_MAGENTA}"
cat << 'BANNER'
  ____  _            _             _                              
 / ___|| |__  _ __ (_)_ __  _ __ | | _____ _ __ _ __              
 \___ \| '_ \| '__|| | '_ \| |/ /| |/ / _ \ '__| '__|             
  ___) | | | | |   | | | | |   < |   <  __/ |  | |                
 |____/|_| |_|_|   |_|_| |_|_|\_\|_|\_\___|_|  |_|  HARDWARE DOCTOR
BANNER
echo -e "${C_RESET}"
echo -e "${C_DIM}Shrinkarr Video Transcoding & Hardware Acceleration Inspector${C_RESET}"
echo -e "${C_DIM}Date: $(date)${C_RESET}"

# 1. Environment & User Permissions
print_header "1. System & Container Environment"

OS_NAME="$(uname -s) $(uname -r) ($(uname -m))"
echo -e "  ${C_BOLD}OS / Kernel:${C_RESET}     $OS_NAME"

if [ "$IS_CONTAINER" = "1" ]; then
  print_ok "Running inside a ${C_BOLD}Docker container${C_RESET}"
else
  print_info "Running directly on ${C_BOLD}Host OS${C_RESET}"
fi

CURRENT_USER="$(id -un) (UID=$(id -u), GID=$(id -g))"
echo -e "  ${C_BOLD}Current User:${C_RESET}    $CURRENT_USER"
echo -e "  ${C_BOLD}User Groups:${C_RESET}     $(id -Gn)"

# Check video and render group membership
GROUPS_STRING="$(id -Gn)"
if echo "$GROUPS_STRING" | grep -q -E "video|render"; then
  print_ok "User belongs to GPU access group(s)"
else
  print_warn "User is not explicitly in 'video' or 'render' groups (may still work if /dev/dri permissions allow)"
fi

# 2. Device Nodes Inspection
print_header "2. Direct Rendering Manager (DRM) Device Nodes"

if [ ! -d /dev/dri ]; then
  print_fail "${C_BOLD}/dev/dri directory not found!${C_RESET}"
  echo -e "      ${C_YELLOW}→ GPU device passthrough is missing from your Docker container.${C_RESET}"
  echo -e "      ${C_YELLOW}→ Add ${C_BOLD}devices: - /dev/dri:/dev/dri${C_RESET}${C_YELLOW} to your docker-compose.yml${C_RESET}"
else
  print_ok "Found ${C_BOLD}/dev/dri${C_RESET} directory"
  
  RENDER_NODES=$(find_render_nodes)
  CARD_NODES=$(find_card_nodes)

  if [ -z "$RENDER_NODES" ] && [ -z "$CARD_NODES" ]; then
    print_warn "No card* or renderD* nodes found inside /dev/dri"
  else
    for node in /dev/dri/*; do
      [ -e "$node" ] || continue
      PERMS=$(ls -ld "$node" | awk '{print $1}')
      OWNER=$(ls -ld "$node" | awk '{print $3":"$4}')
      
      ACC_STATUS=""
      if [ -r "$node" ] && [ -w "$node" ]; then
        ACC_STATUS="${C_GREEN}[Read/Write OK]${C_RESET}"
      elif [ -r "$node" ]; then
        ACC_STATUS="${C_YELLOW}[Read Only]${C_RESET}"
      else
        ACC_STATUS="${C_RED}[Permission Denied]${C_RESET}"
      fi

      echo -e "  • ${C_BOLD}$node${C_RESET}  ${C_DIM}($PERMS $OWNER)${C_RESET} → $ACC_STATUS"
    done
  fi
fi

# Check for NVIDIA device nodes
NVIDIA_NODES=$(find /dev -maxdepth 1 -name "nvidia*" 2>/dev/null || true)
if [ -n "$NVIDIA_NODES" ]; then
  print_ok "NVIDIA device nodes detected in /dev"
  for nnode in $NVIDIA_NODES; do
    echo -e "    • $nnode"
  done
fi

# 3. GPU Hardware & VA-API Render Capabilities
print_header "3. GPU Hardware & Driver Capabilities (Render Info)"

# Try listing PCI devices if lspci is available
if command -v lspci >/dev/null 2>&1; then
  GPU_PCI=$(lspci 2>/dev/null | grep -E "VGA|3D|Display" || true)
  if [ -n "$GPU_PCI" ]; then
    echo -e "  ${C_BOLD}PCI Display Adapters:${C_RESET}"
    echo "$GPU_PCI" | while read -r line; do
      echo -e "    • ${C_CYAN}$line${C_RESET}"
    done
  fi
fi

# Check vainfo for each render node
RENDER_LIST=$(find_render_nodes)
HAS_WORKING_VAAPI=0

if [ -n "$RENDER_LIST" ]; then
  if ! command -v vainfo >/dev/null 2>&1; then
    print_warn "vainfo utility is not installed or not in PATH"
  else
    for rnode in $RENDER_LIST; do
      echo ""
      print_sub "Render Node: $rnode"
      
      if [ ! -r "$rnode" ] || [ ! -w "$rnode" ]; then
        print_fail "Cannot access $rnode due to permissions"
        continue
      fi

      VA_OUT=$(vainfo --display drm --device "$rnode" 2>&1 || true)
      
      if echo "$VA_OUT" | grep -qi "VA-API version:"; then
        HAS_WORKING_VAAPI=1
        VA_VER=$(echo "$VA_OUT" | grep -i "VA-API version:" | sed 's/.*VA-API version:[[:space:]]*//' | tr -d '\n')
        DRIVER_STR=$(echo "$VA_OUT" | grep -i "Driver version:" | sed 's/.*Driver version:[[:space:]]*//' | tr -d '\n')

        print_ok "VA-API Version: ${C_BOLD}$VA_VER${C_RESET}"
        print_ok "Driver Version: ${C_BOLD}$DRIVER_STR${C_RESET}"
        
        echo -e "\n    ${C_BOLD}Hardware Acceleration Codec Matrix:${C_RESET}"
        printf "    %-28s %-16s %-16s\n" "Codec / Profile" "Hardware Decode" "Hardware Encode"
        printf "    %-28s %-16s %-16s\n" "----------------------------" "---------------" "---------------"

        # Check H.264
        H264_DEC="-" ; check_va_profile "$VA_OUT" "VAProfileH264" "VAEntrypointVLD" && H264_DEC="${C_GREEN}Supported [✓]${C_RESET}"
        H264_ENC="-" ; check_va_profile "$VA_OUT" "VAProfileH264" "VAEntrypointEnc" && H264_ENC="${C_GREEN}Supported [✓]${C_RESET}"
        printf "    %-28s %-26b %-26b\n" "H.264 / AVC (8-bit)" "$H264_DEC" "$H264_ENC"

        # Check HEVC Main
        HEVC_DEC="-" ; check_va_profile "$VA_OUT" "VAProfileHEVCMain" "VAEntrypointVLD" && HEVC_DEC="${C_GREEN}Supported [✓]${C_RESET}"
        HEVC_ENC="-" ; (check_va_profile "$VA_OUT" "VAProfileHEVCMain[[:space:]]" "VAEntrypointEnc" || check_va_profile "$VA_OUT" "VAProfileHEVCMain$" "VAEntrypointEnc") && HEVC_ENC="${C_GREEN}Supported [✓]${C_RESET}"
        printf "    %-28s %-26b %-26b\n" "HEVC / H.265 (8-bit)" "$HEVC_DEC" "$HEVC_ENC"

        # Check HEVC Main 10 (10-bit / HDR)
        HEVC10_DEC="-" ; check_va_profile "$VA_OUT" "VAProfileHEVCMain10" "VAEntrypointVLD" && HEVC10_DEC="${C_GREEN}Supported [✓]${C_RESET}"
        HEVC10_ENC="-" ; check_va_profile "$VA_OUT" "VAProfileHEVCMain10" "VAEntrypointEnc" && HEVC10_ENC="${C_GREEN}Supported [✓]${C_RESET}"
        printf "    %-28s %-26b %-26b\n" "HEVC Main 10 (10-bit / HDR)" "$HEVC10_DEC" "$HEVC10_ENC"

        # Check AV1
        AV1_DEC="-" ; check_va_profile "$VA_OUT" "VAProfileAV1" "VAEntrypointVLD" && AV1_DEC="${C_GREEN}Supported [✓]${C_RESET}"
        AV1_ENC="-" ; check_va_profile "$VA_OUT" "VAProfileAV1" "VAEntrypointEnc" && AV1_ENC="${C_GREEN}Supported [✓]${C_RESET}"
        printf "    %-28s %-26b %-26b\n" "AV1 (Profile 0)" "$AV1_DEC" "$AV1_ENC"

        # Check VP9
        VP9_DEC="-" ; check_va_profile "$VA_OUT" "VAProfileVP9" "VAEntrypointVLD" && VP9_DEC="${C_GREEN}Supported [✓]${C_RESET}"
        VP9_ENC="-" ; check_va_profile "$VA_OUT" "VAProfileVP9" "VAEntrypointEnc" && VP9_ENC="${C_GREEN}Supported [✓]${C_RESET}"
        printf "    %-28s %-26b %-26b\n" "Google VP9" "$VP9_DEC" "$VP9_ENC"

        # Check MPEG2
        MPEG2_DEC="-" ; check_va_profile "$VA_OUT" "VAProfileMPEG2" "VAEntrypointVLD" && MPEG2_DEC="${C_GREEN}Supported [✓]${C_RESET}"
        MPEG2_ENC="-" ; check_va_profile "$VA_OUT" "VAProfileMPEG2" "VAEntrypointEnc" && MPEG2_ENC="${C_GREEN}Supported [✓]${C_RESET}"
        printf "    %-28s %-26b %-26b\n" "MPEG-2 (DVD / OTA TV)" "$MPEG2_DEC" "$MPEG2_ENC"

      else
        print_fail "vainfo failed to initialize $rnode"
        if [ "$VERBOSE" = "1" ]; then
          echo "$VA_OUT" | head -n 8 | sed 's/^/      /'
        fi
      fi
    done
  fi
fi

# Check NVIDIA SMI if available
if command -v nvidia-smi >/dev/null 2>&1; then
  echo ""
  print_sub "NVIDIA GPU Status (nvidia-smi)"
  NV_INFO=$(nvidia-smi --query-gpu=name,driver_version,memory.total,temperature.gpu --format=csv,noheader 2>/dev/null || true)
  if [ -n "$NV_INFO" ]; then
    print_ok "NVIDIA GPU accessible"
    echo -e "    • ${C_BOLD}GPU:${C_RESET}         $(echo "$NV_INFO" | awk -F',' '{print $1}')"
    echo -e "    • ${C_BOLD}Driver:${C_RESET}      $(echo "$NV_INFO" | awk -F',' '{print $2}')"
    echo -e "    • ${C_BOLD}VRAM:${C_RESET}        $(echo "$NV_INFO" | awk -F',' '{print $3}')"
    echo -e "    • ${C_BOLD}Temp:${C_RESET}        $(echo "$NV_INFO" | awk -F',' '{print $4}')${C_RESET}"
  else
    print_warn "nvidia-smi installed but failed to query GPU (is NVIDIA Container Toolkit installed?)"
  fi
fi

# 4. FFmpeg Capabilities
print_header "4. FFmpeg Transcoder Capabilities"

if ! command -v ffmpeg >/dev/null 2>&1; then
  print_fail "ffmpeg executable not found in PATH"
else
  FFMPEG_BIN=$(command -v ffmpeg)
  FFMPEG_VERSION=$(ffmpeg -version 2>&1 | head -n1)
  print_ok "FFmpeg binary: ${C_BOLD}$FFMPEG_BIN${C_RESET}"
  print_ok "FFmpeg version: ${C_BOLD}$FFMPEG_VERSION${C_RESET}"

  HWACCELS=$(ffmpeg -hide_banner -hwaccels 2>&1 | tail -n +2 | tr '\n' ' ' || true)
  echo -e "  ${C_BOLD}Supported HW Methods:${C_RESET} ${C_CYAN}$HWACCELS${C_RESET}"

  # Scan for available encoders
  ALL_ENCODERS=$(ffmpeg -hide_banner -encoders 2>&1 || true)
  
  HW_ENCODERS_FOUND=()
  for enc in hevc_vaapi h264_vaapi av1_vaapi hevc_qsv h264_qsv av1_qsv hevc_nvenc h264_nvenc av1_nvenc hevc_amf h264_amf av1_amf; do
    if echo "$ALL_ENCODERS" | grep -q " $enc "; then
      HW_ENCODERS_FOUND+=("$enc")
    fi
  done

  if [ ${#HW_ENCODERS_FOUND[@]} -gt 0 ]; then
    print_ok "Compiled Hardware Encoders: ${C_GREEN}${HW_ENCODERS_FOUND[*]}${C_RESET}"
  else
    print_warn "No hardware encoders found in ffmpeg build"
  fi
fi

# 5. Live Transcode Benchmark & Verification
print_header "5. Live Hardware Acceleration Transcode Test"
echo -e "  ${C_DIM}Running live micro-encodes to verify hardware pipelines...${C_RESET}\n"

TEST_COUNT=0
PASS_COUNT=0

test_vaapi_encoder() {
  local encoder="$1"
  local rnode="$2"
  local name="$3"
  local extra_vf="${4:-}"
  local is_10bit="${5:-0}"

  TEST_COUNT=$((TEST_COUNT + 1))
  printf "  Testing %-24s on %-20s ... " "$name" "$rnode"

  local extra_args="-vaapi_device $rnode -vf format=nv12|vaapi,hwupload"
  if [ "$is_10bit" = "1" ]; then
    extra_args="-vaapi_device $rnode -vf format=p010|vaapi,hwupload"
  fi

  local res="640x360"
  local dur="0.8"
  if [ "$MODE" = "benchmark" ]; then
    res="1920x1080"
    dur="2.0"
  fi

  local result
  result=$(test_encoder "$encoder" "$extra_args" "$res" "$dur" "$is_10bit")
  local status="${result%%|*}"

  if [ "$status" = "OK" ]; then
    PASS_COUNT=$((PASS_COUNT + 1))
    local rest="${result#OK|}"
    local speed="${rest%%|*}"
    local fps="${rest#*|}"
    echo -e "${C_GREEN}[PASS]${C_RESET} (Speed: ${C_BOLD}${C_GREEN}${speed}${C_RESET}, FPS: ${fps})"
  else
    local err="${result#FAIL|}"
    echo -e "${C_RED}[FAIL]${C_RESET}"
    if [ "$VERBOSE" = "1" ] || [ -n "$err" ]; then
      echo -e "      ${C_DIM}Error: $err${C_RESET}"
    fi
  fi
}

test_generic_encoder() {
  local encoder="$1"
  local name="$2"
  local extra_args="$3"

  TEST_COUNT=$((TEST_COUNT + 1))
  printf "  Testing %-24s (Direct HW)          ... " "$name"

  local res="640x360"
  local dur="0.8"
  if [ "$MODE" = "benchmark" ]; then
    res="1920x1080"
    dur="2.0"
  fi

  local result
  result=$(test_encoder "$encoder" "$extra_args" "$res" "$dur" "0")
  local status="${result%%|*}"

  if [ "$status" = "OK" ]; then
    PASS_COUNT=$((PASS_COUNT + 1))
    local rest="${result#OK|}"
    local speed="${rest%%|*}"
    local fps="${rest#*|}"
    echo -e "${C_GREEN}[PASS]${C_RESET} (Speed: ${C_BOLD}${C_GREEN}${speed}${C_RESET}, FPS: ${fps})"
  else
    echo -e "${C_RED}[FAIL]${C_RESET}"
  fi
}

# Run VA-API tests for each render node
if [ -n "$RENDER_LIST" ]; then
  for rnode in $RENDER_LIST; do
    [ -r "$rnode" ] && [ -w "$rnode" ] || continue
    
    # Test H.264 VAAPI
    test_vaapi_encoder "h264_vaapi" "$rnode" "H.264 (VA-API)"
    
    # Test HEVC VAAPI 8-bit
    test_vaapi_encoder "hevc_vaapi" "$rnode" "HEVC 8-bit (VA-API)"

    # Test HEVC VAAPI 10-bit HDR
    test_vaapi_encoder "hevc_vaapi" "$rnode" "HEVC 10-bit HDR (VA-API)" "" "1"

    # Test AV1 VAAPI if supported
    VA_OUT=$(vainfo --display drm --device "$rnode" 2>&1 || true)
    if check_va_profile "$VA_OUT" "VAProfileAV1" "VAEntrypointEnc"; then
      test_vaapi_encoder "av1_vaapi" "$rnode" "AV1 (VA-API)"
    fi
  done
fi

# Run NVENC tests if NVIDIA is present
if [ -n "$NVIDIA_NODES" ] || command -v nvidia-smi >/dev/null 2>&1; then
  test_generic_encoder "hevc_nvenc" "HEVC (NVIDIA NVENC)" ""
  test_generic_encoder "h264_nvenc" "H.264 (NVIDIA NVENC)" ""
fi

# Run QSV tests if Intel QSV is present
if echo "${HW_ENCODERS_FOUND[*]:-}" | grep -q "hevc_qsv"; then
  test_generic_encoder "hevc_qsv" "HEVC (Intel QSV)" ""
fi

# Test Software CPU Fallback for baseline comparison
printf "  Testing %-24s (Software CPU)       ... " "HEVC (libx265)"
CPU_RES=$(test_encoder "libx265" "-preset fast -crf 28" "640x360" "0.8" "0")
if [ "${CPU_RES%%|*}" = "OK" ]; then
  CPU_SPEED=$(echo "$CPU_RES" | awk -F'|' '{print $2}')
  echo -e "${C_GREEN}[PASS]${C_RESET} (Speed: ${C_DIM}${CPU_SPEED}${C_RESET} CPU reference)"
else
  echo -e "${C_RED}[FAIL]${C_RESET}"
fi

# Extended 4K HDR benchmark if requested
if [ "$MODE" = "benchmark" ] && [ -n "$RENDER_LIST" ]; then
  echo ""
  print_sub "Extended 4K UHD HDR10 Transcode Benchmark"
  for rnode in $RENDER_LIST; do
    [ -r "$rnode" ] && [ -w "$rnode" ] || continue
    printf "  Benchmarking 4K 10-bit HEVC on %-20s ... " "$rnode"
    B4K_RES=$(test_encoder "hevc_vaapi" "-vaapi_device $rnode -vf format=p010|vaapi,hwupload" "3840x2160" "3.0" "1")
    if [ "${B4K_RES%%|*}" = "OK" ]; then
      B4K_SPEED=$(echo "$B4K_RES" | awk -F'|' '{print $2}')
      B4K_FPS=$(echo "$B4K_RES" | awk -F'|' '{print $3}')
      echo -e "${C_GREEN}[PASS]${C_RESET} (Speed: ${C_BOLD}${C_GREEN}${B4K_SPEED}${C_RESET}, ${B4K_FPS} FPS)"
    else
      echo -e "${C_YELLOW}[SKIPPED / UNSUPPORTED]${C_RESET}"
    fi
  done
fi

# 6. Overall Verdict & Recommendations
print_header "6. Diagnosis Summary & Verdict"

if [ "$PASS_COUNT" -gt 0 ]; then
  echo -e "  ${C_BOLD}${C_GREEN}STATUS: HARDWARE ACCELERATION FULLY OPERATIONAL (${PASS_COUNT} hardware encoder tests passed)${C_RESET}\n"
  echo -e "  Shrinkarr will automatically transcode video via hardware GPU encoders at maximum efficiency."
else
  echo -e "  ${C_BOLD}${C_RED}STATUS: HARDWARE ACCELERATION NOT DETECTED / FAILING${C_RESET}\n"
  echo -e "  Transcoding will fall back to CPU software encoding (high CPU utilization)."
  echo -e "\n  ${C_BOLD}Troubleshooting Steps:${C_RESET}"
  if [ "$IS_CONTAINER" = "1" ]; then
    if [ ! -d /dev/dri ]; then
      echo -e "  1. Pass DRM devices to your container in ${C_BOLD}docker-compose.yml${C_RESET}:"
      echo -e "     ${C_CYAN}services:${C_RESET}"
      echo -e "     ${C_CYAN}  shrinkarr:${C_RESET}"
      echo -e "     ${C_CYAN}    devices:${C_RESET}"
      echo -e "     ${C_CYAN}      - /dev/dri:/dev/dri${C_RESET}"
    fi
    echo -e "  2. Ensure permissions on host /dev/dri are accessible by the container user."
    echo -e "  3. On Synology DSM: verify /dev/dri exists over SSH ('ls -l /dev/dri')."
    echo -e "  4. On NVIDIA systems: install 'nvidia-container-toolkit' and add 'deploy.resources.reservations.devices'."
  fi
fi

echo -e "\n${C_DIM}----------------------------------------------------------------------${C_RESET}"
echo -e "${C_DIM}Run 'shrinkarr-top' or 'docker exec shrinkarr shrinkarr-top' to monitor live GPU load.${C_RESET}\n"
