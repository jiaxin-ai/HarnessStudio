#!/usr/bin/env python3
"""Runs one Agent command inside a HarnessStudio sandbox and prints one JSON result.

    run.py run '<json spec>'   spec: exec_id, command, cwd, timeout_s, max_bytes, env
    run.py cancel <exec_id>    kills the process group of that run

The command runs as `bash -c` in its own process group. When the command exits, times out or is cancelled, the
whole group is killed, so background processes never outlive the call. stdout and stderr are each kept up to
max_bytes: the start, plus the last 64 KiB when longer.
"""
import json
import os
import signal
import subprocess
import sys
import threading
import time

STATE = os.environ.get('HS_RUN_STATE', '/run/hs')
TAIL = 64 * 1024


class Capture:
    def __init__(self, limit):
        self.limit, self.head, self.tail, self.total = limit, bytearray(), bytearray(), 0

    def add(self, chunk):
        self.total += len(chunk)
        room = max(0, self.limit - TAIL - len(self.head))
        self.head += chunk[:room]
        rest = chunk[room:]
        if rest:
            self.tail = (self.tail + rest)[-TAIL:]

    def text(self):
        if self.total <= len(self.head) + len(self.tail):
            data = bytes(self.head + self.tail)
            return data.decode('utf-8', 'replace'), False
        skipped = self.total - len(self.head) - len(self.tail)
        return (bytes(self.head).decode('utf-8', 'replace') + f'\n…[省略 {skipped} 字节]…\n' + bytes(self.tail).decode('utf-8', 'replace')), True


def pump(stream, capture):
    while True:
        chunk = stream.read(65536)
        if not chunk:
            break
        capture.add(chunk)
    stream.close()


def kill_group(pgid, sig):
    try:
        os.killpg(pgid, sig)
    except (ProcessLookupError, PermissionError):
        pass


def run(spec):
    exec_id, timeout = spec['exec_id'], float(spec['timeout_s'])
    os.makedirs(STATE, exist_ok=True)
    env = dict(os.environ)
    env.update(spec.get('env') or {})
    if not os.path.isdir(spec['cwd']):
        return {'error': f"工作目录不存在：{spec['cwd']}"}
    started = time.monotonic()
    process = subprocess.Popen(['/bin/bash', '-c', spec['command']], cwd=spec['cwd'], env=env, stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    marker = os.path.join(STATE, f'{exec_id}.pgid')
    with open(marker, 'w') as handle:
        handle.write(str(process.pid))
    out, err = Capture(spec['max_bytes']), Capture(spec['max_bytes'])
    readers = [threading.Thread(target=pump, args=(process.stdout, out), daemon=True), threading.Thread(target=pump, args=(process.stderr, err), daemon=True)]
    for reader in readers:
        reader.start()
    timed_out = False
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        kill_group(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            pass
    # Background children of the command end with it; they would otherwise hold the pipes open.
    kill_group(process.pid, signal.SIGKILL)
    process.wait()
    for reader in readers:
        reader.join(timeout=5)
    cancelled = os.path.exists(marker + '.cancelled')
    for path in (marker, marker + '.cancelled'):
        try:
            os.remove(path)
        except FileNotFoundError:
            pass
    code = process.returncode
    stdout, stdout_truncated = out.text()
    stderr, stderr_truncated = err.text()
    return {
        'exit_code': code if code >= 0 else None, 'signal': signal.Signals(-code).name if code < 0 else None,
        'timed_out': timed_out, 'cancelled': cancelled, 'duration_ms': round((time.monotonic() - started) * 1000),
        'stdout': stdout, 'stderr': stderr, 'stdout_bytes': out.total, 'stderr_bytes': err.total,
        'stdout_truncated': stdout_truncated, 'stderr_truncated': stderr_truncated,
    }


def cancel(exec_id):
    marker = os.path.join(STATE, f'{exec_id}.pgid')
    try:
        with open(marker) as handle:
            pgid = int(handle.read().strip())
    except (FileNotFoundError, ValueError):
        return {'cancelled': False}
    open(marker + '.cancelled', 'w').close()
    kill_group(pgid, signal.SIGKILL)
    return {'cancelled': True}


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == 'run':
        result = run(json.loads(sys.argv[2]))
    elif len(sys.argv) == 3 and sys.argv[1] == 'cancel':
        result = cancel(sys.argv[2])
    else:
        result = {'error': 'usage: run.py run <json> | cancel <exec_id>'}
    sys.stdout.write(json.dumps(result, ensure_ascii=False))
