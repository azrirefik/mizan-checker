#!/usr/bin/env python3
"""LLM Quran Accuracy Benchmark - tests hallucination rates on Quran prompts.

Runs 50 prompts across available LLMs, validates each Arabic quote against the
Quran Checker API, and generates a leaderboard HTML + JSON report.

Environment variables:
  OPENAI_API_KEY     - enables GPT-4o + GPT-4o-mini
  ANTHROPIC_API_KEY  - enables Claude Sonnet
  GEMINI_API_KEY     - enables Gemini 2.0 Flash

Usage:
  # Test all available models
  python benchmark/runner.py

  # Test specific models
  python benchmark/runner.py --models openai anthropic

  # Output directory (default: benchmark/results)
  python benchmark/runner.py --output benchmark/my-results
"""

import json, os, sys, time, argparse, textwrap
from datetime import datetime, timezone
from urllib.request import Request, urlopen
from urllib.error import URLError

# ── Config ──
API_URL = os.environ.get("QURAN_API_URL", "https://quran-checker.up.railway.app/validate/batch")
BENCHMARK_DIR = os.path.dirname(os.path.abspath(__file__))
PROMPTS_FILE = os.path.join(BENCHMARK_DIR, "prompts.json")

# ── Provider clients (minimal http calls) ──

def openai_chat(model, prompt, api_key):
    r = Request("https://api.openai.com/v1/chat/completions", method="POST")
    r.add_header("Authorization", f"Bearer {api_key}")
    r.add_header("Content-Type", "application/json")
    body = json.dumps({
        "model": model,
        "messages": [{"role":"user","content": prompt}],
        "temperature": 0
    }).encode()
    resp = urlopen(r, body, timeout=60)
    data = json.loads(resp.read())
    return data["choices"][0]["message"]["content"]

def anthropic_chat(model, prompt, api_key):
    r = Request("https://api.anthropic.com/v1/messages", method="POST")
    r.add_header("x-api-key", api_key)
    r.add_header("anthropic-version", "2023-06-01")
    r.add_header("Content-Type", "application/json")
    body = json.dumps({
        "model": model,
        "max_tokens": 1024,
        "temperature": 0,
        "messages": [{"role":"user","content": prompt}]
    }).encode()
    resp = urlopen(r, body, timeout=60)
    data = json.loads(resp.read())
    return data["content"][0]["text"]

def gemini_chat(model, prompt, api_key):
    r = Request(
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}",
        method="POST"
    )
    r.add_header("Content-Type", "application/json")
    body = json.dumps({
        "contents": [{"parts":[{"text": prompt}]}],
        "generationConfig": {"temperature": 0}
    }).encode()
    resp = urlopen(r, body, timeout=60)
    data = json.loads(resp.read())
    return data["candidates"][0]["content"]["parts"][0]["text"]

# ── Provider registry ──
PROVIDERS = {
    "openai": {
        "models": [
            {"id": "gpt-4o", "name": "GPT-4o"},
            {"id": "gpt-4o-mini", "name": "GPT-4o Mini"},
        ],
        "chat": lambda model_id, prompt, key: openai_chat(model_id, prompt, key),
        "env_key": "OPENAI_API_KEY",
    },
    "anthropic": {
        "models": [
            {"id": "claude-sonnet-4-20250514", "name": "Claude Sonnet 4"},
        ],
        "chat": lambda model_id, prompt, key: anthropic_chat(model_id, prompt, key),
        "env_key": "ANTHROPIC_API_KEY",
    },
    "gemini": {
        "models": [
            {"id": "gemini-2.0-flash", "name": "Gemini 2.0 Flash"},
        ],
        "chat": lambda model_id, prompt, key: gemini_chat(model_id, prompt, key),
        "env_key": "GEMINI_API_KEY",
    },
}

# ── Extract Arabic from LLM response ──
def extract_arabic(text):
    """Extract all Arabic segments from LLM response."""
    import re
    pattern = r"[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF][\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\s\u0640]*"
    segments = re.findall(pattern, text)
    return [s.strip() for s in segments if len(s.strip()) >= 4]

# ── Validate via API ──
def validate_texts(texts):
    """Send list of Arabic texts to Quran Checker API for validation."""
    try:
        r = Request(API_URL, method="POST")
        r.add_header("Content-Type", "application/json")
        body = json.dumps({"inputs": texts}).encode()
        resp = urlopen(r, body, timeout=30)
        return json.loads(resp.read())
    except URLError as e:
        print(f"  ⚠ API error: {e}")
        return None

# ── Score a single prompt result ──
SCORING = {
    "exact_arabic_matches": 2,
    "normalized_matches": 2,
    "fabrication_penalty": -2,
}

def score_response(arabic_texts, api_result):
    """Score based on how many extracted Arabic segments are valid Quran."""
    if api_result is None or "results" not in api_result:
        return 0

    score = 0
    for item in api_result["results"]:
        if item.get("isValid"):
            if item.get("matchType") == "exact":
                score += SCORING["exact_arabic_matches"]
            else:
                score += SCORING["normalized_matches"]
        elif item.get("fabrication"):
            score += SCORING["fabrication_penalty"]
    return score

# ── HTML leaderboard ──
LEADERBOARD_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Quran LLM Accuracy Leaderboard</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f172a;color:#e2e8f0;padding:2rem 1rem}
.container{max-width:900px;margin:0 auto}
h1{font-size:1.75rem;color:#f8fafc;margin-bottom:.25rem}
.subtitle{color:#94a3b8;font-size:.875rem;margin-bottom:1.5rem}
table{width:100%;border-collapse:collapse;margin-bottom:2rem}
th{text-align:left;padding:.75rem 1rem;font-size:.75rem;color:#64748b;text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid #334155}
td{padding:.75rem 1rem;border-bottom:1px solid #1e293b;font-size:.875rem}
tr:hover td{background:#1e293b}
.rank{color:#38bdf8;font-weight:700;font-size:1.125rem}
.score{font-weight:700;font-size:1.125rem}
.bar-bg{background:#1e293b;border-radius:9999px;height:8px;overflow:hidden}
.bar-fill{background:#38bdf8;height:100%;border-radius:9999px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1rem;margin-bottom:2rem}
.stat-card{background:#1e293b;border:1px solid #334155;border-radius:8px;padding:1rem}
.stat-value{font-size:1.5rem;font-weight:700;color:#38bdf8}
.stat-label{font-size:.75rem;color:#64748b;margin-top:.25rem}
.model-breakdown{margin-bottom:2rem}
.model-card{background:#1e293b;border:1px solid #334155;border-radius:8px;padding:1.25rem;margin-bottom:.75rem}
.model-name{font-size:1rem;font-weight:700;color:#f8fafc;margin-bottom:.5rem}
.model-stats{display:flex;gap:1.5rem;flex-wrap:wrap}
.model-stat{font-size:.8125rem}
.model-stat span{color:#38bdf8;font-weight:700}
.cat-tag{display:inline-block;padding:.125rem .5rem;border-radius:4px;font-size:.75rem;margin-right:.25rem}
.cat-direct{background:rgba(34,197,94,.15);color:#22c55e}
.cat-completion{background:rgba(56,189,248,.15);color:#38bdf8}
.cat-fabrication{background:rgba(239,68,68,.15);color:#ef4444}
.cat-reference{background:rgba(250,204,21,.15);color:#facc15}
.cat-open{background:rgba(168,85,247,.15);color:#a855f7}
.footer{margin-top:3rem;font-size:.75rem;color:#475569;text-align:center}
.footer a{color:#64748b}
</style>
</head>
<body>
<div class="container">
<h1>LLM Quran Accuracy Leaderboard</h1>
<p class="subtitle">Which AI model hallucinates the fewest Quran verses? {{PROMPT_COUNT}} prompts across 5 categories. Scored by Quran Checker.</p>

<div class="stats" id="stats"></div>

<h2 style="font-size:1.125rem;margin-bottom:.75rem;color:#94a3b8">Rankings</h2>
<table>
<thead><tr><th>#</th><th>Model</th><th>Score</th><th>Accuracy</th><th>Fabrications</th></tr></thead>
<tbody id="ranks"></tbody>
</table>

<h2 style="font-size:1.125rem;margin-bottom:.75rem;color:#94a3b8">Per-Model Breakdown</h2>
<div class="model-breakdown" id="breakdown"></div>

<div class="footer">
<p>Generated by <a href="https://github.com/azrirefik/mizan-checker">Quran Checker</a> · {{DATE}}</p>
</div>
</div>

<script>
fetch('results.json').then(r=>r.json()).then(d=>{
  document.querySelector('.subtitle').textContent = `{{PROMPT_COUNT}} prompts across 5 categories. Scored by Quran Checker.`;
  const maxScore = d.results[0]?.score || 1;
  document.getElementById('stats').innerHTML = `
    <div class="stat-card"><div class="stat-value">${d.models_tested}</div><div class="stat-label">Models Tested</div></div>
    <div class="stat-card"><div class="stat-value">${d.total_prompts}</div><div class="stat-label">Prompts</div></div>
    <div class="stat-card"><div class="stat-value">${d.avg_fabrications_per_model?.toFixed(1) || 0}</div><div class="stat-label">Avg Fabrications/Model</div></div>
  `;
  const cats = {direct_quote:'Direct Quote',completion:'Completion',fabrication_bait:'Bait',reference_test:'Reference',open_ended:'Open-Ended'};
  document.getElementById('ranks').innerHTML = d.results.map((r,i)=>`
    <tr>
      <td class="rank">#${i+1}</td>
      <td><strong>${r.model}</strong></td>
      <td class="score">${r.score}<span style="font-size:.75rem;color:#64748b">/${maxScore}</span></td>
      <td><div class="bar-bg"><div class="bar-fill" style="width:${r.accuracy}%"></div></div><span style="font-size:.6875rem;color:#64748b">${r.accuracy}%</span></td>
      <td>${r.fabrication_count}</td>
    </tr>`).join('');
  document.getElementById('breakdown').innerHTML = d.results.map(r=>`
    <div class="model-card">
      <div class="model-name">${r.model} <span style="font-size:.75rem;color:#64748b;font-weight:400">(${r.provider})</span></div>
      <div class="model-stats">
        <div class="model-stat">Exact: <span>${r.exact_matches}</span></div>
        <div class="model-stat">Normalized: <span>${r.normalized_matches}</span></div>
        <div class="model-stat">Fabrications: <span style="color:#ef4444">${r.fabrication_count}</span></div>
        <div class="model-stat">Score: <span>${r.score}</span></div>
      </div>
      <div style="margin-top:.5rem">${Object.entries(r.category_scores||{}).map(([k,v])=>{
        const cls='cat-'+k.split('_')[0];
        return `<span class="cat-tag ${cls}">${cats[k]||k}: ${v}</span>`;
      }).join('')}</div>
    </div>`).join('');
});
</script>
</body>
</html>"""


def generate_leaderboard(results, prompts, output_dir):
    """Generate leaderboard HTML + JSON from results."""
    os.makedirs(output_dir, exist_ok=True)

    # Build per-model summaries
    summary = []
    for model_name, model_results in results.items():
        score = sum(r["score"] for r in model_results)
        exact = sum(1 for r in model_results if r["exact"])
        normalized = sum(1 for r in model_results if r["normalized"])
        fabrications = sum(1 for r in model_results if r["fabrications"] > 0)
        category_scores = {}
        for r in model_results:
            cat = r["category"]
            category_scores[cat] = (category_scores.get(cat, 0) + r["score"])

        summary.append({
            "model": model_name,
            "provider": r.get("provider", ""),
            "score": score,
            "max_score": len(model_results) * 2,
            "accuracy": round((score / max(len(model_results) * 2, 1)) * 100),
            "exact_matches": exact,
            "normalized_matches": normalized,
            "fabrication_count": fabrications,
            "category_scores": category_scores,
        })

    summary.sort(key=lambda x: x["score"], reverse=True)

    total_fabs = sum(s["fabrication_count"] for s in summary)
    avg_fab = total_fabs / max(len(summary), 1)

    data = {
        "date": datetime.now(timezone.utc).isoformat(),
        "prompts_file": "prompts.json",
        "total_prompts": len(prompts),
        "models_tested": len(summary),
        "avg_fabrications_per_model": round(avg_fab, 1),
        "results": summary,
    }

    # Write JSON
    json_path = os.path.join(output_dir, "results.json")
    with open(json_path, "w") as f:
        json.dump(data, f, indent=2)

    # Write HTML
    html = LEADERBOARD_HTML
    html = html.replace("{{PROMPT_COUNT}}", str(len(prompts)))
    html = html.replace("{{DATE}}", datetime.now().strftime("%B %d, %Y"))
    html_path = os.path.join(output_dir, "leaderboard.html")
    with open(html_path, "w") as f:
        f.write(html)

    return json_path, html_path


# ── Main ──
def main():
    parser = argparse.ArgumentParser(description="LLM Quran Accuracy Benchmark")
    parser.add_argument("--models", nargs="+", choices=list(PROVIDERS.keys()),
                        help="Which providers to test (default: all available)")
    parser.add_argument("--output", default=os.path.join(BENCHMARK_DIR, "results"),
                        help="Output directory (default: benchmark/results)")
    parser.add_argument("--delay", type=float, default=1.0,
                        help="Delay between API calls in seconds")
    args = parser.parse_args()

    # Load prompts
    with open(PROMPTS_FILE) as f:
        data = json.load(f)
    prompts = data["prompts"]
    print(f"📋 Loaded {len(prompts)} prompts ({len(set(p['category'] for p in prompts))} categories)\n")

    # Determine available models
    available = {}
    selected = args.models or list(PROVIDERS.keys())
    for name in selected:
        provider = PROVIDERS[name]
        key = os.environ.get(provider["env_key"])
        if key:
            available[name] = provider
            print(f"✅ {name}: {len(provider['models'])} model(s) available")
        else:
            print(f"⚠ {name}: skipped (${provider['env_key']} not set)")
    print()

    if not available:
        print("❌ No providers available. Set API keys as environment variables.")
        print("   Export one or more: OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY")
        sys.exit(1)

    # Run benchmark
    results = {}
    for prov_name, provider in available.items():
        for model_info in provider["models"]:
            model_id = model_info["id"]
            model_name = model_info["name"]
            key = os.environ[provider["env_key"]]
            print(f"🤖 Testing {model_name} ({prov_name})...")
            model_results = []

            for i, prompt_data in enumerate(prompts):
                pid = prompt_data["id"]
                cat = prompt_data["category"]
                prompt_text = prompt_data["prompt"]

                try:
                    response = provider["chat"](model_id, prompt_text, key)
                    arabic_texts = extract_arabic(response)
                    api_result = validate_texts(arabic_texts) if arabic_texts else None
                    result_score = score_response(arabic_texts, api_result) if arabic_texts else 0

                    model_results.append({
                        "prompt_id": pid,
                        "category": cat,
                        "prompt": prompt_text,
                        "response": response[:500],
                        "arabic_segments": arabic_texts,
                        "validation": api_result["results"] if api_result else [],
                        "score": result_score,
                        "exact": any(r.get("matchType") == "exact" for r in (api_result["results"] if api_result else [])),
                        "normalized": any(r.get("matchType") == "normalized" for r in (api_result["results"] if api_result else [])),
                        "fabrications": sum(1 for r in (api_result["results"] if api_result else []) if r.get("fabrication")),
                        "provider": prov_name,
                    })
                    print(f"  [{i+1:2d}/{len(prompts)}] {pid} score={result_score}")
                except Exception as e:
                    print(f"  [{i+1:2d}/{len(prompts)}] {pid} ERROR: {e}")
                    model_results.append({
                        "prompt_id": pid, "category": cat, "score": 0,
                        "error": str(e), "provider": prov_name,
                    })

                time.sleep(args.delay)  # rate limit

            key = f"{model_name} ({prov_name})"
            results[key] = model_results

    # Generate leaderboard
    json_path, html_path = generate_leaderboard(results, prompts, args.output)
    print(f"\n📊 Leaderboard: {html_path}")
    print(f"📄 Results JSON: {json_path}")

    # Print summary
    with open(json_path) as f:
        summary = json.load(f)
    print("\n🏆 Rankings:")
    for i, r in enumerate(summary["results"]):
        print(f"  {i+1}. {r['model']} - Score: {r['score']}/{r['max_score']} ({r['accuracy']}%) | Fabrications: {r['fabrication_count']}")


if __name__ == "__main__":
    main()
