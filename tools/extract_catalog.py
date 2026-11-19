from __future__ import annotations

import argparse
import ast
import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any

DEFAULT_SOURCE = Path("/home/jiyoung/workspace/무협위키/.local/graph/jianghu-chronicles-data")
OUTPUT = Path(__file__).resolve().parent.parent / "src/catalog-data.js"
KEYS = (
    "items", "weapons", "weaponCategories", "weaponAttrs", "skills",
    "kidneys", "titles", "jobs", "schools", "facilities", "futures",
    "dateYears", "attrLevels", "honorLevels", "formulas",
)
RESIDUAL_MAP = {
    "一品阁": "일품각", "无名": "무명", "未知": "알 수 없음", "通用": "공용",
    "全部": "전체", "略微": "소폭", "短刀": "단도", "短剑": "단검",
    "年": "년", "月": "월", "日": "일", "人": "인", "中立": "중립",
    "正派": "정파", "邪派": "사파", "无": "없음",
}
CJK_RE = re.compile(r"[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF]")
TAG_RE = re.compile(r"</?(?:color|b|i|size|align)\b[^>]*>", re.I)
URL_RE = re.compile(r"https?://\S+", re.I)
WS_RE = re.compile(r"\s+")


def read_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        if default is not None:
            return default
        raise


def rows(path: Path) -> list[dict[str, Any]]:
    data = read_json(path, [])
    if isinstance(data, list):
        return [r for r in data if isinstance(r, dict)]
    if isinstance(data, dict):
        for key in ("data", "rows", "list", "config", "items"):
            if isinstance(data.get(key), list):
                return [r for r in data[key] if isinstance(r, dict)]
        return [r for r in data.values() if isinstance(r, dict)]
    return []


def norm_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


def get(row: dict[str, Any], *names: str, default: Any = "") -> Any:
    indexed = {norm_key(str(k)): v for k, v in row.items()}
    for name in names:
        key = norm_key(name)
        if key in indexed:
            return indexed[key]
    return default


def parse_list(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if not isinstance(value, str) or not value.strip():
        return []
    for parser in (json.loads, ast.literal_eval):
        try:
            result = parser(value)
            if isinstance(result, list):
                return result
        except (ValueError, SyntaxError, json.JSONDecodeError):
            pass
    return []


def integer(value: Any) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError, OverflowError):
        return 0


def number(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError, OverflowError):
        return 0.0


def boolean(value: Any) -> bool:
    return value is True or str(value).strip().lower() in {"1", "true", "yes"}


class Translator:
    def __init__(self, source: Path):
        lookup = read_json(source / "parsed/ko_lookup.json", {})
        self.by_table = lookup.get("by_table", {}) if isinstance(lookup, dict) else {}
        self.by_src = lookup.get("by_src", {}) if isinstance(lookup, dict) else {}
        extra = read_json(source / "parsed/extra_ko_dict.json", {})
        self.extra = extra if isinstance(extra, dict) else {}

    def tr(
        self, table: str, rid: Any, field: str, raw_val: Any,
        default: str = "", fallback_prefix: str = "미번역",
    ) -> str:
        if raw_val is None or raw_val == "" or raw_val == "None":
            return default
        src = str(raw_val)
        translated = (
            self.by_table.get(f"{table}\x1f{rid}\x1f{field}")
            or self.by_src.get(src)
            or self.extra.get(src)
            or src
        )
        result = str(translated)
        for term, replacement in RESIDUAL_MAP.items():
            result = result.replace(term, replacement)
        result = WS_RE.sub(" ", URL_RE.sub("", TAG_RE.sub("", result))).strip()
        if CJK_RE.search(result):
            result = default or f"{fallback_prefix} {rid}"
        return result


def field(
    tr: Translator, table: str, row: dict[str, Any], rid: Any,
    output: str, *aliases: str, default: Any = "",
) -> str:
    return tr.tr(table, rid, output, get(row, *aliases, default=default))


def load_table(source: Path, filename: str) -> list[dict[str, Any]]:
    return rows(source / "raw/json_config_extracted" / filename)


def build_catalog(source: Path) -> dict[str, Any]:
    tr = Translator(source)

    def table(filename: str) -> list[dict[str, Any]]:
        return load_table(source, filename)

    categories = table("weapon_category_data.json")
    category_names = {
        str(get(r, "id", "categoryId")): field(
            tr, "weapon_category_data", r, get(r, "id", "categoryId"),
            "name", "name", "categoryName",
        )
        for r in categories
    }

    skill_details: dict[str, dict[str, Any]] = {}
    for filename in ("skill_wg_data.json", "skill_ng_data.json", "skill_xf_data.json"):
        for row in table(filename):
            key = str(get(row, "actionId", "id"))
            skill_details.setdefault(key, {}).update(row)

    result: dict[str, Any] = {}

    source_table = "drop_item_data"
    result["items"] = []
    for r in table(source_table + ".json"):
        rid = get(r, "id", "itemId")
        result["items"].append({
            "id": rid, "name": field(tr, source_table, r, rid, "name", "name"),
            "type": integer(get(r, "type")), "subType": integer(get(r, "subType")),
            "typeDesc": field(tr, source_table, r, rid, "typeDesc", "typeDesc", "typeName"),
            "level": integer(get(r, "level")), "price": integer(get(r, "price")),
            "desc": field(tr, source_table, r, rid, "desc", "desc", "description"),
        })

    source_table = "weapon_data"
    result["weapons"] = []
    for r in table(source_table + ".json"):
        rid = get(r, "id", "weaponId")
        category = get(r, "categoryId", "weaponCategoryId")
        result["weapons"].append({
            "id": rid, "name": field(tr, source_table, r, rid, "name", "name"),
            "categoryId": category,
            "categoryName": category_names.get(str(category), ""),
            "level": integer(get(r, "level")),
            "damageRate": number(get(r, "damageRate")),
            "damageType": field(tr, source_table, r, rid, "damageType", "damageType"),
            "costTenacity": integer(get(r, "costTenacity")),
        })

    result["weaponCategories"] = [{
        "id": rid, "name": field(tr, "weapon_category_data", r, rid, "name", "name"),
        "feature": field(tr, "weapon_category_data", r, rid, "feature", "feature"),
    } for r in categories for rid in [get(r, "id", "categoryId")]]

    result["weaponAttrs"] = []
    for r in table("weapon_upgrade_attr_data.json"):
        rid = get(r, "id")
        result["weaponAttrs"].append({
            "id": rid, "attrKey": field(tr, "weapon_upgrade_attr_data", r, rid, "attrKey", "attrKey", "key"),
            "level": integer(get(r, "level")), "type": integer(get(r, "type")),
            "vals": parse_list(get(r, "vals")),
            "textStr": field(tr, "weapon_upgrade_attr_data", r, rid, "textStr", "textStr"),
            "desc": field(tr, "weapon_upgrade_attr_data", r, rid, "desc", "desc", "description"),
        })

    result["skills"] = []
    for r in table("drop_skill_data.json"):
        rid = get(r, "id", "skillId")
        detail = skill_details.get(str(get(r, "actionId", "id")), {})
        result["skills"].append({
            "id": rid, "name": field(tr, "drop_skill_data", r, rid, "name", "name"),
            "isOutPower": boolean(get(r, "isOutPower")),
            "weaponType": integer(get(r, "weaponType")),
            "weaponTypeName": field(tr, "drop_skill_data", r, rid, "weaponTypeName", "weaponTypeName"),
            "level": integer(get(r, "level")),
            "maxLevel": integer(get(r, "maxLevel")),
            "forceCoefficient": number(get(detail, "forceCoefficient", "forceRate")),
            "desc": field(tr, "drop_skill_data", r, rid, "desc", "desc", "description"),
        })

    specs = (
        ("kidneys", "character_kidney_data", "character_kidney_data.json",
         ("key", ("key",)), ("levelValue", ("levelValue",)), ("showType", ("showType",)),
         ("comment", ("comment",)), ("desc", ("desc", "description"))),
        ("titles", "student_title_data", "student_title_data.json",
         ("titleType", ("titleType",)), ("content", ("content",)), ("attrDesc", ("attrDesc",))),
        ("jobs", "student_job_data", "student_job_data.json",
         ("type", ("type",)), ("hvRate", ("hvRate",))),
        ("schools", "school_data", "school_data.json",
         ("schoolLevel", ("schoolLevel",)), ("standPoint", ("standPoint",)),
         ("goodEvilValue", ("goodEvilValue",)), ("cost", ("cost",))),
        ("facilities", "facility_data", "facility_data.json",
         ("type", ("type",)), ("maxLevel", ("maxLevel",))),
        ("futures", "futures_price_data", "futures_price_data.json",
         ("type", ("type",)), ("minRate", ("minRate",)), ("maxRate", ("maxRate",)),
         ("monthRate", ("monthRate",))),
        ("dateYears", "date_year_data", "date_year_data.json",
         ("index", ("index",)), ("yearCount", ("yearCount",))),
        ("attrLevels", "student_attr_level_data", "student_attr_level_data.json",
         ("levelRange", ("levelRange",)), ("attrRange", ("attrRange",))),
        ("honorLevels", "school_honor_level_data", "school_honor_level_data.json",
         ("level", ("level",)), ("range1", ("range1",)), ("applyVal", ("applyVal",))),
    )
    for key, table_name, filename, *attrs in specs:
        result[key] = []
        for r in table(filename):
            rid = get(r, "id")
            item: dict[str, Any] = {
                "id": rid,
                "name": field(tr, table_name, r, rid, "name", "name"),
            }
            for name, aliases in attrs:
                raw = get(r, *aliases)
                if name in {"levelRange", "attrRange", "range1"}:
                    item[name] = parse_list(raw)
                elif name in {"minRate", "maxRate", "monthRate"}:
                    item[name] = number(raw)
                elif name in {"key", "comment", "desc", "content", "attrDesc"}:
                    item[name] = field(tr, table_name, r, rid, name, *aliases)
                else:
                    item[name] = integer(raw)
            result[key].append(item)

    result["formulas"] = {
        "vitToHpRate": 417.0, "attrToAtkRate": 11.4, "dzPointRate": 200.0,
        "studentForceCoefficient": 0.5, "requiredSuccessChance": 20,
        "extraSuccessChance": 10, "powerSuccessChance": 20,
    }
    return result


def render(catalog: dict[str, Any]) -> str:
    payload = json.dumps(catalog, ensure_ascii=False, separators=(",", ":"))
    payload = payload.replace("</script", "<\\/script")
    return (
        "(function(root,factory){if(typeof module==='object'&&module.exports)"
        "module.exports=factory();else root.JhlCatalog=factory();})"
        "(typeof globalThis!=='undefined'?globalThis:this,function(){"
        f"return {payload};"
        "});\n"
    )


def valid_output(content: str) -> bool:
    if not content or "JhlCatalog" not in content or "module.exports" not in content:
        return False
    if any(pattern.search(content) for pattern in (CJK_RE, TAG_RE, URL_RE)):
        return False
    try:
        start = content.index("return ") + len("return ")
        end = content.rindex(";});")
        catalog = json.loads(content[start:end])
    except (ValueError, json.JSONDecodeError):
        return False
    return (
        isinstance(catalog, dict)
        and all(key in catalog and bool(catalog[key]) for key in KEYS)
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-dir", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    parser.add_argument("--check-only", action="store_true")
    args = parser.parse_args()

    if args.check_only:
        try:
            return 0 if valid_output(args.output.read_text(encoding="utf-8")) else 1
        except OSError:
            return 1

    content = render(build_catalog(args.source_dir))
    if not valid_output(content):
        return 1
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temp_name = ""
    try:
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=args.output.parent, delete=False
        ) as temp:
            temp.write(content)
            temp_name = temp.name
        os.replace(temp_name, args.output)
    finally:
        if temp_name and os.path.exists(temp_name):
            os.unlink(temp_name)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())