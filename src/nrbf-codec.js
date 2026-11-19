(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else if (typeof define === "function" && define.amd) define([], factory);
  else root.JhlNrbfCodec = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var REC = {
    SerializedStreamHeader: 0, ClassWithId: 1, SystemClassWithMembers: 2,
    ClassWithMembers: 3, SystemClassWithMembersAndTypes: 4,
    ClassWithMembersAndTypes: 5, BinaryObjectString: 6, BinaryArray: 7,
    MemberPrimitiveTyped: 8, MemberReference: 9, ObjectNull: 10, MessageEnd: 11,
    BinaryLibrary: 12, ObjectNullMultiple256: 13, ObjectNullMultiple: 14,
    ArraySinglePrimitive: 15, ArraySingleObject: 16, ArraySingleString: 17,
    MethodCall: 21, MethodReturn: 22
  };
  var BT = {
    Primitive: 0, String: 1, Object: 2, SystemClass: 3, Class: 4,
    ObjectArray: 5, StringArray: 6, PrimitiveArray: 7
  };
  var PT = {
    Boolean: 1, Byte: 2, Char: 3, Decimal: 5, Double: 6, Int16: 7,
    Int32: 8, Int64: 9, SByte: 10, Single: 11, TimeSpan: 12,
    DateTime: 13, UInt16: 14, UInt32: 15, UInt64: 16, Null: 17,
    String: 18
  };
  var BAT = {
    Single: 0, Jagged: 1, Rectangular: 2, SingleOffset: 3,
    JaggedOffset: 4, RectangularOffset: 5
  };

  function Reader(bytes) {
    this.bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    this.pos = 0;
  }
  Reader.prototype.take = function (n) {
    if (n < 0 || this.pos + n > this.bytes.length) throw new Error("Unexpected end of NRBF data");
    var p = this.pos;
    this.pos += n;
    return this.bytes.subarray(p, this.pos);
  };
  Reader.prototype.u8 = function () { return this.take(1)[0]; };
  Reader.prototype.i8 = function () { return this.view.getInt8(this.pos - 1); };
  Reader.prototype.bool = function () { return this.u8() !== 0; };
  Reader.prototype.i16 = function () { var p = this.pos; this.take(2); return this.view.getInt16(p, true); };
  Reader.prototype.u16 = function () { var p = this.pos; this.take(2); return this.view.getUint16(p, true); };
  Reader.prototype.i32 = function () { var p = this.pos; this.take(4); return this.view.getInt32(p, true); };
  Reader.prototype.u32 = function () { var p = this.pos; this.take(4); return this.view.getUint32(p, true); };
  Reader.prototype.i64 = function () {
    var lo = this.u32(), hi = this.i32();
    return typeof BigInt === "function" ? ((BigInt(hi) << 32n) | BigInt(lo)).toString() : String(hi * 4294967296 + lo);
  };
  Reader.prototype.u64 = function () {
    var lo = this.u32(), hi = this.u32();
    return typeof BigInt === "function" ? ((BigInt(hi) << 32n) | BigInt(lo)).toString() : String(hi * 4294967296 + lo);
  };
  Reader.prototype.f32 = function () { var p = this.pos; this.take(4); return this.view.getFloat32(p, true); };
  Reader.prototype.f64 = function () { var p = this.pos; this.take(8); return this.view.getFloat64(p, true); };
  Reader.prototype.string = function () {
    var n = 0, shift = 0, b;
    do {
      b = this.u8();
      n |= (b & 127) << shift;
      shift += 7;
      if (shift > 35) throw new Error("Invalid NRBF string length");
    } while (b & 128);
    return decodeUtf8(this.take(n));
  };
  Reader.prototype.utf8Char = function () {
    var first = this.u8(), n = first < 0x80 ? 1 : (first & 0xe0) === 0xc0 ? 2 :
      (first & 0xf0) === 0xe0 ? 3 : (first & 0xf8) === 0xf0 ? 4 : 0;
    if (!n) throw new Error("Invalid UTF-8 Char in NRBF stream");
    var a = new Uint8Array(n);
    a[0] = first;
    for (var i = 1; i < n; i++) a[i] = this.u8();
    return decodeUtf8(a);
  };

  function Writer() { this.bytes = []; }
  Writer.prototype.u8 = function (v) { this.bytes.push(Number(v) & 255); };
  Writer.prototype.i8 = function (v) { this.u8(v); };
  Writer.prototype.bool = function (v) { this.u8(v ? 1 : 0); };
  Writer.prototype.i16 = function (v) { this._num(2, "setInt16", v); };
  Writer.prototype.u16 = function (v) { this._num(2, "setUint16", v); };
  Writer.prototype.i32 = function (v) { this._num(4, "setInt32", v); };
  Writer.prototype.u32 = function (v) { this._num(4, "setUint32", v); };
  Writer.prototype.i64 = function (v) { this._big(v, true); };
  Writer.prototype.u64 = function (v) { this._big(v, false); };
  Writer.prototype._big = function (v, signed) {
    if (typeof BigInt === "function") {
      var x = BigInt(v), mask = 0xffffffffn;
      this.u32(Number(x & mask));
      this.u32(Number((x >> 32n) & mask));
    } else {
      var n = Number(v), hi = Math.floor(n / 4294967296), lo = n - hi * 4294967296;
      this.u32(lo); this.u32(hi);
    }
  };
  Writer.prototype.f32 = function (v) { this._num(4, "setFloat32", v); };
  Writer.prototype.f64 = function (v) { this._num(8, "setFloat64", v); };
  Writer.prototype._num = function (n, method, v) {
    var b = new ArrayBuffer(n), d = new DataView(b);
    d[method](0, v, true);
    this.raw(new Uint8Array(b));
  };
  Writer.prototype.raw = function (b) { for (var i = 0; i < b.length; i++) this.bytes.push(b[i]); };
  Writer.prototype.string = function (s) {
    var b = encodeUtf8(String(s)), n = b.length;
    while (n >= 128) { this.u8((n & 127) | 128); n >>>= 7; }
    this.u8(n); this.raw(b);
  };
  Writer.prototype.finish = function () { return new Uint8Array(this.bytes); };
  Writer.prototype.utf8Char = function (s) { this.raw(encodeUtf8(String(s))); };

  function decodeUtf8(bytes) {
    if (typeof TextDecoder !== "undefined") return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    var out = "";
    for (var i = 0; i < bytes.length;) {
      var c = bytes[i++], cp;
      if (c < 128) cp = c;
      else if ((c & 224) === 192) cp = ((c & 31) << 6) | (bytes[i++] & 63);
      else if ((c & 240) === 224) cp = ((c & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
      else cp = ((c & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
      if (cp <= 0xffff) out += String.fromCharCode(cp);
      else { cp -= 0x10000; out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023)); }
    }
    return out;
  }
  function encodeUtf8(s) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(s);
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        var d = s.charCodeAt(++i);
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
      }
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }

  function primitiveRead(r, pt) {
    switch (pt) {
      case PT.Boolean: return r.bool();
      case PT.Byte: return r.u8();
      case PT.Char: return r.utf8Char();
      case PT.Decimal: return r.string();
      case PT.Double: return r.f64();
      case PT.Int16: return r.i16();
      case PT.Int32: return r.i32();
      case PT.Int64: return r.i64();
      case PT.SByte: return r.i8();
      case PT.Single: return r.f32();
      case PT.TimeSpan: case PT.UInt64: return r.u64();
      case PT.DateTime: return r.i64();
      case PT.UInt16: return r.u16();
      case PT.UInt32: return r.u32();
      case PT.Null: return null;
      case PT.String: return r.string();
      default: throw new Error("Unsupported NRBF primitive type: " + pt);
    }
  }
  function primitiveWrite(w, pt, v) {
    switch (pt) {
      case PT.Boolean: w.bool(v); break;
      case PT.Byte: w.u8(v); break;
      case PT.Char: w.utf8Char(v); break;
      case PT.Decimal: w.string(v); break;
      case PT.Double: w.f64(v); break;
      case PT.Int16: w.i16(v); break;
      case PT.Int32: w.i32(v); break;
      case PT.Int64: case PT.TimeSpan: case PT.UInt64: case PT.DateTime: w.i64(v); break;
      case PT.SByte: w.i8(v); break;
      case PT.Single: w.f32(v); break;
      case PT.UInt16: w.u16(v); break;
      case PT.UInt32: w.u32(v); break;
      case PT.Null: break;
      case PT.String: w.string(v); break;
      default: throw new Error("Unsupported NRBF primitive type: " + pt);
    }
  }

  function parseNrbf(input) {
    var r = new Reader(input), doc = { records: [], libraries: {}, metadata: {}, objects: {}, rootId: 0, headerId: 0, majorVersion: 1, minorVersion: 0 };
    function readAdditional(bt) {
      if (bt === BT.Primitive || bt === BT.PrimitiveArray) return { primitiveType: r.u8() };
      if (bt === BT.SystemClass) return { className: r.string() };
      if (bt === BT.Class) return { className: r.string(), libraryId: r.i32() };
      return {};
    }
    function readValue(parent, top) {
      var x = parseRecord(parent, top);
      return x;
    }
    function parseRecord(parent, top) {
      var start = r.pos, rt = r.u8(), x, count, i;
      if (rt === REC.BinaryLibrary && !top) {
        x = { recordType: rt, libraryId: r.i32(), libraryName: r.string(), _parent: parent };
        x.rawRecord = r.bytes.slice(start, r.pos);
        doc.libraries[x.libraryId] = x.libraryName;
        var next = parseRecord(parent, false);
        if (!next._precedingLibs) next._precedingLibs = [];
        next._precedingLibs.unshift(x);
        return next;
      }
      x = { recordType: rt, _parent: parent || null };
      switch (rt) {
        case REC.SerializedStreamHeader:
          x.rootId = r.i32(); x.headerId = r.i32(); x.majorVersion = r.i32(); x.minorVersion = r.i32();
          doc.rootId = x.rootId; doc.headerId = x.headerId; doc.majorVersion = x.majorVersion; doc.minorVersion = x.minorVersion;
          break;
        case REC.BinaryLibrary:
          x.libraryId = r.i32(); x.libraryName = r.string(); doc.libraries[x.libraryId] = x.libraryName; break;
        case REC.BinaryObjectString:
          x.objectId = r.i32(); x.value = r.string(); doc.objects[x.objectId] = x; break;
        case REC.MemberReference: x.idRef = r.i32(); break;
        case REC.ObjectNull: break;
        case REC.ObjectNullMultiple256: x.nullCount = r.u8(); break;
        case REC.ObjectNullMultiple: x.nullCount = r.i32(); break;
        case REC.MessageEnd: break;
        case REC.MemberPrimitiveTyped:
          x.primitiveType = r.u8(); x.value = primitiveRead(r, x.primitiveType); break;
        case REC.ClassWithId:
          x.objectId = r.i32(); x.metadataId = r.i32();
          var meta = doc.metadata[x.metadataId];
          if (!meta) throw new Error("Missing NRBF class metadata " + x.metadataId);
          x.className = meta.className; x.members = meta.members.map(cloneMember);
          readClassValues(x, meta);
          doc.objects[x.objectId] = x; break;
        case REC.SystemClassWithMembers: case REC.ClassWithMembers:
          x.objectId = r.i32(); x.className = r.string(); count = r.i32();
          x.memberNames = readNames(count); x.members = x.memberNames.map(function (n) { return { name: n, binaryType: BT.Object, value: null }; });
          if (rt === REC.ClassWithMembers) x.libraryId = r.i32();
          doc.metadata[x.objectId] = { className: x.className, members: x.members.map(cloneMember), libraryId: x.libraryId };
          readClassValues(x, doc.metadata[x.objectId]); doc.objects[x.objectId] = x; break;
        case REC.SystemClassWithMembersAndTypes: case REC.ClassWithMembersAndTypes:
          x.objectId = r.i32(); x.className = r.string(); count = r.i32();
          x.memberNames = readNames(count);
          x.binaryTypes = [];
          for (i = 0; i < count; i++) x.binaryTypes.push(r.u8());
          x.additionalInfos = x.binaryTypes.map(readAdditional);
          x.members = x.memberNames.map(function (n, j) {
            return { name: n, binaryType: x.binaryTypes[j], additionalInfo: x.additionalInfos[j], value: null };
          });
          if (rt === REC.ClassWithMembersAndTypes) x.libraryId = r.i32();
          doc.metadata[x.objectId] = { className: x.className, members: x.members.map(cloneMember), libraryId: x.libraryId };
          readClassValues(x, doc.metadata[x.objectId]); doc.objects[x.objectId] = x; break;
        case REC.ArraySinglePrimitive:
          x.objectId = r.i32(); count = r.i32(); x.primitiveType = r.u8(); x.items = [];
          for (i = 0; i < count; i++) x.items.push({ recordType: REC.MemberPrimitiveTyped, primitiveType: x.primitiveType, value: primitiveRead(r, x.primitiveType), _parent: x, rawRecord: null });
          doc.objects[x.objectId] = x; break;
        case REC.ArraySingleObject: case REC.ArraySingleString:
          x.objectId = r.i32(); x.length = r.i32(); x.items = []; doc.objects[x.objectId] = x;
          while (x.items.length < x.length) {
            var item = readValue(x, false);
            if (item.recordType === REC.ObjectNullMultiple256 || item.recordType === REC.ObjectNullMultiple) {
              for (var z = 0; z < item.nullCount && x.items.length < x.length; z++)
                x.items.push({ recordType: REC.ObjectNull, _parent: x, rawRecord: null });
            } else x.items.push(item);
          }
          break;
        case REC.BinaryArray:
          x.objectId = r.i32(); x.binaryArrayType = r.u8(); x.rank = r.i32();
          x.lengths = []; for (i = 0; i < x.rank; i++) x.lengths.push(r.i32());
          if (x.binaryArrayType >= BAT.SingleOffset) {
            x.lowerBounds = []; for (i = 0; i < x.rank; i++) x.lowerBounds.push(r.i32());
          } else x.lowerBounds = [];
          x.elementType = r.u8(); x.additionalInfo = readAdditional(x.elementType);
          x.total = x.lengths.reduce(function (a, b) { return a * b; }, 1);
          x.items = []; doc.objects[x.objectId] = x;
          if (x.elementType === BT.Primitive) {
            for (i = 0; i < x.total; i++) x.items.push({ recordType: REC.MemberPrimitiveTyped, primitiveType: x.additionalInfo.primitiveType, value: primitiveRead(r, x.additionalInfo.primitiveType), _parent: x, rawRecord: null });
          } else {
            while (x.items.length < x.total) {
              item = readValue(x, false);
              if (item.recordType === REC.ObjectNullMultiple256 || item.recordType === REC.ObjectNullMultiple) {
                for (z = 0; z < item.nullCount && x.items.length < x.total; z++)
                  x.items.push({ recordType: REC.ObjectNull, _parent: x, rawRecord: null });
              } else x.items.push(item);
            }
          }
          break;
        default:
          throw new Error("Unsupported NRBF record type: " + rt);
      }
      x.rawRecord = r.bytes.slice(start, r.pos);
      return x;
    }
    function readNames(n) { var a = []; for (var j = 0; j < n; j++) a.push(r.string()); return a; }
    function readClassValues(x, meta) {
      for (var j = 0; j < x.members.length; j++) {
        var m = x.members[j], bt = m.binaryType;
        m.value = bt === BT.Primitive ? primitiveRead(r, m.additionalInfo.primitiveType) : readValue(x, false);
        m._parent = x;
      }
    }
    function cloneMember(m) {
      return { name: m.name, binaryType: m.binaryType, additionalInfo: m.additionalInfo, value: null };
    }
    while (r.pos < r.bytes.length) {
      var rec = parseRecord(null, true);
      doc.records.push(rec);
      if (rec.recordType === REC.MessageEnd) break;
    }
    doc.bytes = r.bytes;
    return doc;
  }

  function writeRec(w, x, doc) {
    if (x && x.rawRecord && !x._dirty) {
      (x._precedingLibs || []).forEach(function (lib) { writeRec(w, lib, doc); });
      w.raw(x.rawRecord);
      return;
    }
    if (!x) throw new Error("Missing NRBF record");
    (x._precedingLibs || []).forEach(function (lib) { writeRec(w, lib, doc); });
    var rt = x.recordType, i, m, total;
    w.u8(rt);
    switch (rt) {
      case REC.SerializedStreamHeader:
        w.i32(x.rootId); w.i32(x.headerId); w.i32(x.majorVersion); w.i32(x.minorVersion); break;
      case REC.BinaryLibrary: w.i32(x.libraryId); w.string(x.libraryName); break;
      case REC.BinaryObjectString: w.i32(x.objectId); w.string(x.value); break;
      case REC.MemberReference: w.i32(x.idRef); break;
      case REC.ObjectNull: case REC.MessageEnd: break;
      case REC.ObjectNullMultiple256: w.u8(x.nullCount); break;
      case REC.ObjectNullMultiple: w.i32(x.nullCount); break;
      case REC.MemberPrimitiveTyped: w.u8(x.primitiveType); primitiveWrite(w, x.primitiveType, x.value); break;
      case REC.ClassWithId:
        w.i32(x.objectId); w.i32(x.metadataId); writeClassValues(w, x, doc); break;
      case REC.SystemClassWithMembers: case REC.ClassWithMembers:
        w.i32(x.objectId); w.string(x.className); w.i32(x.members.length);
        x.members.forEach(function (v) { w.string(v.name); });
        if (rt === REC.ClassWithMembers) w.i32(x.libraryId);
        writeClassValues(w, x, doc); break;
      case REC.SystemClassWithMembersAndTypes: case REC.ClassWithMembersAndTypes:
        w.i32(x.objectId); w.string(x.className); w.i32(x.members.length);
        x.members.forEach(function (v) { w.string(v.name); });
        x.members.forEach(function (v) { w.u8(v.binaryType); });
        x.members.forEach(function (v) { writeAdditional(w, v.binaryType, v.additionalInfo || {}); });
        if (rt === REC.ClassWithMembersAndTypes) w.i32(x.libraryId);
        writeClassValues(w, x, doc); break;
      case REC.ArraySinglePrimitive:
        w.i32(x.objectId); w.i32(x.items.length); w.u8(x.primitiveType);
        x.items.forEach(function (v) { primitiveWrite(w, x.primitiveType, v.value); }); break;
      case REC.ArraySingleObject: case REC.ArraySingleString:
        w.i32(x.objectId); w.i32(x.items.length); writeArrayItems(w, x, x.items, doc); break;
      case REC.BinaryArray:
        w.i32(x.objectId); w.u8(x.binaryArrayType); w.i32(x.rank);
        x.lengths.forEach(function (v) { w.i32(v); });
        if (x.binaryArrayType >= BAT.SingleOffset) (x.lowerBounds || []).forEach(function (v) { w.i32(v); });
        w.u8(x.elementType); writeAdditional(w, x.elementType, x.additionalInfo || {});
        if (x.elementType === BT.Primitive) x.items.forEach(function (v) { primitiveWrite(w, x.additionalInfo.primitiveType, v.value); });
        else writeArrayItems(w, x, x.items, doc);
        break;
      default: throw new Error("Cannot serialize NRBF record type: " + rt);
    }
  }
  function writeClassValues(w, x, doc) {
    (x.members || []).forEach(function (m) {
      if (m.binaryType === BT.Primitive) primitiveWrite(w, m.additionalInfo.primitiveType, m.value);
      else writeRec(w, m.value, doc);
    });
  }
  function writeAdditional(w, bt, a) {
    if (bt === BT.Primitive || bt === BT.PrimitiveArray) w.u8(a.primitiveType);
    else if (bt === BT.SystemClass) w.string(a.className);
    else if (bt === BT.Class) { w.string(a.className); w.i32(a.libraryId); }
  }
  function writeArrayItems(w, x, items, doc) {
    for (var i = 0; i < items.length;) {
      var v = items[i];
      if (v && v.recordType === REC.ObjectNull && v.rawRecord == null) {
        var n = 1;
        while (i + n < items.length && items[i + n] && items[i + n].recordType === REC.ObjectNull && items[i + n].rawRecord == null) n++;
        if (n === 1) { w.u8(REC.ObjectNull); }
        else if (n <= 255) { w.u8(REC.ObjectNullMultiple256); w.u8(n); }
        else { w.u8(REC.ObjectNullMultiple); w.i32(n); }
        i += n;
      } else { writeRec(w, v, doc); i++; }
    }
  }
  function serializeNrbf(doc) {
    var w = new Writer();
    (doc.records || []).forEach(function (x) { writeRec(w, x, doc); });
    return w.finish();
  }

  function invalidate(rec) {
    if (!rec) return;
    rec._dirty = true; rec.rawRecord = null;
    if (rec._parent) invalidate(rec._parent);
  }
  function nextObjectId(doc) {
    if (doc._maxObjectId === undefined) {
      var max = 0;
      Object.keys(doc.objects || {}).forEach(function (k) { var n = Number(k); if (n > max) max = n; });
      (doc.records || []).forEach(function (x) { if (x.objectId > max) max = x.objectId; });
      doc._maxObjectId = max;
    }
    return ++doc._maxObjectId;
  }
  function resolveRef(doc, rec) {
    if (!rec) return rec;
    if (rec.recordType === REC.MemberReference) return doc.objects[rec.idRef] || rec;
    return rec;
  }
  function getClassMeta(doc, rec) {
    if (!rec) return null;
    return doc.metadata[rec.metadataId] || { className: rec.className, members: rec.members || [], libraryId: rec.libraryId };
  }
  function getMemberNames(doc, rec) {
    return (rec && rec.members ? rec.members : []).map(function (m) { return m.name; });
  }
  function getObjFields(doc, rec) {
    var out = {};
    (rec && rec.members || []).forEach(function (m) { out[m.name] = getFieldJs(doc, rec, m.name); });
    return out;
  }
  function getFieldJs(doc, rec, name) {
    var m = (rec && rec.members || []).find(function (v) { return v.name === name; });
    if (!m) return undefined;
    var v = m.value;
    if (v && v.recordType === REC.MemberReference) v = resolveRef(doc, v);
    if (!v) return v;
    if (v.recordType === REC.ObjectNull) return null;
    if (v.recordType === REC.BinaryObjectString || v.recordType === REC.MemberPrimitiveTyped) return v.value;
    return v.value !== undefined ? v.value : v;
  }
  function setFieldJs(doc, rec, name, jsVal) {
    var member = (rec.members || []).find(function (m) { return m.name === name; });
    if (!member) throw new Error("Unknown NRBF member: " + name);
    var cur = getFieldJs(doc, rec, name);
    if (cur === jsVal && (jsVal !== null || (member.value && member.value.recordType === REC.ObjectNull))) return member.value;
    if (member.binaryType === BT.Primitive) {
      member.value = jsVal;
    } else if (jsVal == null) {
      member.value = { recordType: REC.ObjectNull, _parent: rec, rawRecord: null };
    } else if (typeof jsVal === "string") {
      var str = { recordType: REC.BinaryObjectString, objectId: nextObjectId(doc), value: jsVal, _parent: null, rawRecord: null };
      insertRecordBeforeEnd(doc, str);
      member.value = { recordType: REC.MemberReference, idRef: str.objectId, _parent: rec, rawRecord: null };
    } else {
      if (!member.value || typeof member.value !== "object") member.value = { value: jsVal };
      member.value.value = jsVal;
      member.value.raw = null;
      member.value._origValue = undefined;
    }
    invalidate(rec);
    return member.value;
  }

  function getMemberRaw(doc, rec, name) {
    if (typeof doc !== "object" || (doc.recordType !== undefined && !doc.records)) {
      name = rec;
      rec = doc;
      doc = null;
    }
    if (doc) rec = resolveRef(doc, rec);
    if (!rec || !rec.members) return null;
    return rec.members.find(function (m) { return m.name === name; }) || null;
  }

  function isListRecord(doc, rec) {
    rec = resolveRef(doc, rec);
    if (!rec || !rec.members) return false;
    return rec.members.some(function (m) { return m.name === "_items"; }) &&
           rec.members.some(function (m) { return m.name === "_size"; });
  }

  function listGetItems(doc, rec) {
    rec = resolveRef(doc, rec);
    if (!rec) return [];
    if (isListRecord(doc, rec)) {
      var itemsMem = getMemberRaw(doc, rec, "_items");
      if (!itemsMem) return [];
      var arrRec = resolveRef(doc, itemsMem.value);
      if (!arrRec || !Array.isArray(arrRec.items)) return [];
      var n = getFieldJs(doc, rec, "_size");
      if (typeof n === "number" && n >= 0 && n <= arrRec.items.length) {
        return arrRec.items.slice(0, n);
      }
      return arrRec.items;
    }
    return rec && Array.isArray(rec.items) ? rec.items : [];
  }

  function listAddItem(doc, rec, value) {
    rec = resolveRef(doc, rec);
    if (!rec) return undefined;
    if (isListRecord(doc, rec)) {
      var itemsMem = getMemberRaw(doc, rec, "_items");
      var sizeMem = getMemberRaw(doc, rec, "_size");
      if (!itemsMem) return undefined;
      var arrRec = resolveRef(doc, itemsMem.value);
      var size = getFieldJs(doc, rec, "_size");
      if (typeof size !== "number" || !arrRec || !arrRec.items) {
        size = arrRec && Array.isArray(arrRec.items) ? arrRec.items.length : 0;
      }
      if (!arrRec || !arrRec.items) {
        arrRec = {
          recordType: REC.ArraySingleObject,
          objectId: nextObjectId(doc),
          length: 0,
          items: [],
          _parent: rec,
          rawRecord: null
        };
        doc.objects[arrRec.objectId] = arrRec;
        insertRecordBeforeEnd(doc, arrRec);
        itemsMem.value = { recordType: REC.MemberReference, idRef: arrRec.objectId, _parent: rec, rawRecord: null };
      }
      var v = value && typeof value === "object" && value.recordType != null ? value :
        typeof value === "string" ? { recordType: REC.BinaryObjectString, objectId: nextObjectId(doc), value: value, rawRecord: null } :
        { recordType: REC.MemberPrimitiveTyped, primitiveType: inferPrimitive(value), value: value, rawRecord: null };
      if (v.objectId != null && !doc.objects[v.objectId]) {
        doc.objects[v.objectId] = v;
        insertRecordBeforeEnd(doc, v);
      }
      var itemNode = (v.objectId != null ? { recordType: REC.MemberReference, idRef: v.objectId, _parent: arrRec, rawRecord: null } : v);
      arrRec.items[size] = itemNode;
      if (arrRec.length !== undefined) arrRec.length = Math.max(arrRec.length, arrRec.items.length);
      var newSize = size + 1;
      if (sizeMem) {
        setFieldJs(doc, rec, "_size", newSize);
      }
      var verMem = getMemberRaw(doc, rec, "_version");
      if (verMem) {
        var ver = getFieldJs(doc, rec, "_version");
        setFieldJs(doc, rec, "_version", (typeof ver === "number" ? ver + 1 : 1));
      }
      invalidate(rec);
      return v;
    }
    if (!rec.items) rec.items = [];
    var v = value && typeof value === "object" && value.recordType != null ? value :
      typeof value === "string" ? { recordType: REC.BinaryObjectString, objectId: nextObjectId(doc), value: value, rawRecord: null } :
      { recordType: REC.MemberPrimitiveTyped, primitiveType: inferPrimitive(value), value: value, rawRecord: null };
    v._parent = rec; rec.items.push(v);
    if (rec.length !== undefined) rec.length = rec.items.length;
    invalidate(rec);
    return v;
  }

  function listRemoveAt(doc, rec, index) {
    rec = resolveRef(doc, rec);
    if (!rec) return undefined;
    if (isListRecord(doc, rec)) {
      var itemsMem = getMemberRaw(doc, rec, "_items");
      var sizeMem = getMemberRaw(doc, rec, "_size");
      if (!itemsMem) return undefined;
      var arrRec = resolveRef(doc, itemsMem.value);
      if (!arrRec || !arrRec.items) return undefined;
      var size = getFieldJs(doc, rec, "_size");
      if (typeof size !== "number") size = arrRec.items.length;
      if (index < 0 || index >= size) return undefined;
      var removed = arrRec.items.splice(index, 1)[0];
      arrRec.items.push({ recordType: REC.ObjectNull, _parent: arrRec, rawRecord: null });
      var newSize = size - 1;
      if (sizeMem) {
        setFieldJs(doc, rec, "_size", newSize);
      }
      var verMem = getMemberRaw(doc, rec, "_version");
      if (verMem) {
        var ver = getFieldJs(doc, rec, "_version");
        setFieldJs(doc, rec, "_version", (typeof ver === "number" ? ver + 1 : 1));
      }
      invalidate(rec);
      return removed;
    }
    if (!rec.items) return undefined;
    var v = rec.items.splice(index, 1)[0];
    if (rec.length !== undefined) rec.length = rec.items.length;
    invalidate(rec);
    return v;
  }

  function insertRecordBeforeEnd(doc, rec) {
    rec.rawRecord = null;
    if (rec.objectId != null) doc.objects[rec.objectId] = rec;
    var i = (doc.records || []).findIndex(function (x) { return x.recordType === REC.MessageEnd; });
    if (i < 0) doc.records.push(rec); else doc.records.splice(i, 0, rec);
    return rec;
  }

  function findLibraryId(doc, name) {
    var keys = Object.keys(doc.libraries || {});
    for (var i = 0; i < keys.length; i++) {
      if (String(doc.libraries[keys[i]] || "").indexOf(name) === 0) return Number(keys[i]);
    }
    return undefined;
  }

  function findMetadataId(doc, className) {
    var keys = Object.keys(doc.metadata || {});
    for (var i = 0; i < keys.length; i++) if (doc.metadata[keys[i]].className === className) return Number(keys[i]);
    return undefined;
  }

  function createClassInstance(doc, metadataId, objectId, libraryId) {
    var meta = doc.metadata[metadataId];
    if (!meta) throw new Error("Missing metadata for id " + metadataId);
    if (objectId == null) objectId = nextObjectId(doc);
    if (libraryId == null) libraryId = meta.libraryId;
    var members = (meta.members || []).map(function (m) {
      var val = null;
      if (m.binaryType === BT.Primitive) {
        var pt = m.additionalInfo && m.additionalInfo.primitiveType;
        if (pt === PT.Boolean) val = false;
        else if (pt === PT.String) val = "";
        else if (pt === PT.Null) val = null;
        else val = 0;
      } else {
        val = { recordType: REC.ObjectNull, rawRecord: null };
      }
      return {
        name: m.name,
        binaryType: m.binaryType,
        additionalInfo: m.additionalInfo,
        value: val
      };
    });
    var rec = {
      recordType: REC.ClassWithMembersAndTypes,
      objectId: objectId,
      className: meta.className,
      memberNames: members.map(function (m) { return m.name; }),
      binaryTypes: members.map(function (m) { return m.binaryType; }),
      additionalInfos: members.map(function (m) { return m.additionalInfo; }),
      members: members,
      libraryId: libraryId,
      _parent: null,
      rawRecord: null
    };
    doc.objects[objectId] = rec;
    insertRecordBeforeEnd(doc, rec);
    return rec;
  }

  function dictGetEntries(doc, rec) {
    rec = resolveRef(doc, rec);
    if (!rec) return [];
    var fields = getObjFields(doc, rec), keys = fields.keys || fields._keys || [], values = fields.values || fields._values || [];
    if (keys && keys.items) keys = keys.items;
    if (values && values.items) values = values.items;
    var out = [];
    for (var i = 0; i < Math.min(keys.length || 0, values.length || 0); i++) {
      out.push([valueOf(doc, keys[i]), valueOf(doc, values[i])]);
    }
    return out;
  }
  function valueOf(doc, v) {
    v = resolveRef(doc, v);
    if (!v) return v;
    if (v.recordType === REC.ObjectNull) return null;
    return v.value !== undefined ? v.value : v;
  }
  function inferPrimitive(v) {
    if (typeof v === "boolean") return PT.Boolean;
    if (typeof v === "number") return Number.isInteger(v) ? PT.Int32 : PT.Double;
    if (typeof v === "string") return PT.String;
    return PT.Object;
  }

  return {
    REC: REC, BT: BT, PT: PT, BAT: BAT,
    parseNrbf: parseNrbf, serializeNrbf: serializeNrbf,
    nextObjectId: nextObjectId, resolveRef: resolveRef, getClassMeta: getClassMeta,
    getMemberNames: getMemberNames, getObjFields: getObjFields, getFieldJs: getFieldJs,
    setFieldJs: setFieldJs, listGetItems: listGetItems, listAddItem: listAddItem,
    listRemoveAt: listRemoveAt, insertRecordBeforeEnd: insertRecordBeforeEnd,
    findLibraryId: findLibraryId, findMetadataId: findMetadataId,
    dictGetEntries: dictGetEntries, getMemberRaw: getMemberRaw, createClassInstance: createClassInstance
  };
});
