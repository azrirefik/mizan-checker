# Mizan

LLMs hallucinate Quran verses. Not slightly wrong, completely fabricated - Arabic text that looks legit but doesn't exist anywhere in the Quran. I built this to catch that.

Turns out the fix is a normalization pipeline and a lookup table. Strip diacritics, normalize letter variants (alef, yeh, ta marbuta, hamza carriers), collapse whitespace, then check against a pre-computed index of all 6,236 verses. If it's not in the index, it's not Quran.

## Try it

- **Web app** - [azrirefik.github.io/mizan-checker](https://azrirefik.github.io/mizan-checker) - paste Arabic text, get instant validation. Works offline (PWA).
- **Chrome extension** - auto-detects and validates Quran quotes on any webpage.
- **npm package** - `npm install mizan-checker`
- **REST API** - FastAPI, deployed via Docker on Railway.

## How it actually works

```
Input: "بسم الله الرحمان الرحيم" (common simplified spelling)
  |
  v  NFKC + strip bidi markers + remove diacritics + normalize variants
  |
"بسم الله الرحمن الرحيم"
  |
  v  lookup in Map<normalized_text, Verse[]>
  |
Match: 1:1 (Al-Fatiha)
  |
  v  return authentic Uthmani text
  |
"بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ"
```

The normalization handles: alef variants (ا/أ/إ/آ/ٱ), yeh/alef maqsura (ي/ى), ta marbuta/heh (ة/ه), hamza carriers, tatweel, and small letters. Basmala is pre-stripped from verse 1 of each surah (except Al-Fatiha) so lookups work regardless of whether the input includes it.

If a verse doesn't match at all, fabrication analysis kicks in: greedy longest-contiguous-match against the full Quran corpus to show exactly which words are real and which are invented.

## Quick start

```ts
import { QuranValidator } from 'mizan-checker';

const validator = new QuranValidator();
const result = validator.validate("بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ");
// { isValid: true, reference: "1:1", matchType: "exact" }
```

### With LLM output

```ts
import { LLMProcessor, SYSTEM_PROMPTS } from 'mizan-checker';

const processor = new LLMProcessor({ autoCorrect: true });
const result = processor.process(llmResponse);

if (!result.allValid) {
  console.log('Corrected:', result.correctedText);
}
```

## What I learned

- Arabic text normalization is surprisingly deep. Unicode has multiple representations for the same visual character, and every Quran data source uses slightly different encoding.
- The Basmala edge case was the hardest bug. AlQuran.cloud's data prepends Basmala to verse 1 of every surah, so "قُلْ هُوَ ٱللَّهُ أَحَدٌ" (112:1) wouldn't match until I pre-stripped it during indexing.
- Substring matching is a trap. My first approach scanned all 6,236 verses on every failed lookup. O(n) with false positive risk. Pre-computed hash map is the right answer.

## Limitations

- Quran data is from [AlQuran.cloud](https://alquran.cloud/api) (Uthmani script). Different Quran texts (Indopak, Simple) may normalize differently.
- The benchmark framework exists but needs API keys to run against live models. Sample results are placeholders.
- Chrome extension works but isn't on the Chrome Web Store yet (needs $5 developer fee).

## License

MIT
