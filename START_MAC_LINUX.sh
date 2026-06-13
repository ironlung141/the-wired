#!/bin/bash
clear
echo ""
echo " ========================================"
echo "  The Wired 2.0 -- Setup"
echo " ========================================"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo " [ERROR] Node.js is not installed!"
    echo ""
    echo " Install it from: https://nodejs.org"
    echo " Download the LTS version, then run this script again."
    echo ""
    exit 1
fi

echo " [OK] Node.js $(node --version) found"
echo ""

# Install dependencies
echo " Installing dependencies..."
npm install
if [ $? -ne 0 ]; then
    echo ""
    echo " [ERROR] npm install failed. Check your internet connection."
    exit 1
fi

echo ""
echo " ========================================"
echo "  Starting The Wired 2.0..."
echo " ========================================"
echo ""

# Get local IP (works on both Mac and Linux)
if [[ "$OSTYPE" == "darwin"* ]]; then
    IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "unknown")
else
    IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "unknown")
fi

echo " Local address:  http://localhost:3000"
echo " Network (LAN):  http://$IP:3000"
echo ""
echo " Share the Network address with friends on the same WiFi."
echo " For internet access, see README.md"
echo ""
echo " Press Ctrl+C to stop the server."
echo ""

node server.js
