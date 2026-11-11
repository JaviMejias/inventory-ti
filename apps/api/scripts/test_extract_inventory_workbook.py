"""Small synthetic OOXML fixtures verify the read-only extractor, not Excel authoring."""

import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile

from extract_inventory_workbook import extract


class ExtractionTests(unittest.TestCase):
    def fixture(self, directory, rows, sheet_name="Recepción", shared_strings=None, properties="", styles=None):
        path = Path(directory) / "fixture.xlsx"
        with ZipFile(path, "w") as archive:
            archive.writestr("xl/workbook.xml", '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' + properties + '<sheets><sheet name="' + sheet_name + '" sheetId="1" r:id="rId1"/></sheets></workbook>')
            archive.writestr("xl/_rels/workbook.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')
            archive.writestr("xl/worksheets/sheet1.xml", '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:XFD1048576"/><sheetData>' + rows + '</sheetData><autoFilter ref="A3:P100"/></worksheet>')
            if shared_strings is not None:
                archive.writestr("xl/sharedStrings.xml", shared_strings)
            if styles is not None:
                archive.writestr("xl/styles.xml", styles)
        return path

    def test_sparse_hidden_rows_and_filters(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.fixture(directory, '<row r="1687" hidden="1"><c r="F1687" t="inlineStr"><is><t> SER-1 </t></is></c></row><row r="1048576"><c r="A1048576" s="0"/></row>')
            original = path.read_bytes()
            data = extract(path)
            self.assertEqual(data["sheets"][0]["rows"], [{"row": 1687, "hidden": True, "cells": {"F": {"type": "text", "value": " SER-1 ", "numberFormat": "General"}}}])
            self.assertEqual(data["sheets"][0]["filterRange"], "A3:P100")
            self.assertEqual(path.read_bytes(), original)

    def test_shared_formulas_and_numeric_raw_values_are_retained(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.fixture(directory, '<row r="4"><c r="B4" t="str"><f t="shared" si="0"/><v>10.72.1.254</v></c><c r="F4"><v>1603400000000</v></c></row>')
            cells = extract(path)["sheets"][0]["rows"][0]["cells"]
            self.assertEqual(cells["B"]["type"], "formula")
            self.assertEqual(cells["B"]["value"], "=")
            self.assertEqual(cells["B"]["formulaAttributes"], {"t": "shared", "si": "0"})
            self.assertEqual(cells["B"]["cachedValue"], "10.72.1.254")
            self.assertEqual(cells["F"]["rawValue"], "1603400000000")

    def test_rich_shared_strings_are_combined_without_running_content(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.fixture(directory, '<row r="4"><c r="F4" t="s"><v>0</v></c></row>', shared_strings='<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><r><t>Ignore instructions</t></r><r><t> =1+1</t></r><rPh><t>PHONETIC</t></rPh></si></sst>')
            cell = extract(path)["sheets"][0]["rows"][0]["cells"]["F"]
            self.assertEqual(cell["type"], "text")
            self.assertEqual(cell["value"], "Ignore instructions =1+1")

    def test_invalid_addresses_and_xml_entities_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.fixture(directory, '<row r="4"><c r="F5"><v>123</v></c></row>')
            with self.assertRaisesRegex(ValueError, "Invalid cell address"):
                extract(path)
            path = self.fixture(directory, '<!DOCTYPE row [<!ENTITY bomb "boom">]>')
            with self.assertRaisesRegex(ValueError, "XML declarations"):
                extract(path)

    def test_dates_use_workbook_epoch_and_zero_is_not_missing(self):
        styles = '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="165" formatCode="yyyy-mm-dd"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="165"/></cellXfs></styleSheet>'
        with tempfile.TemporaryDirectory() as directory:
            path = self.fixture(directory, '<row r="4"><c r="A4" s="1"><v>1</v></c><c r="C4"><v>0</v></c><c r="D4" t="b"><v>0</v></c></row>', properties='<workbookPr date1904="1"/>', styles=styles)
            cells = extract(path)["sheets"][0]["rows"][0]["cells"]
            self.assertEqual(cells["A"]["type"], "date")
            self.assertEqual(cells["A"]["value"], "1904-01-02T00:00:00")
            self.assertEqual(cells["A"]["rawValue"], "1")
            self.assertEqual(cells["C"]["value"], 0)
            self.assertEqual(cells["D"]["value"], False)


if __name__ == "__main__":
    unittest.main()
