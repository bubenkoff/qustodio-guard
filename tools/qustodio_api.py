#!/usr/bin/env python3
"""The (unofficial) Qustodio API as the parent, with the token handled for you.

    qustodio_api.py login                  # once per machine, in your own terminal (browser)
    qustodio_api.py login --password       # the old e-mail + password login (no two-step)
    qustodio_api.py ids                    # account and profile ids
    qustodio_api.py get v2/accounts/{uid}/profiles/{puid:Alexander}/routines
    qustodio_api.py patch <path> body.json # or - for stdin; also put, post, delete

`login` signs in through Qustodio's own login page in your browser, which asks for the two-step
code (on since 2026-11-10; the password grant is refused then, HTTP 401). It prints the page's
address; after you sign in, the browser lands on family.qustodio.com/parents-app?kind=auth-code&authorization_code=… (a blank
page: the web app leaves a code it did not ask for alone), and you paste that address back. The code
is exchanged as the Android parent app's client, and only the refresh token is kept, mode 600, in
~/.config/qustodio/ (with `client`, which client it belongs to). `login --password` is the old way,
like qustodio-token.sh --password: e-mail and password, neither kept. (The guard's own token, in
/var/root/qustodio-guard/ on each Mac, is a separate login: qustodio-token.sh.)
Every other command takes an access token from there, renewing it with the refresh token when it
is close to expiring or the API answers 401, and saves whatever new refresh token comes back.

Paths are relative to https://api.qustodio.com/. In a path, {id} and {uid} are the account's,
{pid:<name>} and {puid:<name>} a profile's by name. Endpoints and bodies: docs/API.md in this repo.
Importable too: put this directory on sys.path, then `from qustodio_api import call`.
"""
import contextlib, fcntl, getpass, json, os, re, sys, time, urllib.error, urllib.parse, urllib.request

API = "https://api.qustodio.com/"
CLIENT_ID = "264ca1d226906aa08b03"                       # the Qustodio web app's own client
CLIENT_SECRET = "3e8826cbed3b996f8b206c7d6a4b2321529bc6bd"
# The Android parent app's client: the login page (auth.qustodio.com/en/sso/login/) takes it, and
# its codes go to the same redirect as the web app's. From the web app's own config (2026-11-11).
BROWSER_CLIENT = ("kWyT0DkAqK1GKIFkEpY5DVckfwqru0ZDJi8YBKjJ",
                  "SO1ntU0sNhkPNMbKTKzXlQtybAJ6911ew8TnePJcwganNCh7rJ54nCH512Z5ZzfHJKR4LQUusMAiur3oFFJhq2eNDyvg2w4v1dBh8Yeqx1bcLDUrVYMIBSak9PNOHdKE")
REDIRECT = "https://family.qustodio.com/parents-app"
DIR = os.path.expanduser(os.environ.get("QUSTODIO_DIR", "~/.config/qustodio"))
REFRESH = os.path.join(DIR, "refresh_token")
ACCESS = os.path.join(DIR, "access_token.json")
CLIENT = os.path.join(DIR, "client")          # "browser" when the token came from the browser login
LOCK = os.path.join(DIR, ".lock")


def _write(path, text):
    os.makedirs(DIR, mode=0o700, exist_ok=True)
    fd = os.open(path + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.replace(path + ".tmp", path)


@contextlib.contextmanager
def _locked():
    """One token refresh at a time: Qustodio may rotate the refresh token, and two processes
    refreshing at once could otherwise store one that was already replaced."""
    os.makedirs(DIR, mode=0o700, exist_ok=True)
    with open(LOCK, "w") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        yield


def _client():
    try:
        return BROWSER_CLIENT if open(CLIENT).read().strip() == "browser" else (CLIENT_ID, CLIENT_SECRET)
    except OSError:
        return CLIENT_ID, CLIENT_SECRET


def _grant(client=None, **fields):
    cid, secret = client or _client()
    data = urllib.parse.urlencode(dict(client_id=cid, client_secret=secret, **fields)).encode()
    req = urllib.request.Request(API + "v1/oauth2/access_token", data=data)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            tok = json.load(r)
    except urllib.error.HTTPError as e:
        # Show Qustodio's own reason (error, error_description): with two-step login on, the
        # password grant is refused, and the body says what it wants instead.
        try:
            body = json.load(e)
            why = {k: v for k, v in body.items() if not re.search(r"token|secret|code", k)} if isinstance(body, dict) else body
        except ValueError:
            why = None
        sys.exit(f"Qustodio refused the {fields['grant_type']} grant: HTTP {e.code} {json.dumps(why) if why else ''}. "
                 "Run `qustodio_api.py login` again.")
    except urllib.error.URLError as e:
        sys.exit(f"cannot reach Qustodio: {e.reason}")
    if tok.get("refresh_token"):
        _write(REFRESH, tok["refresh_token"] + "\n")
    life = int(tok.get("expires_in", 3600))
    # Renew a day early, or at nine tenths of the life of a short-lived token.
    _write(ACCESS, json.dumps({"access_token": tok["access_token"],
                               "renew_at": time.time() + life - min(24 * 3600, life // 10)}))
    return tok["access_token"]


def _cached():
    try:
        cached = json.load(open(ACCESS))
        return cached["access_token"] if cached["renew_at"] > time.time() else None
    except (OSError, ValueError, KeyError):
        return None


def _access(stale=None):
    """A usable access token. `stale` is one the API just refused: renew unless another
    process already has."""
    token = _cached()
    if token and token != stale:
        return token
    with _locked():
        token = _cached()                      # someone may have renewed while we waited
        if token and token != stale:
            return token
        try:
            refresh = open(REFRESH).read().strip()
        except OSError:
            sys.exit(f"No refresh token in {REFRESH}. Run `qustodio_api.py login` in your own terminal.")
        return _grant(grant_type="refresh_token", refresh_token=refresh)


def call(method, path, body=None):
    """One API request; returns the decoded JSON (None for an empty answer)."""
    path = _expand(path)
    data = json.dumps(body).encode() if body is not None else None
    token = None
    for attempt in (0, 1):
        token = _access(stale=token)
        req = urllib.request.Request(API + path.lstrip("/"), data=data, method=method.upper(),
                                     headers={"Authorization": "Bearer " + token,
                                              "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                raw = r.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            if e.code != 401 or attempt:
                raise


_me, _profiles = None, None


def _expand(path):
    global _me, _profiles
    if "{" not in path:
        return path
    if _me is None:
        _me = call("GET", "v1/accounts/me")
    def sub(m):
        global _profiles
        key, _, name = m.group(1).partition(":")
        if key in ("id", "uid") and not name:
            return str(_me[key])
        if key in ("pid", "puid") and name:
            if _profiles is None:
                _profiles = call("GET", f"v1/accounts/{_me['id']}/profiles/")
            hit = [p for p in _profiles if p["name"].lower() == name.lower()]
            if not hit:
                sys.exit(f"no profile named {name!r}; have {[p['name'] for p in _profiles]}")
            return str(hit[0]["id" if key == "pid" else "uid"])
        sys.exit(f"unknown placeholder {{{m.group(1)}}}")
    return re.sub(r"\{([^}]+)\}", sub, path)


def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return
    cmd = argv[0]
    if cmd == "login":
        # Without a terminal getpass falls back to reading the password with echo on.
        if not (sys.stdin.isatty() and os.isatty(sys.stderr.fileno())):
            sys.exit("login needs a real terminal: run it in your own terminal, not through `!` or a pipe")
        if argv[1:2] == ["--password"]:
            user = input("Qustodio parent e-mail: ")
            password = getpass.getpass("Qustodio password: ")
            with _locked():
                _grant((CLIENT_ID, CLIENT_SECRET), grant_type="password", username=user, password=password)
                _write(CLIENT, "password\n")
            del password
        else:
            import base64, secrets
            state = secrets.token_urlsafe(16)
            enc = lambda d: base64.b64encode(json.dumps(d).encode()).decode()
            url = "https://auth.qustodio.com/en/sso/login/?" + urllib.parse.urlencode(dict(
                response_type="code", state=state, client_id=BROWSER_CLIENT[0], redirect_uri=REDIRECT,
                details=enc({"source_platform": "Web", "source_details": "qustodio_api",
                             "source_os_version": "1", "source_touchpoint": "Parent Device"}),
                conf=enc({"showBackButton": False})))
            print("1. Open this in your browser and sign in (with the two-step code):\n\n" + url + "\n")
            print("2. The browser then shows a blank family.qustodio.com/parents-app?…authorization_code=… page.")
            back = urllib.parse.urlparse(input("   Paste that whole address here: ").strip())
            q = urllib.parse.parse_qs(back.query)
            # The page gets ?kind=auth-code&authorization_code=…&state=… (not the usual ?code=).
            code = (q.get("authorization_code") or q.get("code") or [""])[0]
            if q.get("state", [""])[0] != state or not code:
                sys.exit("That address has no code from this login (or another login's). Run login again.")
            with _locked():
                _grant(BROWSER_CLIENT, grant_type="authorization_code", code=code, redirect_uri=REDIRECT)
                _write(CLIENT, "browser\n")
        print(f"refresh token written to {REFRESH}")
        return
    if cmd == "ids":
        me = call("GET", "v1/accounts/me")
        print(json.dumps({"id": me["id"], "uid": me["uid"],
                          "profiles": {p["name"]: {"id": p["id"], "uid": p["uid"]}
                                       for p in call("GET", f"v1/accounts/{me['id']}/profiles/")}}, indent=1))
        return
    if cmd in ("get", "delete") and len(argv) == 2:
        body = None
    elif cmd in ("patch", "put", "post") and len(argv) == 3:
        body = json.load(sys.stdin if argv[2] == "-" else open(argv[2]))
    else:
        sys.exit(__doc__)
    try:
        out = call(cmd, argv[1], body)
    except urllib.error.HTTPError as e:
        sys.exit(f"HTTP {e.code}: {e.read().decode(errors='replace')[:500]}")
    except urllib.error.URLError as e:
        sys.exit(f"cannot reach Qustodio: {e.reason}")
    if out is not None:
        print(json.dumps(out, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main(sys.argv[1:])
