"""HTTP smoke test against the built native app with an isolated SQLite directory."""
import json
import argparse
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

project = Path(__file__).resolve().parent.parent
arguments = argparse.ArgumentParser()
arguments.add_argument('--binary', default='src-tauri/target/debug/oddclicks.exe')
binary = project / arguments.parse_args().binary
data = project / '.test-data' / f'native-{time.time_ns()}'
data.mkdir(parents=True)
with socket.socket() as probe:
    if probe.connect_ex(('127.0.0.1', 28765)) == 0:
        raise RuntimeError('Port 28765 is already occupied; existing process is left untouched.')
environment = os.environ.copy()
environment['ODDCLICKS_DATA_DIR'] = str(data)
environment['WEBVIEW2_USER_DATA_FOLDER'] = str(data / 'webview')
startup = subprocess.STARTUPINFO()
startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
startup.wShowWindow = subprocess.SW_HIDE
process = subprocess.Popen([str(binary)], cwd=project, env=environment, startupinfo=startup, creationflags=subprocess.CREATE_NO_WINDOW)
origin = 'http://127.0.0.1:28765'

def request(path, payload=None, token=None):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = f'Bearer {token}'
    req = urllib.request.Request(origin + path, headers=headers, data=json.dumps(payload).encode() if payload else None)
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error)

try:
    deadline = time.monotonic() + 20
    while True:
        try:
            status, health = request('/api/health')
            assert status == 200 and health['protocol'] == 1
            break
        except (OSError, urllib.error.URLError):
            if time.monotonic() > deadline or process.poll() is not None:
                raise RuntimeError('Native app failed to start its loopback server')
            time.sleep(.1)
    with sqlite3.connect(data / 'oddclicks.db') as db:
        token = db.execute("SELECT value FROM app_settings WHERE key='capture_token'").fetchone()[0]
    payload = {'request_id': 'smoke-1', 'url': 'https://example.invalid/oddclicks-smoke', 'title': 'Smoke'}
    assert request('/api/v1/capture', payload)[0] == 401
    status, saved = request('/api/v1/capture', payload, token)
    assert status == 200 and saved['outcome'] == 'created'
    assert request('/api/v1/capture', payload, token)[1] == saved
    duplicate = {**payload, 'request_id': 'smoke-2', 'title': 'Should not overwrite'}
    assert request('/api/v1/capture', duplicate, token)[1]['outcome'] == 'existing'
    assert request('/api/v1/capture', {**payload, 'url': 'chrome://settings', 'request_id': 'bad'}, token)[0] == 400
    assert request('/api/v1/capture', {**payload, 'url': 'https://other.invalid/'}, token)[0] == 409
    assert request('/api/health', token='bad')[0] == 401
    with sqlite3.connect(data / 'oddclicks.db') as db:
        assert db.execute('SELECT COUNT(*) FROM bookmarks').fetchone()[0] == 1
        assert db.execute('SELECT title FROM bookmarks').fetchone()[0] == 'Smoke'
        db.execute('DELETE FROM bookmarks')
        db.commit()
    assert request('/api/v1/capture', payload, token)[1] == saved
    with sqlite3.connect(data / 'oddclicks.db') as db:
        assert db.execute('SELECT COUNT(*) FROM bookmarks').fetchone()[0] == 0
    legacy_url = urllib.parse.quote('https://example.invalid/legacy', safe='')
    assert request('/api/add?url=' + legacy_url)[0] == 200
    assert request('/api/add?url=' + legacy_url, {'ignored': True})[0] == 200
    print('Native HTTP smoke: health, authentication, capture, deduplication, replay after deletion, validation, conflict and legacy bookmarklet passed.')
finally:
    process.terminate()
    process.wait(timeout=10)
