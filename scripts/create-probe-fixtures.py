from pathlib import Path
from docx import Document
from openpyxl import Workbook, load_workbook
from PIL import Image

root = Path(__file__).resolve().parents[1] / "assets"
root.mkdir(exist_ok=True)
paths = [root / "probe.docx", root / "probe.xlsx", root / "probe.png", root / "probe.txt"]
if any(p.exists() for p in paths):
    raise SystemExit("Fixtures already exist; inspect before regenerating")
doc = Document()
doc.core_properties.author = ""
doc.core_properties.last_modified_by = ""
doc.add_heading("Readiness Probe", level=1)
doc.add_paragraph("DSH-READINESS-PROBE-v1")
doc.add_paragraph("This is a synthetic document used only to check the conversion pipeline.")
doc.save(paths[0])
assert "DSH-READINESS-PROBE-v1" in [p.text for p in Document(paths[0]).paragraphs]
wb = Workbook()
wb.properties.creator = ""
wb.properties.lastModifiedBy = ""
s = wb.active
s.title = "Probe"
s["A1"] = "DSH-READINESS-PROBE-v1"
s["A2"] = 2
s["A3"] = 2
s["A4"] = "=SUM(A2:A3)"
wb.save(paths[1])
assert load_workbook(paths[1], data_only=False)["Probe"]["A4"].value == "=SUM(A2:A3)"
Image.new("RGB", (64,64), (240,50,50)).save(paths[2])
paths[3].write_text("DSH-READINESS-PROBE-v1\n", encoding="utf-8")
for p in paths:
    print(p.name, p.stat().st_size)
