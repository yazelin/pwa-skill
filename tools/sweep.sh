#!/usr/bin/env bash
# 掃全機的 PWA,逐站跑 pwa-check,印成一張表。
#
# 清單靠掃描產生,不靠人列 —— 手列清單一定會漏。2026-08-07 那次「SW 互刪同 origin
# 別站快取」就是:原本以為只有 3 個站,掃過才知道 13 個站在互相清空離線包。
#
# 用法:
#   sweep.sh                  掃 $HOME
#   sweep.sh ~/projects       掃指定目錄
#   sweep.sh --full           連執行期檢查一起跑(慢很多,需要 playwright)
#
# 退出碼 0=沒有 FAIL,1=有站沒過。
set -uo pipefail
MODE="--static-only"
ROOT="$HOME"
for a in "$@"; do
  case "$a" in
    --full) MODE="" ;;
    -*) echo "不認識的參數:$a" >&2; exit 2 ;;
    *) ROOT="$a" ;;
  esac
done
CHECK="$(cd "$(dirname "$0")" && pwd)/pwa-check.mjs"

# 找出所有含 sw.js 的專案。收斂到 repo 根,因為 pwa-check 自己會找站台根目錄
# (才處理得了 docs/ public/ web/ dist/ 這些擺法);sw.js 的位置留著當退路。
declare -A SWPATH   # repo 根 → 它的 sw.js
while read -r f; do
  [ -z "$f" ] && continue
  d=$(dirname "$f")
  top=$(git -C "$d" rev-parse --show-toplevel 2>/dev/null || echo "$d")
  [ -n "${SWPATH[$top]:-}" ] || SWPATH[$top]="$f"
done < <(find "$ROOT" -maxdepth 4 -name sw.js -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null | sort)

# 同一個 repo 在磁碟上常有多份工作副本(舊 clone、實驗用的第二份)。
# 用 origin URL 分組,只留最後有 commit 的那份,其餘明講跳過 —— 靜靜丟掉會讓人
# 以為「掃過了」。(SDD/cat 就是 catime 六個月前的舊副本,會報一堆早就修好的問題。)
declare -A BEST BEST_TS
declare -a SKIPPED=()
for top in "${!SWPATH[@]}"; do
  url=$(git -C "$top" remote get-url origin 2>/dev/null || echo "path:$top")
  ts=$(git -C "$top" log -1 --format=%ct 2>/dev/null || echo 0)
  prev="${BEST[$url]:-}"
  if [ -z "$prev" ]; then BEST[$url]="$top"; BEST_TS[$url]="$ts"
  elif [ "$ts" -gt "${BEST_TS[$url]}" ]; then SKIPPED+=("$prev(舊副本,最新的是 ${top#"$ROOT"/})"); BEST[$url]="$top"; BEST_TS[$url]="$ts"
  else SKIPPED+=("$top(舊副本,最新的是 ${prev#"$ROOT"/})")
  fi
done

mapfile -t sites < <(printf '%s\n' "${BEST[@]}" | sort)
# 別人的 repo(留在本機當對照的 clone)不該進自己的合規報告。~/.pwa-sweep-ignore
# 一行一個路徑片段,比對到就跳過。
IGNORE_FILE="$HOME/.pwa-sweep-ignore"
if [ -f "$IGNORE_FILE" ]; then
  declare -a kept=()
  for s in "${sites[@]}"; do
    hit=""
    while read -r pat; do
      [ -z "$pat" ] && continue
      case "$pat" in \#*) continue ;; esac
      case "$s" in *"$pat"*) hit=1 ;; esac
    done < "$IGNORE_FILE"
    if [ -n "$hit" ]; then SKIPPED+=("$s(在 ~/.pwa-sweep-ignore 裡)"); else kept+=("$s"); fi
  done
  sites=("${kept[@]}")
fi

[ ${#sites[@]} -eq 0 ] && { echo "在 $ROOT 底下沒找到任何 sw.js"; exit 0; }
echo "掃到 ${#sites[@]} 個站(${ROOT})"
echo

fails=0
declare -a detail=()
for s in "${sites[@]}"; do
  out=$(node "$CHECK" "$s" $MODE 2>&1)
  # sw.js 不在 repo 根(client/public/、static/、漫畫/dist/ 這種擺法)時,
  # pwa-check 找不到站台根目錄 —— 拿掃描時記下的實際位置再跑一次。
  if grep -q '找不到 sw.js' <<<"$out"; then
    out=$(node "$CHECK" "$s" --root "$(dirname "${SWPATH[$s]}")" $MODE 2>&1)
  fi
  sum=$(echo "$out" | tail -1)
  p=$(sed -n 's/.*PASS \([0-9]*\).*/\1/p' <<<"$sum"); w=$(sed -n 's/.*WARN \([0-9]*\).*/\1/p' <<<"$sum")
  f=$(sed -n 's/.*FAIL \([0-9]*\).*/\1/p' <<<"$sum")
  name=${s#"$ROOT"/}
  printf '%-30s PASS %-3s WARN %-3s FAIL %-3s\n' "$name" "${p:-?}" "${w:-?}" "${f:-?}"
  if [ "${f:-0}" -gt 0 ] 2>/dev/null; then
    fails=$((fails + f))
    detail+=("$(echo "$out" | grep '^FAIL' | sed "s|^|  $name → |")")
  fi
done

if [ ${#SKIPPED[@]} -gt 0 ]; then
  echo
  echo "=== 跳過的重複副本 ==="
  printf '  %s\n' "${SKIPPED[@]}"
fi
if [ ${#detail[@]} -gt 0 ]; then
  echo
  echo "=== 沒過的項目 ==="
  printf '%s\n' "${detail[@]}"
fi
echo
echo "=== 共 $fails 個 FAIL ==="
[ "$fails" -gt 0 ] && exit 1 || exit 0
