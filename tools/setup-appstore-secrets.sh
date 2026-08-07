#!/usr/bin/env bash
# Load your App Store Connect API key into GitHub Actions secrets.
#
# Run once, after downloading the .p8 from
# https://appstoreconnect.apple.com/access/integrations/api
#
#   bash tools/setup-appstore-secrets.sh
#
# The key is piped straight from the file into GitHub. It is never printed,
# never copied to the clipboard, and never written anywhere else on disk.

set -euo pipefail

REPO="jandglabsco-boop/TeeBoard"

die() { printf '\n\033[31m%s\033[0m\n' "$1" >&2; exit 1; }
ok()  { printf '\033[32m  ✓\033[0m %s\n' "$1"; }

command -v gh >/dev/null || die "GitHub CLI not installed.  brew install gh"
gh auth status >/dev/null 2>&1 || die "Not signed in to GitHub.  Run: gh auth login"

# ---------------------------------------------------------------- find the key
# Apple names the download AuthKey_<KEYID>.p8 — so the Key ID comes free.
# (No arrays/mapfile here: macOS still ships bash 3.2.)
FOUND="$(find "$HOME/Downloads" "$HOME/Desktop" . -maxdepth 2 -name 'AuthKey_*.p8' 2>/dev/null | sort -u)"
COUNT="$(printf '%s' "$FOUND" | grep -c . || true)"

if [ "$COUNT" -eq 0 ]; then
  echo "No AuthKey_*.p8 found in ~/Downloads, ~/Desktop, or here."
  read -r -p "Full path to your .p8 file: " P8
elif [ "$COUNT" -eq 1 ]; then
  P8="$FOUND"
else
  echo "Found several keys:"
  printf '%s\n' "$FOUND" | nl -w3 -s') '
  read -r -p "Which one? [1] " n; n="${n:-1}"
  P8="$(printf '%s\n' "$FOUND" | sed -n "${n}p")"
fi

P8="${P8/#\~/$HOME}"
[ -f "$P8" ] || die "No such file: $P8"

KEY_ID="$(basename "$P8" .p8)"; KEY_ID="${KEY_ID#AuthKey_}"
[[ "$KEY_ID" =~ ^[A-Z0-9]{8,12}$ ]] || {
  echo "Couldn't read a Key ID from the filename ($(basename "$P8"))."
  read -r -p "Key ID: " KEY_ID
}

echo
echo "Key file : $P8"
echo "Key ID   : $KEY_ID"
echo

# ------------------------------------------------------------- the two ID bits
# Both are visible at https://appstoreconnect.apple.com/access/integrations/api
# Issuer ID sits at the TOP of the page, above the key list — not per-key.
read -r -p "Issuer ID (UUID, top of the API keys page): " ISSUER_ID
ISSUER_ID="$(echo "$ISSUER_ID" | tr -d '[:space:]')"
[[ "$ISSUER_ID" =~ ^[0-9a-fA-F-]{36}$ ]] || die "That doesn't look like a UUID: $ISSUER_ID"

# Team ID: top-right of developer.apple.com, or Membership details.
read -r -p "Team ID (10 chars, top-right of developer.apple.com): " TEAM_ID
TEAM_ID="$(echo "$TEAM_ID" | tr -d '[:space:]')"
[[ "$TEAM_ID" =~ ^[A-Z0-9]{10}$ ]] || die "Team ID should be 10 letters/digits, got: $TEAM_ID"

# ------------------------------------------------------------------- upload
echo
echo "Setting secrets on $REPO ..."

# -A keeps it on one line; the workflow's `base64 --decode` accepts either,
# but single-line avoids surprises in the Actions log redactor.
openssl base64 -A -in "$P8" | gh secret set APPSTORE_API_KEY_P8 --repo "$REPO"
ok "APPSTORE_API_KEY_P8"

gh secret set APPSTORE_API_KEY_ID    --repo "$REPO" --body "$KEY_ID";    ok "APPSTORE_API_KEY_ID"
gh secret set APPSTORE_API_ISSUER_ID --repo "$REPO" --body "$ISSUER_ID"; ok "APPSTORE_API_ISSUER_ID"
gh secret set APPSTORE_TEAM_ID       --repo "$REPO" --body "$TEAM_ID";   ok "APPSTORE_TEAM_ID"

# ------------------------------------------------------------------- verify
echo
MISSING=0
for s in APPSTORE_API_KEY_P8 APPSTORE_API_KEY_ID APPSTORE_API_ISSUER_ID APPSTORE_TEAM_ID; do
  gh secret list --repo "$REPO" --json name --jq '.[].name' | grep -qx "$s" || { echo "  ✗ $s did not stick"; MISSING=1; }
done
[ "$MISSING" -eq 0 ] || die "Some secrets are missing — rerun."

echo "All four secrets are set."
echo
echo "Next: push anything, or run"
echo "    gh workflow run mobile.yml --repo $REPO"
echo "and the build will sign itself and upload to TestFlight."
echo
echo "Keep $P8 somewhere safe — Apple only lets you download it once."
echo "If it ever leaks, revoke it on the API keys page and rerun this script."
