#!/bin/zsh
# Re-download every byte-differing NON-HTML file found by s3-byteverify.
# (HTML files legitimately differ because of wget --convert-links.)
# Usage: ./scripts/s3-refetch-diff.sh <dir> <baseUrl>
set -u
dir=$1
base=${2%/}/
cd "$(dirname "$0")/.." || exit 1

npx tsx scripts/s3-byteverify.ts "$dir" "$base" 2>/dev/null | python3 -c "
import json, sys
d = json.load(sys.stdin)
for f in d['different']:
    if not f.lower().endswith(('.htm', '.html')):
        print(f)
" | while IFS= read -r rel; do
  # minimal escaping for '?' '#' ' ' in object keys
  esc=$(python3 - "$rel" <<'PY'
import sys, re
s = sys.argv[1]
s = re.sub(r'%(?![0-9A-Fa-f]{2})', '%25', s)
print(s.replace('?', '%3F').replace('#', '%23').replace(' ', '%20'))
PY
)
  echo "refetch: $rel"
  curl -sf --retry 3 --retry-delay 2 "$base$esc" -o "$dir/$rel" || echo "  FAILED: $rel"
done
