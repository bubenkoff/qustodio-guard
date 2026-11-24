#!/bin/zsh
# Log in to the (unofficial) Qustodio API as the parent and store the refresh token.
#
#   qustodio-token.sh <token-file>              # through your browser (works with two-step login)
#   qustodio-token.sh <token-file> --password   # the old e-mail + password login (no two-step)
#
# The browser login prints the address of Qustodio's own login page. Open it in any browser —
# yours, not necessarily on this Mac — and sign in with the two-step code; the browser then lands
# on a blank family.qustodio.com/parents-app?kind=auth-code&authorization_code=… page. Paste that
# whole address back here. The code is exchanged as the Android parent app's client (its codes
# go to the web app's redirect), and `client` next to the token file records that, so the guard
# renews the token through the same client.
#
# With two-step login on (Qustodio account setting), the password grant is refused (HTTP 401).
# Neither the password nor the code is stored, and neither appears in any process's argv: they
# reach curl on stdin. Only the refresh token is written, mode 600. install.sh runs this for you;
# run it by hand to re-login (e.g. after changing the Qustodio password).
set -eu
out=${1:?usage: qustodio-token.sh <token-file> [--password]}
mode=${2:-browser}
API=https://api.qustodio.com/v1/oauth2/access_token
REDIRECT=https://family.qustodio.com/parents-app
# The Qustodio web app's own client, and the Android parent app's, which the login page takes —
# both from the web app's own code, not secrets of ours.
WEB_ID=264ca1d226906aa08b03
WEB_SECRET=3e8826cbed3b996f8b206c7d6a4b2321529bc6bd
BROWSER_ID=kWyT0DkAqK1GKIFkEpY5DVckfwqru0ZDJi8YBKjJ
BROWSER_SECRET=SO1ntU0sNhkPNMbKTKzXlQtybAJ6911ew8TnePJcwganNCh7rJ54nCH512Z5ZzfHJKR4LQUusMAiur3oFFJhq2eNDyvg2w4v1dBh8Yeqx1bcLDUrVYMIBSak9PNOHdKE

[[ -t 0 ]] || { echo "qustodio-token.sh needs a terminal (ssh -t …)" >&2; exit 1; }

# JavaScript for Automation, for what zsh cannot do well: URL building and parsing, JSON.
jxa() { /usr/bin/osascript -l JavaScript -e "ObjC.import('Foundation'); $1" "${@:2}"; }

# grant <client-id> <client-secret> <field=value>... — form fields go to curl on stdin as a config.
grant() {
  local f
  {
    print -r -- "url = \"$API\""
    print -r -- silent; print -r -- show-error; print -r -- fail-with-body
    for f in "client_id=$1" "client_secret=$2" "${@:3}"; do
      f=${f//\\/\\\\}; f=${f//\"/\\\"}          # curl config strings: escape \ and "
      print -r -- "data-urlencode = \"$f\""
    done
  } | /usr/bin/curl -K -
}

umask 077
mkdir -p "${out:h}"
if [[ $mode == --password ]]; then
  read "user?Qustodio parent e-mail: "
  read -s "pass?Qustodio password: "; echo
  resp=$(grant $WEB_ID $WEB_SECRET grant_type=password "username=$user" "password=$pass") \
    || { echo "login failed${resp:+: $resp} (two-step login on? then run without --password)" >&2; exit 1; }
  unset pass
  client=password
else
  state=$(/usr/bin/openssl rand -hex 16)
  url=$(jxa '
    function run(a) {
      const b64 = o => $(JSON.stringify(o)).dataUsingEncoding($.NSUTF8StringEncoding).base64EncodedStringWithOptions(0).js;
      const p = { response_type: "code", state: a[0], client_id: a[1], redirect_uri: a[2],
        details: b64({ source_platform: "Web", source_details: "qustodio-guard", source_os_version: "1",
                       source_touchpoint: "Parent Device" }),
        conf: b64({ showBackButton: false }) };
      return "https://auth.qustodio.com/en/sso/login/?" +
        Object.entries(p).map(([k, v]) => k + "=" + encodeURIComponent(v)).join("&");
    }' $state $BROWSER_ID $REDIRECT)
  print -r -- "1. Open this in your browser and sign in (with the two-step code):"
  print -r -- ""
  print -r -- "$url"
  print -r -- ""
  print -r -- "2. The browser then shows a blank family.qustodio.com/parents-app?…authorization_code=… page."
  read "back?   Paste that whole address here: "
  # The page gets ?kind=auth-code&authorization_code=…&state=… (not the usual ?code=).
  code=$(jxa '
    function run(a) {
      const c = $.NSURLComponents.componentsWithString(a[0].trim());
      if (c.isNil() || c.queryItems.isNil()) return "";
      const q = {};
      const items = c.queryItems;
      for (let i = 0; i < items.count; i++) {
        const it = items.objectAtIndex(i);
        q[ObjC.unwrap(it.name)] = ObjC.unwrap(it.value) || "";
      }
      return q.state === a[1] ? (q.authorization_code || q.code || "") : "";
    }' "$back" $state)
  unset back
  [[ -n $code ]] || { echo "That address has no code from this login (or another login's). Run it again." >&2; exit 1; }
  resp=$(grant $BROWSER_ID $BROWSER_SECRET grant_type=authorization_code "code=$code" "redirect_uri=$REDIRECT") \
    || { echo "login failed${resp:+: $resp}" >&2; exit 1; }
  unset code
  client=browser
fi
token=$(jxa 'function run() {
    const d = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
    return JSON.parse($.NSString.alloc.initWithDataEncoding(d, $.NSUTF8StringEncoding).js).refresh_token || "";
  }' <<<"$resp")
unset resp
[[ -n $token ]] || { echo "login failed: no refresh_token in the response" >&2; exit 1; }
print -r -- "$token" > "$out.new" && mv "$out.new" "$out"
print -r -- $client > "${out:h}/client"
chmod 600 "$out" "${out:h}/client"
echo "refresh token written to $out (client: $client)"
