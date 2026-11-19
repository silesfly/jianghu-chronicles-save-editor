import contextlib
import hashlib
import http.client
import inspect
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import jhl_editor as editor


ROOT = Path(__file__).resolve().parents[1]
REAL_SAVES = Path("/tmp/jhl_real_saves_ro")
GAME_NAME = "JHL_GameData0_1.sav"
SUMMARY_NAME = "JHL_Summary_Data.sav"


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def status_code(error):
    for field in ("status", "status_code", "code", "http_status"):
        value = getattr(error, field, None)
        if isinstance(value, int):
            return value
    return None


def command(*args):
    return [sys.executable, "-W", "error", "-B", str(ROOT / "jhl_editor.py"), *map(str, args)]


class EditorTests(unittest.TestCase):
    def setUp(self):
        directory = self.enterContext(tempfile.TemporaryDirectory())
        self.directory = Path(directory)
        self.save = self.directory / GAME_NAME

    def run_cli(self, *args):
        result = subprocess.run(
            command(*args), cwd=self.directory, capture_output=True,
            text=True, encoding="utf-8", timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result.stdout

    def copy_real_saves(self):
        sources = [REAL_SAVES / name for name in (GAME_NAME, SUMMARY_NAME)]
        if not all(source.is_file() for source in sources):
            self.skipTest("Both real-save fixtures are required")
        for source in sources:
            shutil.copyfile(source, self.directory / source.name)

    def test_synthetic_round_trip(self):
        result = editor.self_test()
        self.assertIsNot(result, False)
        if type(result) is int:
            self.assertEqual(result, 0)

    def test_unsafe_save_paths(self):
        for name in (r"\\host\share\a.sav", "save.sav:stream", "CON.sav", "NUL.sav"):
            with self.subTest(name=name):
                candidate = name if name.startswith("\\\\") else self.directory / name
                with self.assertRaises(Exception):
                    editor.validate_safe_save_path(candidate)

    def test_symlink_save_path(self):
        self.save.write_bytes(b"save data")
        alias = self.directory / "alias.sav"
        try:
            alias.symlink_to(self.save)
        except (OSError, NotImplementedError) as exc:
            self.skipTest(f"Symlink creation unavailable: {exc}")
        with self.assertRaises(Exception):
            editor.validate_safe_save_path(alias)
        self.assertEqual(self.save.read_bytes(), b"save data")

    def test_running_game_blocks_write(self):
        original = b"before"
        self.save.write_bytes(original)
        with patch.dict(os.environ, {"JHL_SIMULATE_GAME_RUNNING": "1"}):
            self.assertTrue(editor.game_running())
            with self.assertRaises(Exception):
                editor.atomic_write(self.save, b"after", expected_sha=sha256(original))
        self.assertEqual(self.save.read_bytes(), original)

    def test_atomic_write_precondition(self):
        original = b"original"
        replacement = b"replacement"
        self.save.write_bytes(original)
        with patch.dict(os.environ, {"JHL_SIMULATE_GAME_RUNNING": "0"}):
            editor.atomic_write(self.save, replacement, expected_sha=sha256(original))
            self.assertEqual(sha256(self.save.read_bytes()), sha256(replacement))
            before = {entry: sha256(entry.read_bytes())
                      for entry in self.directory.rglob("*") if entry.is_file()}
            with self.assertRaises(Exception) as failure:
                editor.atomic_write(self.save, b"stale writer", expected_sha=sha256(original))
            self.assertEqual(status_code(failure.exception), 409, str(failure.exception))
            after = {entry: sha256(entry.read_bytes())
                     for entry in self.directory.rglob("*") if entry.is_file()}
            self.assertEqual(after, before)

    def test_backup_keeps_twenty_verified_versions(self):
        payloads = [f"version {index:02d}".encode("ascii") for index in range(23)]
        signature = inspect.signature(editor._backup)
        for payload in payloads:
            self.save.write_bytes(payload)
            arguments = (self.save,)
            try:
                signature.bind(*arguments)
            except TypeError:
                arguments = (self.save, payload)
                signature.bind(*arguments)
            backup = editor._backup(*arguments)
            if isinstance(backup, (str, os.PathLike)):
                self.assertEqual(sha256(Path(backup).read_bytes()), sha256(payload))
        known_hashes = {sha256(payload) for payload in payloads}
        saved_hashes = [
            sha256(entry.read_bytes()) for entry in self.directory.rglob("*")
            if entry.is_file() and entry != self.save
        ]
        versions = [digest for digest in saved_hashes if digest in known_hashes]
        self.assertCountEqual(versions, [sha256(payload) for payload in payloads[-20:]])

    def test_real_save_cli(self):
        self.copy_real_saves()
        original = self.save.read_bytes()
        self.run_cli("validate", self.save)
        self.run_cli("validate", self.directory / SUMMARY_NAME)
        before = self.run_cli("inspect", self.save)
        self.assertTrue(before.strip())
        self.assertEqual(self.save.read_bytes(), original)

        help_text = self.run_cli("apply", "--help")
        if "--money" in help_text:
            arguments = ("--money", "123456")
        else:
            self.assertIn("--set", help_text, "Expected a CLI money-edit option")
            arguments = ("--set", "money=123456")
        self.run_cli("apply", self.save, *arguments)
        self.assertNotEqual(sha256(self.save.read_bytes()), sha256(original))
        self.run_cli("validate", self.save)
        after = self.run_cli("inspect", self.save)
        self.assertRegex(after.replace(",", ""), r"\b123456\b")
        self.assertNotEqual(after, before)


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.directory = Path(self.enterContext(tempfile.TemporaryDirectory()))
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
            listener.bind(("127.0.0.1", 0))
            self.port = listener.getsockname()[1]
        self.host = f"127.0.0.1:{self.port}"
        self.origin = f"http://{self.host}"

        log = self.enterContext(tempfile.TemporaryFile(mode="w+b"))
        help_result = subprocess.run(
            command("serve", "--help"), cwd=self.directory, capture_output=True,
            text=True, encoding="utf-8", check=True, timeout=10,
        )
        options = ["--port", str(self.port)]
        if "--host" in help_result.stdout:
            options += ["--host", "127.0.0.1"]
        if "--no-browser" in help_result.stdout:
            options.append("--no-browser")
        environment = dict(os.environ, JHL_SIMULATE_GAME_RUNNING="0")
        process = subprocess.Popen(
            command("serve", *options), cwd=self.directory, env=environment,
            stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
        )
        self.addCleanup(self.stop_process, process)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and process.poll() is None:
            try:
                status, _, self.index = self.request("GET", "/", headers={"Host": self.host})
            except (OSError, http.client.HTTPException):
                time.sleep(0.05)
                continue
            self.assertEqual(status, 200)
            break
        else:
            log.seek(0)
            self.fail(f"Loopback server failed to start: {log.read().decode('utf-8', 'replace')}")

        token_patterns = (
            r'<meta\b[^>]*name=["\'](?:jhl-token|x-jhl-token)["\'][^>]*content=["\']([^"\']+)',
            r'["\']X-Jhl-Token["\']\s*:\s*["\']([^"\']+)',
            r'(?:JHL_TOKEN|__JHL_TOKEN__|jhlToken|bridgeToken)["\']?\s*[:=]\s*["\']([^"\']+)',
        )
        page = self.index.decode("utf-8")
        for pattern in token_patterns:
            match = re.search(pattern, page, flags=re.IGNORECASE)
            if match:
                self.token = match.group(1)
                break
        else:
            self.fail("The loopback index did not expose a bridge token")

    @staticmethod
    def stop_process(process):
        if process.poll() is None:
            with contextlib.suppress(ProcessLookupError):
                process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)

    def request(self, method, route, *, headers, body=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            headers = dict(headers)
            if body is not None:
                headers["Content-Type"] = "application/json"
                body = json.dumps(body).encode("utf-8")
            connection.request(method, route, body=body, headers=headers)
            response = connection.getresponse()
            return response.status, response.getheader("Content-Type", ""), response.read()
        finally:
            connection.close()

    def api(self, method, route, body=None, *, status=200, overrides=None):
        headers = {
            "Host": self.host,
            "Origin": self.origin,
            "Sec-Fetch-Site": "same-origin",
            "X-Jhl-Token": self.token,
        }
        for name, value in (overrides or {}).items():
            if value is None:
                headers.pop(name, None)
            else:
                headers[name] = value
        actual, content_type, payload = self.request(
            method, route, headers=headers, body=body,
        )
        self.assertEqual(actual, status, f"{method} {route}: {payload[:300]!r}")
        if actual == 200:
            self.assertIn("application/json", content_type)
            return json.loads(payload)
        return payload

    def test_browser_request_guards(self):
        self.assertTrue(self.index.strip())
        self.api("GET", "/api/status")
        self.api("GET", "/api/discover")
        for overrides in (
            {"X-Jhl-Token": None},
            {"X-Jhl-Token": "invalid"},
            {"Host": f"untrusted.invalid:{self.port}"},
            {"Origin": "http://untrusted.invalid"},
            {"Sec-Fetch-Site": "cross-site"},
        ):
            with self.subTest(overrides=overrides):
                self.api("GET", "/api/status", status=403, overrides=overrides)
                self.api("POST", "/api/save", {}, status=403, overrides=overrides)

    def test_load_save_precondition_backups_and_restore(self):
        fixture = REAL_SAVES / GAME_NAME
        if not fixture.is_file():
            self.skipTest("Real game save is required for the HTTP save lifecycle")
        path = self.directory / GAME_NAME
        shutil.copyfile(fixture, path)
        summary = REAL_SAVES / SUMMARY_NAME
        if summary.is_file():
            shutil.copyfile(summary, self.directory / SUMMARY_NAME)
        original = path.read_bytes()
        target = {"path": str(path)}
        loaded = self.api("POST", "/api/load", target)
        base_sha = loaded.get("sha256", loaded.get("baseSha256"))
        self.assertEqual(base_sha, sha256(original))

        state = loaded["state"]
        school = state.get("playerSchool", state)
        initial_money = school["money"]
        school["money"] += 137
        request = {**target, "baseSha256": base_sha, "state": state}
        self.api("POST", "/api/save", request)
        changed = path.read_bytes()
        self.assertNotEqual(sha256(changed), base_sha)
        reloaded = self.api("POST", "/api/load", target)
        current_state = reloaded["state"]
        self.assertEqual(current_state.get("playerSchool", current_state)["money"], initial_money + 137)
        self.api("POST", "/api/save", request, status=409)
        self.assertEqual(path.read_bytes(), changed)

        response = self.api("POST", "/api/backups", target)
        backups = response["backups"] if isinstance(response, dict) else response
        self.assertTrue(backups)
        verified = [entry for entry in backups if entry.get("sha256") == base_sha]
        self.assertEqual(len(verified), 1)
        backup = verified[0]
        backup_id = backup.get("id", backup.get("path", backup.get("name")))
        self.assertIsNotNone(backup_id)
        self.api("POST", "/api/restore", {
            **target, "backupId": backup_id, "baseSha256": sha256(changed),
        })
        self.assertEqual(path.read_bytes(), original)
        restored = self.api("POST", "/api/load", target)["state"]
        self.assertEqual(restored.get("playerSchool", restored)["money"], initial_money)


if __name__ == "__main__":
    unittest.main()
