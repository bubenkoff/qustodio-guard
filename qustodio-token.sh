#!/bin/zsh
# Log in to the (unofficial) Qustodio API as the parent and store the refresh token.
#
#   qustodio-token.sh <token-file>
#
# Prompts for the parent account's e-mail and password; neither is stored, and neither appears
# in any process's argv. Only the refresh token is written, mode 600. install.sh runs this for
# you; run it by hand to re-login (e.g. after changing the Qustodio password).
set -eu
out=${1:?usage: qustodio-token.sh <token-file>}

CLIENT_ID=264ca1d226906aa08b03                       # the Qustodio web app's own client
CLIENT_SECRET=3e8826cbed3b996f8b206c7d6a4b2321529bc6bd

read "user?Qustodio parent e-mail: "
read -s "pass?Qustodio password: "; echo

umask 077
mkdir -p "${out:h}"
resp=$(print -rn -- "$pass" | /usr/bin/curl -fsS https://api.qustodio.com/v1/oauth2/access_token \
  --data-urlencode client_id=$CLIENT_ID \
  --data-urlencode client_secret=$CLIENT_SECRET \
  --data-urlencode grant_type=password \
  --data-urlencode "username=$user" \
  --data-urlencode password@-) || { echo "login failed" >&2; exit 1; }
unset pass

token=$(print -rn -- "$resp" | /usr/bin/osascript -l JavaScript -e '
  ObjC.import("Foundation");
  function run() {
    const d = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
    return JSON.parse($.NSString.alloc.initWithDataEncoding(d, $.NSUTF8StringEncoding).js).refresh_token || "";
  }')
unset resp
[[ -n $token ]] || { echo "login failed: no refresh_token in the response" >&2; exit 1; }
print -r -- "$token" > "$out"
chmod 600 "$out"
echo "refresh token written to $out"
