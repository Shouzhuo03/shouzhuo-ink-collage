#!/usr/bin/env python3
"""Static file server for the preview page, with caching turned off so edits
to src/ show up on a plain reload.

    python3 tools/serve.py          # http://localhost:8137/preview/
    python3 tools/serve.py 9000     # another port
"""
import functools
import http.server
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8137
    handler = functools.partial(NoCache, directory=str(ROOT))
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        print(f"serving {ROOT} at http://localhost:{port}/preview/")
        httpd.serve_forever()
