import argparse
import base64
import binascii
import contextlib
import hashlib
import hmac
import io
import json
import os
import re
import secrets
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import webbrowser
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit


PRIMITIVES = {
    1: "Boolean", 2: "Byte", 3: "Char", 4: "Reserved",
    5: "Decimal", 6: "Double", 7: "Int16", 8: "Int32",
    9: "Int64", 10: "SByte", 11: "Single", 12: "TimeSpan",
    13: "DateTime", 14: "UInt16", 15: "UInt32", 16: "UInt64",
}
FORMATS = {
    1: "<?", 2: "<B", 6: "<d", 7: "<h", 8: "<i", 9: "<q",
    10: "<b", 11: "<f", 12: "<q", 13: "<Q", 14: "<H",
    15: "<I", 16: "<Q",
}
MAX_BYTES = 64 * 1024 * 1024
MAX_SLOTS = 2_000_000
BACKUP_LIMIT = 20
BACKUP_ID = re.compile(r"\d{20}\.[0-9a-f]{8}\.bak\.[0-9a-f]{16}-[0-9a-f]{64}")
RESERVED_NAMES = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}
PRESETS = {
    "wealth": {"money": 1000000, "jhMoney": 1000000, "food": 1000000},
    "school_max": {"schoolLevel": 10, "exp": 1000000},
    "disciples_god": {},
    "disciples_heal": {},
    "supply_pack": {},
    "diplomacy_max": {},
}
EDITABLE = ("money", "jhMoney", "food", "exp", "schoolLevel")
WRITE_LOCK = threading.RLock()


class ConflictError(FileExistsError):
    status = 409


def status_code(err):
    if hasattr(err, "status"):
        return err.status
    if isinstance(err, FileNotFoundError):
        return 404
    if isinstance(err, PermissionError):
        return 403
    if isinstance(err, FileExistsError):
        return 409
    if isinstance(err, (ValueError, TypeError, KeyError, OverflowError, struct.error)):
        return 400
    return 500


def _pack(fmt, *values):
    return struct.pack("<" + fmt, *values)


def _string(value):
    raw = value.encode("utf-8", "strict")
    n = len(raw)
    if n > 0x7fffffff:
        raise ValueError("NRBF string is too long")
    prefix = bytearray()
    while n >= 128:
        prefix.append((n & 127) | 128)
        n >>= 7
    prefix.append(n)
    return bytes(prefix) + raw


def _primitive_bytes(kind, value):
    if kind == 3:
        if len(value) != 1:
            raise ValueError("Expected one Unicode character")
        return value.encode("utf-8", "strict")
    if kind in (5, 18):
        return _string(value)
    if kind in FORMATS:
        return struct.pack(FORMATS[kind], value)
    raise ValueError(f"Unsupported primitive type {kind}")


class NRBFReader:
    def __init__(self, data):
        self.data = data
        self.stream = io.BytesIO(data)
        self.by_id = {}
        self.libraries = {}
        self.depth = 0
        self.slots = 0

    def take(self, n):
        if n < 0 or n > len(self.data) - self.stream.tell():
            raise ValueError("Truncated NRBF record")
        return self.stream.read(n)

    def u8(self):
        return self.take(1)[0]

    def i32(self):
        return struct.unpack("<i", self.take(4))[0]

    def string(self):
        size = 0
        for shift in range(0, 35, 7):
            byte = self.u8()
            size |= (byte & 127) << shift
            if not byte & 128:
                if size > 0x7fffffff:
                    break
                return self.take(size).decode("utf-8", "strict")
        raise ValueError("Invalid NRBF string length")

    def primitive(self, kind):
        if kind == 3:
            first = self.take(1)
            lead = first[0]
            size = (
                1 if lead < 0x80 else 2 if 0xC2 <= lead <= 0xDF
                else 3 if 0xE0 <= lead <= 0xEF else 4 if 0xF0 <= lead <= 0xF4
                else 0
            )
            if not size:
                raise ValueError("Invalid UTF-8 character")
            return (first + self.take(size - 1)).decode("utf-8", "strict")
        if kind in (5, 18):
            return self.string()
        if kind in FORMATS:
            fmt = FORMATS[kind]
            return struct.unpack(fmt, self.take(struct.calcsize(fmt)))[0]
        raise ValueError(f"Unsupported primitive type {kind}")

    def additional_type(self, kind):
        if kind in (0, 7):
            return self.u8()
        if kind == 3:
            return self.string()
        if kind == 4:
            return self.string(), self.i32()
        if kind not in (1, 2, 5, 6):
            raise ValueError(f"Unknown binary type {kind}")
        return None

    def claim_slots(self, count):
        if count < 0 or count > MAX_SLOTS - self.slots:
            raise ValueError("Invalid or excessive NRBF slot count")
        self.slots += count

    def register(self, rec):
        object_id = rec["id"]
        if object_id == 0 or object_id in self.by_id:
            raise ValueError(f"Invalid or duplicate object ID {object_id}")
        self.by_id[object_id] = rec

    def _value(self, kind=2, additional=None, array=False):
        if kind == 0:
            return self.primitive(additional)
        preceding = []
        while True:
            start = self.stream.tell()
            code = self.u8()
            rec = self._record(code, start)
            if code != 12:
                break
            preceding.append(rec)
        allowed = (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 16, 17)
        if code not in allowed and not (array and code in (13, 14)):
            raise ValueError(f"Invalid value record {code}")
        if preceding:
            rec["_precedingLibs"] = preceding
        return rec

    def _array_values(self, total, kind, additional):
        self.claim_slots(total)
        vals = []
        while len(vals) < total:
            value = self._value(kind, additional, array=True)
            if isinstance(value, dict) and value["record"] in (13, 14):
                count = value["count"]
                if not 1 <= count <= total - len(vals):
                    raise ValueError("Null run exceeds array length")
                for index in range(count):
                    slot = {"record": 10, "count": 1}
                    if index == 0 and "_precedingLibs" in value:
                        slot["_precedingLibs"] = value["_precedingLibs"]
                    vals.append(slot)
            else:
                vals.append(value)
        return vals

    def _record(self, code, start):
        if self.depth >= 128:
            raise ValueError("NRBF nesting limit exceeded")
        self.depth += 1
        try:
            rec = self._body(code)
        finally:
            self.depth -= 1
        rec["_raw"] = self.data[start:self.stream.tell()]
        return rec

    def _body(self, code):
        rec = {"record": code}
        if code == 0:
            rec.update(rootId=self.i32(), headerId=self.i32(),
                       majorVersion=self.i32(), minorVersion=self.i32())
            if (rec["majorVersion"], rec["minorVersion"]) != (1, 0):
                raise ValueError("Unsupported NRBF stream version")
        elif code in (1, 2, 3, 4, 5):
            rec["id"] = self.i32()
            if code == 1:
                rec["metadataId"] = self.i32()
                metadata = self.by_id.get(rec["metadataId"])
                if metadata is None or metadata["record"] not in (2, 3, 4, 5):
                    raise ValueError("Missing class metadata")
                for key in ("name", "memberNames", "memberTypes", "additionalTypes"):
                    rec[key] = metadata[key]
                self.claim_slots(len(rec["memberNames"]))
            else:
                rec["name"] = self.string()
                count = self.i32()
                self.claim_slots(count)
                rec["memberNames"] = [self.string() for _ in range(count)]
                kinds = [self.u8() for _ in range(count)] if code in (4, 5) else [2] * count
                rec["memberTypes"] = kinds
                rec["additionalTypes"] = [self.additional_type(kind) for kind in kinds]
                if code in (3, 5):
                    rec["libraryId"] = self.i32()
            self.register(rec)
            rec["members"] = {
                name: self._value(kind, additional)
                for name, kind, additional in zip(
                    rec["memberNames"], rec["memberTypes"], rec["additionalTypes"]
                )
            }
            if len(rec["members"]) != len(rec["memberNames"]):
                raise ValueError("Duplicate class member names")
        elif code == 6:
            rec.update(id=self.i32(), value=self.string())
            self.register(rec)
        elif code == 7:
            rec.update(id=self.i32(), arrayType=self.u8())
            rank = self.i32()
            if not 1 <= rank <= 32 or rec["arrayType"] not in range(6):
                raise ValueError("Invalid BinaryArray shape")
            lengths = [self.i32() for _ in range(rank)]
            total = 1
            for length in lengths:
                if not 0 <= length <= MAX_SLOTS:
                    raise ValueError("Invalid BinaryArray dimension")
                total *= length
            rec["lengths"] = lengths
            if rec["arrayType"] >= 3:
                rec["lowerBounds"] = [self.i32() for _ in range(rank)]
            kind = self.u8()
            additional = self.additional_type(kind)
            rec.update(binaryType=kind, additionalType=additional)
            self.register(rec)
            rec["values"] = self._array_values(total, kind, additional)
        elif code == 8:
            rec["primitiveType"] = self.u8()
            rec["value"] = self.primitive(rec["primitiveType"])
        elif code == 9:
            rec["idRef"] = self.i32()
        elif code == 10:
            rec["count"] = 1
        elif code == 12:
            rec.update(libraryId=self.i32(), name=self.string())
            if rec["libraryId"] in self.libraries:
                raise ValueError("Duplicate library ID")
            self.libraries[rec["libraryId"]] = rec
        elif code in (13, 14):
            rec["count"] = self.u8() if code == 13 else self.i32()
        elif code in (15, 16, 17):
            rec.update(id=self.i32(), length=self.i32())
            if code == 15:
                rec["primitiveType"] = self.u8()
            self.register(rec)
            rec["values"] = self._array_values(
                rec["length"], 0 if code == 15 else 1 if code == 17 else 2,
                rec.get("primitiveType"),
            )
        elif code != 11:
            raise ValueError(f"Unsupported NRBF record {code}")
        return rec


def parse_nrbf(data):
    if not data or len(data) > MAX_BYTES:
        raise ValueError("Invalid save size")
    reader = NRBFReader(data)
    records = []
    while reader.stream.tell() < len(data):
        start = reader.stream.tell()
        code = reader.u8()
        if (not records and code != 0) or (records and code == 0):
            raise ValueError("Invalid NRBF stream header")
        records.append(reader._record(code, start))
        if code == 11:
            if reader.stream.tell() != len(data):
                raise ValueError("Unexpected data after MessageEnd")
            return {"records": records, "by_id": reader.by_id, "libraries": reader.libraries}
    raise ValueError("Missing MessageEnd")


def _additional_bytes(kind, value):
    if kind in (0, 7):
        return _pack("B", value)
    if kind == 3:
        return _string(value)
    if kind == 4:
        return _string(value[0]) + _pack("i", value[1])
    if kind in (1, 2, 5, 6):
        return b""
    raise ValueError(f"Unknown binary type {kind}")


def _encode_value(value, kind=2, additional=None):
    if kind == 0:
        return _primitive_bytes(additional, value)
    return b"".join(_encode_record(lib) for lib in value.get("_precedingLibs", ())) + _encode_record(value)


def _encode_record(rec):
    if not rec.get("_dirty") and "_raw" in rec:
        return rec["_raw"]
    code = rec["record"]
    out = bytearray(_pack("B", code))
    if code == 0:
        out += _pack("iiii", rec["rootId"], rec["headerId"], rec["majorVersion"], rec["minorVersion"])
    elif code in (1, 2, 3, 4, 5):
        out += _pack("i", rec["id"])
        names = rec["memberNames"]
        kinds = rec["memberTypes"]
        additional = rec["additionalTypes"]
        if code == 1:
            out += _pack("i", rec["metadataId"])
        else:
            out += _string(rec["name"]) + _pack("i", len(names))
            for name in names:
                out += _string(name)
            if code in (4, 5):
                out += bytes(kinds)
                for kind, extra in zip(kinds, additional):
                    out += _additional_bytes(kind, extra)
            if code in (3, 5):
                out += _pack("i", rec["libraryId"])
        for name, kind, extra in zip(names, kinds, additional):
            out += _encode_value(rec["members"][name], kind, extra)
    elif code == 6:
        out += _pack("i", rec["id"]) + _string(rec["value"])
    elif code == 7:
        lengths = rec["lengths"]
        kind, extra = rec["binaryType"], rec["additionalType"]
        out += _pack("iBi", rec["id"], rec["arrayType"], len(lengths))
        for length in lengths:
            out += _pack("i", length)
        for bound in rec.get("lowerBounds", ()):
            out += _pack("i", bound)
        out += _pack("B", kind) + _additional_bytes(kind, extra)
        for value in rec["values"]:
            out += _encode_value(value, kind, extra)
    elif code == 8:
        out += _pack("B", rec["primitiveType"])
        out += _primitive_bytes(rec["primitiveType"], rec["value"])
    elif code == 9:
        out += _pack("i", rec["idRef"])
    elif code == 12:
        out += _pack("i", rec["libraryId"]) + _string(rec["name"])
    elif code in (13, 14):
        out += _pack("B" if code == 13 else "i", rec["count"])
    elif code in (15, 16, 17):
        values = rec["values"]
        out += _pack("ii", rec["id"], len(values))
        if code == 15:
            out += _pack("B", rec["primitiveType"])
        for value in values:
            out += _encode_value(value, 0 if code == 15 else 2, rec.get("primitiveType"))
    elif code not in (10, 11):
        raise ValueError(f"Cannot encode NRBF record {code}")
    return bytes(out)


def _propagate_dirty(rec):
    if not isinstance(rec, dict):
        return False
    children = list(rec.get("members", {}).values())
    children.extend(rec.get("values", ()))
    children.extend(rec.get("_precedingLibs", ()))
    for child in children:
        if _propagate_dirty(child):
            rec["_dirty"] = True
    return bool(rec.get("_dirty"))


def serialize_nrbf(ast):
    parts = []
    for rec in ast["records"]:
        _propagate_dirty(rec)
        if not rec.get("_dirty") and "_raw" in rec:
            parts.append(rec["_raw"])
        else:
            parts.append(_encode_record(rec))
    return b"".join(parts)


def _resolve(ast, value):
    seen = set()
    while isinstance(value, dict) and value.get("record") == 9:
        ref = value["idRef"]
        if ref in seen or ref not in ast["by_id"]:
            raise ValueError(f"Invalid member reference {ref}")
        seen.add(ref)
        value = ast["by_id"][ref]
    if isinstance(value, dict):
        if value.get("record") in (6, 8):
            return value["value"]
        if value.get("record") in (10, 13, 14):
            return None
    return value


def _members(value):
    return value.get("members", {}) if isinstance(value, dict) else {}


def _detect_kind(ast):
    for rec in ast["by_id"].values():
        members = _members(rec)
        if "playerSchool" in members:
            return "PlayerGameData"
        if "schoolLevel" in members or "schoolDataId" in members:
            return "StoreData"
    return "Unknown"


def _school_context(ast):
    root = ast["by_id"].get(ast["records"][0]["rootId"])
    root_members = _members(root)
    if "playerSchool" in root_members:
        school = _resolve(ast, root_members["playerSchool"])
        if not _members(school):
            raise ValueError("Cannot resolve playerSchool")
        return root_members, school
    candidates = [rec for rec in ast["by_id"].values() if "playerSchool" in _members(rec)]
    if len(candidates) == 1:
        school = _resolve(ast, _members(candidates[0])["playerSchool"])
        if not _members(school):
            raise ValueError("Cannot resolve playerSchool")
        return _members(candidates[0]), school
    store_candidates = [rec for rec in ast["by_id"].values() if "schoolLevel" in _members(rec) or "schoolDataId" in _members(rec)]
    if store_candidates:
        store = store_candidates[0]
        return _members(store), store
    raise ValueError("Cannot locate the school owner context")


def _list_parts(ast, value):
    value = _resolve(ast, value)
    if value is None:
        return (), 0
    if not isinstance(value, dict):
        raise ValueError("Invalid school list")
    members = _members(value)
    if "_items" in members:
        backing = _resolve(ast, members["_items"])
        values = backing.get("values", ()) if isinstance(backing, dict) else ()
        size = _resolve(ast, members.get("_size", len(values)))
    else:
        values = value.get("values", ())
        size = len(values)
    if type(size) is not int or not 0 <= size <= len(values):
        raise ValueError("Invalid list size")
    return values, size


def _detect_kind(ast):
    root = ast["by_id"].get(ast["records"][0]["rootId"], {}) if ast.get("records") else {}
    name = str(root.get("name") or root.get("className") or "")
    members = _members(root)
    if "StoreData" in name or "summarySlots" in members or "list" in members:
        return "StoreData"
    if "PlayerGameData" in name or "playerSchool" in members:
        return "PlayerGameData"
    return "Unknown"


def _summary(ast):
    if _detect_kind(ast) == "StoreData":
        root = ast["by_id"].get(ast["records"][0]["rootId"], {})
        members = _members(root)
        _, slots = _list_parts(ast, members.get("summarySlots") or members.get("list"))
        return {"kind": "StoreData", "summarySlots": slots}
    root, school = _school_context(ast)
    members = _members(school)
    _, students = _list_parts(ast, members.get("students"))
    result = {
        "kind": "PlayerGameData",
        "school": _resolve(ast, members.get("name")),
        "level": _resolve(ast, members.get("schoolLevel")),
        "students": students,
        "dateTime": _resolve(ast, root.get("dateTime", members.get("dateTime"))),
    }
    result.update({key: _resolve(ast, members.get(key)) for key in EDITABLE})
    return result


def _mutate(ast, changes):
    root, school = _school_context(ast)
    targets = [school]
    members = _members(school)
    school_id = _resolve(ast, members.get("schoolDataId"))
    if school_id is not None:
        values, size = _list_parts(ast, root.get("schoolGameDataList"))
        for item in values[:size]:
            candidate = _resolve(ast, item)
            candidate_members = _members(candidate)
            if candidate is not school and _resolve(ast, candidate_members.get("schoolDataId")) == school_id:
                targets.append(candidate)
    pending = []
    for key, value in changes.items():
        if key not in EDITABLE or type(value) is not int:
            raise ValueError(f"Invalid change for {key}")
        if key not in members:
            raise ValueError(f"Missing playerSchool member {key}")
        for target in targets:
            fields = _members(target)
            if key not in fields:
                continue
            index = target["memberNames"].index(key)
            if target["memberTypes"][index] == 0:
                kind = target["additionalTypes"][index]
                destination, field = fields, key
            elif isinstance(fields[key], dict) and fields[key].get("record") == 8:
                destination, field = fields[key], "value"
                kind = destination["primitiveType"]
            else:
                raise ValueError(f"Unsupported numeric representation for {key}")
            if kind not in (2, 6, 7, 8, 9, 10, 11, 14, 15, 16):
                raise ValueError(f"Invalid numeric type for {key}")
            _primitive_bytes(kind, value)
            pending.append((target, destination, field, value))
    for target, destination, field, value in pending:
        if destination[field] != value:
            destination[field] = value
            target["_dirty"] = True
            if field != "value" or target["members"] is destination:
                continue
            destination["_dirty"] = True
    return ast


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def validate_safe_save_path(path, root=None):
    raw_s = str(path)
    if not raw_s or "\0" in raw_s or raw_s.startswith("\\\\") or "//" in raw_s:
        raise ValueError("Invalid path")
    raw_p = Path(path)
    if ".." in raw_p.parts or any(part in (".jhl_backups", ".jhl-backups") for part in raw_p.parts):
        raise ValueError("Invalid path components")
    if any(":" in p for p in raw_p.parts[1:]) or (raw_p.parts and ":" in raw_p.parts[0] and not re.fullmatch(r"[A-Za-z]:\\?", raw_p.parts[0])):
        raise ValueError("Alternate streams are forbidden")
    raw = raw_p.absolute()
    if raw.drive.startswith("\\\\") or any(":" in p for p in raw.parts[1:]):
        raise ValueError("Network paths and alternate streams are forbidden")
    stem = raw.stem.split(".")[0]
    if stem.upper() in RESERVED_NAMES:
        raise ValueError("Reserved device names are forbidden")
    for part in (raw, *raw.parents):
        try:
            if part.is_symlink() or getattr(part, "is_junction", lambda: False)():
                raise ValueError("Linked save paths are forbidden")
        except OSError:
            pass
    if root is not None:
        resolved_root = Path(root).resolve(strict=True)
        resolved = raw.resolve(strict=True)
        if not resolved.is_relative_to(resolved_root):
            raise PermissionError("Save path is outside the configured directory")
    else:
        try:
            resolved = raw.resolve(strict=True)
        except OSError:
            resolved = raw
    if resolved.exists():
        if not stat.S_ISREG(resolved.stat().st_mode):
            raise ValueError("Expected a regular save file")
    return raw.resolve()


def game_running():
    sim = os.environ.get("JHL_SIMULATE_GAME_RUNNING")
    if sim is not None:
        return sim == "1"
    try:
        if os.name == "nt":
            output = subprocess.check_output(
                ["tasklist", "/FO", "CSV", "/NH"], text=True, errors="replace",
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
        else:
            output = subprocess.check_output(["ps", "-A", "-o", "comm="], text=True, errors="replace")
        return bool(re.search(r"jianghu[ _-]*chronicles|江湖录|강호록", output, re.I))
    except Exception:
        return False


def _read(path):
    with path.open("rb") as stream:
        data = stream.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError("File exceeds the save size limit")
    return data


def _check_sha(data, expected_sha256):
    if not isinstance(expected_sha256, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", expected_sha256):
        raise ValueError("A valid expected SHA-256 is required")
    if not hmac.compare_digest(_sha(data), expected_sha256.lower()):
        raise ConflictError("Save changed since it was loaded")


def atomic_write(path, data, expected_sha=None, *, expected_sha256=None):
    expected = expected_sha if expected_sha is not None else expected_sha256
    with WRITE_LOCK:
        path = validate_safe_save_path(path)
        if game_running():
            raise ConflictError("Close the game before writing the save")
        if expected is not None:
            _check_sha(_read(path), expected)
        mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o644
        fd, temporary = tempfile.mkstemp(prefix=".jhl-", dir=path.parent)
        try:
            with os.fdopen(fd, "wb") as stream:
                os.chmod(temporary, mode)
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            if expected is not None:
                _check_sha(_read(path), expected)
            if game_running():
                raise ConflictError("Close the game before writing the save")
            os.replace(temporary, path)
            if os.name != "nt":
                directory_fd = os.open(path.parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
        finally:
            Path(temporary).unlink(missing_ok=True)


def _backup_dir(path, create=False):
    directory = path.parent / ".jhl_backups"
    if create:
        directory.mkdir(mode=0o700, exist_ok=True)
    return directory


def _backups(path):
    directory = _backup_dir(path)
    if not directory.exists():
        return []
    tag8 = hashlib.sha256(os.fsencode(path.name)).hexdigest()[:8]
    pattern = re.compile(rf"^\d{{20}}\.{tag8}\.bak\.[0-9a-f]{{16}}-[0-9a-f]{{64}}$")
    results = []
    for p in directory.iterdir():
        if pattern.fullmatch(p.name) and not p.is_symlink() and p.is_file():
            results.append(p)
    return sorted(results, reverse=True)


def _read_backup(path, backup_id):
    if not isinstance(backup_id, str) or not BACKUP_ID.fullmatch(backup_id):
        raise ValueError("Invalid backup ID")
    filename = _backup_dir(path) / backup_id
    if filename.is_symlink() or not filename.is_file():
        raise FileNotFoundError("Backup not found")
    data = _read(filename)
    _check_sha(data, backup_id.rsplit("-", 1)[1])
    return data


def _backup(path, data=None):
    with WRITE_LOCK:
        if data is None:
            data = _read(path)
        directory = _backup_dir(path, create=True)
        tag8 = hashlib.sha256(os.fsencode(path.name)).hexdigest()[:8]
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S%f")
        backup_id = f"{timestamp}.{tag8}.bak.{secrets.token_hex(8)}-{_sha(data)}"
        fd, temporary = tempfile.mkstemp(prefix=".backup-", dir=directory)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            _check_sha(_read(Path(temporary)), _sha(data))
            os.replace(temporary, directory / backup_id)
        finally:
            Path(temporary).unlink(missing_ok=True)
        for old in _backups(path)[BACKUP_LIMIT:]:
            with contextlib.suppress(Exception):
                old.unlink()
        return directory / backup_id


_SERVE_CACHE = {}


def _payload(path, data, ast=None):
    if ast is None:
        digest = _sha(data)
        ast = _SERVE_CACHE.get(digest) or parse_nrbf(data)
        if len(_SERVE_CACHE) > 4:
            _SERVE_CACHE.clear()
        _SERVE_CACHE[digest] = ast
    summary = _summary(ast)
    try:
        root, school = _school_context(ast)
        school_members = _members(school)
        school_name = _resolve(ast, school_members.get("name")) or path.stem
        state = {
            "playerSchool": {
                "name": school_name,
                **{k: _resolve(ast, school_members.get(k)) for k in EDITABLE if k in school_members}
            }
        }
    except Exception:
        state = {"playerSchool": {"name": path.stem}}
    return {
        "path": str(path),
        "sha256": _sha(data),
        "summary": summary,
        "state": state,
        "bytesBase64": base64.b64encode(data).decode("ascii"),
    }


def discover(save_dir=None):
    root = Path(save_dir or Path.cwd()).resolve()
    if not root.exists():
        return []
    files = []
    for p in root.rglob("*.sav"):
        if p.is_symlink() or not p.is_file():
            continue
        if ".jhl_backups" in p.parts or ".jhl-backups" in p.parts or ".bak." in p.name:
            continue
        try:
            validated = validate_safe_save_path(p, root)
            files.append(str(validated))
        except Exception:
            pass
    return sorted(files)


def _commit(path, data, expected, ast=None):
    result = _payload(path, data, ast=ast)
    with WRITE_LOCK:
        if game_running():
            raise ConflictError("Close the game before writing the save")
        if path.exists():
            original = _read(path)
            if expected is not None:
                _check_sha(original, expected)
            _backup(path, original)
        atomic_write(path, data, expected)
    return result


def serve(port=0, html_path=None, save_root=None, host="127.0.0.1", open_browser=False):
    html_path = Path(html_path) if html_path else (Path(__file__).resolve().parent / "dist" / "JianghuChroniclesSaveEditor-v1.0.0.html")
    if not html_path.is_file():
        html_path = Path(__file__).with_suffix(".html")
    html = html_path.read_bytes() if html_path.is_file() else b"<!DOCTYPE html><html><head><title>JHL Editor</title></head><body>JHL Editor</body></html>"
    token = secrets.token_urlsafe(32)
    meta = f'<meta name="x-jhl-token" content="{token}">'.encode()
    script = f'<script>window.__JHL_BRIDGE__={json.dumps({"token": token})};</script>'.encode()
    injection = meta + script
    head = re.search(rb"<head(?:\s[^>]*)?>", html, re.I)
    offset = head.end() if head else (re.match(rb"\s*<!doctype[^>]*>", html, re.I) or re.match(rb"", html)).end()
    html = html[:offset] + injection + html[offset:]
    html = re.sub(rb"connect-src\s+'none'", b"connect-src 'self'", html, flags=re.I)

    class Handler(BaseHTTPRequestHandler):
        def reply(self, status, body, content_type):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

        def json_reply(self, status, result):
            self.reply(status, json.dumps(result, ensure_ascii=True, allow_nan=False).encode(), "application/json")

        def handle_route(self, method):
            try:
                route = urlsplit(self.path)
                expected_host = f"{host}:{self.server.server_port}"
                if self.headers.get("Host") != expected_host:
                    raise PermissionError("Invalid Host header")
                if method == "GET" and route.path == "/":
                    self.reply(200, html, "text/html; charset=utf-8")
                    return
                origin = self.headers.get("Origin")
                allowed_origins = (None, f"http://{expected_host}", f"https://{expected_host}")
                if origin not in allowed_origins:
                    raise PermissionError("Invalid request origin")
                fetch_site = self.headers.get("Sec-Fetch-Site")
                if fetch_site == "cross-site":
                    raise PermissionError("Cross-site request forbidden")
                supplied = self.headers.get("X-Jhl-Token", "")
                if not hmac.compare_digest(supplied, token):
                    raise PermissionError("Invalid bridge token")
                if route.path not in ("/api/status", "/api/discover", "/api/load", "/api/backups", "/api/save", "/api/restore"):
                    raise FileNotFoundError("Unknown endpoint")
                if method == "GET":
                    args = {key: values[-1] for key, values in parse_qs(route.query).items()}
                else:
                    length = int(self.headers.get("Content-Length", "0"))
                    if not 0 <= length <= 2 * MAX_BYTES + 65536:
                        raise ValueError("Invalid request size")
                    args = json.loads(self.rfile.read(length)) if length > 0 else {}
                    if not isinstance(args, dict):
                        raise ValueError("Expected a JSON object")
                
                if route.path == "/api/status":
                    self.json_reply(200, {"ok": True, "gameRunning": game_running()})
                    return
                if route.path == "/api/discover":
                    self.json_reply(200, {"files": discover(save_root)})
                    return

                path_str = args.get("path")
                if not path_str:
                    raise ValueError("Path is required")
                path = validate_safe_save_path(path_str, save_root)

                if route.path == "/api/load":
                    result = _payload(path, _read(path))
                elif route.path == "/api/backups":
                    backups_list = []
                    for p in _backups(path):
                        parts = p.name.rsplit("-", 1)
                        sha = parts[1] if len(parts) > 1 else ""
                        backups_list.append({"id": p.name, "name": p.name, "path": str(p), "sha256": sha})
                    result = {"backups": backups_list}
                elif route.path == "/api/save":
                    expected = args.get("baseSha256") or args.get("expectedSha256") or args.get("sha256")
                    if "bytesBase64" in args:
                        data = base64.b64decode(args["bytesBase64"], validate=True)
                    elif "data" in args:
                        data = bytes.fromhex(args["data"])
                    elif "state" in args:
                        state = args["state"]
                        school_state = state.get("playerSchool", state)
                        changes = {k: v for k, v in school_state.items() if k in EDITABLE and type(v) is int}
                        if not path.exists():
                            raise FileNotFoundError("Save file not found for state mutation")
                        original_data = _read(path)
                        ast = _SERVE_CACHE.pop(_sha(original_data), None) or parse_nrbf(original_data)
                        _mutate(ast, changes)
                        data = serialize_nrbf(ast)
                    else:
                        raise ValueError("Missing save payload")
                    result = _commit(path, data, expected, ast=ast if "state" in args else None)
                elif route.path == "/api/restore":
                    backup_id = args.get("backupId") or args.get("backup")
                    expected = args.get("baseSha256") or args.get("expectedSha256") or args.get("sha256")
                    data = _read_backup(path, backup_id)
                    result = _commit(path, data, expected)
                self.json_reply(200, result)
            except (OSError, ValueError, TypeError, KeyError, OverflowError, struct.error, binascii.Error) as err:
                status = status_code(err)
                self.json_reply(status, {"error": str(err) if status < 500 else "Save operation failed"})

        def do_GET(self):
            self.handle_route("GET")

        def do_POST(self):
            self.handle_route("POST")

    with ThreadingHTTPServer((host, port), Handler) as server:
        addr = f"http://{host}:{server.server_port}/"
        print(addr, flush=True)
        if open_browser:
            with contextlib.suppress(Exception):
                webbrowser.open(addr)
        server.serve_forever()


def self_test():
    header = b"\x00" + _pack("iiii", 1, -1, 1, 0)
    library = b"\x0c" + _pack("i", 1) + _string("Game")
    array = b"\x10" + _pack("ii", 1, 4) + b"\x0d\x02"
    binary = b"\x07" + _pack("iBiiB", 3, 0, 1, 2, 2) + b"\x0e" + _pack("i", 2)
    source = header + array + library + b"\x06" + _pack("i", 2) + _string("가") + binary + b"\x0b"
    ast = parse_nrbf(source)
    assert serialize_nrbf(ast) == source
    assert len(ast["by_id"][1]["values"]) == 4
    assert len(ast["by_id"][3]["values"]) == 2
    string = ast["by_id"][2]
    assert string["_precedingLibs"][0] is ast["libraries"][1]
    string.update(value="강호록", _dirty=True)
    assert parse_nrbf(serialize_nrbf(ast))["by_id"][2]["value"] == "강호록"
    assert status_code(ConflictError()) == 409 and isinstance(ConflictError(), FileExistsError)
    for char in ("a", "é", "가", "😀"):
        assert NRBFReader(_primitive_bytes(3, char)).primitive(3) == char
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true", dest="run_self_test")
    commands = parser.add_subparsers(dest="command", required=False)
    
    selftest_p = commands.add_parser("self-test")
    
    disc_p = commands.add_parser("discover")
    disc_p.add_argument("--dir", dest="save_dir")
    
    insp_p = commands.add_parser("inspect")
    insp_p.add_argument("file")
    
    val_p = commands.add_parser("validate")
    val_p.add_argument("file")
    
    commands.add_parser("presets")
    
    server = commands.add_parser("serve")
    server.add_argument("--port", type=int, default=0)
    server.add_argument("--host", default="127.0.0.1")
    server.add_argument("--dir", "--save-root", dest="save_root")
    server.add_argument("--html")
    server.add_argument("--no-browser", action="store_true")
    
    apply = commands.add_parser("apply")
    apply.add_argument("file")
    apply.add_argument("--preset")
    apply.add_argument("--presets-file", type=Path, default=Path(__file__).with_name("presets.json"))
    for key, flag in zip(EDITABLE, ("money", "jh-money", "food", "exp", "school-level")):
        apply.add_argument(f"--{flag}", f"--set-{flag}", dest=key, type=int)
    apply.add_argument("--set", action="append", default=[])
    
    restore = commands.add_parser("restore")
    restore.add_argument("file")
    restore.add_argument("--backup", required=True)
    
    args = parser.parse_args(argv)
    try:
        if args.run_self_test or args.command == "self-test":
            sys.exit(self_test())
        elif not args.command:
            parser.error("the following arguments are required: command")
        elif args.command == "serve":
            serve(args.port, args.html, args.save_root, args.host, not args.no_browser)
        elif args.command == "discover":
            for f in discover(args.save_dir):
                print(f)
        elif args.command == "inspect":
            path = validate_safe_save_path(args.file)
            print(json.dumps(_payload(path, _read(path))["summary"], ensure_ascii=False, indent=2))
        elif args.command == "validate":
            path = validate_safe_save_path(args.file)
            data = _read(path)
            ast = parse_nrbf(data)
            print(json.dumps({"valid": True, "kind": _detect_kind(ast), "summary": _summary(ast)}, ensure_ascii=False, indent=2))
        elif args.command == "presets":
            print(json.dumps(PRESETS, ensure_ascii=False, indent=2))
        elif args.command == "restore":
            path = validate_safe_save_path(args.file)
            data = _read_backup(path, args.backup)
            original = _read(path) if path.exists() else b""
            result = _commit(path, data, _sha(original) if original else None)
            result.pop("bytesBase64", None)
            print(json.dumps(result, ensure_ascii=False))
        elif args.command == "apply":
            changes = {}
            if args.preset is not None:
                presets_path = args.presets_file
                if presets_path.is_file():
                    presets = json.loads(presets_path.read_text(encoding="utf-8"))
                    preset = presets.get(args.preset, PRESETS.get(args.preset))
                else:
                    preset = PRESETS.get(args.preset)
                if not isinstance(preset, dict):
                    raise ValueError(f"Unknown preset {args.preset!r}")
                changes.update(preset)
            changes.update({key: getattr(args, key) for key in EDITABLE if getattr(args, key) is not None})
            for item in args.set:
                if "=" in item:
                    k, v = item.split("=", 1)
                    k = k.strip()
                    if k in EDITABLE:
                        changes[k] = int(v.strip())
            if not changes:
                raise ValueError("Provide a preset or at least one field to update")
            path = validate_safe_save_path(args.file)
            original = _read(path)
            edited = serialize_nrbf(_mutate(parse_nrbf(original), changes))
            result = _commit(path, edited, _sha(original)) if edited != original else _payload(path, original)
            result.pop("bytesBase64", None)
            print(json.dumps(result, ensure_ascii=False))
    except (OSError, ValueError, TypeError, KeyError, OverflowError, struct.error, subprocess.SubprocessError) as err:
        parser.exit(1, f"{err}\n")


if __name__ == "__main__":
    main()
