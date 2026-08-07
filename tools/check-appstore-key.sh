#!/usr/bin/env bash
# Ask Apple whether an App Store Connect API key + Issuer ID actually work.
#
#   bash tools/check-appstore-key.sh                 # prompts for the Issuer ID
#   bash tools/check-appstore-key.sh <ISSUER_ID>
#
# Answers in a couple of seconds instead of a four-minute CI round trip.
# Nothing is uploaded and no secrets are changed - this only reads.

set -uo pipefail

die() { printf '\n\033[31m%s\033[0m\n' "$1" >&2; exit 1; }
ok()  { printf '\033[32m  ✓\033[0m %s\n' "$1"; }

# ---------------------------------------------------------------- find the key
SEARCH="$HOME/Downloads $HOME/Desktop"
[ "$PWD" = "$HOME" ] || SEARCH="$SEARCH $PWD"
# shellcheck disable=SC2086
FOUND="$(find $SEARCH -maxdepth 2 -name 'AuthKey_*.p8' 2>/dev/null | sort -u || true)"
P8="$(printf '%s\n' "$FOUND" | head -1)"
[ -n "$P8" ] && [ -f "$P8" ] || die "No AuthKey_*.p8 found in ~/Downloads or ~/Desktop."

KEY_ID="$(basename "$P8" .p8)"; KEY_ID="${KEY_ID#AuthKey_}"
openssl pkey -in "$P8" -noout 2>/dev/null || die "$P8 is not a readable private key."
ok "key file: $P8"
ok "key ID:   $KEY_ID"

# ------------------------------------------------------------------ issuer id
ISSUER="${1:-}"
if [ -z "$ISSUER" ]; then
  echo
  echo "Issuer ID is at the TOP of https://appstoreconnect.apple.com/access/integrations/api"
  echo "above the list of keys - it is one value for the whole account, not per key."
  read -r -p "Issuer ID: " ISSUER
fi
ISSUER="$(echo "$ISSUER" | tr -d '[:space:]')"
[ ${#ISSUER} -eq 36 ] || die "Issuer ID should be 36 characters, got ${#ISSUER}."

# ----------------------------------------------------------------- dependencies
VENV="$HOME/.cache/teeboard-asc-venv"
if [ ! -x "$VENV/bin/python" ]; then
  echo
  echo "Setting up a small local Python environment (once)..."
  python3 -m venv "$VENV" >/dev/null 2>&1 || die "Could not create a venv."
  "$VENV/bin/pip" install --quiet --disable-pip-version-check pyjwt cryptography \
    || die "Could not install pyjwt/cryptography."
fi

# ----------------------------------------------------------------------- ask
echo
KEY_ID="$KEY_ID" ISSUER="$ISSUER" P8="$P8" "$VENV/bin/python" - <<'PY'
import os, sys, time, json, urllib.request, urllib.error, jwt

key_id, issuer, p8 = os.environ["KEY_ID"], os.environ["ISSUER"], os.environ["P8"]
token = jwt.encode(
    {"iss": issuer, "iat": int(time.time()), "exp": int(time.time()) + 900,
     "aud": "appstoreconnect-v1"},
    open(p8).read(), algorithm="ES256", headers={"kid": key_id, "typ": "JWT"})

req = urllib.request.Request("https://api.appstoreconnect.apple.com/v1/apps?limit=200",
                             headers={"Authorization": "Bearer " + token})
try:
    with urllib.request.urlopen(req) as r:
        data = json.load(r)
except urllib.error.HTTPError as e:
    body = e.read().decode()[:600]
    if e.code == 401:
        print("\033[31m  ✗ Apple rejected these credentials (401).\033[0m\n")
        print("  The key and this Issuer ID are not from the same account, or the key")
        print("  has been revoked. On the API keys page, check that:")
        print("    - the key ID shown for your key is exactly", key_id)
        print("    - its status is Active, not Revoked")
        print("    - the Issuer ID you used is the one at the top of that page")
        print("    - you are on the same tab (Team Keys vs Individual Keys) as the key")
    else:
        print(f"\033[31m  ✗ App Store Connect returned {e.code}\033[0m")
    print("\n  Apple said:", body)
    sys.exit(1)

print("\033[32m  ✓ Apple accepted these credentials.\033[0m\n")
apps = {a["attributes"]["bundleId"]: a["attributes"]["name"] for a in data["data"]}
print(f"  Apps this key can see: {len(apps)}")
for bid, name in sorted(apps.items()):
    print(f"    {bid}  ({name})")

want = "com.jandglabs.teeboard"
if want in apps:
    print(f"\n\033[32m  ✓ Found the app record for {want}.\033[0m")
    print("\n  Everything checks out. Set the Issuer ID with:")
    print(f"    gh secret set APPSTORE_API_ISSUER_ID --repo jandglabsco-boop/TeeBoard --body {issuer}")
else:
    print(f"\n\033[31m  ✗ No app record for {want}.\033[0m")
    print("  Create it at https://appstoreconnect.apple.com/apps (My Apps -> + -> New App),")
    print("  or grant this key access to it under Users and Access.")
    sys.exit(1)
PY
