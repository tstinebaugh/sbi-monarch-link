#!/bin/bash
# install_native_host.sh
# Registers the SBI Monarch native messaging host with Chrome/Brave/Edge/Arc on macOS.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_SCRIPT="$SCRIPT_DIR/sbi_monarch_host.py"
LAUNCHER_SCRIPT="$SCRIPT_DIR/sbi_monarch_host_launcher.sh"
MANIFEST_DEST="$SCRIPT_DIR/com.sbi.monarch.host.json"

DEFAULT_EXT_ID="olancffkhkogbcnkhemeiooednpodibo"

# Make scripts executable
chmod +x "$HOST_SCRIPT"

# Detect Python binary that has required dependencies
PYTHON_PATH=$(python3 -c "import sys; print(sys.executable)" 2>/dev/null || which python3)
echo "Using Python executable: $PYTHON_PATH"

# Create launcher script
cat > "$LAUNCHER_SCRIPT" <<EOF
#!/bin/bash
# SBI Monarch Native Messaging Host Launcher
SCRIPT_DIR="\$(cd "\$(dirname "\$0")" && pwd)"
PYTHON_EXEC="$PYTHON_PATH"

if [ ! -x "\$PYTHON_EXEC" ]; then
  PYTHON_EXEC="\$(which python3)"
fi

export PATH="\$HOME/.pyenv/shims:\$HOME/.pyenv/bin:/usr/local/bin:/opt/homebrew/bin:\$PATH"
exec "\$PYTHON_EXEC" "\$SCRIPT_DIR/sbi_monarch_host.py" "\$@"
EOF

chmod +x "$LAUNCHER_SCRIPT"

echo ""
echo "┌─────────────────────────────────────────────────┐"
echo "│  SBI Shinsei → Monarch Native Host Installer    │"
echo "└─────────────────────────────────────────────────┘"
echo ""
echo "Step 1: Extension ID detection"
echo "  Default ID: $DEFAULT_EXT_ID"
echo ""
if [ -t 0 ]; then
  read -p "Paste your extension ID (or press Enter for default [$DEFAULT_EXT_ID]): " EXT_INPUT
  EXT_ID="${EXT_INPUT:-$DEFAULT_EXT_ID}"
else
  EXT_ID="$DEFAULT_EXT_ID"
fi

# Write final manifest
cat > "$MANIFEST_DEST" <<EOF
{
  "name": "com.sbi.monarch.host",
  "description": "SBI Shinsei to Monarch Money native sync host",
  "path": "$LAUNCHER_SCRIPT",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXT_ID/"
  ]
}
EOF

# Register with browsers
CHROME_HOST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
BRAVE_HOST_DIR="$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
EDGE_HOST_DIR="$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
CHROMIUM_HOST_DIR="$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
ARC_HOST_DIR="$HOME/Library/Application Support/Arc/User Data/NativeMessagingHosts"

install_for_browser() {
  local dir="$1"
  local name="$2"
  if [ -d "$(dirname "$dir")" ]; then
    mkdir -p "$dir"
    cp "$MANIFEST_DEST" "$dir/com.sbi.monarch.host.json"
    echo "✓ Installed for $name"
  fi
}

install_for_browser "$CHROME_HOST_DIR" "Chrome"
install_for_browser "$BRAVE_HOST_DIR" "Brave"
install_for_browser "$EDGE_HOST_DIR" "Edge"
install_for_browser "$CHROMIUM_HOST_DIR" "Chromium"
install_for_browser "$ARC_HOST_DIR" "Arc"

echo ""
echo "✅ Native host installed successfully!"
echo ""
echo "Step 2: Connect Monarch session via extension popup or CLI:"
echo "  python3 $HOST_SCRIPT --session"
echo ""
echo "Step 3: Reload your extension in chrome://extensions and test!"
