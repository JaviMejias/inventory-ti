"""Read sparse XLSX cells into the preview envelope; never save or recalculate Excel."""

import argparse
import hashlib
import io
import json
import posixpath
import re
import sys
import xml.etree.ElementTree as ET
from datetime import date, datetime
from pathlib import Path
from zipfile import BadZipFile, ZipFile

from openpyxl.styles.numbers import BUILTIN_FORMATS, is_date_format
from openpyxl.utils.datetime import CALENDAR_MAC_1904, CALENDAR_WINDOWS_1900, from_excel

NS = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
MAX_BYTES = 64 * 1024 * 1024
MAX_CELLS = 150000
MAX_ROWS = 15000


def read_xml(archive, name):
    content = archive.read(name)
    # Do not permit entity expansion or external declarations in an input file.
    declaration_content = content.replace(b"\x00", b"")
    if b"<!DOCTYPE" in declaration_content or b"<!ENTITY" in declaration_content:
        raise ValueError("XML declarations are not supported")
    return ET.fromstring(content)


def text_content(element):
    inline = element.find("s:is", NS)
    container = inline if inline is not None else element
    values = []
    for child in container:
        if child.tag == "{" + NS["s"] + "}t":
            values.append(child.text or "")
        elif child.tag == "{" + NS["s"] + "}r":
            text = child.find("s:t", NS)
            values.append(text.text or "" if text is not None else "")
    return "".join(values)


def extract(path):
    path = Path(path)
    if path.suffix.lower() != ".xlsx" or path.stat().st_size > MAX_BYTES:
        raise ValueError("Expected an XLSX file no larger than 64 MiB")
    with path.open("rb") as source:
        content = source.read(MAX_BYTES + 1)
    if len(content) > MAX_BYTES:
        raise ValueError("Workbook exceeds 64 MiB")
    source_hash = hashlib.sha256(content).hexdigest()
    sheets = []
    cell_count = 0
    row_count = 0
    # Hash and decode the same bounded byte snapshot, even if the path changes later.
    with ZipFile(io.BytesIO(content)) as archive:
        entries = archive.infolist()
        if len(entries) > 4096 or sum(item.file_size for item in entries) > MAX_BYTES:
            raise ValueError("Expanded workbook exceeds the extraction limit")
        if len({item.filename for item in entries}) != len(entries):
            raise ValueError("Duplicate ZIP entries are not supported")
        workbook = read_xml(archive, "xl/workbook.xml")
        relationships = read_xml(archive, "xl/_rels/workbook.xml.rels")
        targets = {}
        for rel in relationships:
            if rel.get("TargetMode") == "External":
                continue
            target = rel.get("Target", "")
            targets[rel.get("Id")] = posixpath.normpath(
                target.lstrip("/") if target.startswith("/") else posixpath.join("xl", target)
            )
        properties = workbook.find("s:workbookPr", NS)
        epoch = CALENDAR_MAC_1904 if properties is not None and properties.get("date1904") in ("1", "true") else CALENDAR_WINDOWS_1900
        strings = []
        if "xl/sharedStrings.xml" in archive.namelist():
            strings = [text_content(item) for item in read_xml(archive, "xl/sharedStrings.xml")]
        formats = []
        if "xl/styles.xml" in archive.namelist():
            styles = read_xml(archive, "xl/styles.xml")
            custom = {int(item.get("numFmtId")): item.get("formatCode", "") for item in styles.findall("s:numFmts/s:numFmt", NS)}
            formats = [custom.get(int(item.get("numFmtId", "0")), BUILTIN_FORMATS.get(int(item.get("numFmtId", "0")), "General")) for item in styles.findall("s:cellXfs/s:xf", NS)]
        nodes = workbook.findall("s:sheets/s:sheet", NS)
        if not 1 <= len(nodes) <= 32:
            raise ValueError("Expected 1 to 32 worksheets")
        for sheet in nodes:
            target = targets.get(sheet.get("{" + REL + "}id"))
            if target is None or not target.startswith("xl/"):
                raise ValueError("Unsupported worksheet relationship")
            root = read_xml(archive, target)
            rows = []
            for row in root.findall("s:sheetData/s:row", NS):
                cells = {}
                row_number = int(row.get("r", "0"))
                for cell in row.findall("s:c", NS):
                    address = cell.get("r", "")
                    match = re.fullmatch(r"([A-Z]{1,3})([1-9][0-9]*)", address)
                    if not match or int(match[2]) != row_number:
                        raise ValueError("Invalid cell address")
                    column = match[1]
                    formula = cell.find("s:f", NS)
                    value_node = cell.find("s:v", NS)
                    raw = value_node.text if value_node is not None else None
                    kind = cell.get("t", "n")
                    style = int(cell.get("s", "0"))
                    number_format = formats[style] if style < len(formats) else "General"
                    if kind == "inlineStr":
                        value = text_content(cell)
                    elif raw is None:
                        value = None
                    elif kind == "s":
                        value = strings[int(raw)]
                    elif kind == "b":
                        value = raw == "1"
                    elif kind in ("str", "e", "d"):
                        value = raw
                    else:
                        numeric = float(raw)
                        value = int(numeric) if numeric.is_integer() else numeric
                        if is_date_format(number_format):
                            try:
                                converted = from_excel(numeric, epoch)
                                if isinstance(converted, (date, datetime)):
                                    value = converted.isoformat()
                                    kind = "d"
                            except (ValueError, OverflowError):
                                pass
                    if formula is None and (value is None or value == ""):
                        continue
                    output_kind = "formula" if formula is not None else "date" if kind == "d" else "error" if kind == "e" else "boolean" if isinstance(value, bool) else "number" if isinstance(value, (int, float)) else "text"
                    entry = {"type": output_kind, "value": "=" + (formula.text or "") if formula is not None else value, "numberFormat": number_format}
                    if raw is not None:
                        entry["rawValue"] = raw
                    if formula is not None:
                        entry["cachedValue"] = value
                        entry["formulaAttributes"] = dict(formula.attrib)
                    cells[column] = entry
                    cell_count += 1
                    if cell_count > MAX_CELLS:
                        raise ValueError("Workbook exceeds 150000 populated cells")
                if cells:
                    rows.append({"row": row_number, "hidden": row.get("hidden") in ("1", "true"), "cells": cells})
                    row_count += 1
                    if row_count > MAX_ROWS:
                        raise ValueError("Workbook exceeds 15000 populated rows")
            auto_filter = root.find("s:autoFilter", NS)
            sheets.append({"name": sheet.get("name"), "hidden": sheet.get("state", "visible") != "visible", "filterRange": auto_filter.get("ref") if auto_filter is not None else None, "rows": rows})
    return {"formatVersion": 1, "source": {"fileName": path.name, "sha256": source_hash}, "sheets": sheets}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workbook")
    parser.add_argument("--output", help="Create a new JSON file exclusively; default stdout")
    parser.add_argument("--summary", action="store_true", help="Print only worksheet/header statistics")
    args = parser.parse_args()
    data = extract(args.workbook)
    if args.summary:
        data = [{"sheet": sheet["name"], "populatedRows": len(sheet["rows"]), "headers": [{"row": row["row"], "values": {column: cell["value"] for column, cell in row["cells"].items()}} for row in sheet["rows"] if row["row"] <= 5]} for sheet in data["sheets"]]
    serialized = json.dumps(data, ensure_ascii=False, allow_nan=False)
    if args.output:
        with open(args.output, "x", encoding="utf-8") as output:
            output.write(serialized)
    else:
        sys.stdout.reconfigure(encoding="utf-8")
        print(serialized)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, IndexError, ET.ParseError, BadZipFile, RuntimeError):
        sys.exit("Extraction failed. Check the XLSX structure, limits and output path. The source workbook was not modified.")
