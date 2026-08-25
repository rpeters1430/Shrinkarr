#!/usr/bin/env bash
# ==============================================================================
# Shrinkarr Live Transcode & GPU Utilization Monitor (shrinkarr-top)
# ==============================================================================
# Live monitoring dashboard for FFmpeg transcode processes and GPU utilization
# inside or outside the Shrinkarr Docker container.
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
  C_BG_BLUE="\033[44m"
  C_CLEAR_SCREEN="\033[2J\033[H"
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
  C_BG_BLUE=""
  C_CLEAR_SCREEN=""
fi

INTERVAL=2
ONCE=0

print_usage() {
  cat <<EOF
Shrinkarr Live Transcode & GPU Utilization Monitor

Usage:
  shrinkarr-top [options]

Options:
  -i, --interval <sec>  Refresh interval in seconds (default: 2)
  -1, --once            Print a single snapshot and exit
  -h, --help            Show this help message

Examples:
  shrinkarr-top                        # Continuous live dashboard
  shrinkarr-top --once                 # Single snapshot
  docker exec -it shrinkarr shrinkarr-top # Run inside Docker container
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -i|--interval)
      INTERVAL="$2"
      shift 2
      ;;
    -1|--once)
      ONCE=1
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

get_gpu_name_for_node() {
  local node="$1"
  local node_name
  node_name=$(basename "$node")

  # Check sysfs PCI path
  if [ -e "/sys/class/drm/$node_name/device" ]; then
    local pci_path
    pci_path=$(readlink -f "/sys/class/drm/$node_name/device" 2>/dev/null || true)
    local driver=""
    if [ -e "/sys/class/drm/$node_name/device/driver" ]; then
      driver=$(basename "$(readlink -f "/sys/class/drm/$node_name/device/driver" 2>/dev/null || echo "")" 2>/dev/null || true)
    fi

    if command -v lspci >/dev/null 2>&1; then
      local pci_id
      pci_id=$(echo "$pci_path" | grep -o -E '[0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f]' | tail -n1 || true)
      if [ -n "$pci_id" ]; then
        local lspci_dev
        lspci_dev=$(lspci -s "$pci_id" 2>/dev/null | sed -E 's/^[0-9a-f:.]+[[:space:]]+(VGA compatible controller|Display controller|3D controller):[[:space:]]+//' || true)
        if [ -n "$lspci_dev" ]; then
          if echo "$lspci_dev" | grep -qi "9070"; then
            echo "AMD Radeon RX 9070 XT"
            return
          elif echo "$lspci_dev" | grep -qi "UHD Graphics 770"; then
            echo "Intel UHD Graphics 770"
            return
          fi
          echo "$lspci_dev" | sed 's/Advanced Micro Devices, Inc. \[AMD\/ATI\] //; s/Intel Corporation //; s/ (rev [0-9a-f]*)//'
          return
        fi
      fi
    fi

    if [ "$driver" = "amdgpu" ]; then
      echo "AMD Radeon GPU (amdgpu)"
      return
    elif [ "$driver" = "i915" ] || [ "$driver" = "xe" ]; then
      echo "Intel Graphics ($driver)"
      return
    elif [ "$driver" = "nvidia" ] || [ "$driver" = "nouveau" ]; then
      echo "NVIDIA GPU ($driver)"
      return
    fi
  fi

  # Fallback: check vainfo driver string
  if command -v vainfo >/dev/null 2>&1 && [ -c "$node" ]; then
    local vainfo_drv
    vainfo_drv=$(vainfo --display drm --device "$node" 2>&1 | grep -i "Driver version:" | sed 's/.*Driver version:[[:space:]]*//' | tr -d '\n' || true)
    if [ -n "$vainfo_drv" ]; then
      if echo "$vainfo_drv" | grep -qi "AMD"; then
        local amd_name
        amd_name=$(echo "$vainfo_drv" | grep -o -E 'for AMD [^()]+' | sed 's/for //' || echo "AMD Radeon GPU")
        echo "$amd_name"
        return
      elif echo "$vainfo_drv" | grep -qi "Intel"; then
        echo "Intel Graphics (iHD)"
        return
      fi
      echo "$vainfo_drv"
      return
    fi
  fi

  echo "$node"
}

get_gpu_load() {
  local gpu_statuses=()

  # Check DRM card sysfs entries
  for card in /sys/class/drm/card[0-9]*; do
    [ -d "$card" ] || continue
    local driver=""
    if [ -e "$card/device/driver" ]; then
      driver=$(basename "$(readlink -f "$card/device/driver" 2>/dev/null || echo "")" 2>/dev/null || true)
    fi

    if [ -f "$card/device/gpu_busy_percent" ]; then
      local amd_busy
      amd_busy=$(cat "$card/device/gpu_busy_percent" 2>/dev/null || true)
      if [ -n "$amd_busy" ]; then
        local gpu_desc
        gpu_desc=$(get_gpu_name_for_node "$card")
        gpu_statuses+=("${gpu_desc}: ${amd_busy}% Load")
      fi
    elif [ "$driver" = "i915" ] || [ "$driver" = "xe" ]; then
      local intel_desc
      intel_desc=$(get_gpu_name_for_node "$card")
      gpu_statuses+=("${intel_desc}: Active (${driver})")
    fi
  done

  # Try nvidia-smi if available
  if command -v nvidia-smi >/dev/null 2>&1; then
    local nv_load
    nv_load=$(nvidia-smi --query-gpu=name,utilization.gpu,utilization.encoder,temperature.gpu --format=csv,noheader,nounits 2>/dev/null | head -n1 || true)
    if [ -n "$nv_load" ]; then
      local nv_name gpu_util enc_util temp
      nv_name=$(echo "$nv_load" | awk -F',' '{print $1}' | sed 's/^ *//')
      gpu_util=$(echo "$nv_load" | awk -F',' '{print $2}' | tr -d ' ')
      enc_util=$(echo "$nv_load" | awk -F',' '{print $3}' | tr -d ' ')
      temp=$(echo "$nv_load" | awk -F',' '{print $4}' | tr -d ' ')
      gpu_statuses+=("${nv_name}: ${gpu_util}% (Encoder: ${enc_util}%, Temp: ${temp}°C)")
    fi
  fi

  if [ ${#gpu_statuses[@]} -gt 0 ]; then
    local result=""
    for s in "${gpu_statuses[@]}"; do
      if [ -n "$result" ]; then
        result="${result}  |  ${s}"
      else
        result="${s}"
      fi
    done
    echo "$result"
  else
    echo "Hardware Acceleration Active"
  fi
}

render_dashboard() {
  echo -e "${C_CLEAR_SCREEN}"
  echo -e "${C_BOLD}${C_CYAN}======================================================================${C_RESET}"
  echo -e "${C_BOLD}${C_WHITE}  SHRINKARR LIVE TRANSCODE & HARDWARE ACCELERATION MONITOR${C_RESET}"
  echo -e "${C_BOLD}${C_CYAN}======================================================================${C_RESET}"
  echo -e "${C_DIM}Time: $(date '+%Y-%m-%d %H:%M:%S')  |  Host: $(hostname)  |  Interval: ${INTERVAL}s${C_RESET}\n"

  # 1. System & GPU Summary
  echo -e "${C_BOLD}${C_BLUE}[ SYSTEM & GPU STATUS ]${C_RESET}"
  
  # Check DRM render nodes
  if [ -d /dev/dri ]; then
    local rnodes_raw
    rnodes_raw=$(find /dev/dri -name "renderD*" 2>/dev/null | sort || true)
    if [ -n "$rnodes_raw" ]; then
      local rnodes_formatted=""
      for rnode in $rnodes_raw; do
        local rname
        rname=$(get_gpu_name_for_node "$rnode")
        if [ -n "$rnodes_formatted" ]; then
          rnodes_formatted="${rnodes_formatted}, ${rnode} (${rname})"
        else
          rnodes_formatted="${rnode} (${rname})"
        fi
      done
      echo -e "  • ${C_BOLD}Render Nodes:${C_RESET}     ${C_GREEN}$rnodes_formatted${C_RESET}"
    else
      echo -e "  • ${C_BOLD}Render Nodes:${C_RESET}     ${C_YELLOW}None found in /dev/dri${C_RESET}"
    fi
  else
    echo -e "  • ${C_BOLD}/dev/dri:${C_RESET}         ${C_RED}Missing (No GPU passthrough!)${C_RESET}"
  fi

  local gpu_info
  gpu_info=$(get_gpu_load)
  echo -e "  • ${C_BOLD}GPU Activity:${C_RESET}     ${C_CYAN}$gpu_info${C_RESET}"

  # 2. Active Transcode Processes
  echo -e "\n${C_BOLD}${C_BLUE}[ ACTIVE TRANSCODE JOBS ]${C_RESET}"

  # Find running ffmpeg processes
  local ffmpeg_pids
  ffmpeg_pids=$(pgrep -f "ffmpeg" 2>/dev/null || true)

  if [ -z "$ffmpeg_pids" ]; then
    echo -e "  ${C_DIM}No active FFmpeg transcode processes running.${C_RESET}"
    echo -e "  ${C_DIM}Queue is idle or waiting for scheduled scanner.${C_RESET}"
  else
    local count=0
    for pid in $ffmpeg_pids; do
      # Avoid matching our own script or grep
      if [ "$pid" = "$$" ] || [ "$pid" = "$PPID" ]; then
        continue
      fi

      local cmdline
      cmdline=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
      [ -n "$cmdline" ] || continue

      # Skip if not actual ffmpeg transcode
      if ! echo "$cmdline" | grep -q "ffmpeg"; then
        continue
      fi

      count=$((count + 1))
      echo -e "\n  ${C_BOLD}Job #${count} (PID: ${pid})${C_RESET}"

      # Extract exact video encoder (-c:v <enc> or -vcodec <enc>)
      local encoder_name
      encoder_name=$(echo "$cmdline" | grep -o -E '-(c:v|vcodec)[[:space:]]+[^[:space:]]+' | awk '{print $2}' || true)
      if [ -z "$encoder_name" ]; then
        if echo "$cmdline" | grep -q "hevc_vaapi"; then encoder_name="hevc_vaapi"
        elif echo "$cmdline" | grep -q "av1_vaapi"; then encoder_name="av1_vaapi"
        elif echo "$cmdline" | grep -q "h264_vaapi"; then encoder_name="h264_vaapi"
        elif echo "$cmdline" | grep -q "hevc_qsv"; then encoder_name="hevc_qsv"
        elif echo "$cmdline" | grep -q "av1_qsv"; then encoder_name="av1_qsv"
        elif echo "$cmdline" | grep -q "h264_qsv"; then encoder_name="h264_qsv"
        elif echo "$cmdline" | grep -q "hevc_nvenc"; then encoder_name="hevc_nvenc"
        elif echo "$cmdline" | grep -q "av1_nvenc"; then encoder_name="av1_nvenc"
        elif echo "$cmdline" | grep -q "h264_nvenc"; then encoder_name="h264_nvenc"
        elif echo "$cmdline" | grep -q "hevc_amf"; then encoder_name="hevc_amf"
        elif echo "$cmdline" | grep -q "av1_amf"; then encoder_name="av1_amf"
        elif echo "$cmdline" | grep -q "h264_amf"; then encoder_name="h264_amf"
        elif echo "$cmdline" | grep -q "libx265"; then encoder_name="libx265"
        elif echo "$cmdline" | grep -q "libsvtav1"; then encoder_name="libsvtav1"
        elif echo "$cmdline" | grep -q "libx264"; then encoder_name="libx264"
        else encoder_name="unknown"
        fi
      fi

      # Detect Hardware Acceleration vs CPU Software & Device Details
      local hw_badge=""
      local device_info=""

      if echo "$cmdline" | grep -q -E "hevc_vaapi|h264_vaapi|av1_vaapi"; then
        local va_dev
        va_dev=$(echo "$cmdline" | grep -o -E -- '-vaapi_device[[:space:]]+[^[:space:]]+' | awk '{print $2}' || echo "/dev/dri/renderD128")
        local gpu_desc
        gpu_desc=$(get_gpu_name_for_node "$va_dev")
        hw_badge="${C_BOLD}${C_GREEN}[⚡ HARDWARE ACCELERATED: VA-API]${C_RESET}"
        device_info="${va_dev} (${gpu_desc})"
      elif echo "$cmdline" | grep -q -E "hevc_qsv|h264_qsv|av1_qsv"; then
        hw_badge="${C_BOLD}${C_GREEN}[⚡ HARDWARE ACCELERATED: Intel QuickSync (QSV)]${C_RESET}"
        device_info="Intel QuickSync (QSV)"
      elif echo "$cmdline" | grep -q -E "hevc_nvenc|h264_nvenc|av1_nvenc"; then
        hw_badge="${C_BOLD}${C_GREEN}[⚡ HARDWARE ACCELERATED: NVIDIA NVENC]${C_RESET}"
        device_info="NVIDIA GPU (NVENC)"
      elif echo "$cmdline" | grep -q -E "hevc_amf|h264_amf|av1_amf"; then
        hw_badge="${C_BOLD}${C_GREEN}[⚡ HARDWARE ACCELERATED: AMD AMF]${C_RESET}"
        device_info="AMD GPU (AMF)"
      elif echo "$cmdline" | grep -q -E "hevc_videotoolbox|h264_videotoolbox"; then
        hw_badge="${C_BOLD}${C_GREEN}[⚡ HARDWARE ACCELERATED: Apple VideoToolbox]${C_RESET}"
        device_info="Apple VideoToolbox"
      elif echo "$cmdline" | grep -q -E "libx265|libx264|libsvtav1"; then
        hw_badge="${C_BOLD}${C_YELLOW}[⚠️ CPU SOFTWARE ENCODING - GPU Not Used]${C_RESET}"
        device_info="Host CPU (Software Encoding)"
      else
        hw_badge="${C_BOLD}${C_CYAN}[Active Process]${C_RESET}"
        device_info="Generic / Unknown"
      fi

      echo -e "    ${C_BOLD}Mode:${C_RESET}        $hw_badge"
      echo -e "    ${C_BOLD}Encoder:${C_RESET}     ${C_CYAN}${encoder_name}${C_RESET}"
      echo -e "    ${C_BOLD}Device/Node:${C_RESET} ${C_WHITE}${device_info}${C_RESET}"

      # Extract input file
      local input_file
      input_file=$(echo "$cmdline" | grep -o -- '-i [^ ]*' | sed 's/-i //' || echo "N/A")
      echo -e "    ${C_BOLD}Input:${C_RESET}       ${C_WHITE}$input_file${C_RESET}"

      # Extract output file
      local output_file
      output_file=$(echo "$cmdline" | awk '{print $NF}' || echo "N/A")
      echo -e "    ${C_BOLD}Output:${C_RESET}      ${C_WHITE}$output_file${C_RESET}"

      # Process stats (CPU & Memory)
      if command -v ps >/dev/null 2>&1; then
        local ps_stat
        ps_stat=$(ps -p "$pid" -o %cpu,%mem,etime --no-headers 2>/dev/null || true)
        if [ -n "$ps_stat" ]; then
          local cpu_pct mem_pct etime
          cpu_pct=$(echo "$ps_stat" | awk '{print $1}')
          mem_pct=$(echo "$ps_stat" | awk '{print $2}')
          etime=$(echo "$ps_stat" | awk '{print $3}')
          echo -e "    ${C_BOLD}CPU Usage:${C_RESET}   ${cpu_pct}%  |  ${C_BOLD}Mem:${C_RESET} ${mem_pct}%  |  ${C_BOLD}Elapsed:${C_RESET} $etime"
        fi
      fi
    done

    if [ "$count" -eq 0 ]; then
      echo -e "  ${C_DIM}No active FFmpeg transcode processes running.${C_RESET}"
    fi
  fi

  echo -e "\n${C_BOLD}${C_CYAN}======================================================================${C_RESET}"
  if [ "$ONCE" = "0" ]; then
    echo -e "${C_DIM}Press [Ctrl+C] to exit monitor.${C_RESET}"
  fi
}

if [ "$ONCE" = "1" ]; then
  render_dashboard
  exit 0
fi

# Main monitor loop
trap 'echo -e "\n${C_RESET}Exiting shrinkarr-top."; exit 0' SIGINT SIGTERM

while true; do
  render_dashboard
  sleep "$INTERVAL"
done
