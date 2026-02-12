import { describe, it, expect } from 'vitest';
import {
    LLMProcessor,
    createLLMProcessor,
    quickValidate,
    SYSTEM_PROMPTS,
} from './llm-integration';
import versesData from '../data/quran-verses.min.json';

// Pull the exact text from the bundled data to avoid Unicode encoding mismatches
const findVerse = (s: number, a: number) =>
    (versesData as Array<{ surah: number; ayah: number; text: string }>).find(
        (v) => v.surah === s && v.ayah === a
    )!.text;

const FATIHA_1 = findVerse(1, 1);
const FATIHA_2 = findVerse(1, 2);

describe('SYSTEM_PROMPTS', () => {
    it('has xml, markdown, bracket, and minimal prompts', () => {
        expect(SYSTEM_PROMPTS.xml).toBeDefined();
        expect(SYSTEM_PROMPTS.markdown).toBeDefined();
        expect(SYSTEM_PROMPTS.bracket).toBeDefined();
        expect(SYSTEM_PROMPTS.minimal).toBeDefined();
    });

    it('xml prompt contains example tags', () => {
        expect(SYSTEM_PROMPTS.xml).toContain('<quran ref=');
        expect(SYSTEM_PROMPTS.xml).toContain('</quran>');
    });
});

describe('LLMProcessor', () => {
    describe('constructor and getSystemPrompt', () => {
        it('defaults to xml tag format', () => {
            const p = new LLMProcessor();
            expect(p.getSystemPrompt()).toBe(SYSTEM_PROMPTS.xml);
        });

        it('respects tagFormat option', () => {
            const p = new LLMProcessor({ tagFormat: 'bracket' });
            expect(p.getSystemPrompt()).toBe(SYSTEM_PROMPTS.bracket);
        });

        it('createLLMProcessor helper works', () => {
            const p = createLLMProcessor({ tagFormat: 'markdown' });
            expect(p.getSystemPrompt()).toBe(SYSTEM_PROMPTS.markdown);
        });
    });

    describe('XML tag extraction', () => {
        it('processes valid xml-tagged Quran quote', () => {
            const processor = new LLMProcessor({ tagFormat: 'xml' });
            const text = `Here is a verse: <quran ref="1:1">${FATIHA_1}</quran>`;
            const result = processor.process(text);

            expect(result.quotes).toHaveLength(1);
            expect(result.quotes[0].isValid).toBe(true);
            expect(result.quotes[0].reference).toBe('1:1');
            expect(result.quotes[0].detectionMethod).toBe('tagged');
            expect(result.quotes[0].wasCorrected).toBe(false);
            expect(result.allValid).toBe(true);
        });

        it('detects invalid xml-tagged quote', () => {
            const processor = new LLMProcessor({
                tagFormat: 'xml',
                autoCorrect: false,
            });
            const text = `<quran ref="1:1">هذا نص مختلف تماما وليس آية</quran>`;
            const result = processor.process(text);

            expect(result.quotes).toHaveLength(1);
            expect(result.quotes[0].isValid).toBe(false);
        });
    });

    describe('bracket tag extraction', () => {
        it('processes bracket-tagged Quran quote', () => {
            const processor = new LLMProcessor({ tagFormat: 'bracket' });
            const text = `Here: [[Q:1:1|${FATIHA_1}]]`;
            const result = processor.process(text);

            expect(result.quotes).toHaveLength(1);
            expect(result.quotes[0].isValid).toBe(true);
            expect(result.quotes[0].reference).toBe('1:1');
        });
    });

    describe('inline reference extraction', () => {
        it('detects inline reference pattern: "text (surah:ayah)"', () => {
            const processor = new LLMProcessor({ tagFormat: 'xml' });
            const text = `${FATIHA_1} (1:1)`;
            const result = processor.process(text);

            expect(result.quotes.length).toBeGreaterThanOrEqual(1);
            // The inline ref should be detected
            const tagged = result.quotes.find((q) => q.detectionMethod === 'tagged');
            expect(tagged).toBeDefined();
            expect(tagged!.isValid).toBe(true);
        });
    });

    describe('verse range support', () => {
        it('validates a verse range reference (1:1-2)', () => {
            const processor = new LLMProcessor({ tagFormat: 'xml' });
            const combined = `${FATIHA_1} ${FATIHA_2}`;
            const text = `<quran ref="1:1-2">${combined}</quran>`;
            const result = processor.process(text);

            expect(result.quotes).toHaveLength(1);
            expect(result.quotes[0].isValid).toBe(true);
            expect(result.quotes[0].reference).toBe('1:1-2');
        });
    });

    describe('auto-correction', () => {
        it('auto-corrects misquoted text to the correct verse', () => {
            const processor = new LLMProcessor({
                tagFormat: 'xml',
                autoCorrect: true,
            });
            // Replace alef wasla (ٱ) with regular alef (ا), a common user-input variation
            const variant = FATIHA_1.replace(/\u0671/g, '\u0627');
            const text = `<quran ref="1:1">${variant}</quran>`;
            const result = processor.process(text);

            expect(result.quotes).toHaveLength(1);
            expect(result.quotes[0].isValid).toBe(true);
            expect(result.quotes[0].wasCorrected).toBe(true);
            expect(result.quotes[0].corrected).toBe(FATIHA_1);
            expect(result.correctedText).toContain(FATIHA_1);
        });
    });

    describe('untagged scanning', () => {
        it('detects untagged Quran content when scanUntagged is true', () => {
            const processor = new LLMProcessor({
                tagFormat: 'xml',
                scanUntagged: true,
            });
            const text = `Here is something important: ${FATIHA_1}. That was the first verse.`;
            const result = processor.process(text);

            // Should find the untagged quote
            const fuzzy = result.quotes.find((q) => q.detectionMethod === 'fuzzy');
            expect(fuzzy).toBeDefined();
            expect(fuzzy!.isValid).toBe(true);
            expect(result.warnings.length).toBeGreaterThan(0);
        });

        it('does not scan untagged when option is false', () => {
            const processor = new LLMProcessor({
                tagFormat: 'xml',
                scanUntagged: false,
            });
            const text = `Here is something: ${FATIHA_1}. That was the first verse.`;
            const result = processor.process(text);

            // Should not find any fuzzy quotes
            const fuzzy = result.quotes.find((q) => q.detectionMethod === 'fuzzy');
            expect(fuzzy).toBeUndefined();
        });
    });

    describe('validateQuote', () => {
        it('validates a correct quote', () => {
            const processor = new LLMProcessor();
            const result = processor.validateQuote(FATIHA_1);
            expect(result.isValid).toBe(true);
            expect(result.actualRef).toBe('1:1');
        });

        it('validates with expected reference', () => {
            const processor = new LLMProcessor();
            const result = processor.validateQuote(FATIHA_1, '1:1');
            expect(result.isValid).toBe(true);
        });

        it('rejects mismatched reference', () => {
            const processor = new LLMProcessor();
            // Correct verse text for 1:1, but claim it's 2:1
            const result = processor.validateQuote(FATIHA_1, '2:1');
            expect(result.isValid).toBe(false);
        });

        it('rejects invalid text', () => {
            const processor = new LLMProcessor();
            const result = processor.validateQuote('هذا ليس قرآنا');
            expect(result.isValid).toBe(false);
        });
    });

    describe('fabrication analysis for invalid quotes', () => {
        it('includes fabrication analysis when quote is invalid', () => {
            const processor = new LLMProcessor({
                tagFormat: 'xml',
                autoCorrect: false,
            });
            const fabricated = 'هذا نص مزيف وليس من القرآن الكريم أبدا';
            const text = `<quran ref="1:1">${fabricated}</quran>`;
            const result = processor.process(text);

            expect(result.quotes).toHaveLength(1);
            expect(result.quotes[0].isValid).toBe(false);
            expect(result.quotes[0].fabricationAnalysis).toBeDefined();
        });
    });
});

describe('quickValidate', () => {
    it('detects valid Quran content in XML-tagged text', () => {
        const text = `<quran ref="1:1">${FATIHA_1}</quran>`;
        const result = quickValidate(text);
        expect(result.hasQuranContent).toBe(true);
        expect(result.allValid).toBe(true);
    });

    it('reports issues for invalid tagged quotes', () => {
        const text = `<quran ref="1:1">هذا نص مختلف تماما</quran>`;
        const result = quickValidate(text);
        expect(result.hasQuranContent).toBe(true);
        expect(result.allValid).toBe(false);
        expect(result.issues.length).toBeGreaterThan(0);
    });

    it('returns no Quran content for plain English', () => {
        const result = quickValidate('Hello world, no Arabic here.');
        expect(result.hasQuranContent).toBe(false);
        expect(result.allValid).toBe(true);
    });
});
