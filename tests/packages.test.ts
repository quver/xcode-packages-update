import { vi, beforeEach, describe, test, expect } from 'vitest';
import { comparePackages } from '../src/packages.js';
import type { getPackages as GetPackagesFn } from '../src/packages.js';

let mockReadFileSync: ReturnType<typeof vi.fn>;

beforeEach(() => {
    mockReadFileSync = vi.fn();
    vi.resetModules();

    vi.doMock('fs', () => ({
        default: {
            readFileSync: mockReadFileSync
        }
    }));
});

async function loadGetPackages(): Promise<typeof GetPackagesFn> {
    const { getPackages } = await import('../src/packages.js');
    return getPackages;
}

describe('getPackages', () => {
    test('parses version from pins', async () => {
        mockReadFileSync.mockReturnValue(
            JSON.stringify({
                pins: [
                    { identity: 'firebase', state: { version: '11.0.0' } },
                    { identity: 'jwt', state: { version: '3.3.0' } }
                ]
            })
        );

        const getPackages = await loadGetPackages();
        const result = getPackages('Package.resolved');

        expect(result.get('firebase')).toBe('11.0.0');
        expect(result.get('jwt')).toBe('3.3.0');
    });

    test('falls back to branch when version is missing', async () => {
        mockReadFileSync.mockReturnValue(
            JSON.stringify({
                pins: [{ identity: 'some-package', state: { branch: 'main' } }]
            })
        );

        const getPackages = await loadGetPackages();
        const result = getPackages('Package.resolved');

        expect(result.get('some-package')).toBe('main');
    });

    test('falls back to revision when version and branch are missing', async () => {
        mockReadFileSync.mockReturnValue(
            JSON.stringify({
                pins: [{ identity: 'some-package', state: { revision: 'abc123' } }]
            })
        );

        const getPackages = await loadGetPackages();
        const result = getPackages('Package.resolved');

        expect(result.get('some-package')).toBe('abc123');
    });

    test('returns empty map for empty pins', async () => {
        mockReadFileSync.mockReturnValue(JSON.stringify({ pins: [] }));

        const getPackages = await loadGetPackages();
        const result = getPackages('Package.resolved');

        expect(result.size).toBe(0);
    });
});

describe('comparePackages', () => {
    test('no changes returns empty results', () => {
        const before = new Map([
            ['firebase', '11.0.0'],
            ['jwt', '3.3.0']
        ]);
        const after = new Map([
            ['firebase', '11.0.0'],
            ['jwt', '3.3.0']
        ]);

        const { removed, added, updated } = comparePackages(before, after);

        expect(removed).toHaveLength(0);
        expect(added).toHaveLength(0);
        expect(updated).toHaveLength(0);
    });

    test('detects removed package', () => {
        const before = new Map([
            ['firebase', '11.0.0'],
            ['jwt', '3.3.0']
        ]);
        const after = new Map([['firebase', '11.0.0']]);

        const { removed } = comparePackages(before, after);

        expect(removed).toEqual(['jwt']);
    });

    test('detects added package', () => {
        const before = new Map([['firebase', '11.0.0']]);
        const after = new Map([
            ['firebase', '11.0.0'],
            ['jwt', '3.3.0']
        ]);

        const { added } = comparePackages(before, after);

        expect(added).toEqual(['jwt']);
    });

    test('detects updated package version', () => {
        const before = new Map([['firebase', '11.0.0']]);
        const after = new Map([['firebase', '11.1.0']]);

        const { updated } = comparePackages(before, after);

        expect(updated).toEqual(['firebase']);
    });

    test('detects multiple changes at once', () => {
        const before = new Map([
            ['firebase', '11.0.0'],
            ['jwt', '3.3.0'],
            ['adjust', '5.5.0']
        ]);
        const after = new Map([
            ['firebase', '11.1.0'],
            ['snapshot-testing', '1.18.9'],
            ['adjust', '5.5.0']
        ]);

        const { removed, added, updated } = comparePackages(before, after);

        expect(removed).toEqual(['jwt']);
        expect(added).toEqual(['snapshot-testing']);
        expect(updated).toEqual(['firebase']);
    });

    test('handles empty before', () => {
        const before = new Map<string, string>();
        const after = new Map([['firebase', '11.0.0']]);

        const { removed, added, updated } = comparePackages(before, after);

        expect(removed).toHaveLength(0);
        expect(added).toEqual(['firebase']);
        expect(updated).toHaveLength(0);
    });

    test('handles empty after', () => {
        const before = new Map([['firebase', '11.0.0']]);
        const after = new Map<string, string>();

        const { removed, added, updated } = comparePackages(before, after);

        expect(removed).toEqual(['firebase']);
        expect(added).toHaveLength(0);
        expect(updated).toHaveLength(0);
    });
});
