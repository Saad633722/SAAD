#!/bin/bash
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Install Node.js (LTS) from https://nodejs.org, then run this again."; open https://nodejs.org; exit 1; }
[ -d node_modules ] || npm install
[ -f data/carwash.db ] || npm run seed:demo
(sleep 2; open http://localhost:3000/staff) &
echo "Mr.Clean is running at http://localhost:3000 — admin PIN 2222, employee PIN 1111. Close this window to stop."
npm start
