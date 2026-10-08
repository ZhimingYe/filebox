#!/usr/bin/env python3
"""Generate a synthetic multi-page lab methods report PDF (original content)."""
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT, TA_RIGHT
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    PageBreak, Image, KeepTogether, HRFlowable, ListFlowable, ListItem,
)
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor
import math, io, os

OUT = "/tmp/fbx_demo/reports/demo-report.pdf"
FIGDIR = "/tmp/fbx_demo/figures"

# --- generate synthetic figures with matplotlib ---
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

os.makedirs(FIGDIR, exist_ok=True)

# Figure 1: multi-panel assay curve
rng = np.random.default_rng(42)
fig, axes = plt.subplots(2, 2, figsize=(7.2, 5.4), dpi=140)
t = np.linspace(0, 48, 97)
for ax, (label, k, c) in zip(axes.flat, [
    ("Batch A", 0.08, "#4f46e5"),
    ("Batch B", 0.11, "#059669"),
    ("Batch C", 0.06, "#d97706"),
    ("Control", 0.02, "#6b7280"),
]):
    y = 1 - np.exp(-k * t) + rng.normal(0, 0.02, t.shape)
    ax.plot(t, y, color=c, lw=1.8, label=label)
    ax.fill_between(t, y - 0.04, y + 0.04, color=c, alpha=0.15)
    ax.set_title(label, fontsize=10)
    ax.set_xlabel("Time (h)", fontsize=8)
    ax.set_ylabel("Relative OD₆₀₀", fontsize=8)
    ax.grid(True, alpha=0.3)
    ax.set_ylim(-0.05, 1.15)
fig.suptitle("Figure 1. Growth kinetics across four assay batches", fontsize=11, fontweight="bold")
fig.tight_layout()
fig1_path = "/tmp/fbx_fig1.png"
fig.savefig(fig1_path, bbox_inches="tight", facecolor="white")
plt.close()

# Figure 2: heatmap-like correlation matrix
fig, ax = plt.subplots(figsize=(5.5, 4.4), dpi=140)
labels = ["OD", "pH", "Temp", "RPM", "Yield", "Purity"]
M = rng.normal(0, 0.4, (6, 6))
M = (M + M.T) / 2
np.fill_diagonal(M, 1.0)
im = ax.imshow(M, cmap="RdBu_r", vmin=-1, vmax=1)
ax.set_xticks(range(6)); ax.set_yticks(range(6))
ax.set_xticklabels(labels, fontsize=8); ax.set_yticklabels(labels, fontsize=8)
for i in range(6):
    for j in range(6):
        ax.text(j, i, f"{M[i,j]:.2f}", ha="center", va="center", fontsize=7,
                color="white" if abs(M[i,j]) > 0.5 else "black")
fig.colorbar(im, ax=ax, fraction=0.046, pad=0.04)
ax.set_title("Figure 2. Process variable correlation matrix", fontsize=10, fontweight="bold")
fig.tight_layout()
fig2_path = "/tmp/fbx_fig2.png"
fig.savefig(fig2_path, bbox_inches="tight", facecolor="white")
plt.close()

# Figure 3: bar chart with error bars
fig, ax = plt.subplots(figsize=(6.2, 3.6), dpi=140)
cats = ["Run-01", "Run-02", "Run-03", "Run-04", "Run-05", "Run-06"]
means = [72.4, 81.1, 68.9, 88.2, 79.5, 84.0]
errs = [3.2, 2.8, 4.1, 2.1, 3.5, 2.6]
bars = ax.bar(cats, means, yerr=errs, color="#6366f1", alpha=0.85, capsize=4, ecolor="#312e81")
ax.axhline(80, color="#dc2626", ls="--", lw=1.2, label="Target ≥ 80%")
ax.set_ylabel("Assay recovery (%)", fontsize=9)
ax.set_title("Figure 3. Recovery by process run (n=3 technical replicates)", fontsize=10, fontweight="bold")
ax.set_ylim(55, 100)
ax.legend(fontsize=8)
ax.grid(True, axis="y", alpha=0.3)
fig.tight_layout()
fig3_path = "/tmp/fbx_fig3.png"
fig.savefig(fig3_path, bbox_inches="tight", facecolor="white")
plt.close()

# Also publish the figures as standalone PNGs in the demo root so the docs can
# show them in their own preview tabs next to the PDF (multi-tab screenshots).
import shutil
for src, name in [
    (fig1_path, "growth-kinetics.png"),
    (fig2_path, "correlation-matrix.png"),
    (fig3_path, "recovery-by-run.png"),
]:
    shutil.copyfile(src, os.path.join(FIGDIR, name))

# --- PDF document ---
PAGE_W, PAGE_H = letter
MARGIN = 0.75 * inch

def add_page_decor(c, doc):
    c.saveState()
    # header bar
    c.setFillColor(HexColor("#312e81"))
    c.rect(0, PAGE_H - 28, PAGE_W, 28, fill=1, stroke=0)
    c.setFillColor(colors.white)
    c.setFont("Helvetica", 8)
    c.drawString(MARGIN, PAGE_H - 18, "Synthetic Methods Note  ·  FBX-DEMO-2026  ·  Not a real publication")
    c.drawRightString(PAGE_W - MARGIN, PAGE_H - 18, "CONFIDENTIAL — DEMO DATA")
    # footer
    c.setFillColor(HexColor("#4b5563"))
    c.setFont("Helvetica", 8)
    c.drawString(MARGIN, 28, "filebox demo sample  ·  generated for UI preview screenshots")
    c.drawRightString(PAGE_W - MARGIN, 28, f"Page {doc.page}")
    c.setStrokeColor(HexColor("#c7d2fe"))
    c.setLineWidth(0.6)
    c.line(MARGIN, 40, PAGE_W - MARGIN, 40)
    c.restoreState()

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(
    name="CoverTitle", fontName="Helvetica-Bold", fontSize=22, leading=26,
    alignment=TA_CENTER, textColor=HexColor("#1e1b4b"), spaceAfter=10,
))
styles.add(ParagraphStyle(
    name="CoverSub", fontName="Helvetica", fontSize=12, leading=16,
    alignment=TA_CENTER, textColor=HexColor("#4338ca"), spaceAfter=6,
))
styles.add(ParagraphStyle(
    name="Section", fontName="Helvetica-Bold", fontSize=13, leading=17,
    textColor=HexColor("#312e81"), spaceBefore=14, spaceAfter=8,
))
styles.add(ParagraphStyle(
    name="SubSec", fontName="Helvetica-Bold", fontSize=11, leading=14,
    textColor=HexColor("#3730a3"), spaceBefore=10, spaceAfter=6,
))
styles.add(ParagraphStyle(
    name="BodyJust", fontName="Helvetica", fontSize=9.5, leading=13,
    alignment=TA_JUSTIFY, spaceAfter=7, textColor=HexColor("#1f2937"),
))
styles.add(ParagraphStyle(
    name="Caption", fontName="Helvetica-Oblique", fontSize=8.5, leading=11,
    alignment=TA_CENTER, textColor=HexColor("#4b5563"), spaceBefore=4, spaceAfter=10,
))
styles.add(ParagraphStyle(
    name="Eq", fontName="Courier", fontSize=10, leading=14,
    alignment=TA_CENTER, textColor=HexColor("#111827"), spaceBefore=6, spaceAfter=6,
))
styles.add(ParagraphStyle(
    name="Meta", fontName="Helvetica", fontSize=9, leading=12,
    alignment=TA_LEFT, textColor=HexColor("#374151"),
))
styles.add(ParagraphStyle(
    name="Tiny", fontName="Helvetica", fontSize=8, leading=10,
    textColor=HexColor("#6b7280"),
))
styles.add(ParagraphStyle(
    name="Cell", fontName="Helvetica", fontSize=8, leading=10,
))
styles.add(ParagraphStyle(
    name="CellBold", fontName="Helvetica-Bold", fontSize=8, leading=10,
    textColor=colors.white,
))

story = []

# ===== COVER =====
story.append(Spacer(1, 1.1 * inch))
story.append(Paragraph("Adaptive Recovery Assay for Multiplex Process Monitoring", styles["CoverTitle"]))
story.append(Spacer(1, 0.15 * inch))
story.append(HRFlowable(width="80%", thickness=1.5, color=HexColor("#6366f1"), spaceBefore=4, spaceAfter=10, hAlign="CENTER"))
story.append(Paragraph("Synthetic Laboratory Methods Report  ·  Version 1.5", styles["CoverSub"]))
story.append(Paragraph("Document ID: FBX-DEMO-LAB-2026-10  ·  Classification: Demo / Non-confidential", styles["CoverSub"]))
story.append(Spacer(1, 0.35 * inch))

meta_data = [
    [Paragraph("<b>Authors</b>", styles["Meta"]),
     Paragraph("A. Chen, R. Okada, M. Silva  (synthetic personas)", styles["Meta"])],
    [Paragraph("<b>Affiliation</b>", styles["Meta"]),
     Paragraph("Filebox Demo Lab — Computational Process Analytics Group", styles["Meta"])],
    [Paragraph("<b>Prepared</b>", styles["Meta"]),
     Paragraph("2026-10-08  ·  Asia/Shanghai", styles["Meta"])],
    [Paragraph("<b>Keywords</b>", styles["Meta"]),
     Paragraph("assay recovery, process analytics, OD kinetics, QC dashboard", styles["Meta"])],
]
meta_t = Table(meta_data, colWidths=[1.3*inch, 5.2*inch])
meta_t.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (-1, -1), HexColor("#eef2ff")),
    ("BOX", (0, 0), (-1, -1), 0.8, HexColor("#a5b4fc")),
    ("INNERGRID", (0, 0), (-1, -1), 0.3, HexColor("#c7d2fe")),
    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ("LEFTPADDING", (0, 0), (-1, -1), 8),
    ("RIGHTPADDING", (0, 0), (-1, -1), 8),
    ("TOPPADDING", (0, 0), (-1, -1), 6),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
]))
story.append(meta_t)
story.append(Spacer(1, 0.4 * inch))
story.append(Paragraph(
    "<b>Abstract.</b> This synthetic methods note describes a fictitious adaptive recovery assay "
    "used to illustrate multi-page PDF preview in filebox. It includes tabulated QC metrics, "
    "multi-panel figures, a correlation matrix, and simple kinetic equations. All numeric values "
    "and prose are original demo content — not derived from any copyrighted paper.",
    styles["BodyJust"],
))
story.append(Spacer(1, 0.25 * inch))
story.append(Paragraph(
    "<i>Intended use:</i> visual richness for documentation screenshots "
    "(tables · figures · headings · equations · multi-column summary).",
    styles["Tiny"],
))

story.append(PageBreak())

# ===== TOC-ish + Intro =====
story.append(Paragraph("1. Introduction and Scope", styles["Section"]))
story.append(Paragraph(
    "Process development teams often need a single browser view of assay PDFs, CSV metrics, and "
    "figure panels scattered across shared storage. This demo report mirrors that layout: a short "
    "methods narrative, quantitative tables, and figures generated from synthetic time-series. "
    "The assay itself is fictional; the goal is typographic density suitable for UI preview.",
    styles["BodyJust"],
))
story.append(Paragraph(
    "We summarize (i) sample preparation, (ii) kinetic fitting, (iii) recovery acceptance criteria, "
    "and (iv) a six-variable correlation screen. Downstream sections include a two-column summary "
    "box and an appendix of raw-ish tabular extracts.",
    styles["BodyJust"],
))

story.append(Paragraph("2. Materials and Methods", styles["Section"]))
story.append(Paragraph("2.1 Sample matrix", styles["SubSec"]))
story.append(Paragraph(
    "Synthetic broth aliquots (12 mL) were prepared in six process runs. Each run carried three "
    "technical replicates. Optical density at 600 nm (OD<sub>600</sub>) was recorded every 30 minutes for "
    "48 hours. Temperature setpoints alternated between 28 °C and 32 °C; agitation targeted "
    "180–220 RPM. pH was buffered near 6.8 ± 0.2.",
    styles["BodyJust"],
))
story.append(Paragraph("2.2 Kinetic model", styles["SubSec"]))
story.append(Paragraph(
    "Relative OD was modeled as a saturating exponential with additive Gaussian noise ε ~ N(0, σ²):",
    styles["BodyJust"],
))
story.append(Paragraph("y(t) = 1 − exp(−k · t) + ε,     σ ≈ 0.02", styles["Eq"]))
story.append(Paragraph(
    "Batch-specific rate constants k ∈ {0.08, 0.11, 0.06, 0.02} h<super>−1</super> were used for Batches A–C "
    "and the Control series shown in Figure 1. Recovery percentage R is defined as measured "
    "analyte mass divided by spiked mass × 100.",
    styles["BodyJust"],
))
story.append(Paragraph("2.3 Acceptance criteria", styles["SubSec"]))
story.append(Paragraph(
    "A run passes when mean recovery ≥ 80% and the relative standard deviation across technical "
    "replicates is ≤ 5%. Runs failing either gate enter a re-prep queue; this document only "
    "records the primary pass/fail table for screenshot realism.",
    styles["BodyJust"],
))

# Materials table
story.append(Paragraph("Table 1. Reagents and instruments (synthetic)", styles["SubSec"]))
hdr = [Paragraph(x, styles["CellBold"]) for x in ["Item", "Vendor / Model", "Lot / ID", "Notes"]]
rows = [hdr]
for r in [
    ["Buffer A (pH 6.8)", "DemoChem", "LOT-A-2241", "Store 4 °C"],
    ["Spiked analyte std.", "SynStd Co.", "STD-09B", "10 mg/mL stock"],
    ["Spectrophotometer", "OptiLab 600", "SN-77102", "λ = 600 nm"],
    ["Incubator shaker", "OrbitMax", "SN-33881", "180–220 RPM"],
    ["pH probe", "GlassTip Pro", "SN-11902", "Daily 2-pt cal"],
    ["Data logger", "filebox Agent", "lab-server", "CSV export hourly"],
]:
    rows.append([Paragraph(c, styles["Cell"]) for c in r])
t1 = Table(rows, colWidths=[1.6*inch, 1.5*inch, 1.2*inch, 1.7*inch])
t1.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (-1, 0), HexColor("#4338ca")),
    ("BACKGROUND", (0, 1), (-1, -1), HexColor("#f8fafc")),
    ("ROWBACKGROUNDS", (0, 1), (-1, -1), [HexColor("#f8fafc"), HexColor("#eef2ff")]),
    ("BOX", (0, 0), (-1, -1), 0.7, HexColor("#6366f1")),
    ("INNERGRID", (0, 0), (-1, -1), 0.4, HexColor("#c7d2fe")),
    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ("TOPPADDING", (0, 0), (-1, -1), 4),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ("LEFTPADDING", (0, 0), (-1, -1), 5),
]))
story.append(t1)
story.append(Paragraph("Table 1. Synthetic reagents and instruments used in the demo assay.", styles["Caption"]))

story.append(PageBreak())

# ===== Results with figures =====
story.append(Paragraph("3. Results", styles["Section"]))
story.append(Paragraph("3.1 Growth kinetics", styles["SubSec"]))
story.append(Paragraph(
    "Figure 1 shows relative OD<sub>600</sub> trajectories for four synthetic batches. Batches A and B "
    "approach saturation within 36 h; Batch C is slower; Control remains near baseline. Shaded "
    "bands indicate ±0.04 relative OD for visual emphasis (not formal CI).",
    styles["BodyJust"],
))
story.append(Image(fig1_path, width=6.4*inch, height=4.8*inch))
story.append(Paragraph(
    "Figure 1. Growth kinetics across four assay batches (synthetic data; seed=42).",
    styles["Caption"],
))

story.append(Paragraph("3.2 Process variable correlations", styles["SubSec"]))
story.append(Paragraph(
    "Pairwise Pearson-like correlations among OD, pH, temperature, RPM, yield, and purity "
    "are shown in Figure 2. Off-diagonal magnitudes are drawn from a synthetic symmetric matrix; "
    "diagonal entries are fixed at 1.0 for readability.",
    styles["BodyJust"],
))
story.append(Image(fig2_path, width=5.0*inch, height=4.0*inch))
story.append(Paragraph(
    "Figure 2. Process variable correlation matrix (demo values).",
    styles["Caption"],
))

story.append(Paragraph("3.3 Recovery by run", styles["SubSec"]))
story.append(Paragraph(
    "Figure 3 and Table 2 summarize mean recovery with error bars (n=3). Runs 02, 04, and 06 "
    "clear the 80% target; Run-03 fails and is flagged for re-prep. The dashed red line marks "
    "the acceptance threshold used in the demo QC dashboard.",
    styles["BodyJust"],
))
# QC table
story.append(Paragraph("Table 2. QC recovery summary", styles["SubSec"]))
hdr2 = [Paragraph(x, styles["CellBold"]) for x in
        ["Run", "Mean R (%)", "RSD (%)", "Temp (°C)", "RPM", "Gate"]]
rows2 = [hdr2]
qc = [
    ["Run-01", "72.4", "4.4", "28", "180", "FAIL — low mean"],
    ["Run-02", "81.1", "3.5", "32", "200", "PASS"],
    ["Run-03", "68.9", "6.0", "28", "180", "FAIL — mean & RSD"],
    ["Run-04", "88.2", "2.4", "32", "220", "PASS"],
    ["Run-05", "79.5", "4.4", "30", "200", "BORDERLINE"],
    ["Run-06", "84.0", "3.1", "32", "210", "PASS"],
]
GATE_COLORS = {"PASS": "#15803d", "FAIL": "#b91c1c", "BORDERLINE": "#b45309"}
for r in qc:
    cells = [Paragraph(c, styles["Cell"]) for c in r[:-1]]
    gate = r[-1]
    color = next((v for k, v in GATE_COLORS.items() if gate.startswith(k)), "#0f172a")
    cells.append(Paragraph(f"<font color='{color}'><b>{gate}</b></font>", styles["Cell"]))
    rows2.append(cells)
t2 = Table(rows2, colWidths=[0.9*inch, 1.0*inch, 0.9*inch, 0.9*inch, 0.7*inch, 1.6*inch])
t2.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (-1, 0), HexColor("#4338ca")),
    ("ROWBACKGROUNDS", (0, 1), (-1, -1), [HexColor("#f8fafc"), HexColor("#eef2ff")]),
    ("BOX", (0, 0), (-1, -1), 0.7, HexColor("#6366f1")),
    ("INNERGRID", (0, 0), (-1, -1), 0.4, HexColor("#c7d2fe")),
    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ("TOPPADDING", (0, 0), (-1, -1), 4),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ("ALIGN", (1, 1), (4, -1), "CENTER"),
]))
story.append(t2)
story.append(Paragraph("Table 2. Mean recovery, RSD, and gate decision per run.", styles["Caption"]))


story.append(Image(fig3_path, width=5.8*inch, height=3.35*inch))
story.append(Paragraph(
    "Figure 3. Recovery by process run with technical-replicate error bars.",
    styles["Caption"],
))


# ===== Two-column style summary + discussion =====
story.append(Paragraph("4. Discussion", styles["Section"]))
story.append(Paragraph(
    "Within this synthetic dataset, higher agitation and the 32 °C setpoint co-occur with "
    "passing gates more often, but the sample size (six runs) is intentionally tiny so the "
    "PDF remains short while still looking like a methods appendix. The kinetic constant k "
    "dominates early curvature; Control (k=0.02) never approaches the saturation plateau "
    "within 48 h.",
    styles["BodyJust"],
))
story.append(Paragraph(
    "Operators reviewing results in filebox can open this PDF beside the CSV export "
    "(datasets/metrics.csv) and the PNG figures under figures/ without copying archives "
    "to a laptop. That workflow is the reason this demo document exists.",
    styles["BodyJust"],
))

# Highlight box (two-column table)
story.append(Paragraph("4.1 Operator checklist (two-column)", styles["SubSec"]))
left = Paragraph(
    "<b>Before opening the PDF</b><br/>"
    "• Confirm Agent Online in Hub sidebar<br/>"
    "• Open root <font face='Courier'>demo</font> → <font face='Courier'>reports/</font><br/>"
    "• Prefer Adaptive zoom for first glance<br/>"
    "• Cross-check Table 2 vs CSV columns",
    styles["Cell"],
)
right = Paragraph(
    "<b>While reading</b><br/>"
    "• Figures 1–3 should render crisp at 2× DPR<br/>"
    "• Scroll past cover → methods → results<br/>"
    "• Equations use monospace for clarity<br/>"
    "• Footer shows page index for multi-page UI",
    styles["Cell"],
)
box = Table([[left, right]], colWidths=[3.15*inch, 3.15*inch])
box.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (0, 0), HexColor("#ecfdf5")),
    ("BACKGROUND", (1, 0), (1, 0), HexColor("#eff6ff")),
    ("BOX", (0, 0), (-1, -1), 1.0, HexColor("#6366f1")),
    ("LINEBEFORE", (1, 0), (1, 0), 0.6, HexColor("#a5b4fc")),
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LEFTPADDING", (0, 0), (-1, -1), 10),
    ("RIGHTPADDING", (0, 0), (-1, -1), 10),
    ("TOPPADDING", (0, 0), (-1, -1), 10),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
]))
story.append(box)
story.append(Spacer(1, 0.2 * inch))

story.append(Paragraph("5. Conclusions", styles["Section"]))
story.append(Paragraph(
    "This multi-page synthetic report deliberately packs headings, justified prose, colored "
    "tables, equations, and three figures so filebox PDF preview screenshots are not sparse. "
    "No copyrighted paper text was reused. Replace this file in /tmp/fbx_demo/reports/ when "
    "refreshing documentation imagery.",
    styles["BodyJust"],
))

appendix = [Paragraph("Appendix A. Tabulated kinetic constants", styles["Section"])]
hdr3 = [Paragraph(x, styles["CellBold"]) for x in ["Series", "k (h<super>−1</super>)", "σ", "t<sub>1/2</sub> (h)", "Notes"]]
rows3 = [hdr3]
for r in [
    ["Batch A", "0.08", "0.02", "8.7", "Primary path"],
    ["Batch B", "0.11", "0.02", "6.3", "Fastest rise"],
    ["Batch C", "0.06", "0.02", "11.6", "Slow path"],
    ["Control", "0.02", "0.02", "34.7", "Baseline"],
]:
    rows3.append([Paragraph(c, styles["Cell"]) for c in r])
t3 = Table(rows3, colWidths=[1.2*inch, 1.1*inch, 0.8*inch, 1.0*inch, 2.0*inch])
t3.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (-1, 0), HexColor("#0f766e")),
    ("ROWBACKGROUNDS", (0, 1), (-1, -1), [HexColor("#f0fdfa"), HexColor("#ccfbf1")]),
    ("BOX", (0, 0), (-1, -1), 0.7, HexColor("#14b8a6")),
    ("INNERGRID", (0, 0), (-1, -1), 0.4, HexColor("#99f6e4")),
    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ("TOPPADDING", (0, 0), (-1, -1), 4),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ("ALIGN", (1, 1), (3, -1), "CENTER"),
]))
appendix.append(t3)
appendix.append(Paragraph("Appendix Table A1. Fitted kinetic constants for Figure 1 series.", styles["Caption"]))

appendix.append(Spacer(1, 0.1 * inch))
appendix.append(Paragraph(
    "Appendix B. Changelog — v1.0 sparse stub → v1.4 rich multi-page demo for docs screenshots → "
    "v1.5 correlation matrix + QC table on one page for the docs homepage hero (2026-10-08).",
    styles["Tiny"],
))
# Keep the appendix block intact so it never splits into an orphaned caption page.
story.append(KeepTogether(appendix))

doc = SimpleDocTemplate(
    OUT, pagesize=letter,
    leftMargin=MARGIN, rightMargin=MARGIN,
    topMargin=0.65*inch, bottomMargin=0.6*inch,
    title="Adaptive Recovery Assay — Synthetic Methods Report",
    author="Filebox Demo Lab",
    subject="Demo PDF for filebox documentation screenshots",
)
doc.build(story, onFirstPage=add_page_decor, onLaterPages=add_page_decor)
print("wrote", OUT, "bytes", os.path.getsize(OUT))
