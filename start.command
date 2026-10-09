#!/bin/bash
# 더블클릭하면 로컬 서버를 켜고 브라우저를 엽니다 (macOS)
cd "$(dirname "$0")"
(sleep 1 && open http://localhost:8000) &
python3 -m http.server 8000
