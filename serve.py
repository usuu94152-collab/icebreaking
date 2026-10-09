"""로컬 서버: 이 폴더를 http://localhost:8000 으로 열고 브라우저를 띄운다.

Windows 에서는 .js 가 text/plain 으로 잡히는 경우가 있어 MIME 타입을 직접 지정한다.
"""
import http.server
import os
import socketserver
import threading
import webbrowser

PORT = 8000
os.chdir(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.mjs': 'text/javascript; charset=utf-8',
        '.wasm': 'application/wasm',
        '.json': 'application/json',
        '.task': 'application/octet-stream',
    }

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def log_message(self, *args):
        pass


url = f'http://localhost:{PORT}'
with socketserver.ThreadingTCPServer(('127.0.0.1', PORT), Handler) as httpd:
    print(f'{url} 에서 실행 중입니다. 끝내려면 이 창을 닫거나 Ctrl+C 를 누르세요.')
    threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
