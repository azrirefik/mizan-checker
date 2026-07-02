import type {
    QuranVerse,
    QuranSurah,
    ValidationResult,
    DetectionResult,
    ValidatorOptions,
    MatchType,
    FabricationAnalysis,
    WordAnalysis,
    VerseSegment,
} from './types';
import {
    normalizeArabic,
    containsArabic,
    extractArabicSegments,
} from './normalizer';

/**
 * Aggressive normalization for fabrication checking using stripHamza option.
 * This handles LLM output vs Uthmani differences by stripping hamza carriers
 * and normalizing alef maqsura.
 */
function normalizeFabrication(text: string): string {
    return normalizeArabic(text, { stripHamza: true });
}

/**
 * Normalization for verse lookup. Strips diacritics and normalizes alef
 * variants but does NOT strip hamza (which would destroy alef wasla ٱ).
 */
function verseLookupKey(text: string): string {
    let s = text.normalize('NFKC');
    s = s.replace(/[\u200c\u200d\u200e\u200f\u061c]/g, '');
    s = s.replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, '');
    s = s.replace(/[أإآٱ]/g, 'ا');
    s = s.replace(/ءا/g, 'ا');
    s = s.replace(/ى/g, 'ي');
    s = s.replace(/ة/g, 'ه');
    s = s.replace(/ؤ/g, 'و');
    s = s.replace(/ئ/g, 'ي');
    s = s.replace(/[\u0640\u06E5\u06E6]/g, '');
    s = s.replace(/\s+/g, ' ').trim();
    s = s.replace(/^يا ايها/, 'يايها');
    return s;
}

/**
 * Structural normalization for isExact comparison. Handles Unicode encoding
 * variants (alef wasla U+0671 vs U+0627+U+0670) but keeps diacritics.
 */
function exactKey(text: string): string {
    let s = text.normalize('NFKD');
    s = s.replace(/[\u200c\u200d\u200e\u200f\u061c]/g, '');
    s = s.replace(/\u0671/g, '\u0627');
    s = s.replace(/\u0670/g, '');
    s = s.replace(/[\u0640\u06E5\u06E6]/g, '');
    s = s.replace(/\s+/g, ' ').trim();
    return s;
}

// Import bundled data
import versesData from '../data/quran-verses.min.json';
import surahsData from '../data/quran-surahs.min.json';

/**
 * Default validator options
 */
const DEFAULT_OPTIONS: Required<ValidatorOptions> = {
    maxSuggestions: 3,
    minDetectionLength: 10,
};

// ponytail: hardcoded muqatta'at, 14 known combinations across 29 surahs
const MUQATTAAT: Record<string, number[]> = {
    "\u0635": [38],
    "\u0642": [50],
    "\u0646": [68],
    "\u0637\u0647": [20],
    "\u0637\u0633": [27],
    "\u064A\u0633": [36],
    "\u062D\u0645": [40, 41, 42, 43, 44, 45, 46],
    "\u0627\u0644\u0645": [2, 3, 29, 30, 31, 32],
    "\u0627\u0644\u0631": [10, 11, 12, 14, 15],
    "\u0637\u0633\u0645": [26, 28],
    "\u0627\u0644\u0645\u0635": [7],
    "\u0627\u0644\u0645\u0631": [13],
    "\u0643\u0647\u064A\u0639\u0635": [19],
    "\u062D\u0645 \u0639\u0633\u0642": [42],
};

interface QuranVerseWithDisplay extends QuranVerse {
    displayText?: string;
}

/**
 * QuranValidator - Validate and verify Quranic verses in text
 *
 * @example
 * ```ts
 * import { QuranValidator } from 'quran-validator';
 *
 * const validator = new QuranValidator();
 *
 * // Validate a specific quote
 * const result = validator.validate("بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ");
 * console.log(result.isValid); // true
 * console.log(result.reference); // "1:1"
 *
 * // Detect and validate all Quran quotes in text
 * const detection = validator.detectAndValidate(llmOutput);
 * for (const segment of detection.segments) {
 *   console.log(segment.text, segment.validation?.isValid);
 * }
 * ```
 */
export class QuranValidator {
    private verses: QuranVerseWithDisplay[];
    private surahs: QuranSurah[];
    private options: Required<ValidatorOptions>;

    // Pre-computed normalized data for faster lookups
    private normalizedVerseMap: Map<string, QuranVerseWithDisplay[]>;
    private verseById: Map<number, QuranVerseWithDisplay>;

    // Pre-computed (verse, normalized_text) pairs for partial + multi-verse matching
    private verseKeys: Array<[QuranVerseWithDisplay, string]>;

    // Concatenated normalized corpus for fabrication detection
    private normalizedCorpus: string;

    constructor(options: ValidatorOptions = {}) {
        this.options = { ...DEFAULT_OPTIONS, ...options };

        // Load verses and surahs from bundled data
        this.verses = versesData as QuranVerseWithDisplay[];
        this.surahs = surahsData as QuranSurah[];

        // Build lookup maps
        this.verseById = new Map();
        this.normalizedVerseMap = new Map();

        const corpusTexts: string[] = [];

        for (const verse of this.verses) {
            this.verseById.set(verse.id, verse);

            const normalized = verseLookupKey(verse.text);
            const existing = this.normalizedVerseMap.get(normalized) || [];
            existing.push(verse);
            this.normalizedVerseMap.set(normalized, existing);

            corpusTexts.push(normalizeFabrication(verse.text));
        }

        // Pre-strip Basmala from verse 1 of each surah (except Al-Fatiha and At-Tawbah).
        // AlQuran.cloud data prepends Basmala to every surah's first verse, so we
        // add a secondary lookup key to the map for the stripped text.
        const basmalaVerse = this.verses.find(v => v.surah === 1 && v.ayah === 1);
        if (basmalaVerse) {
            const basmala = basmalaVerse.text;
            for (const verse of this.verses) {
                if (verse.ayah === 1 && verse.surah !== 1 && verse.text.startsWith(basmala)) {
                    const stripped = verse.text.slice(basmala.length).trim();
                    if (stripped) {
                        verse.displayText = stripped;
                        const sk = verseLookupKey(stripped);
                        const arr = this.normalizedVerseMap.get(sk) || [];
                        arr.push(verse);
                        this.normalizedVerseMap.set(sk, arr);
                    }
                }
            }
        }

        // Pre-compute verse-level normalized texts (using displayText if available)
        this.verseKeys = this.verses.map(v => [
            v,
            verseLookupKey(v.displayText || v.text),
        ] as [QuranVerseWithDisplay, string]);

        // Build concatenated corpus for fabrication detection
        this.normalizedCorpus = corpusTexts.join(' ');
    }

    /**
     * Validate a potential Quran quote
     *
     * @param text - The Arabic text to validate
     * @returns Validation result with match details
     *
     * @example
     * ```ts
     * const result = validator.validate("بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ");
     * if (result.isValid) {
     *   console.log(`Found: ${result.reference}`); // "1:1"
     *   console.log(`Match type: ${result.matchType}`); // "exact"
     * }
     * ```
     */
    validate(text: string): ValidationResult {
        const trimmedText = text.trim();
        const normalizedInput = normalizeArabic(trimmedText);
        // Use verse-safe normalization for lookup (preserves alef wasla)
        const lookupKey = verseLookupKey(trimmedText);

        // Early exit if not Arabic
        if (!containsArabic(trimmedText)) {
            return this.noMatch(normalizedInput);
        }

        // Step 1: Try exact match (with diacritics)
        const exactMatch = this.findExactMatch(trimmedText);
        if (exactMatch) {
            return this.createResult(exactMatch, 'exact', normalizedInput);
        }

        // Step 1b: ponytail: muqatta'at detection, finite known set of 14 combinations
        const muqSurahs = MUQATTAAT[lookupKey];
        if (muqSurahs) {
            const firstV = this.versesData.find(v => v.surah === muqSurahs[0] && v.ayah === 1);
            return {
                isValid: true,
                matchType: 'muqattaat',
                normalizedInput,
                reference: `${muqSurahs[0]}:1`,
                matchedVerse: firstV,
                translation: firstV?.translation,
                muqattaatSurahs: muqSurahs,
            };
        }

        // Step 2: Try normalized match (handles script variations)
        const normalizedMatches = this.normalizedVerseMap.get(lookupKey);

        if (normalizedMatches && normalizedMatches.length > 0) {
            const primary = normalizedMatches[0];
            const displayText = primary.displayText || primary.text;
            const isExact = exactKey(trimmedText) === exactKey(displayText);
            const result = this.createResult(
                primary,
                isExact ? 'exact' : 'normalized',
                normalizedInput
            );

            if (normalizedMatches.length > 1) {
                result.suggestions = normalizedMatches
                    .slice(0, this.options.maxSuggestions)
                    .map((v) => ({
                        verse: v,
                        reference: `${v.surah}:${v.ayah}`,
                    }));
            }

            return result;
        }

        // Step 3: Try partial-verse match (input is a substring of some verse)
        const partial = this.findPartialMatches(lookupKey);
        if (partial.refs.length > 0) {
            return {
                isValid: true,
                matchType: 'partial',
                normalizedInput,
                partialMatches: partial.refs,
                partialCount: partial.total,
            };
        }

        // Step 4: Try multi-verse passthrough (input covers consecutive verses)
        const mv = this.findMultiVerseMatch(lookupKey);
        if (mv.segments.length >= 2) {
            const totalInputWords = lookupKey.split(/\s+/).filter(Boolean).length;
            const matchedInputWords = totalInputWords - mv.unmatched.length;
            if (matchedInputWords >= Math.max(3, totalInputWords * 0.5)) {
                return {
                    isValid: mv.unmatched.length === 0,
                    matchType: 'multi_verse',
                    normalizedInput,
                    multiVerse: mv.segments,
                    unmatchedWords: mv.unmatched.length > 0 ? mv.unmatched : undefined,
                };
            }
        }

        // No match found
        return this.noMatch(normalizedInput);
    }

    private findPartialMatches(
        trimmedKey: string,
        limit: number = 3
    ): { refs: string[]; total: number } {
        if (!trimmedKey || trimmedKey.length < 2) return { refs: [], total: 0 };
        const noSpace = trimmedKey.replace(/ /g, '');
        const refs: string[] = [];
        let total = 0;
        for (const [v, verseKey] of this.verseKeys) {
            const verseNoSpace = verseKey.replace(/ /g, '');
            if (verseKey.includes(trimmedKey) || verseNoSpace.includes(noSpace)) {
                total++;
                if (refs.length < limit) refs.push(`${v.surah}:${v.ayah}`);
            }
        }
        return { refs, total };
    }

    private findMultiVerseMatch(
        trimmedKey: string
    ): { segments: VerseSegment[]; unmatched: string[] } {
        const words = trimmedKey.split(/\s+/).filter(Boolean);
        if (words.length === 0) return { segments: [], unmatched: [] };
        const wordCharLens = words.map(w => w.length);
        const cumulative: number[] = [0];
        for (const cl of wordCharLens) cumulative.push(cumulative[cumulative.length - 1] + cl);
        const totalChars = cumulative[cumulative.length - 1];
        const noSpace = trimmedKey.replace(/ /g, '');
        const segments: VerseSegment[] = [];
        const unmatched: string[] = [];
        let pos = 0;
        const verseWordLists: Array<[QuranVerseWithDisplay, string[]]> =
            this.verseKeys.map(([v, vk]) => [v, vk.split(/\s+/).filter(Boolean)]);
        while (pos < totalChars) {
            const wordIdx = cumulative.findIndex((c, i) => i > 0 && c > pos);
            let bestV: QuranVerseWithDisplay | null = null;
            let bestMatchChars = 0;
            for (const [v, vw] of verseWordLists) {
                if (vw.length === 0) continue;
                const vNoSpace = vw.join('');
                if (pos + vNoSpace.length > totalChars) continue;
                if (noSpace.slice(pos, pos + vNoSpace.length) === vNoSpace) {
                    if (vNoSpace.length > bestMatchChars) {
                        bestMatchChars = vNoSpace.length;
                        bestV = v;
                    }
                }
            }
            if (bestV && bestMatchChars > 0) {
                const display = (bestV as QuranVerseWithDisplay).displayText || (bestV as QuranVerseWithDisplay).text;
                segments.push({
                    reference: `${(bestV as QuranVerseWithDisplay).surah}:${(bestV as QuranVerseWithDisplay).ayah}`,
                    surah: (bestV as QuranVerseWithDisplay).surah,
                    ayah: (bestV as QuranVerseWithDisplay).ayah,
                    matchedText: display,
                });
                pos += bestMatchChars;
            } else {
                unmatched.push(words[wordIdx]);
                pos += wordCharLens[wordIdx];
            }
        }
        return { segments, unmatched };
    }

    /**
     * Validate text against a specific verse reference
     *
     * @param text - The Arabic text to validate
     * @param reference - The expected verse reference (e.g., "1:1" or "2:255-257")
     * @returns Validation result with diff information
     *
     * @example
     * ```ts
     * const result = validator.validateAgainst("بسم الله", "1:1");
     * if (!result.isValid) {
     *   console.log(`Expected: ${result.expectedNormalized}`);
     *   console.log(`Got: ${result.normalizedInput}`);
     *   console.log(`Mismatch at index: ${result.mismatchIndex}`);
     * }
     * ```
     */
    validateAgainst(text: string, reference: string): ValidationResult {
        const trimmedText = text.trim();
        const normalizedInput = normalizeArabic(trimmedText);

        // Parse the reference
        const rangeMatch = reference.match(/^(\d+):(\d+)(?:-(\d+))?$/);
        if (!rangeMatch) {
            return this.noMatch(normalizedInput);
        }

        const surah = parseInt(rangeMatch[1], 10);
        const startAyah = parseInt(rangeMatch[2], 10);
        const endAyah = rangeMatch[3] ? parseInt(rangeMatch[3], 10) : startAyah;

        // Get the expected verse(s)
        let expectedText: string;
        let matchedVerse: QuranVerse | undefined;

        if (startAyah === endAyah) {
            // Single verse
            matchedVerse = this.getVerse(surah, startAyah);
            if (!matchedVerse) {
                return this.noMatch(normalizedInput);
            }
            expectedText = matchedVerse.text;
        } else {
            // Verse range
            const range = this.getVerseRange(surah, startAyah, endAyah);
            if (!range) {
                return this.noMatch(normalizedInput);
            }
            expectedText = range.text;
            matchedVerse = range.verses[0];
        }

        const expectedNormalized = normalizeArabic(expectedText);

        // Check for exact match
        if (trimmedText === expectedText) {
            return {
                isValid: true,
                matchType: 'exact',
                matchedVerse,
                reference,
                normalizedInput,
                expectedNormalized,
            };
        }

        // Check for normalized match (use aggressive normalization for ى/ي and hamza variations)
        const inputLookup = normalizeFabrication(trimmedText);
        const expectedLookup = normalizeFabrication(expectedText);
        if (inputLookup === expectedLookup) {
            return {
                isValid: true,
                matchType: 'normalized',
                matchedVerse,
                reference,
                normalizedInput,
                expectedNormalized,
            };
        }

        // No match - find where the mismatch starts
        const mismatchIndex = this.findMismatchIndex(inputLookup, expectedLookup);

        return {
            isValid: false,
            matchType: 'none',
            reference,
            normalizedInput,
            expectedNormalized,
            mismatchIndex,
        };
    }

    /**
     * Detect and validate all potential Quran quotes in text
     *
     * This is useful for post-processing LLM output to find and verify
     * any Quranic content.
     *
     * @param text - Text that may contain Quran quotes
     * @returns Detection result with validated segments
     *
     * @example
     * ```ts
     * const llmOutput = "The verse بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ means...";
     * const result = validator.detectAndValidate(llmOutput);
     *
     * for (const segment of result.segments) {
     *   if (segment.validation?.isValid) {
     *     console.log(`Valid quote: ${segment.text}`);
     *   } else {
     *     console.log(`Possible misquote: ${segment.text}`);
     *   }
     * }
     * ```
     */
    detectAndValidate(text: string): DetectionResult {
        // Extract Arabic segments
        const arabicSegments = extractArabicSegments(text);

        if (arabicSegments.length === 0) {
            return { detected: false, segments: [] };
        }

        // Filter by minimum length and validate each
        const validatedSegments = arabicSegments
            .filter((seg) => seg.text.length >= this.options.minDetectionLength)
            .map((seg) => ({
                text: seg.text,
                startIndex: seg.startIndex,
                endIndex: seg.endIndex,
                validation: this.validate(seg.text),
            }));

        // A detection is positive if we found any valid Quran content
        const detected = validatedSegments.some(
            (seg) => seg.validation.isValid
        );

        return {
            detected,
            segments: validatedSegments,
        };
    }

    /**
     * Get a verse by reference (surah:ayah)
     *
     * @param surah - Surah number (1-114)
     * @param ayah - Ayah number
     * @returns The verse or undefined if not found
     */
    getVerse(surah: number, ayah: number): QuranVerse | undefined {
        return this.verses.find((v) => v.surah === surah && v.ayah === ayah);
    }

    /**
     * Get a range of verses and concatenate their text
     *
     * @param surah - Surah number (1-114)
     * @param startAyah - Starting ayah number
     * @param endAyah - Ending ayah number
     * @returns Object with concatenated text and verses array, or undefined if invalid range
     */
    getVerseRange(
        surah: number,
        startAyah: number,
        endAyah: number
    ): { text: string; textSimple: string; verses: QuranVerse[] } | undefined {
        if (startAyah > endAyah) return undefined;

        const verses: QuranVerse[] = [];
        for (let ayah = startAyah; ayah <= endAyah; ayah++) {
            const verse = this.getVerse(surah, ayah);
            if (!verse) return undefined; // Invalid range
            verses.push(verse);
        }

        return {
            text: verses.map((v) => v.text).join(' '),
            textSimple: verses.map((v) => v.textSimple).join(' '),
            verses,
        };
    }

    /**
     * Get all verses in a surah
     *
     * @param surahNumber - Surah number (1-114)
     * @returns Array of verses in the surah
     */
    getSurahVerses(surahNumber: number): QuranVerse[] {
        return this.verses.filter((v) => v.surah === surahNumber);
    }

    /**
     * Get surah information
     *
     * @param surahNumber - Surah number (1-114)
     * @returns Surah info or undefined
     */
    getSurah(surahNumber: number): QuranSurah | undefined {
        return this.surahs.find((s) => s.number === surahNumber);
    }

    /**
     * Get all surahs
     */
    getAllSurahs(): QuranSurah[] {
        return [...this.surahs];
    }

    /**
     * Search verses by text (containment-based matching)
     *
     * @param query - Search query (Arabic text)
     * @param limit - Maximum results to return
     * @returns Matching verses sorted by relevance
     */
    search(
        query: string,
        limit: number = 10
    ): { verse: QuranVerse; similarity: number }[] {
        const normalizedQuery = normalizeArabic(query);
        const results: { verse: QuranVerse; similarity: number }[] = [];

        for (const verse of this.verses) {
            const normalizedVerse = normalizeArabic(verse.text);

            // Query contained in verse
            if (normalizedVerse.includes(normalizedQuery)) {
                const ratio = normalizedQuery.length / normalizedVerse.length;
                results.push({ verse, similarity: 0.7 + ratio * 0.3 });
            }
            // Verse contained in query
            else if (normalizedQuery.includes(normalizedVerse)) {
                const ratio = normalizedVerse.length / normalizedQuery.length;
                results.push({ verse, similarity: 0.5 + ratio * 0.3 });
            }
        }

        return results
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, limit);
    }

    /**
     * Analyze text for fabricated words that don't exist in the Quran
     *
     * Uses greedy longest contiguous match algorithm:
     * - Words that exist as part of any contiguous sequence in the Quran are valid
     * - Words that cannot be found anywhere in the Quran corpus are marked as fabricated
     *
     * @param text - The Arabic text to analyze
     * @returns Analysis with word-by-word breakdown
     *
     * @example
     * ```ts
     * const analysis = validator.analyzeFabrication('بسم الله الفلان');
     * // 'بسم' and 'الله' are valid (exist in Quran)
     * // 'الفلان' is fabricated (doesn't exist anywhere)
     * console.log(analysis.stats.fabricatedWords); // 1
     * ```
     */
    analyzeFabrication(text: string): FabricationAnalysis {
        const normalizedInput = normalizeArabic(text);
        // Use aggressive normalization for matching against corpus
        const fabricationNormalized = normalizeFabrication(text);
        const words = normalizedInput.split(/\s+/).filter(Boolean);
        const fabricationWords = fabricationNormalized.split(/\s+/).filter(Boolean);
        const results: WordAnalysis[] = [];

        if (words.length === 0) {
            return {
                normalizedInput,
                words: [],
                stats: {
                    totalWords: 0,
                    fabricatedWords: 0,
                    fabricatedRatio: 0,
                },
            };
        }

        let i = 0;
        while (i < fabricationWords.length) {
            // Binary search for longest contiguous match starting at position i
            let lo = 1;
            let hi = fabricationWords.length - i;
            let best = 0;

            while (lo <= hi) {
                const mid = Math.floor((lo + hi) / 2);
                // Use aggressively normalized words for matching
                const candidate = fabricationWords.slice(i, i + mid).join(' ');

                if (this.normalizedCorpus.includes(candidate)) {
                    best = mid;
                    lo = mid + 1; // Try longer
                } else {
                    hi = mid - 1; // Try shorter
                }
            }

            if (best > 0) {
                // Found contiguous match, mark words [i, i+best) as valid
                // Use original normalized words for display
                for (let j = i; j < i + best; j++) {
                    results.push({ word: words[j], isFabricated: false });
                }
                i += best;
            } else {
                // No match at all, word doesn't exist even alone
                results.push({ word: words[i], isFabricated: true });
                i++;
            }
        }

        const fabricatedWords = results.filter((w) => w.isFabricated).length;

        return {
            normalizedInput,
            words: results,
            stats: {
                totalWords: results.length,
                fabricatedWords,
                fabricatedRatio: results.length > 0 ? fabricatedWords / results.length : 0,
            },
        };
    }

    // Private helper methods

    private findExactMatch(text: string): QuranVerseWithDisplay | undefined {
        return this.verses.find(
            (v) => v.text === text || (v.displayText && v.displayText === text)
        );
    }

    private createResult(
        verse: QuranVerse,
        matchType: MatchType,
        normalizedInput: string
    ): ValidationResult {
        return {
            isValid: true,
            matchType,
            matchedVerse: verse,
            reference: `${verse.surah}:${verse.ayah}`,
            translation: verse.translation,
            normalizedInput,
        };
    }

    private noMatch(normalizedInput?: string): ValidationResult {
        return {
            isValid: false,
            matchType: 'none',
            normalizedInput,
        };
    }

    /**
     * Find the character index where two strings first differ
     */
    private findMismatchIndex(str1: string, str2: string): number {
        const minLen = Math.min(str1.length, str2.length);
        for (let i = 0; i < minLen; i++) {
            if (str1[i] !== str2[i]) {
                return i;
            }
        }
        // If we get here, one string is a prefix of the other
        if (str1.length !== str2.length) {
            return minLen;
        }
        return -1; // Strings are identical (shouldn't happen if called correctly)
    }
}

/**
 * Create a new QuranValidator instance
 *
 * @param options - Validator options
 * @returns QuranValidator instance
 *
 * @example
 * ```ts
 * import { createValidator } from 'quran-validator';
 *
 * const validator = createValidator();
 * ```
 */
export function createValidator(options?: ValidatorOptions): QuranValidator {
    return new QuranValidator(options);
}
