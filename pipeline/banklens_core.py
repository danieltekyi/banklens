#!/usr/bin/env python3
"""Shared pure-Python BankLens collection, extraction, dedupe, and analysis logic."""
from __future__ import annotations

import csv
import hashlib
import json
import logging
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import unquote, urldefrag, urljoin, urlparse

import requests
from bs4 import BeautifulSoup
from pypdf import PdfReader

try:
    import pdfplumber
except Exception:  # pragma: no cover - optional fallback
    pdfplumber = None

try:
    import openpyxl
except Exception:  # pragma: no cover - optional dependency during --help
    openpyxl = None

try:
    import pandas as pd
except Exception:  # pragma: no cover - optional xls fallback
    pd = None

USER_AGENT = "BankLens Local Financial Pipeline/2.0 (+https://banklens.tiwaak.com/methodology)"
MAX_TEXT = 4_000_000
REPORT_EXTENSIONS = (".pdf", ".xls", ".xlsx", ".csv")
HTML_EXTENSIONS = (".html", ".htm", "")

REPORT_TERMS = re.compile(
    r"\b(annual\s+reports?|annual\s+financial\s+statements?|financial\s+statements?|"
    r"audited\s+(?:accounts|financials?|statements?)|unaudited\s+(?:accounts|financials?|statements?)|"
    r"interim\s+(?:results?|reports?|financials?|statements?)|half[-\s]?year(?:ly)?\s+(?:results?|reports?|financials?|statements?)|"
    r"quarter(?:ly)?\s+(?:results?|reports?|financials?|statements?)|q[1-4]\s*(?:results?|reports?|financials?|statements?)|"
    r"full[-\s]?year\s+(?:results?|reports?)|year[-\s]?end\s+(?:results?|reports?|financials?)|"
    r"statutory\s+(?:accounts|financials?|statements?)|pillar\s*3|basel\s+(?:ii|iii)|prudential\s+disclosures?|"
    r"capital\s+adequacy\s+disclosures?|financial\s+reports?|investor\s+relations)\b",
    re.I,
)
LOOSE_REPORT_TERMS = re.compile(
    r"\b(annual|financial|statements?|accounts?|results?|reports?|audited|unaudited|interim|"
    r"quarterly|half[-\s]?year|q[1-4]|h[12]|fy\s*20\d{2}|20\d{2}\s*(?:annual|results?|reports?)|"
    r"pillar\s*3|prudential|basel|capital\s+adequacy)\b",
    re.I,
)
EXCLUDED_TERMS = re.compile(
    r"\b(careers?|jobs?|vacanc(?:y|ies)|recruit(?:ment)?|privacy|cookies?|terms(?:[-\s]of[-\s]use)?|"
    r"contact(?:[-\s]us)?|branch(?:es)?|locator|about[-\s]us|board|management|governance|csr|"
    r"sustainability|esg|news|press|media|events?|blog|awards?|gallery|newsletter|"
    r"tariffs?|fees?|charges?|rates?|pricing|products?|loans?|cards?|mortgages?|savings?|accounts?|"
    r"insurance|mobile[-\s]banking|internet[-\s]banking|forms?|downloads?\s+(?:forms?|tariffs?)|"
    r"facebook|linkedin|instagram|youtube|twitter|x\.com|whatsapp|telegram|rss|login|signup|register)\b",
    re.I,
)
SOCIAL_DOMAINS = re.compile(r"(^|\.)(facebook|linkedin|instagram|youtube|youtu|twitter|x|tiktok|whatsapp|telegram)\.com$", re.I)
FILE_RE = re.compile(r"\.(pdf|xlsx?|csv)(?:$|[?#])", re.I)

METRICS: list[tuple[str, str, list[str], str]] = [
    ("assets", "Total assets", ["total assets", "total asset"], "amount"),
    ("deposits", "Customer deposits", ["customer deposits", "deposits from customers", "customer accounts", "customer deposits and other accounts", "deposits"], "amount"),
    ("profit", "Profit after tax", ["profit after tax", "profit for the year", "profit for the period", "profit attributable to equity holders", "net profit"], "amount"),
    ("profit_before_tax", "Profit before tax", ["profit before tax", "profit before taxation"], "amount"),
    ("loans", "Loans and advances", ["loans and advances to customers", "loans and advances", "gross loans", "net loans", "customer loans", "loans"], "amount"),
    ("equity", "Total equity", ["total equity", "shareholders' funds", "shareholders funds", "total shareholders' equity", "shareholder funds"], "amount"),
    ("liabilities", "Total liabilities", ["total liabilities"], "amount"),
    ("revenue", "Total income", ["total income", "operating income", "revenue", "gross earnings"], "amount"),
    ("net_interest_income", "Net interest income", ["net interest income"], "amount"),
    ("operating_expenses", "Operating expenses", ["operating expenses", "total operating expenses"], "amount"),
    ("impairment", "Credit impairment charge", ["credit impairment charge", "credit impairment", "impairment charge", "impairment losses", "loan impairment charge"], "amount"),
    ("cash", "Cash and cash equivalents", ["cash and cash equivalents", "cash balances", "cash and balances with central bank"], "amount"),
    ("borrowings", "Borrowings", ["borrowings", "borrowed funds"], "amount"),
    ("capital_adequacy", "Capital adequacy ratio", ["capital adequacy ratio", "capital adequacy", "total capital ratio", "capital ratio"], "percent"),
    ("tier1_capital_ratio", "Tier 1 capital ratio", ["tier 1 capital ratio", "tier one capital ratio", "cet1 ratio", "common equity tier 1 ratio"], "percent"),
    ("liquidity", "Liquidity ratio", ["liquidity ratio", "liquid assets ratio", "liquidity coverage ratio", "lcr"], "percent"),
    ("npl", "NPL ratio", ["npl ratio", "non-performing loans ratio", "non performing loans ratio", "non-performing loan ratio", "non performing loan ratio"], "percent"),
    ("roe", "Return on equity", ["return on equity", "roe"], "percent"),
    ("roa", "Return on assets", ["return on assets", "roa"], "percent"),
    ("cost_to_income", "Cost-to-income ratio", ["cost to income ratio", "cost-to-income ratio", "cost income ratio"], "percent"),
    ("net_interest_margin", "Net interest margin", ["net interest margin", "nim"], "percent"),
    ("leverage_ratio", "Leverage ratio", ["leverage ratio"], "percent"),
]

MONTHS = {
    "jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3,
    "apr": 4, "april": 4, "may": 5, "jun": 6, "june": 6, "jul": 7, "july": 7,
    "aug": 8, "august": 8, "sep": 9, "sept": 9, "september": 9, "oct": 10, "october": 10,
    "nov": 11, "november": 11, "dec": 12, "december": 12,
}


def now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(s).lower()).strip("-") or "item"


def sha256(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def canonical_url(url: str) -> str:
    return urldefrag(url.strip())[0]


def clean_text(s: str) -> str:
    s = re.sub(r"<script[\s\S]*?</script>|<style[\s\S]*?</style>", " ", s, flags=re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    replacements = {"&nbsp;": " ", "&#160;": " ", "&amp;": "&", "&pound;": "GBP", "&cent;": "", "&quot;": '"'}
    for a, b in replacements.items():
        s = re.sub(re.escape(a), b, s, flags=re.I)
    return re.sub(r"\s+", " ", s).strip()


def parse_number(raw: str | None) -> float | None:
    if not raw:
        return None
    x = str(raw).strip()
    neg = bool(re.match(r"^\(", x)) or x.startswith("-")
    x = re.sub(r"[^0-9.]", "", x)
    if not x or x == ".":
        return None
    try:
        value = float(x)
    except ValueError:
        return None
    return -value if neg else value


def url_extension(url: str) -> str:
    path = unquote(urlparse(url).path).lower()
    for ext in REPORT_EXTENSIONS + (".html", ".htm"):
        if path.endswith(ext):
            return ext
    return ""


def is_social_url(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    return bool(SOCIAL_DOMAINS.search(host))


def is_financial_report_candidate(url: str, title: str = "") -> bool:
    if not url or is_social_url(url):
        return False
    if urlparse(url).scheme not in ("http", "https", ""):
        return False
    haystack = unquote(f"{title} {url}").replace("_", " ").replace("-", " ")
    if EXCLUDED_TERMS.search(haystack) and not REPORT_TERMS.search(haystack):
        return False
    ext = url_extension(url)
    if ext in REPORT_EXTENSIONS:
        return bool(LOOSE_REPORT_TERMS.search(haystack) or REPORT_TERMS.search(haystack))
    if ext in HTML_EXTENSIONS:
        return bool(REPORT_TERMS.search(haystack) or (LOOSE_REPORT_TERMS.search(haystack) and re.search(r"20\d{2}|q[1-4]|h[12]|fy", haystack, re.I)))
    return False


def report_type(title: str, url: str, text: str = "") -> str:
    s = f"{title} {url} {text[:2000]}"
    if re.search(r"pillar\s*3|prudential|basel", s, re.I):
        return "prudential"
    if re.search(r"q[1-4]|quarter", s, re.I):
        return "quarterly"
    if re.search(r"half[-\s]?year|interim|\bh[12]\b|six\s+months", s, re.I):
        return "interim"
    if re.search(r"annual|full[-\s]?year|year[-\s]?end|audited", s, re.I):
        return "annual"
    return "financial"


def discover_reports(html: str, base: str) -> list[dict[str, str]]:
    soup = BeautifulSoup(html or "", "html.parser")
    found: dict[str, dict[str, str]] = {}

    def add(raw: str | None, title: str = "") -> None:
        if not raw:
            return
        raw = raw.strip().replace("\\/", "/")
        if raw.startswith("#") or raw.lower().startswith(("javascript:", "mailto:", "tel:")):
            return
        u = canonical_url(urljoin(base, raw))
        if urlparse(u).scheme not in ("http", "https"):
            return
        if is_financial_report_candidate(u, title):
            found[u] = {"url": u, "title": title.strip() or Path(urlparse(u).path).name or u, "report_type": report_type(title, u)}

    for a in soup.find_all("a"):
        title = a.get_text(" ", strip=True) or a.get("title", "") or a.get("aria-label", "")
        add(a.get("href"), title)
        for k in ("data-href", "data-url", "data-download", "data-download-url", "data-file", "data-pdf", "data-document-url"):
            add(a.get(k), title)
        onclick = a.get("onclick", "") or ""
        for u in re.findall(r"""['\"]([^'\"]+(?:pdf|xlsx?|csv|download|document|report|financial)[^'\"]*)['\"]""", onclick, re.I):
            add(u, title)
    for tag in soup.find_all(["iframe", "object", "embed"]):
        add(tag.get("src") or tag.get("data"), tag.get("title", ""))
    return list(found.values())


def make_session() -> requests.Session:
    s = requests.Session()
    s.headers.update({
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/pdf,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv;q=0.9,*/*;q=0.8",
    })
    return s


def fetch(session: requests.Session, url: str, timeout: int = 45) -> requests.Response:
    r = session.get(url, timeout=timeout, allow_redirects=True)
    r.raise_for_status()
    return r


def remote_fingerprint(session: requests.Session, url: str, timeout: int = 20) -> dict[str, str] | None:
    headers = {"Accept": "*/*"}
    try:
        r = session.head(url, timeout=timeout, allow_redirects=True, headers=headers)
        if r.status_code < 400:
            fp = {k: r.headers.get(k, "") for k in ("ETag", "Last-Modified", "Content-Length", "Content-Type") if r.headers.get(k)}
            fp["final_url"] = canonical_url(r.url)
            if len(fp) > 1:
                return fp
    except Exception:
        pass
    try:
        r = session.get(url, timeout=timeout, allow_redirects=True, headers={"Range": "bytes=0-0", "Accept": "*/*"}, stream=True)
        if r.status_code < 400:
            fp = {k: r.headers.get(k, "") for k in ("ETag", "Last-Modified", "Content-Length", "Content-Range", "Content-Type") if r.headers.get(k)}
            fp["final_url"] = canonical_url(r.url)
            r.close()
            if len(fp) > 1:
                return fp
    except Exception:
        pass
    return None


def fingerprint_key(fp: dict[str, str] | None) -> str | None:
    if not fp:
        return None
    parts = [fp.get(k, "") for k in ("final_url", "ETag", "Last-Modified", "Content-Length", "Content-Range", "Content-Type")]
    compact = "|".join(parts)
    return hashlib.sha256(compact.encode("utf-8", "ignore")).hexdigest() if compact.strip("|") else None


def load_state(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        data = {}
    data.setdefault("urls", {})
    data.setdefault("hashes", {})
    return data


def save_state(path: Path, state: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")


def known_sets(docs: Iterable[dict[str, Any]] = (), recs: Iterable[dict[str, Any]] = (), extra_hashes: Iterable[str] = ()) -> tuple[set[str], set[str]]:
    urls: set[str] = set()
    hashes: set[str] = {str(h) for h in extra_hashes if h}
    for d in docs:
        if d.get("report_url"):
            urls.add(canonical_url(str(d["report_url"])))
        if d.get("content_hash"):
            hashes.add(str(d["content_hash"]))
    for r in recs:
        if r.get("source_url"):
            urls.add(canonical_url(str(r["source_url"])))
        if r.get("content_hash"):
            hashes.add(str(r["content_hash"]))
    return urls, hashes


def should_skip_before_download(url: str, fp: dict[str, str] | None, state: dict[str, Any], known_hashes: set[str], force: bool = False) -> tuple[bool, str]:
    if force:
        return False, "forced"
    entry = state.get("urls", {}).get(canonical_url(url))
    key = fingerprint_key(fp)
    if entry and key and entry.get("fingerprint_key") == key and entry.get("content_hash"):
        h = entry["content_hash"]
        if h in state.get("hashes", {}) or h in known_hashes:
            return True, "unchanged fingerprint"
    return False, "new or changed"


def remember_processed(state: dict[str, Any], url: str, content_hash: str, fp: dict[str, str] | None, path: str | None, meta: dict[str, Any]) -> None:
    key = canonical_url(url)
    item = {"content_hash": content_hash, "fingerprint": fp or {}, "fingerprint_key": fingerprint_key(fp), "path": path, "processed_at": now(), **meta}
    state.setdefault("urls", {})[key] = item
    state.setdefault("hashes", {})[content_hash] = {"url": key, "path": path, "processed_at": item["processed_at"]}


def unit_multiplier(text: str) -> tuple[float | None, str | None, str | None]:
    t = text.lower()
    currency = None
    if re.search(r"\bghs\b|ghana\s+cedis?|\bcedis?\b|₵", t): currency = "GHS"
    elif re.search(r"\busd\b|us\s+dollars?|\$", t): currency = "USD"
    elif re.search(r"\bgbp\b|pounds?\s+sterling|£", t): currency = "GBP"
    elif re.search(r"\beur\b|euros?|€", t): currency = "EUR"
    elif re.search(r"\bngn\b|naira", t): currency = "NGN"
    elif re.search(r"\bkes\b|kenya\s+shillings?", t): currency = "KES"
    elif re.search(r"\bzar\b|rand", t): currency = "ZAR"
    if re.search(r"\b(?:in|amounts?\s+in|expressed\s+in)\s+(?:thousands?|000)\b|['’]000", t):
        return 1 / 1_000_000, f"{currency or 'LOCAL'}_bn", currency
    if re.search(r"\b(?:in|amounts?\s+in|expressed\s+in)?\s*(?:millions?|mn|\bm\b)\b", t):
        return 1 / 1_000, f"{currency or 'LOCAL'}_bn", currency
    if re.search(r"\b(?:in|amounts?\s+in|expressed\s+in)?\s*(?:billions?|bn|\bb\b)\b", t):
        return 1.0, f"{currency or 'LOCAL'}_bn", currency
    return None, None, currency


def extract_metrics(text: str) -> list[dict[str, Any]]:
    bounded = (text or "")[:2_000_000]
    mult, unit, currency = unit_multiplier(bounded[:200_000])
    normalized = re.sub(r"[\t\u00a0]+", " ", bounded)
    results: list[dict[str, Any]] = []
    seen: set[str] = set()
    for key, label, labels, kind in METRICS:
        best: tuple[float, str] | None = None
        for lab in labels:
            pat = re.compile(rf"{re.escape(lab)}[^0-9()\-%]{{0,260}}([(\-]?\s*\d[\d,]*(?:\.\d+)?\s*\)?)\s*(%)?", re.I)
            m = pat.search(normalized)
            if not m:
                continue
            val = parse_number(m.group(1))
            if val is None:
                continue
            if kind == "percent":
                if not m.group(2) and val > 100:
                    continue
                if abs(val) > 1000:
                    continue
                best = (val, m.group(1))
                break
            local_mult = mult
            if local_mult is None:
                if abs(val) >= 1_000_000:
                    local_mult = 1 / 1_000_000_000
                    unit = f"{currency or 'LOCAL'}_bn"
                else:
                    continue
            best = (val * local_mult, m.group(1))
            break
        if best and key not in seen:
            value, raw = best
            results.append({
                "metric_key": key,
                "metric_label": label,
                "raw_value": raw,
                "value": round(value, 6),
                "unit": "percent" if kind == "percent" else (unit or "LOCAL_bn"),
                "currency": None if kind == "percent" else currency,
            })
            seen.add(key)
    return results


def period(text: str, title: str = "", url: str = "") -> tuple[str, str, str]:
    s = f"{title} {url} {(text or '')[:300000]}"
    m = re.search(r"\b(?:Q([1-4])|([1-4])Q|quarter\s*([1-4]))[\s\-/]*(20\d{2})\b", s, re.I)
    if m:
        q = int(m.group(1) or m.group(2) or m.group(3)); y = int(m.group(4))
        starts = {1: "01-01", 2: "04-01", 3: "07-01", 4: "10-01"}; ends = {1: "03-31", 2: "06-30", 3: "09-30", 4: "12-31"}
        return f"Q{q} {y}", f"{y}-{starts[q]}", f"{y}-{ends[q]}"
    m = re.search(r"\b(?:half[-\s]?year|interim|h([12])|six\s+months)[^\n]{0,80}\b(20\d{2})\b", s, re.I)
    if m:
        half = int(m.group(1) or 1); y = int(m.group(2))
        return f"H{half} {y}", f"{y}-{'01-01' if half == 1 else '07-01'}", f"{y}-{'06-30' if half == 1 else '12-31'}"
    m = re.search(r"(?:year|period|quarter|months)\s+ended\s+(\d{1,2})\s+([A-Za-z]+)\s+(20\d{2})", s, re.I)
    if m:
        month = MONTHS.get(m.group(2).lower()[:3], 12); y = int(m.group(3))
        if month == 12:
            return f"FY {y}", f"{y}-01-01", f"{y}-12-31"
        if month == 6:
            return f"H1 {y}", f"{y}-01-01", f"{y}-06-30"
        q = (month - 1) // 3 + 1
        starts = {1: "01-01", 2: "04-01", 3: "07-01", 4: "10-01"}; ends = {1: "03-31", 2: "06-30", 3: "09-30", 4: "12-31"}
        return f"Q{q} {y}", f"{y}-{starts[q]}", f"{y}-{ends[q]}"
    m = re.search(r"\b(20\d{2})\s*(?:annual|year[- ]end|full[- ]year)\b", s, re.I) or re.search(r"\b(?:annual|year[- ]end|full[- ]year)\s*(?:report|results|financial statements?)?\s*(20\d{2})\b", s, re.I)
    if m:
        y = int(m.group(1)); return f"FY {y}", f"{y}-01-01", f"{y}-12-31"
    m = re.search(r"\b(20\d{2})\b", s)
    y = int(m.group(1)) if m else datetime.now().year
    return f"FY {y}", f"{y}-01-01", f"{y}-12-31"


def extract_pdf(path: Path) -> str:
    text = ""
    try:
        header = path.read_bytes()[:5]
    except Exception:
        header = b""
    if header != b"%PDF-":
        try:
            return path.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            return ""
    try:
        reader = PdfReader(str(path), strict=False)
        for p in reader.pages:
            text += (p.extract_text() or "") + "\n"
            if len(text) > MAX_TEXT:
                break
    except Exception:
        pass
    if len(text.strip()) < 200 and pdfplumber:
        try:
            with pdfplumber.open(str(path)) as pdf:
                chunks = []
                for p in pdf.pages[:100]:
                    chunks.append(p.extract_text() or "")
                    if sum(map(len, chunks)) > MAX_TEXT:
                        break
                text = "\n".join(chunks)
        except Exception:
            pass
    if not text.strip():
        try:
            text = path.read_bytes().decode("utf-8", "ignore")
        except Exception:
            text = ""
    return text


def extract_excel(path: Path) -> str:
    chunks: list[str] = []
    suffix = path.suffix.lower()
    try:
        if suffix == ".xlsx" and openpyxl:
            wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
            for ws in wb.worksheets:
                chunks.append(f"Sheet: {ws.title}")
                for row in ws.iter_rows(max_row=500, values_only=True):
                    vals = [str(v) for v in row if v is not None and str(v).strip()]
                    if vals:
                        chunks.append(" | ".join(vals))
                    if sum(map(len, chunks)) > MAX_TEXT:
                        break
            try:
                wb.close()
            except Exception:
                pass
        elif pd:
            frames = pd.read_excel(path, sheet_name=None, header=None, nrows=500)
            for name, frame in frames.items():
                chunks.append(f"Sheet: {name}")
                chunks.append(frame.fillna("").to_csv(index=False, header=False))
    except Exception:
        # A file advertised as a spreadsheet is not always one. Rather than
        # losing the report, fall back to delimited-text and then plain-text
        # parsing so the metric extractor still gets a chance at the content.
        chunks = []
    if not "".join(chunks).strip():
        try:
            return extract_csv(path)
        except Exception:
            return clean_text(path.read_text(encoding="utf-8", errors="ignore"))
    return "\n".join(chunks)


def extract_csv(path: Path) -> str:
    rows = []
    with path.open("r", encoding="utf-8-sig", errors="ignore", newline="") as f:
        for i, row in enumerate(csv.reader(f)):
            rows.append(" | ".join(cell for cell in row if cell.strip()))
            if i > 2000 or sum(map(len, rows)) > MAX_TEXT:
                break
    return "\n".join(rows)


def extract_document_text(path: Path, content_type: str = "", url: str = "") -> str:
    ext = path.suffix.lower() or url_extension(url)
    ctype = (content_type or "").lower()

    # A known file extension is authoritative. Content-Type is only a fallback,
    # because servers routinely mislabel documents: Windows hosts advertise .csv
    # as application/vnd.ms-excel, and many sites serve PDFs as
    # application/octet-stream. Testing Content-Type first made a .csv report
    # get parsed by the Excel reader, which then failed outright.
    if ext == ".pdf":
        return extract_pdf(path)
    if ext in (".xlsx", ".xls"):
        return extract_excel(path)
    if ext == ".csv":
        return extract_csv(path)
    if ext in (".html", ".htm"):
        return clean_text(path.read_text(encoding="utf-8", errors="ignore"))

    if "pdf" in ctype:
        return extract_pdf(path)
    if "spreadsheet" in ctype or "excel" in ctype:
        return extract_excel(path)
    if "csv" in ctype:
        return extract_csv(path)
    return clean_text(path.read_text(encoding="utf-8", errors="ignore"))


def filename_for_report(content_hash: str, url: str, content_type: str) -> str:
    ext = url_extension(url)
    if ext not in REPORT_EXTENSIONS:
        ctype = content_type.lower()
        if "pdf" in ctype: ext = ".pdf"
        elif "spreadsheet" in ctype or "excel" in ctype: ext = ".xlsx"
        elif "csv" in ctype: ext = ".csv"
        else: ext = ".html"
    return f"{content_hash[:16]}{ext}"


def setup_logging(data_dir: Path, verbose: bool = False) -> tuple[logging.Logger, Path]:
    log_dir = data_dir / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / f"banklens_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log"
    logger = logging.getLogger("banklens")
    logger.handlers.clear()
    logger.setLevel(logging.DEBUG)
    file_handler = logging.FileHandler(log_path, encoding="utf-8")
    file_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    file_handler.setLevel(logging.DEBUG)
    console = logging.StreamHandler()
    console.setFormatter(logging.Formatter("%(message)s"))
    console.setLevel(logging.DEBUG if verbose else logging.INFO)
    logger.addHandler(file_handler)
    logger.addHandler(console)
    return logger, log_path


def discover_deep(session: requests.Session, portal: str, max_reports: int = 100, max_depth: int = 2, logger: logging.Logger | None = None) -> list[dict[str, str]]:
    queue: list[tuple[str, int, str]] = [(portal, 0, "Financial reporting portal")]
    seen: set[str] = set()
    reports: dict[str, dict[str, str]] = {}
    portal_host = urlparse(portal).netloc
    while queue and len(reports) < max_reports:
        url, depth, title = queue.pop(0)
        key = canonical_url(url)
        if key in seen:
            continue
        seen.add(key)
        try:
            r = fetch(session, url)
            ctype = r.headers.get("content-type", "").lower()
            final_url = canonical_url(r.url)
            if FILE_RE.search(final_url) or any(x in ctype for x in ("pdf", "spreadsheet", "excel", "csv")):
                if is_financial_report_candidate(final_url, title):
                    reports[final_url] = {"url": final_url, "title": title, "report_type": report_type(title, final_url)}
                continue
            if "html" not in ctype and not r.text.lstrip().startswith("<"):
                continue
            discovered = discover_reports(r.text, final_url)
            for rep in discovered:
                u = rep["url"]
                if FILE_RE.search(u) or urlparse(u).netloc != portal_host:
                    reports[u] = rep
                elif depth < max_depth and urlparse(u).netloc == portal_host:
                    queue.append((u, depth + 1, rep["title"]))
                    if re.search(r"20\d{2}|\bq[1-4]\b|\bh[12]\b|pillar\s*3|prudential", f"{rep.get('title','')} {u}", re.I):
                        reports.setdefault(u, rep)
        except Exception as exc:
            if logger:
                logger.debug("Discovery failed for %s: %s", url, exc)
    return list(reports.values())[:max_reports]


def process_report(session: requests.Session, report: dict[str, str], bank: dict[str, Any], country: dict[str, Any], source: dict[str, Any], bank_dir: Path, state: dict[str, Any], known_hashes: set[str], force: bool = False) -> dict[str, Any]:
    url = canonical_url(report["url"])
    fp = remote_fingerprint(session, url)
    skip, reason = should_skip_before_download(url, fp, state, known_hashes, force)
    if skip:
        return {"status": "skipped", "reason": reason, "url": url}
    r = fetch(session, url, timeout=90)
    body = r.content
    final_url = canonical_url(r.url)
    h = sha256(body)
    content_type = r.headers.get("content-type", "")
    if not force and h in known_hashes:
        remember_processed(state, final_url, h, fp, None, {"title": report.get("title"), "skipped": "known hash"})
        return {"status": "skipped", "reason": "known hash", "url": final_url, "content_hash": h}
    bank_dir.mkdir(parents=True, exist_ok=True)
    path = bank_dir / filename_for_report(h, final_url, content_type)
    if not path.exists():
        path.write_bytes(body)
    text = extract_document_text(path, content_type, final_url)
    if not text.strip():
        raise RuntimeError("NO_TEXT: document contains no machine-readable text")
    title = report.get("title") or final_url
    rt = report_type(title, final_url, text)
    pl, ps, pe = period(text, title, final_url)
    metrics = extract_metrics(text)
    if not metrics:
        raise RuntimeError("NO_METRICS: text was extracted but no supported financial metrics were matched")
    ts = now()
    document = {
        "bank_id": int(bank["id"]), "source_id": int(source["id"]), "report_url": final_url,
        "report_title": title, "report_type": rt, "content_hash": h, "content_type": content_type or "application/octet-stream",
        "r2_key": None, "reporting_period_start": ps, "reporting_period_end": pe, "period_label": pl,
        "status": "published", "discovered_at": ts, "downloaded_at": ts, "processed_at": ts, "created_at": ts, "updated_at": ts,
    }
    extraction = {"bank_id": int(bank["id"]), "source_id": int(source["id"]), "source_url": final_url, "content_hash": h, "period_label": pl, "status": "published", "records_found": len(metrics), "error": None, "created_at": ts}
    records = []
    for m in metrics:
        records.append({
            "bank_id": int(bank["id"]), "source_id": int(source["id"]), "bank_name": bank["name"],
            "country_iso2": country.get("iso2"), "source_url": final_url, "source_title": title,
            "metric_key": m["metric_key"], "metric_label": m["metric_label"], "raw_value": m["raw_value"],
            "value": m["value"], "unit": m["unit"], "currency": m.get("currency") or country.get("currency"),
            "report_type": rt, "reporting_period_start": ps, "reporting_period_end": pe, "period_label": pl,
            "statement_date": pe, "content_hash": h, "status": "published", "created_at": ts, "updated_at": ts,
        })
    remember_processed(state, final_url, h, fp, str(path), {"title": title, "bank": bank.get("name"), "period": pl, "metrics": len(metrics)})
    return {"status": "processed", "url": final_url, "content_hash": h, "path": str(path), "metrics": records, "document": document, "extraction": extraction, "period": pl}


def run_collection(countries: list[dict[str, Any]], banks: list[dict[str, Any]], sources: list[dict[str, Any]], data_dir: Path, existing_docs: list[dict[str, Any]] | None = None, existing_records: list[dict[str, Any]] | None = None, extra_known_hashes: Iterable[str] = (), force: bool = False, limit: int | None = None, verbose: bool = False, logger: logging.Logger | None = None) -> dict[str, Any]:
    data_dir.mkdir(parents=True, exist_ok=True)
    if logger is None:
        logger, _ = setup_logging(data_dir, verbose)
    state_path = data_dir / "state.json"
    state = load_state(state_path)
    known_urls, known_hashes = known_sets(existing_docs or [], existing_records or [], extra_known_hashes)
    session = make_session()
    country_by_id = {int(c["id"]): c for c in countries}
    source_by_bank: dict[int, list[dict[str, Any]]] = {}
    for source in sources:
        source_by_bank.setdefault(int(source["bank_id"]), []).append(source)
    reports_root = data_dir / "reports"
    documents: list[dict[str, Any]] = []
    extractions: list[dict[str, Any]] = []
    records: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []
    discovered = downloaded = skipped = 0
    processed_reports = 0
    for bank in banks:
        country = country_by_id.get(int(bank["country_id"]))
        if not country:
            continue
        bank_dir = reports_root / slug(country.get("name") or country.get("iso2") or "country") / slug(bank.get("name") or bank.get("slug") or bank["id"])
        for source in source_by_bank.get(int(bank["id"]), []):
            logger.info("[%s] %s -> %s", country.get("name", country.get("iso2")), bank.get("name"), source.get("url"))
            try:
                report_list = discover_deep(session, str(source["url"]), logger=logger)
            except Exception as exc:
                failures.append({"stage": "portal", "bank": bank.get("name"), "url": source.get("url"), "error": str(exc)})
                continue
            logger.info("  discovered %d candidate report links", len(report_list))
            for rep in report_list:
                if limit is not None and processed_reports >= limit:
                    break
                discovered += 1
                try:
                    result = process_report(session, rep, bank, country, source, bank_dir, state, known_hashes, force=force)
                    if result["status"] == "skipped":
                        skipped += 1
                        logger.debug("  SKIP %s: %s", result.get("reason"), rep.get("url"))
                        continue
                    downloaded += 1
                    processed_reports += 1
                    documents.append(result["document"])
                    extractions.append(result["extraction"])
                    records.extend(result["metrics"])
                    known_hashes.add(result["content_hash"])
                    logger.info("  NEW %s: %d metrics", result.get("period"), len(result["metrics"]))
                except Exception as exc:
                    failures.append({"stage": "report", "bank": bank.get("name"), "country": country.get("name"), "url": rep.get("url"), "title": rep.get("title"), "error": str(exc)})
                    logger.info("  FAIL %s: %s", str(rep.get("title", rep.get("url")))[:70], exc)
            if limit is not None and processed_reports >= limit:
                break
        if limit is not None and processed_reports >= limit:
            break
    save_state(state_path, state)
    summary = {"countries": len(countries), "banks": len(banks), "portals": len(sources), "reports_discovered": discovered, "reports_downloaded": downloaded, "reports_skipped": skipped, "new_values": len(records), "failures": len(failures), "finished_at": now()}
    (data_dir / "failures.json").write_text(json.dumps(failures, indent=2, ensure_ascii=False), encoding="utf-8")
    (data_dir / "last_run.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    return {"records": records, "documents": documents, "extractions": extractions, "failures": failures, "summary": summary, "state_path": str(state_path)}


def _float(v: Any) -> float | None:
    try:
        f = float(v)
        return f if f == f else None
    except Exception:
        return None


def compute_analysis(all_records: list[dict[str, Any]], banks: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    by_bank: dict[int, list[dict[str, Any]]] = {}
    for r in all_records:
        if r.get("bank_id") is not None:
            by_bank.setdefault(int(r["bank_id"]), []).append(r)
    snapshots: list[dict[str, Any]] = []
    analyses: list[dict[str, Any]] = []
    bank_updates: list[dict[str, Any]] = []
    for b in banks:
        bid = int(b["id"])
        rows = sorted(by_bank.get(bid, []), key=lambda x: (x.get("reporting_period_end") or "", int(x.get("id") or 0)), reverse=True)
        latest: dict[str, dict[str, Any]] = {}
        for r in rows:
            latest.setdefault(str(r.get("metric_key")), r)
        snap = {"bank_id": bid, "updated_at": now(), "reporting_period": None, "reporting_period_end": None}
        for key in ["assets", "deposits", "profit", "capital_adequacy", "liquidity", "npl"]:
            r = latest.get(key)
            if r:
                snap[key] = r.get("value")
                snap[f"{key}_source_url"] = r.get("source_url")
                snap[f"{key}_source_title"] = r.get("source_title")
                if snap["reporting_period"] is None:
                    snap["reporting_period"] = r.get("period_label")
                    snap["reporting_period_end"] = r.get("reporting_period_end")
        strengths: list[str] = []
        weaknesses: list[str] = []
        def vals(k: str) -> list[float]:
            return [v for v in (_float(x.get("value")) for x in rows if x.get("metric_key") == k) if v is not None]
        def threshold(k: str, label: str, good: float, higher: bool) -> None:
            v = _float(latest.get(k, {}).get("value"))
            if v is None: return
            if (v >= good and higher) or (v <= good and not higher):
                strengths.append(f"{label} is within the configured healthy reference range.")
            else:
                weaknesses.append(f"{label} is outside the configured healthy reference range.")
        threshold("capital_adequacy", "Capital adequacy", 15, True)
        threshold("liquidity", "Liquidity", 20, True)
        threshold("npl", "NPL ratio", 5, False)
        threshold("cost_to_income", "Cost-to-income ratio", 60, False)
        for key, label, higher in [("profit", "Profitability", True), ("capital_adequacy", "Capital adequacy", True), ("liquidity", "Liquidity", True), ("npl", "NPL ratio", False), ("roe", "Return on equity", True), ("cost_to_income", "Cost-to-income ratio", False)]:
            v = vals(key)
            if len(v) >= 2:
                good = v[0] > v[1] if higher else v[0] < v[1]
                (strengths if good else weaknesses).append(f"{label} improved versus the prior reported period." if good else f"{label} moved in an unfavourable direction versus the prior reported period.")
        parts = [("capital_adequacy", 25, True), ("liquidity", 20, True), ("roe", 15, True), ("roa", 10, True), ("npl", 20, False), ("cost_to_income", 10, False)]
        total = weight = 0.0
        for key, w, higher in parts:
            v = _float(latest.get(key, {}).get("value"))
            if v is None: continue
            component = min(100, max(0, v * (4 if v <= 50 else 1.5))) if higher else max(0, min(100, 100 - v * 2.5))
            total += component * w; weight += w
        score = round(total / weight) if weight else 50
        uniq_strengths = list(dict.fromkeys(strengths))[:4]
        uniq_weaknesses = list(dict.fromkeys(weaknesses))[:4]
        summary = uniq_strengths[0] if uniq_strengths else "Financial history is being built from configured official reports."
        analyses.append({"bank_id": bid, "strengths_json": json.dumps(uniq_strengths), "weaknesses_json": json.dumps(uniq_weaknesses), "generated_at": now()})
        bank_updates.append({"bank_id": bid, "health_score": score, "summary": summary, "updated_at": now()})
        snapshots.append(snap)
    return snapshots, analyses, bank_updates


