# routers/scan.py
# ---------------------------------------------------------------------------
# Credibility scanning for Credify. Handles THREE input types:
#   - Image   (base64 upload)      -> AI-generation / manipulation / plausibility
#   - Article (URL)                -> source reliability + factual accuracy
#   - Text    (typed claim)        -> factual plausibility + verifiability
#
# Engines:
#   1. Groq (primary) — free, OpenAI-compatible. Used when GROQ_API_KEY is set
#      and the `openai` package is installed. A vision-capable Llama model reads
#      the actual image (or article text) and can judge whether an image is
#      AI-generated or a scene is impossible (e.g. Einstein on the Moon). It
#      follows a strict rubric so scores are decisive instead of parking at 50%.
#   2. Heuristic (fallback) — transparent, signal-based. It cannot see pixels,
#      so for images it relies on filename/caption cues and clearly lowers its
#      *confidence* rather than inventing a precise score.
# ---------------------------------------------------------------------------

import os
import re
import json
import base64
import binascii
import hashlib
import time
import urllib.request
import urllib.error
from typing import Optional
from urllib.parse import urlparse

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()


class ScanBody(BaseModel):
    input: str = ""
    image: Optional[str] = None       # base64 (no "data:" prefix)
    image_type: Optional[str] = None  # e.g. "image/png"
    filename: Optional[str] = None


# ---------------------------------------------------------------------------
#  Reference data
# ---------------------------------------------------------------------------

CREDIBLE_DOMAINS = {
    "abs-cbn.com": ("ABS-CBN News", "Center-left"),
    "news.abs-cbn.com": ("ABS-CBN News", "Center-left"),
    "gmanetwork.com": ("GMA News", "Center"),
    "rappler.com": ("Rappler", "Center-left"),
    "inquirer.net": ("Inquirer", "Center"),
    "philstar.com": ("Philippine Star", "Center"),
    "pna.gov.ph": ("Philippine News Agency", "Government"),
    "manilatimes.net": ("Manila Times", "Center-right"),
    "mb.com.ph": ("Manila Bulletin", "Center"),
    "reuters.com": ("Reuters", "Center"),
    "apnews.com": ("Associated Press", "Center"),
    "bbc.com": ("BBC", "Center"),
    "bbc.co.uk": ("BBC", "Center"),
    "nytimes.com": ("New York Times", "Center-left"),
    "theguardian.com": ("The Guardian", "Center-left"),
    "aljazeera.com": ("Al Jazeera", "Center"),
    "npr.org": ("NPR", "Center-left"),
    "who.int": ("World Health Organization", "Official"),
}
FACT_CHECK_DOMAINS = {
    "verafiles.org": ("VERA Files", "Center"),
    "factcheck.org": ("FactCheck.org", "Center"),
    "snopes.com": ("Snopes", "Center"),
    "politifact.com": ("PolitiFact", "Center-left"),
}
LOW_CRED_DOMAINS = {
    "theonion.com": ("The Onion (satire)", "Satire"),
    "adobo-chronicles.com": ("Adobo Chronicles (satire)", "Satire"),
    "babylonbee.com": ("The Babylon Bee (satire)", "Satire"),
}
ANONYMOUS_HOSTS = (
    "blogspot.", "wordpress.com", ".weebly.com", ".wixsite.com",
    "medium.com", ".tumblr.com", "facebook.com", "fb.watch",
    "t.me", "tiktok.com",
)

CLICKBAIT_PATTERNS = [
    r"you won'?t believe", r"shocking", r"doctors hate", r"one weird trick",
    r"miracle (cure|drug|remedy)", r"secret they don'?t want you to know",
    r"share (this )?before", r"gone viral", r"will blow your mind",
    r"what happened next", r"exposed!?", r"the truth about",
]
SENSATIONAL_WORDS = [
    "hoax", "coverup", "cover-up", "conspiracy", "scandal", "banned",
    "censored", "wake up", "sheeple", "plandemic", "microchip",
    "mind control", "false flag", "crisis actor",
]
ATTRIBUTION_WORDS = [
    "according to", "said", "reported", "study", "research", "data",
    "spokesperson", "official", "statement", "confirmed", "cited",
]

# Well-known debunked / impossible claims. Matching these lets the heuristic
# be decisive on common cases even without the AI engine.
KNOWN_FALSE = [
    (r"\beinstein\b.*\bmoon\b|\bmoon\b.*\beinstein\b",
     "Historically impossible - Einstein died in 1955, before any Moon landing"),
    (r"\bflat\s+earth\b", "Contradicts established science"),
    (r"vaccines?\s+cause\s+autism", "Debunked medical claim"),
    (r"5\s?g\b.*(covid|corona)", "Debunked conspiracy theory"),
    (r"(covid|corona).*\bhoax\b", "Debunked conspiracy theory"),
    (r"climate\s+change.*\bhoax\b", "Contradicts scientific consensus"),
    (r"\bmoon\s+landing\b.*\b(fake|hoax|staged)\b", "Debunked conspiracy theory"),
]

# Cues that an image is synthetic (only usable from filename/caption offline).
AI_IMAGE_HINTS = [
    "ai-generated", "aigenerated", "ai_gen", "aigen", "midjourney", "mid-journey",
    "dalle", "dall-e", "stable-diffusion", "stablediffusion", "sora ",
    "deepfake", "deep-fake", "synthetic", "gan-", "generated",
]


# ---------------------------------------------------------------------------
#  Helpers
# ---------------------------------------------------------------------------

def clamp(n, lo=0, hi=100):
    return max(lo, min(hi, int(round(n))))


def looks_like_url(text):
    t = (text or "").strip()
    return bool(re.match(r"^https?://\S+$", t)) or bool(
        re.match(r"^[\w-]+(\.[\w-]+)+(/\S*)?$", t) and " " not in t
    )


def normalize_domain(host):
    host = host.lower()
    return host[4:] if host.startswith("www.") else host


def fetch_url(url):
    if not url.startswith("http"):
        url = "https://" + url
    domain = normalize_domain(urlparse(url).netloc)
    title, text = "", ""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Credify)"})
        with urllib.request.urlopen(req, timeout=8) as resp:
            raw = resp.read(200_000).decode("utf-8", errors="ignore")
        m = re.search(r"<title[^>]*>(.*?)</title>", raw, re.I | re.S)
        if m:
            title = re.sub(r"\s+", " ", m.group(1)).strip()[:200]
        body = re.sub(r"(?is)<(script|style).*?</\1>", " ", raw)
        body = re.sub(r"(?s)<[^>]+>", " ", body)
        text = re.sub(r"\s+", " ", body).strip()[:4000]
    except Exception:
        pass
    return domain, title, text


def verdict_from(score):
    if score >= 70:
        return ("credible", "Not fake news — high confidence",
                "We're confident this is NOT fake news. It shows strong sourcing and is consistent with known facts.")
    if score >= 45:
        return ("uncertain", "Unsure — verify before sharing",
                "The signals are mixed. Treat this with caution and verify with trusted sources before believing or sharing it.")
    return ("not_credible", "Likely fake news — high confidence",
            "Highly confident this is fake news or misleading — but double-check with a trusted fact-checker to be certain.")


def spread(score, seed):
    """Anti-clustering: both the AI and the heuristic love round numbers
    (50, 60, 85...), so different items pile up on identical scores. If the
    score is a suspiciously round multiple of 5, nudge it by a small offset
    derived from a hash of the input — deterministic, so re-checking the
    SAME item gives the same score, but different items spread out. The
    nudge never crosses a verdict boundary (44/45 and 69/70 stay intact)."""
    s = clamp(score)
    if s % 5 != 0:
        return s  # already a natural-looking number
    h = int(hashlib.md5((seed or "x").encode("utf-8", "ignore")).hexdigest()[:8], 16)
    nudged = s + (h % 9) - 4  # -4 .. +4
    if s >= 70:
        nudged = max(70, nudged)
    elif s >= 45:
        nudged = min(69, max(45, nudged))
    else:
        nudged = min(44, nudged)
    return clamp(nudged)

TOPICS = [
    'Politics',
    'Health', 
    'Economy',
    'Science',
    'Celebrities',
    'Disaster',
    'Technology',
    'Gaming',
    'Other'
]

def assemble(score, confidence, input_type, breakdown, details, tags, summary, engine, topic,
             key_findings=None, recommendation=None):
    verdict, label, desc = verdict_from(score)
    full_details = [
        {"label": "Input type", "value": input_type},
        {"label": "Assessment confidence", "value": str(clamp(confidence)) + "%"},
    ] + details
    return {
        "score": clamp(score),
        "confidence": clamp(confidence),
        "verdict": verdict,
        "label": label,
        "desc": desc,
        "input_type": input_type,
        "breakdown": breakdown,
        "details": full_details,
        "topic": topic or "General",
        "tags": tags,
        "summary": summary,
        "key_findings": key_findings or [],
        "recommendation": recommendation or "",
        "engine": engine,
    }


# ---------------------------------------------------------------------------
#  Heuristic engine (fallback)
# ---------------------------------------------------------------------------

def match_known_false(text):
    low = (text or "").lower()
    for pat, reason in KNOWN_FALSE:
        if re.search(pat, low):
            return reason
    for creg, reason in load_dynamic_claims():
        if creg.search(low):
            return reason
    return None


# ── Admin-managed claims (known_claims table in Supabase) ──────
# Admins add/edit debunked-claim patterns from the dashboard; the engine
# picks them up here without a redeploy. Cached for 60s; any failure
# (table missing, Supabase down, bad env) silently falls back to the
# built-in KNOWN_FALSE list above.
_claims_cache = {"at": 0.0, "items": []}


def load_dynamic_claims():
    now = time.time()
    if now - _claims_cache["at"] < 60:
        return _claims_cache["items"]
    _claims_cache["at"] = now  # even on failure, don't retry for another 60s
    try:
        from supabase import create_client
        url = os.getenv("SUPABASE_URL")
        key = os.getenv("SUPABASE_SERVICE_KEY")
        if not url or not key:
            return _claims_cache["items"]
        sb = create_client(url, key)
        rows = (sb.table("known_claims")
                  .select("pattern, reason")
                  .eq("active", True)
                  .execute().data) or []
        items = []
        for r in rows:
            pat, reason = r.get("pattern") or "", r.get("reason") or "Flagged claim"
            if not pat:
                continue
            try:
                items.append((re.compile(pat, re.IGNORECASE), reason))
            except re.error:
                # Not valid regex? Treat it as a plain keyword phrase.
                items.append((re.compile(re.escape(pat), re.IGNORECASE), reason))
        _claims_cache["items"] = items
    except Exception:
        pass  # keep whatever we had; built-in list still applies
    return _claims_cache["items"]


def heuristic_text_or_article(user_input):
    is_url = looks_like_url(user_input)
    domain, title, page_text = "", "", ""
    if is_url:
        domain, title, page_text = fetch_url(user_input)
        analysis_text = (title + " " + page_text).strip() or user_input
        input_type = "Article"
    else:
        analysis_text = user_input
        input_type = "Text claim"

    lower = analysis_text.lower()
    words = re.findall(r"[A-Za-z']+", analysis_text)
    wc = max(1, len(words))

    publisher, bias, domain_age = "No source provided", "Unknown", "-"
    if domain in CREDIBLE_DOMAINS:
        source = 92; publisher, bias = CREDIBLE_DOMAINS[domain]; domain_age = "Established outlet"
    elif domain in FACT_CHECK_DOMAINS:
        source = 95; publisher, bias = FACT_CHECK_DOMAINS[domain]; domain_age = "Fact-checking org"
    elif domain in LOW_CRED_DOMAINS:
        source = 12; publisher, bias = LOW_CRED_DOMAINS[domain]; domain_age = "Satire / flagged"
    elif domain:
        source = 50; publisher = domain
        if any(h in domain for h in ANONYMOUS_HOSTS):
            source -= 18; publisher = domain + " (self-published)"
        if not user_input.strip().lower().startswith("https"):
            source -= 6
        if len(re.findall(r"[-0-9]", domain)) >= 4:
            source -= 8
        if domain.rsplit(".", 1)[-1] in ("gov", "edu", "int"):
            source += 15
    else:
        source = 42

    factual = 62
    known_false = match_known_false(analysis_text)
    clickbait = sum(1 for p in CLICKBAIT_PATTERNS if re.search(p, lower))
    sensational = sum(1 for w in SENSATIONAL_WORDS if w in lower)
    factual -= clickbait * 12 + sensational * 10
    caps = [w for w in words if len(w) >= 3 and w.isupper()]
    caps_ratio = len(caps) / wc
    if caps_ratio > 0.12: factual -= 16
    elif caps_ratio > 0.05: factual -= 7
    exclaims = analysis_text.count("!")
    if exclaims >= 4: factual -= 12
    elif exclaims >= 2: factual -= 5
    if known_false:
        factual = min(factual, 8)

    neutral = 76 - sensational * 10 - clickbait * 6
    if caps_ratio > 0.08: neutral -= 12

    verify = 40
    attribution = sum(1 for a in ATTRIBUTION_WORDS if a in lower)
    verify += min(attribution * 8, 32)
    if is_url or re.search(r"https?://", analysis_text): verify += 8
    if wc < 12 and not is_url: verify -= 10
    if domain in CREDIBLE_DOMAINS or domain in FACT_CHECK_DOMAINS: verify += 16

    source, factual, neutral, verify = map(clamp, (source, factual, neutral, verify))

    if is_url:
        score = 0.38 * source + 0.30 * factual + 0.14 * neutral + 0.18 * verify
    else:
        score = 0.22 * source + 0.46 * factual + 0.14 * neutral + 0.18 * verify
    if domain in LOW_CRED_DOMAINS:
        score = min(score, 28)
    if known_false:
        score = min(score, 12)
    score = clamp(score)

    confidence = 45
    if domain in CREDIBLE_DOMAINS or domain in FACT_CHECK_DOMAINS or domain in LOW_CRED_DOMAINS:
        confidence += 30
    if known_false:
        confidence = 88
    if clickbait or sensational:
        confidence += 12
    if not domain and wc < 10:
        confidence -= 15
    confidence = clamp(confidence)

    if is_url:
        breakdown = [
            {"label": "Source reliability", "value": source},
            {"label": "Factual accuracy", "value": factual},
            {"label": "Neutrality", "value": neutral},
            {"label": "Transparency", "value": verify},
        ]
    else:
        breakdown = [
            {"label": "Factual plausibility", "value": factual},
            {"label": "Attribution", "value": verify},
            {"label": "Neutrality", "value": neutral},
            {"label": "Source reliability", "value": source},
        ]

    details = [{"label": "Publisher", "value": publisher}]
    if is_url:
        details += [
            {"label": "Domain", "value": domain or "-"},
            {"label": "Domain status", "value": domain_age},
            {"label": "Bias", "value": bias},
        ]

    tags = [{"text": ("\U0001F517 Article" if is_url else "\U0001F4DD Text claim"), "kind": "gray"}]
    if source >= 80: tags.append({"text": "\u2713 Reputable source", "kind": "green"})
    elif source < 35 and domain: tags.append({"text": "\u2717 Unverified source", "kind": "red"})
    if known_false: tags.append({"text": "\u2717 Matches known false claim", "kind": "red"})
    if clickbait: tags.append({"text": "\u26A0 Clickbait language", "kind": "yellow"})
    if sensational: tags.append({"text": "\u26A0 Sensational wording", "kind": "yellow"})
    if "Satire" in bias: tags.append({"text": "\u2717 Satire / parody", "kind": "red"})

    summary = build_summary(score, publisher, is_url, known_false,
                            clickbait, sensational, verify, confidence,
                            attribution=attribution, wc=wc)

    # Spread suspiciously round scores so different items don't all land on
    # the same number (deterministic per input, band-safe).
    score = spread(score, user_input)
    confidence = spread(confidence, user_input + "::conf")
    for dim in breakdown:
        dim["value"] = spread(dim["value"], user_input + "::" + dim["label"])

    key_findings = []
    key_findings.append("Source: " + publisher + ((" (" + domain_age + ")") if is_url and domain_age != "-" else ""))
    if known_false:
        key_findings.append("Matches a known debunked claim: " + known_false)
    if attribution:
        key_findings.append(str(attribution) + " attribution cue(s) found - quotes, officials, studies, or data")
    else:
        key_findings.append("No attribution detected - nothing traces the claims to an accountable source")
    if clickbait:
        key_findings.append(str(clickbait) + " clickbait-style phrase(s) in the wording")
    if sensational:
        key_findings.append(str(sensational) + " sensational or conspiratorial term(s) used")
    if caps_ratio > 0.05:
        key_findings.append("Heavy ALL-CAPS emphasis, a common marker of manipulative content")
    if is_url and not (clickbait or sensational or known_false):
        key_findings.append("Language stays largely neutral, with no emotional-manipulation patterns")

    return assemble(score, confidence, input_type, breakdown, details, tags,
                    summary, "heuristic", "Other",
                    key_findings=key_findings[:6],
                    recommendation=build_recommendation(score))


def build_summary(score, publisher, is_url, known_false, clickbait,
                  sensational, verify, confidence, attribution=0, wc=0):
    parts = []
    what = "the linked article" if is_url else "the submitted text claim"
    parts.append("Credify analyzed " + what +
                 (" from " + publisher if publisher and publisher != "No source provided" else "") + ".")
    if known_false:
        parts.append("It matches a known false or debunked claim: " + known_false +
                     ". That alone caps the score in the lowest band, because repeating "
                     "an already-debunked claim is one of the clearest markers of misinformation.")
    elif score >= 70:
        parts.append("The strongest signals in its favor: a recognizable, established source"
                     + (", " + str(attribution) + " attribution cue(s) such as quotes, named "
                        "officials, or cited studies" if attribution else "")
                     + ", and language that stays largely neutral rather than emotional.")
        parts.append("No debunked claims, clickbait framing, or sensational trigger words were detected.")
    elif score >= 45:
        parts.append("Nothing here confirms or debunks the content outright. Some signals point "
                     "each way, which is why it lands in the middle band rather than a confident verdict.")
        if attribution:
            parts.append("It does include " + str(attribution) + " attribution cue(s), which helps, "
                         "but not enough to verify the claims independently.")
        else:
            parts.append("It makes assertions without citing sources, officials, or data that "
                         "could be independently checked.")
    else:
        parts.append("Multiple warning signs typical of low-quality or misleading content were found, "
                     "and they outweigh any positive signals.")
    if clickbait:
        parts.append("The wording uses " + str(clickbait) + " clickbait-style pattern(s) - "
                     "phrasing engineered for shares rather than accuracy.")
    if sensational:
        parts.append(str(sensational) + " sensational or conspiratorial term(s) appear, which "
                     "credible reporting tends to avoid.")
    if verify < 45 and not known_false:
        parts.append("Little sourcing or attribution was detected, so the claims can't be traced "
                     "back to anyone accountable.")
    if confidence < 45:
        parts.append("Confidence is low because there was little material to analyze - treat the "
                     "score as a rough signal, not a ruling.")
    parts.append("This is an automated, signal-based estimate; for anything important, "
                 "cross-check with trusted fact-checkers such as VERA Files or FactCheck.org.")
    return " ".join(parts)


def build_recommendation(score):
    if score >= 70:
        return ("This looks safe to trust and share, but no automated check is perfect - "
                "for high-stakes decisions, confirm directly with the original source.")
    if score >= 45:
        return ("Hold off on sharing this. Search the claim on VERA Files, Rappler Fact Check, "
                "or Google Fact Check Explorer first, and treat it as unverified until confirmed.")
    return ("Do not share this content. If you've seen it circulating, check it against trusted "
            "fact-checkers - and consider reporting the post where you found it.")


def heuristic_image(caption, filename):
    hay = ((filename or "") + " " + (caption or "")).lower()
    ai_hit = any(h in hay for h in AI_IMAGE_HINTS)
    known_false = match_known_false(caption or "") or match_known_false(filename or "")

    if ai_hit or known_false:
        score, confidence = 10, 75
        auth, plaus, consist, prov = 8, (10 if known_false else 25), 20, 15
        summary = ("Signals indicate this image is likely AI-generated or fabricated"
                   + ((" - " + known_false + ".") if known_false else " (based on its filename/caption).")
                   + " Enable the Groq vision engine (set GROQ_API_KEY) for a full pixel-level analysis.")
        tags = [{"text": "\U0001F5BC\uFE0F Image", "kind": "gray"},
                {"text": "\u2717 Likely AI-generated / fabricated", "kind": "red"}]
    else:
        score, confidence = 45, 20
        auth, plaus, consist, prov = 45, 50, 45, 30
        summary = ("Image authenticity can't be verified without the AI vision engine. "
                   "Enable Groq (set GROQ_API_KEY) so Credify can inspect the pixels "
                   "for AI-generation, manipulation, and scene plausibility. Until then this "
                   "is an unverified estimate, not a confirmation.")
        tags = [{"text": "\U0001F5BC\uFE0F Image", "kind": "gray"},
                {"text": "\u26A0 Not verified (AI engine off)", "kind": "yellow"}]

    breakdown = [
        {"label": "Authenticity", "value": auth},
        {"label": "Scene plausibility", "value": plaus},
        {"label": "Visual consistency", "value": consist},
        {"label": "Provenance", "value": prov},
    ]
    details = []
    if filename:
        details.append({"label": "File", "value": filename})
    if caption:
        details.append({"label": "Caption", "value": caption[:80]})

    seed = (filename or "") + (caption or "")
    score = spread(score, seed)
    for dim in breakdown:
        dim["value"] = spread(dim["value"], seed + "::" + dim["label"])

    if ai_hit or known_false:
        key_findings = [
            "The filename or caption itself signals AI generation or fabrication",
            ("Matches a known debunked claim: " + known_false) if known_false
                else "Provenance cannot be established for this image",
            "Pixel-level inspection was NOT performed (AI vision engine is off)",
        ]
    else:
        key_findings = [
            "No AI-generation hints in the filename or caption",
            "Pixel-level inspection was NOT performed (AI vision engine is off)",
            "Authenticity, manipulation, and scene plausibility remain unverified",
        ]

    return assemble(score, confidence, "Image", breakdown, details, tags,
                    summary, "heuristic", "Gaming",
                    key_findings=key_findings,
                    recommendation=build_recommendation(score))


# ---------------------------------------------------------------------------
#  Groq engine (primary) - free, OpenAI-compatible
# ---------------------------------------------------------------------------
#  Setup:
#    1) Get a free key (no credit card) at https://console.groq.com/keys
#    2) pip install openai
#    3) Put GROQ_API_KEY=... in your .env
#  Model IDs occasionally change - check https://console.groq.com/docs/models
#  and override with GROQ_MODEL if the default stops working. The default is a
#  vision-capable model so it can read both images AND article text.
# ---------------------------------------------------------------------------

GROQ_BASE_URL = "https://api.groq.com/openai/v1"
GROQ_DEFAULT_MODEL = "qwen/qwen3.6-27b"  # handles text + vision

SYSTEM_PROMPT = """You are the analysis engine for Credify, a misinformation-detection app.
You assess the CREDIBILITY of ONE submitted item: an IMAGE or an ARTICLE (news URL/text).
(You may also receive a plain TEXT claim.)

Return ONLY a JSON object (no markdown, no backticks) with EXACTLY this shape:
{
  "score": <int 0-100>,
  "confidence": <int 0-100>,
  "verdict": "credible" | "uncertain" | "not_credible",
  "breakdown": [ {"label": "<dimension>", "value": <int 0-100>} ],
  "details":   [ {"label": "<key>", "value": "<short value>"} ],
  "flags":     ["<short warning or note>"],
  "key_findings": ["<4-6 specific, concrete findings about THIS item, one short sentence each>"],
  "summary": "<5-8 sentences of detailed plain-English analysis>",
  "recommendation": "<1-2 sentences telling the reader exactly what to do next>",
  "topic": "<one value from this exact list: Politics, Health, Economy, Science, Celebrities, Disaster, Technology, Gaming, Other>",
}

Scoring bands (verdict MUST match the score):
- 70-100 -> "credible":     confidently NOT fake news. Verified, well-sourced, consistent with known facts.
- 45-69  -> "uncertain":    mixed or thin signals. Cannot confirm or debunk. Reader should verify.
- 0-44   -> "not_credible": high confidence of fake/misleading content - fabricated, manipulated,
             debunked, impossible, or riddled with misinformation markers.

NUMBER RULES (critical - follow exactly):
- Use PRECISE integers that reflect your actual assessment: 73, 41, 88, 62, 17, 94...
- NEVER use round multiples of 5 or 10 (never 50, 60, 75, 85, 90...). Round numbers look lazy.
- Every breakdown value must DIFFER from the other breakdown values AND from the overall score.
- Spread across the full band: a weak-but-not-terrible item might be 38, an extremely fabricated one 6.
- Be decisive. Never park at the midpoint. If evidence is thin, LOWER the confidence instead.

SUMMARY RULES: write 5-8 sentences that cover, in order:
(1) what exactly was analyzed, (2) the strongest credibility signals found,
(3) the strongest warning signs found, (4) how you weighed them to reach the score,
(5) any important context or caveat the reader should know. Be specific to THIS item -
name the source, quote a suspicious phrase, describe the visual artifact - never generic filler.

KEY_FINDINGS: concrete, specific observations ("The article cites two named health officials",
"Shadows fall in two different directions", "The domain was registered to mimic a real outlet") -
not vague statements like "the source is questionable".

RECOMMENDATION: actionable next step matched to the verdict (share it / verify it first on
specific fact-checking sites / do not share and warn others).

TOPIC RULE: the "topic" field must be exactly one value from this list (case-sensitive):
Politics, Health, Economy, Science, Celebrities, Disaster, Technology, Gaming, Other
Pick the single best match for the content. If nothing fits, use "Other".

Never leave it blank, never invent new categories.
IMAGE rules (critical):
- If the image is AI-generated, digitally manipulated, or depicts a physically or
  HISTORICALLY IMPOSSIBLE scene (e.g. a person on the Moon who died before spaceflight,
  impossible physics, fabricated events), the score MUST be 0-15 and verdict "not_credible".
- Inspect lighting/shadow consistency, anatomy (hands, eyes, teeth), garbled text,
  repeating textures, and whether the depicted event could actually have happened.
- Use breakdown dimensions: "Authenticity", "Scene plausibility", "Visual consistency", "Provenance".

ARTICLE rules: weigh source reliability, factual accuracy, neutrality, transparency.
  Dimensions: "Source reliability", "Factual accuracy", "Neutrality", "Transparency".

TEXT rules: weigh factual plausibility vs known facts, attribution, neutrality, verifiability.
  Historically/scientifically impossible claims are not_credible (0-24).
  Dimensions: "Factual plausibility", "Attribution", "Neutrality", "Verifiability"."""


def groq_scan(body, page_context=""):
    key = os.getenv("GROQ_API_KEY")
    if not key:
        return None
    try:
        from openai import OpenAI
    except ImportError:
        print("[scan] openai package not installed (pip install openai); using heuristic.")
        return None

    is_image = bool(body.image)
    is_url = (not is_image) and looks_like_url(body.input)
    input_type = "Image" if is_image else ("Article" if is_url else "Text claim")
    model = os.getenv("GROQ_MODEL", GROQ_DEFAULT_MODEL)

    try:
        client = OpenAI(api_key=key, base_url=GROQ_BASE_URL)

        if is_image:
            try:
                base64.b64decode(body.image)  # validate before sending
            except (binascii.Error, ValueError):
                return None
            data_url = "data:" + (body.image_type or "image/png") + ";base64," + body.image
            prompt = ("Analyze this IMAGE for credibility. "
                      "Filename: " + (body.filename or "unknown") + ". "
                      "User caption/claim: " + (body.input or "(none)"))
            user_content = [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": data_url}},
            ]
        elif is_url:
            prompt = ("Analyze this ARTICLE for credibility.\nURL: " + body.input +
                      "\nFetched content (truncated):\n" + page_context[:3500])
            user_content = prompt
        else:
            prompt = "Analyze this TEXT claim for credibility:\n\n" + body.input
            user_content = prompt

        resp = client.chat.completions.create(
            model=model,
            temperature=0.5,   # slight variance so scores don't cluster
            max_tokens=4000,   # thinking models need room for reasoning + JSON
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
        )
        raw = (resp.choices[0].message.content or "").strip()
        text = re.sub(r"^```(json)?|```$", "", raw).strip()
        text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            # Model wrapped the JSON in prose — grab the outermost {...} block.
            m = re.search(r"\{.*\}", text, re.DOTALL)
            if not m:
                print("[scan] Groq returned non-JSON. First 300 chars: " + text[:300])
                return None
            data = json.loads(m.group(0))

        seed = (body.input or "") + (body.filename or "")
        score = spread(clamp(data.get("score", 50)), seed)
        confidence = spread(clamp(data.get("confidence", 60)), seed + "::conf")
        breakdown = []
        for item in (data.get("breakdown") or [])[:4]:
            label = str(item.get("label", ""))[:40]
            breakdown.append({"label": label,
                              "value": spread(clamp(item.get("value", score)), seed + "::" + label)})
        details = []
        for item in (data.get("details") or [])[:6]:
            details.append({"label": str(item.get("label", ""))[:40],
                            "value": str(item.get("value", ""))[:90]})

        key_findings = [str(f)[:180] for f in (data.get("key_findings") or [])[:6]]
        recommendation = str(data.get("recommendation", ""))[:400]

        flags = data.get("flags") or []
        icon = {"Image": "\U0001F5BC\uFE0F Image", "Article": "\U0001F517 Article",
                "Text claim": "\U0001F4DD Text claim"}[input_type]
        tags = [{"text": icon, "kind": "gray"}]
        for f in flags[:4]:
            fl = str(f).lower()
            if any(w in fl for w in ("fake", "ai", "manipulat", "false", "fabricat", "impossible")):
                kind = "red"
            elif any(w in fl for w in ("caution", "unverified", "bias", "mixed")):
                kind = "yellow"
            else:
                kind = "green"
            tags.append({"text": str(f)[:40], "kind": kind})

        summary = str(data.get("summary", "")) or "Analysis complete."
        raw_topic = str(data.get("topic", "Other")).strip()
        # Strip quotes the model sometimes adds
        raw_topic = raw_topic.strip('"\'')
        topic = raw_topic if raw_topic in TOPICS else "Other"
        print("topic:")
        print(topic)
        return assemble(score, confidence, input_type, breakdown, details, tags,
                        summary, "groq", topic=topic, key_findings=key_findings, 
                        recommendation=recommendation)
    except Exception as e:
        print("[scan] Groq call failed (" + str(e) + "); using heuristic.")
        return None


# ---------------------------------------------------------------------------
#  Route
# ---------------------------------------------------------------------------

@router.post("/scan")
async def scan(body: ScanBody):
    has_image = bool(body.image)
    has_text = bool((body.input or "").strip())
    if not has_image and not has_text:
        return {"error": "Empty input"}

    page_context = ""
    if not has_image and looks_like_url(body.input):
        _, title, text = fetch_url(body.input)
        page_context = title + "\n" + text
    
    smart = groq_scan(body, page_context)
    print(smart)
    if smart:
        return smart

    if has_image:
        print(heuristic_image(body.input, body.filename))
        return heuristic_image(body.input, body.filename)
    print(heuristic_text_or_article(body.input.strip()))
    return heuristic_text_or_article(body.input.strip())