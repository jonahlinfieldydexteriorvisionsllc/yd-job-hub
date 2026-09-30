# Local preview server for YD Job Hub.
#
# Plain `python -m http.server` sends no cache headers, so the browser caches
# files by its own guesswork. That made testing unreliable: edits to app.js and
# billing.js kept appearing not to work because the browser was still running
# the previous copy. Everything here is served no-store so a reload always
# shows what is actually on disk.
#
# Development only. GitHub Pages sends its own headers in production, and the
# service worker handles real offline caching there.

import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        # Keep the log to real problems; the request firehose hides them.
        if args and str(args[0]).startswith(("GET", "HEAD")) and str(args[1]).startswith("2"):
            return
        super().log_message(fmt, *args)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
    handler = partial(NoCacheHandler, directory=".")
    print(f"YD Job Hub dev server on http://localhost:{port} (no-store)")
    ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
