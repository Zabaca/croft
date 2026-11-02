# SERVE_UNAUTHORIZED: croft serve refused the request (401 or 403)

croft serve answers only requests that carry its token (Authorization: Bearer <token>) or a key made with croft serve
key add (croft docs keys), from an allowed Host and Origin. This error is never retried: the same request fails the
same way.

- 401, a missing or wrong token. croft serve writes a new random token to .croft/serve.json at every start, so
  an app that copied one goes stale on the next restart. In the project, @zabaca/croft/read reads the token
  from .croft/serve.json by itself: pass no token. An app elsewhere needs CROFT_SERVE_TOKEN set to the server's:
  the user sets the same CROFT_SERVE_TOKEN in the project's .env (a token that never changes) and in the app's
  environment. Never print, copy or read the token yourself.
- 401 for a key: the key was removed (croft serve key remove), or never existed. A removed key is refused on its next
  request. details.reason does not say which: a key is not told whether it ever was one. The user can make another.
- 403, the Host header is not the address croft serve listens on, localhost or 127.0.0.1 (a reverse proxy must
  pass the Host it names in the banner), or a browser page's Origin is not in serve.allowOrigins in croft.json.
- 403 for a key on /status or /health (details.reason key_scope): a key reads the shared tables over POST /query and
  nothing else; those two endpoints need the app token.

croft docs serve explains how apps reach the server.
