import json
import re
import unicodedata
from pathlib import Path
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="Quran Checker API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Data loading ──
DATA_PATH = Path(__file__).parent / "quran-verses.min.json"

verses = []
verse_map: dict[str, list[dict]] = {}
corpus_text = ""

def norm_key(text: str) -> str:
    s = unicodedata.normalize("NFKD", text)
    s = re.sub(r"[\u200c\u200d\u200e\u200f\u061c]", "", s)
    s = re.sub(r"[\u064B-\u065F\u0670\u06D6-\u06ED]", "", s)
    s = re.sub(r"[أإآٱ]", "ا", s)
    s = re.sub(r"ءا", "ا", s)  # ponytail: hamza+alef in Quranic "ءامنوا" collapses to "ا"
    s = re.sub(r"[ى]", "ي", s)
    s = re.sub(r"[ة]", "ه", s)
    s = re.sub(r"[ؤ]", "و", s)
    s = re.sub(r"[ئ]", "ي", s)
    s = re.sub(r"[\u0640\u06E5\u06E6]", "", s)
    s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(r"^يا ايها", "يايها", s)  # ponytail: vocative join, add more if reported
    return s

def exact_key(text: str) -> str:
    s = unicodedata.normalize("NFKD", text)
    s = re.sub(r"[\u200c\u200d\u200e\u200f\u061c]", "", s)
    s = re.sub(r"\u0671", "\u0627", s)
    s = re.sub(r"\u0670", "", s)
    s = re.sub(r"[\u0640\u06E5\u06E6]", "", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s

def load_data():
    global verses, verse_map, corpus_text
    with open(DATA_PATH, "r", encoding="utf-8") as f:
        verses = json.load(f)
    parts = []
    for v in verses:
        key = norm_key(v["text"])
        verse_map.setdefault(key, []).append(v)
        parts.append(key)

    # Pre-compute Basmala-stripped keys for verse-1s
    # AlQuran.cloud prepends Basmala to verse 1 of every Surah (except At-Tawbah).
    # Without this, "قُلْ هُوَ ٱللَّهُ أَحَدٌ" won't match 112:1 because the stored
    # text is "بسمله + قُلْ هُوَ ٱللَّهُ أَحَدٌ".
    basmala = next((v["text"] for v in verses if v["surah"] == 1 and v["ayah"] == 1), None)
    if basmala:
        basmala_len = len(basmala)
        for v in verses:
            if v["ayah"] == 1 and v["surah"] != 1 and v["text"].startswith(basmala):
                stripped = v["text"][basmala_len:].strip()
                if stripped:
                    v["displayText"] = stripped
                    sk = norm_key(stripped)
                    verse_map.setdefault(sk, []).append(v)

    corpus_text = " ".join(parts)

# Pre-compute verse-level normalized texts for partial + multi-verse matching
def _populate_verse_keys():
    global verse_keys
    verse_keys = [(v, norm_key(v.get("displayText", v["text"]))) for v in verses]

load_data()
_populate_verse_keys()

# ── Models ──
class ValidateRequest(BaseModel):
    text: str

class WordAnalysis(BaseModel):
    word: str
    is_fabricated: bool

class FabricationResult(BaseModel):
    total_words: int
    fabricated_words: int
    fabricated_ratio: float

class VerseSegment(BaseModel):
    reference: str
    surah: int
    ayah: int
    matched_text: str

# ponytail: hardcoded muqatta'at, 14 known combinations across 29 surahs
MUQATTAAT = {
    "ص": [38],
    "ق": [50],
    "ن": [68],
    "طه": [20],
    "طس": [27],
    "يس": [36],
    "حم": [40, 41, 42, 43, 44, 45, 46],
    "الم": [2, 3, 29, 30, 31, 32],
    "الر": [10, 11, 12, 14, 15],
    "طسم": [26, 28],
    "المص": [7],
    "المر": [13],
    "كهيعص": [19],
    "حم عسق": [42],
}


class ValidationResult(BaseModel):
    is_valid: bool
    match_type: str  # "exact" | "normalized" | "partial" | "multi_verse" | "muqattaat" | "none"
    reference: str | None = None
    matched_text: str | None = None
    translation: str | None = None
    corrected_text: str | None = None
    normalized_input: str | None = None
    word_analysis: list[WordAnalysis] | None = None
    fabrication: FabricationResult | None = None
    suggestions: list[str] | None = None
    partial_matches: list[str] | None = None
    partial_count: int | None = None
    multi_verse: list[VerseSegment] | None = None
    unmatched_words: list[str] | None = None
    muqattaat_surahs: list[int] | None = None

# ── Logic ──
def analyze_fabrication(text: str) -> tuple[list[WordAnalysis], FabricationResult]:
    key = norm_key(text)
    words = key.split()
    if not words:
        return [], FabricationResult(total_words=0, fabricated_words=0, fabricated_ratio=0)

    results = []
    i = 0
    while i < len(words):
        lo, hi, best = 1, len(words) - i, 0
        while lo <= hi:
            mid = (lo + hi) // 2
            candidate = " ".join(words[i : i + mid])
            if candidate in corpus_text:
                best = mid
                lo = mid + 1
            else:
                hi = mid - 1

        if best > 0:
            for j in range(i, i + best):
                results.append(WordAnalysis(word=words[j], is_fabricated=False))
            i += best
        else:
            results.append(WordAnalysis(word=words[i], is_fabricated=True))
            i += 1

    fab_count = sum(1 for w in results if w.is_fabricated)
    return results, FabricationResult(
        total_words=len(results),
        fabricated_words=fab_count,
        fabricated_ratio=fab_count / len(results) if results else 0,
    )


def find_partial_matches(trimmed_key: str, limit: int = 3) -> tuple[list[str], int]:
    """Find verses whose normalized text contains trimmed_key as a substring.
    Also matches when the input has a space that's not in the verse (e.g.,
    user types 'يا ايها' but verse has 'يايها'). Returns (top_references, total_count)."""
    if not trimmed_key or len(trimmed_key) < 2:
        return [], 0
    no_space = trimmed_key.replace(" ", "")
    refs = []
    total = 0
    for v, verse_key in verse_keys:
        verse_no_space = verse_key.replace(" ", "")
        if trimmed_key in verse_key or no_space in verse_no_space:
            total += 1
            if len(refs) < limit:
                refs.append(f"{v['surah']}:{v['ayah']}")
    return refs, total


def find_multi_verse_match(trimmed_key: str) -> tuple[list[VerseSegment], list[str]]:
    """Greedy: map input word sequence to consecutive FULL verse references.
    At each position, find the longest verse whose no-space text exactly
    matches the input starting at pos. Only full verse matches count
    (no partials). Returns (segments, unmatched_words)."""
    words = trimmed_key.split()
    if not words:
        return [], []
    word_char_lens = [len(w) for w in words]
    cumulative = [0]
    for cl in word_char_lens:
        cumulative.append(cumulative[-1] + cl)
    total_chars = cumulative[-1]
    no_space = trimmed_key.replace(" ", "")
    if len(no_space) != total_chars:
        no_space = trimmed_key
    segments: list[VerseSegment] = []
    unmatched: list[str] = []
    pos = 0
    verse_word_lists: list[tuple[dict, list[str]]] = [
        (v, vk.split()) for v, vk in verse_keys
    ]
    while pos < total_chars:
        word_idx = next(i for i, c in enumerate(cumulative[1:]) if c > pos)
        best_v = None
        best_match_chars = 0
        for v, vw in verse_word_lists:
            if not vw:
                continue
            v_no_space = "".join(vw)
            # Check if full verse matches input starting at pos
            if pos + len(v_no_space) > total_chars:
                continue
            if no_space[pos:pos + len(v_no_space)] == v_no_space:
                if len(v_no_space) > best_match_chars:
                    best_match_chars = len(v_no_space)
                    best_v = v
        if best_v and best_match_chars > 0:
            display = best_v.get("displayText", best_v["text"])
            segments.append(VerseSegment(
                reference=f"{best_v['surah']}:{best_v['ayah']}",
                surah=best_v["surah"],
                ayah=best_v["ayah"],
                matched_text=display,
            ))
            pos += best_match_chars
        else:
            unmatched.append(words[word_idx])
            pos += word_char_lens[word_idx]
    return segments, unmatched


def validate_text(text: str) -> ValidationResult:
    trimmed = text.strip()
    if not re.search(r"[\u0600-\u06FF]", trimmed):
        return ValidationResult(is_valid=False, match_type="none")

    key = norm_key(trimmed)

    # ponytail: muqatta'at detection, finite known set of 14 combinations
    muq_surahs = MUQATTAAT.get(key)
    if muq_surahs:
        ref = f"{muq_surahs[0]}:1"
        first_v = next((v for v in verses if v["surah"] == muq_surahs[0] and v["ayah"] == 1), None)
        matched = first_v.get("displayText", first_v["text"]) if first_v else trimmed
        return ValidationResult(
            is_valid=True,
            match_type="muqattaat",
            reference=ref,
            matched_text=matched,
            translation=first_v.get("translation") if first_v else None,
            normalized_input=key,
            muqattaat_surahs=muq_surahs,
        )

    matches = verse_map.get(key)

    if matches and len(matches) > 0:
        verse = matches[0]
        display_text = verse.get("displayText", verse["text"])
        is_exact = exact_key(trimmed) == exact_key(display_text)
        return ValidationResult(
            is_valid=True,
            match_type="exact" if is_exact else "normalized",
            reference=f"{verse['surah']}:{verse['ayah']}",
            matched_text=display_text,
            translation=verse.get("translation"),
            corrected_text=None if is_exact else display_text,
            normalized_input=key,
            suggestions=[f"{v['surah']}:{v['ayah']}" for v in matches[1:4]] if len(matches) > 1 else None,
        )

    # Try partial-verse matching: input is a substring of some verse's text
    partial_refs, partial_count = find_partial_matches(key)
    if partial_refs:
        return ValidationResult(
            is_valid=True,
            match_type="partial",
            normalized_input=key,
            partial_matches=partial_refs,
            partial_count=partial_count,
        )

    # Try multi-verse matching: input covers multiple consecutive verses
    mv_segments, mv_unmatched = find_multi_verse_match(key)
    if mv_segments:
        total_input_words = len(key.split())
        matched_input_words = total_input_words - len(mv_unmatched)
        # Require: at least 2 segments, at least 50% of input words matched,
        # and at least 3 words matched.
        if (
            len(mv_segments) >= 2
            and matched_input_words >= max(3, total_input_words * 0.5)
        ):
            return ValidationResult(
                is_valid=(len(mv_unmatched) == 0),
                match_type="multi_verse",
                normalized_input=key,
                multi_verse=mv_segments,
                unmatched_words=mv_unmatched if mv_unmatched else None,
            )

    words, fab = analyze_fabrication(trimmed)
    return ValidationResult(
        is_valid=False,
        match_type="none",
        normalized_input=key,
        word_analysis=words,
        fabrication=fab,
    )


# ── Routes ──
@app.get("/health")
def health():
    return {"status": "ok", "verses_loaded": len(verses)}


@app.post("/validate", response_model=ValidationResult)
def validate(req: ValidateRequest):
    if not req.text or len(req.text.strip()) == 0:
        raise HTTPException(status_code=400, detail="Text cannot be empty")
    return validate_text(req.text)


@app.post("/validate/batch", response_model=list[ValidationResult])
def validate_batch(req: ValidateRequest):
    if not req.text:
        raise HTTPException(status_code=400, detail="Text cannot be empty")
    lines = [line.strip() for line in req.text.split("\n") if line.strip()]
    if not lines:
        raise HTTPException(status_code=400, detail="No valid lines found")
    return [validate_text(line) for line in lines]
