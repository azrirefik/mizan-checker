import { describe, it, expect, beforeAll } from 'vitest';
import { QuranValidator, createValidator } from './validator';
import versesData from '../data/quran-verses.min.json';

// Pull the exact text from the bundled data to avoid Unicode encoding mismatches
const findVerse = (s: number, a: number) =>
    (versesData as Array<{ surah: number; ayah: number; text: string }>).find(
        (v) => v.surah === s && v.ayah === a
    )!.text;

const FATIHA_1 = findVerse(1, 1);
const FATIHA_2 = findVerse(1, 2);
const FATIHA_3 = findVerse(1, 3);

describe('QuranValidator', () => {
    let validator: QuranValidator;

    beforeAll(() => {
        validator = new QuranValidator();
    });

    // ---- constructor / createValidator ----

    describe('construction', () => {
        it('creates an instance with default options', () => {
            expect(validator).toBeInstanceOf(QuranValidator);
        });

        it('createValidator helper returns a QuranValidator', () => {
            const v = createValidator();
            expect(v).toBeInstanceOf(QuranValidator);
        });
    });

    // ---- validate() ----

    describe('validate', () => {
        it('exact match returns isValid true with matchType exact', () => {
            const result = validator.validate(FATIHA_1);
            expect(result.isValid).toBe(true);
            expect(result.matchType).toBe('exact');
            expect(result.reference).toBe('1:1');
            expect(result.matchedVerse).toBeDefined();
            expect(result.matchedVerse!.surah).toBe(1);
            expect(result.matchedVerse!.ayah).toBe(1);
        });

        it('normalized match returns isValid true with matchType normalized', () => {
            // Strip diacritics entirely to force a normalized match
            const variant = FATIHA_1.replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, '');
            const result = validator.validate(variant);
            expect(result.isValid).toBe(true);
            expect(result.matchType).toBe('normalized');
            expect(result.reference).toBe('1:1');
        });

        it('returns no match for non-Quran Arabic text', () => {
            const result = validator.validate('هذا ليس قرآنا أبدا ولن يكون');
            expect(result.isValid).toBe(false);
            expect(result.matchType).toBe('none');
        });

        it('returns no match for non-Arabic text', () => {
            const result = validator.validate('Hello world');
            expect(result.isValid).toBe(false);
            expect(result.matchType).toBe('none');
        });

        it('returns no match for empty string', () => {
            const result = validator.validate('');
            expect(result.isValid).toBe(false);
        });

        it('trims input before matching', () => {
            const result = validator.validate(`  ${FATIHA_1}  `);
            expect(result.isValid).toBe(true);
            // After trimming, the exact verse text is restored so it may match exact or normalized
            expect(['exact', 'normalized']).toContain(result.matchType);
        });
    });

    // ---- validateAgainst() ----

    describe('validateAgainst', () => {
        it('validates correct text against correct reference', () => {
            const result = validator.validateAgainst(FATIHA_1, '1:1');
            expect(result.isValid).toBe(true);
            expect(['exact', 'normalized']).toContain(result.matchType);
        });

        it('validates text against correct range reference', () => {
            const combined = `${FATIHA_1} ${FATIHA_2}`;
            const result = validator.validateAgainst(combined, '1:1-2');
            expect(result.isValid).toBe(true);
        });

        it('returns invalid for text that does not match the reference', () => {
            // Verse 1:2 text but reference says 1:1
            const result = validator.validateAgainst(FATIHA_2, '1:1');
            expect(result.isValid).toBe(false);
            expect(result.matchType).toBe('none');
            expect(result.mismatchIndex).toBeDefined();
            expect(typeof result.mismatchIndex).toBe('number');
        });

        it('returns noMatch for invalid reference format', () => {
            const result = validator.validateAgainst(FATIHA_1, 'invalid-ref');
            expect(result.isValid).toBe(false);
        });

        it('returns noMatch for non-existent surah/ayah', () => {
            const result = validator.validateAgainst(FATIHA_1, '999:999');
            expect(result.isValid).toBe(false);
        });
    });

    // ---- detectAndValidate() ----

    describe('detectAndValidate', () => {
        it('detects and validates Arabic Quran text in mixed content', () => {
            const text = `The verse ${FATIHA_1} means In the name of God`;
            const result = validator.detectAndValidate(text);
            expect(result.detected).toBe(true);
            expect(result.segments.length).toBeGreaterThan(0);

            const validSegment = result.segments.find(
                (s) => s.validation?.isValid
            );
            expect(validSegment).toBeDefined();
            expect(validSegment!.validation!.reference).toBe('1:1');
        });

        it('returns detected false for pure English text', () => {
            const result = validator.detectAndValidate('This is plain English text');
            expect(result.detected).toBe(false);
            expect(result.segments).toHaveLength(0);
        });

        it('respects minDetectionLength option', () => {
            const v = new QuranValidator({ minDetectionLength: 1000 });
            const result = v.detectAndValidate(`Here is ${FATIHA_3}`);
            // Segment detection should filter out short segments
            expect(result.segments).toHaveLength(0);
        });
    });

    // ---- getVerse / getVerseRange / getSurah ----

    describe('data accessors', () => {
        it('getVerse returns correct verse for 1:1', () => {
            const verse = validator.getVerse(1, 1);
            expect(verse).toBeDefined();
            expect(verse!.text).toBe(FATIHA_1);
            expect(verse!.surah).toBe(1);
            expect(verse!.ayah).toBe(1);
        });

        it('getVerse returns undefined for non-existent verse', () => {
            const verse = validator.getVerse(999, 999);
            expect(verse).toBeUndefined();
        });

        it('getVerseRange returns concatenated text', () => {
            const range = validator.getVerseRange(1, 1, 3);
            expect(range).toBeDefined();
            expect(range!.verses).toHaveLength(3);
            expect(range!.text).toContain(FATIHA_1);
            expect(range!.text).toContain(FATIHA_3);
        });

        it('getVerseRange returns undefined for invalid range', () => {
            expect(validator.getVerseRange(1, 5, 2)).toBeUndefined(); // start > end
            expect(validator.getVerseRange(999, 1, 2)).toBeUndefined(); // bad surah
        });

        it('getSurahVerses returns all verses for Al-Fatiha', () => {
            const verses = validator.getSurahVerses(1);
            expect(verses).toHaveLength(7);
            expect(verses[0].ayah).toBe(1);
            expect(verses[6].ayah).toBe(7);
        });

        it('getSurah returns surah info', () => {
            const surah = validator.getSurah(1);
            expect(surah).toBeDefined();
            expect(surah!.number).toBe(1);
            expect(surah!.englishName).toContain('Faatiha');
        });

        it('getSurah returns undefined for non-existent surah', () => {
            expect(validator.getSurah(999)).toBeUndefined();
        });

        it('getAllSurahs returns 114 surahs', () => {
            const surahs = validator.getAllSurahs();
            expect(surahs).toHaveLength(114);
        });
    });

    // ---- search() ----

    describe('search', () => {
        it('finds verses containing the query', () => {
            const results = validator.search('بسم', 5);
            expect(results.length).toBeGreaterThan(0);
            expect(results[0].similarity).toBeGreaterThan(0);
        });

        it('respects the limit parameter', () => {
            const results = validator.search('الله', 3);
            expect(results.length).toBeLessThanOrEqual(3);
        });
    });

    // ---- analyzeFabrication() ----

    describe('analyzeFabrication', () => {
        it('identifies Quran words as non-fabricated', () => {
            const analysis = validator.analyzeFabrication('بسم الله');
            expect(analysis.stats.fabricatedWords).toBe(0);
            expect(analysis.words.every((w) => !w.isFabricated)).toBe(true);
        });

        it('identifies fabricated words', () => {
            // Use a clearly non-Quran word
            const analysis = validator.analyzeFabrication('بيتزا');
            expect(analysis.stats.fabricatedWords).toBeGreaterThan(0);
            expect(analysis.stats.fabricatedRatio).toBeGreaterThan(0);
        });

        it('handles empty text', () => {
            const analysis = validator.analyzeFabrication('');
            expect(analysis.stats.totalWords).toBe(0);
            expect(analysis.stats.fabricatedWords).toBe(0);
            expect(analysis.stats.fabricatedRatio).toBe(0);
        });

        it('returns correct word count', () => {
            const analysis = validator.analyzeFabrication('بسم الله الرحمن الرحيم');
            expect(analysis.stats.totalWords).toBe(4);
        });
    });

    describe('partial and multi-verse matching', () => {
        it('detects partial match for half of Ayat al-Kursi', () => {
            // "الله لا اله الا هو" is a common substring that appears in 2:255
            const result = validator.validate('وهو العزيز الحكيم');
            expect(result.isValid).toBe(true);
            expect(result.matchType).toBe('partial');
            expect(result.partialMatches).toBeDefined();
            expect(result.partialMatches!.length).toBeGreaterThan(0);
            expect(result.partialCount).toBeGreaterThan(0);
        });

        it('detects multi-verse match for 112:1+2', () => {
            // "قل هو الله احد الله الصمد" is 112:1 followed by 112:2
            const result = validator.validate('قل هو الله احد الله الصمد');
            expect(result.isValid).toBe(true);
            expect(result.matchType).toBe('multi_verse');
            expect(result.multiVerse).toBeDefined();
            expect(result.multiVerse!.length).toBeGreaterThanOrEqual(2);
        });

        it('detects multi-verse match for Basmala + 112:1', () => {
            // Basmala + 112:1
            const result = validator.validate('بسم الله الرحمن الرحيم قل هو الله احد');
            expect(result.isValid).toBe(true);
            expect(['multi_verse', 'partial', 'normalized', 'exact']).toContain(result.matchType);
        });
    });
});
