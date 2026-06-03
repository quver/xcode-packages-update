import { vi, beforeEach, describe, test, expect } from 'vitest';
import { comparePackages } from '../src/packages.js';
import type {
    getPackages as GetPackagesFn,
    getPackagesWithInfo as GetPackagesWithInfoFn,
    generateHtmlReport as GenerateHtmlReportFn,
    generateSbom as GenerateSbomFn,
    detectXcodeDevPackages as DetectXcodeDevPackagesFn
} from '../src/packages.js';

let mockReadFileSync: ReturnType<typeof vi.fn>;
let mockReaddirSync: ReturnType<typeof vi.fn>;
let mockExistsSync: ReturnType<typeof vi.fn>;

beforeEach(() => {
    mockReadFileSync = vi.fn();
    mockReaddirSync = vi.fn().mockReturnValue([]);
    mockExistsSync = vi.fn().mockReturnValue(false);
    vi.resetModules();

    vi.doMock('fs', () => ({
        default: {
            readFileSync: mockReadFileSync,
            readdirSync: mockReaddirSync,
            existsSync: mockExistsSync
        }
    }));
});

async function loadGetPackages(): Promise<typeof GetPackagesFn> {
    const { getPackages } = await import('../src/packages.js');
    return getPackages;
}

async function loadGetPackagesWithInfo(): Promise<typeof GetPackagesWithInfoFn> {
    const { getPackagesWithInfo } = await import('../src/packages.js');
    return getPackagesWithInfo;
}

async function loadGenerateHtmlReport(): Promise<typeof GenerateHtmlReportFn> {
    const { generateHtmlReport } = await import('../src/packages.js');
    return generateHtmlReport;
}

async function loadGenerateSbom(): Promise<typeof GenerateSbomFn> {
    const { generateSbom } = await import('../src/packages.js');
    return generateSbom;
}

describe('getPackages', () => {
    test('parses version from pins', async () => {
        mockReadFileSync.mockReturnValue(
            JSON.stringify({
                pins: [
                    { identity: 'firebase', location: 'https://github.com/firebase/sdk', state: { version: '11.0.0' } },
                    { identity: 'jwt', location: 'https://github.com/auth0/jwt', state: { version: '3.3.0' } }
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
                pins: [{ identity: 'some-package', location: 'https://github.com/org/repo', state: { branch: 'main' } }]
            })
        );

        const getPackages = await loadGetPackages();
        const result = getPackages('Package.resolved');

        expect(result.get('some-package')).toBe('main');
    });

    test('falls back to revision when version and branch are missing', async () => {
        mockReadFileSync.mockReturnValue(
            JSON.stringify({
                pins: [
                    { identity: 'some-package', location: 'https://github.com/org/repo', state: { revision: 'abc123' } }
                ]
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

    test('returns empty map when pins field is absent', async () => {
        mockReadFileSync.mockReturnValue(JSON.stringify({}));

        const getPackages = await loadGetPackages();
        const result = getPackages('Package.resolved');

        expect(result.size).toBe(0);
    });
});

describe('getPackagesWithInfo', () => {
    test('includes version and url', async () => {
        mockReadFileSync.mockReturnValue(
            JSON.stringify({
                pins: [
                    {
                        identity: 'firebase',
                        location: 'https://github.com/firebase/firebase-ios-sdk',
                        state: { version: '12.0.0' }
                    }
                ]
            })
        );

        const getPackagesWithInfo = await loadGetPackagesWithInfo();
        const result = getPackagesWithInfo('Package.resolved');
        const info = result.get('firebase');

        expect(info?.version).toBe('12.0.0');
        expect(info?.url).toBe('https://github.com/firebase/firebase-ios-sdk');
    });

    test('falls back to branch for version', async () => {
        mockReadFileSync.mockReturnValue(
            JSON.stringify({
                pins: [{ identity: 'pkg', location: 'https://github.com/org/repo', state: { branch: 'main' } }]
            })
        );

        const getPackagesWithInfo = await loadGetPackagesWithInfo();
        const result = getPackagesWithInfo('Package.resolved');

        expect(result.get('pkg')?.version).toBe('main');
    });

    test('returns empty map for empty pins', async () => {
        mockReadFileSync.mockReturnValue(JSON.stringify({ pins: [] }));

        const getPackagesWithInfo = await loadGetPackagesWithInfo();
        expect((await getPackagesWithInfo('Package.resolved')).size).toBe(0);
    });

    test('uses empty string when location is missing', async () => {
        mockReadFileSync.mockReturnValue(JSON.stringify({ pins: [{ identity: 'pkg', state: { version: '1.0.0' } }] }));

        const getPackagesWithInfo = await loadGetPackagesWithInfo();
        const result = getPackagesWithInfo('Package.resolved');

        expect(result.get('pkg')?.url).toBe('');
    });

    test('returns empty string version when state has no version branch or revision', async () => {
        mockReadFileSync.mockReturnValue(
            JSON.stringify({ pins: [{ identity: 'pkg', location: 'https://github.com/org/pkg', state: {} }] })
        );

        const getPackagesWithInfo = await loadGetPackagesWithInfo();
        const result = getPackagesWithInfo('Package.resolved');

        expect(result.get('pkg')?.version).toBe('');
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

describe('generateHtmlReport', () => {
    const makeInfo = (version: string, url = 'https://github.com/org/repo') => ({ version, url });

    test('contains all package names', async () => {
        const generateHtmlReport = await loadGenerateHtmlReport();
        const beforeInfo = new Map([['firebase', makeInfo('11.0.0')]]);
        const afterInfo = new Map([['firebase', makeInfo('12.0.0')]]);

        const html = generateHtmlReport(beforeInfo, afterInfo, { removed: [], added: [], updated: ['firebase'] });

        expect(html).toContain('firebase');
        expect(html).toContain('11.0.0');
        expect(html).toContain('12.0.0');
    });

    test('marks updated packages with updated row class', async () => {
        const generateHtmlReport = await loadGenerateHtmlReport();
        const info = new Map([['firebase', makeInfo('11.0.0')]]);

        const html = generateHtmlReport(info, info, { removed: [], added: [], updated: ['firebase'] });

        expect(html).toContain('class="updated"');
        expect(html).toContain('⬆ updated');
    });

    test('marks added packages', async () => {
        const generateHtmlReport = await loadGenerateHtmlReport();
        const afterInfo = new Map([['jwt', makeInfo('3.0.0')]]);

        const html = generateHtmlReport(new Map(), afterInfo, { removed: [], added: ['jwt'], updated: [] });

        expect(html).toContain('class="added"');
        expect(html).toContain('✨ added');
    });

    test('marks removed packages', async () => {
        const generateHtmlReport = await loadGenerateHtmlReport();
        const beforeInfo = new Map([['old-pkg', makeInfo('1.0.0')]]);

        const html = generateHtmlReport(beforeInfo, new Map(), { removed: ['old-pkg'], added: [], updated: [] });

        expect(html).toContain('class="removed"');
        expect(html).toContain('🗑 removed');
    });

    test('labels development packages with Development badge', async () => {
        const generateHtmlReport = await loadGenerateHtmlReport();
        const info = new Map([
            ['swiftlintplugins', makeInfo('0.63.0')],
            ['firebase', makeInfo('12.0.0')]
        ]);
        const devPackages = new Set(['swiftlintplugins']);

        const html = generateHtmlReport(info, info, { removed: [], added: [], updated: [] }, devPackages);

        expect(html).toContain('🛠 Development');
        expect(html).toContain('📦 App');
    });

    test('labels all packages as App when no dev packages provided', async () => {
        const generateHtmlReport = await loadGenerateHtmlReport();
        const info = new Map([['firebase', makeInfo('12.0.0')]]);

        const html = generateHtmlReport(info, info, { removed: [], added: [], updated: [] });

        expect(html).toContain('📦 App');
        expect(html).not.toContain('🛠 Development');
    });

    test('renders repository URL as link', async () => {
        const generateHtmlReport = await loadGenerateHtmlReport();
        const info = new Map([['firebase', makeInfo('12.0.0', 'https://github.com/firebase/firebase-ios-sdk')]]);

        const html = generateHtmlReport(info, info, { removed: [], added: [], updated: [] });

        expect(html).toContain('href="https://github.com/firebase/firebase-ios-sdk"');
    });

    test('renders package name as plain text when url is empty', async () => {
        const generateHtmlReport = await loadGenerateHtmlReport();
        const info = new Map([['no-url-pkg', makeInfo('1.0.0', '')]]);

        const html = generateHtmlReport(info, info, { removed: [], added: [], updated: [] });

        expect(html).toContain('no-url-pkg');
        expect(html).not.toContain('href=');
    });

    test('includes summary counts in meta section', async () => {
        const generateHtmlReport = await loadGenerateHtmlReport();
        const info = new Map([['firebase', makeInfo('12.0.0')]]);

        const html = generateHtmlReport(info, info, { removed: [], added: [], updated: ['firebase'] });

        expect(html).toContain('⬆ Updated: 1');
    });

    test('produces valid HTML structure', async () => {
        const generateHtmlReport = await loadGenerateHtmlReport();

        const html = generateHtmlReport(new Map(), new Map(), { removed: [], added: [], updated: [] });

        expect(html).toContain('<!DOCTYPE html>');
        expect(html).toContain('<table>');
        expect(html).toContain('</table>');
    });
});

describe('generateSbom', () => {
    test('produces valid CycloneDX JSON', async () => {
        const generateSbom = await loadGenerateSbom();
        const info = new Map([
            ['firebase', { version: '12.0.0', url: 'https://github.com/firebase/firebase-ios-sdk' }]
        ]);

        const sbom = JSON.parse(generateSbom(info));

        expect(sbom.bomFormat).toBe('CycloneDX');
        expect(sbom.specVersion).toBe('1.6');
        expect(sbom.components).toHaveLength(1);
    });

    test('sets scope required for app packages', async () => {
        const generateSbom = await loadGenerateSbom();
        const info = new Map([
            ['firebase', { version: '12.0.0', url: 'https://github.com/firebase/firebase-ios-sdk' }]
        ]);

        const sbom = JSON.parse(generateSbom(info));

        expect(sbom.components[0].scope).toBe('required');
    });

    test('sets scope excluded for development packages', async () => {
        const generateSbom = await loadGenerateSbom();
        const info = new Map([
            ['firebase', { version: '12.0.0', url: 'https://github.com/firebase/sdk' }],
            ['swiftlintplugins', { version: '0.63.0', url: 'https://github.com/SimplyDanny/SwiftLintPlugins' }]
        ]);
        const devPackages = new Set(['swiftlintplugins']);

        const sbom = JSON.parse(generateSbom(info, devPackages));
        const lint = sbom.components.find((c: { name: string }) => c.name === 'swiftlintplugins');
        const firebase = sbom.components.find((c: { name: string }) => c.name === 'firebase');

        expect(lint.scope).toBe('excluded');
        expect(firebase.scope).toBe('required');
    });

    test('generates valid swift purl', async () => {
        const generateSbom = await loadGenerateSbom();
        const info = new Map([
            ['firebase-ios-sdk', { version: '12.0.0', url: 'https://github.com/firebase/firebase-ios-sdk' }]
        ]);

        const sbom = JSON.parse(generateSbom(info));

        expect(sbom.components[0].purl).toBe('pkg:swift/github.com/firebase/firebase-ios-sdk@12.0.0');
    });

    test('includes vcs externalReference for packages with url', async () => {
        const generateSbom = await loadGenerateSbom();
        const info = new Map([['firebase', { version: '12.0.0', url: 'https://github.com/firebase/sdk' }]]);

        const sbom = JSON.parse(generateSbom(info));

        expect(sbom.components[0].externalReferences).toEqual([
            { type: 'vcs', url: 'https://github.com/firebase/sdk' }
        ]);
    });

    test('includes serialNumber as urn:uuid', async () => {
        const generateSbom = await loadGenerateSbom();
        const sbom = JSON.parse(generateSbom(new Map()));

        expect(sbom.serialNumber).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    });

    test('returns empty components for empty map', async () => {
        const generateSbom = await loadGenerateSbom();
        const sbom = JSON.parse(generateSbom(new Map()));

        expect(sbom.components).toHaveLength(0);
    });

    test('omits externalReferences when url is empty', async () => {
        const generateSbom = await loadGenerateSbom();
        const info = new Map([['no-url-pkg', { version: '1.0.0', url: '' }]]);

        const sbom = JSON.parse(generateSbom(info));

        expect(sbom.components[0].externalReferences).toBeUndefined();
    });

    test('falls back to identity-only purl when url has too few path segments', async () => {
        const generateSbom = await loadGenerateSbom();
        const info = new Map([['mypkg', { version: '2.0.0', url: 'https://example.com/mypkg' }]]);

        const sbom = JSON.parse(generateSbom(info));

        expect(sbom.components[0].purl).toBe('pkg:swift/mypkg@2.0.0');
    });
});

describe('detectDevPackages', () => {
    async function loadDetectDevPackages(): Promise<typeof import('../src/packages.js').detectDevPackages> {
        const { detectDevPackages } = await import('../src/packages.js');
        return detectDevPackages;
    }

    beforeEach(() => {
        mockReaddirSync = vi.fn();
        mockExistsSync = vi.fn().mockReturnValue(false);
    });

    const makeResolved = (...identities: string[]) =>
        JSON.stringify({
            pins: identities.map((id) => ({
                identity: id,
                location: `https://github.com/org/${id}`,
                state: { version: '1.0.0' }
            }))
        });

    const makeEntry = (name: string, isDir: boolean): fs.Dirent =>
        ({ name, isFile: () => !isDir, isDirectory: () => isDir }) as unknown as fs.Dirent;

    test('classifies test-only package as development', async () => {
        const packageSwift = `
            .testTarget(name: "MyTests", dependencies: [
                .product(name: "PactSwift", package: "pactswift")
            ])
            .target(name: "MyApp", dependencies: [
                .product(name: "Firebase", package: "firebase-ios-sdk")
            ])
        `;

        mockReaddirSync.mockReturnValue([makeEntry('Package.swift', false)]);
        mockReadFileSync.mockImplementation((p: string) => {
            if (String(p).endsWith('Package.resolved')) return makeResolved('pactswift', 'firebase-ios-sdk');
            return packageSwift;
        });

        const detectDevPackages = await loadDetectDevPackages();
        const result = detectDevPackages('Package.resolved', '.');

        expect(result.has('pactswift')).toBe(true);
        expect(result.has('firebase-ios-sdk')).toBe(false);
    });

    test('classifies plugin-only package as development', async () => {
        const packageSwift = `
            .target(name: "MyApp", dependencies: [], plugins: [
                .plugin(name: "SwiftLintBuildToolPlugin", package: "swiftlintplugins")
            ])
        `;

        mockReaddirSync.mockReturnValue([makeEntry('Package.swift', false)]);
        mockReadFileSync.mockImplementation((p: string) => {
            if (String(p).endsWith('Package.resolved')) return makeResolved('swiftlintplugins');
            return packageSwift;
        });

        const detectDevPackages = await loadDetectDevPackages();
        const result = detectDevPackages('Package.resolved', '.');

        expect(result.has('swiftlintplugins')).toBe(true);
    });

    test('does not classify as dev when package is also an app dependency', async () => {
        const packageSwift = `
            .target(name: "MyApp", dependencies: [
                .product(name: "SharedLib", package: "shared-lib")
            ])
            .testTarget(name: "MyTests", dependencies: [
                .product(name: "SharedLib", package: "shared-lib")
            ])
        `;

        mockReaddirSync.mockReturnValue([makeEntry('Package.swift', false)]);
        mockReadFileSync.mockImplementation((p: string) => {
            if (String(p).endsWith('Package.resolved')) return makeResolved('shared-lib');
            return packageSwift;
        });

        const detectDevPackages = await loadDetectDevPackages();
        const result = detectDevPackages('Package.resolved', '.');

        expect(result.has('shared-lib')).toBe(false);
    });

    test('returns empty set when no Package.swift files found', async () => {
        mockReaddirSync.mockReturnValue([]);
        mockReadFileSync.mockReturnValue(makeResolved('firebase-ios-sdk'));

        const detectDevPackages = await loadDetectDevPackages();
        const result = detectDevPackages('Package.resolved', '.');

        expect(result.size).toBe(0);
    });

    test('skips identities not present in Package.resolved', async () => {
        const packageSwift = `
            .testTarget(name: "T", dependencies: [
                .product(name: "Ghost", package: "ghost-pkg")
            ])
        `;

        mockReaddirSync.mockReturnValue([makeEntry('Package.swift', false)]);
        mockReadFileSync.mockImplementation((p: string) => {
            if (String(p).endsWith('Package.resolved')) return makeResolved('firebase-ios-sdk');
            return packageSwift;
        });

        const detectDevPackages = await loadDetectDevPackages();
        const result = detectDevPackages('Package.resolved', '.');

        expect(result.has('ghost-pkg')).toBe(false);
    });

    test('recurses into subdirectories', async () => {
        const packageSwift = `
            .testTarget(name: "T", dependencies: [
                .product(name: "PactSwift", package: "pactswift")
            ])
        `;

        mockReaddirSync.mockImplementation((dir: string) => {
            if (String(dir) === '.') return [makeEntry('Modules', true)];
            if (String(dir) === 'Modules') return [makeEntry('Package.swift', false)];
            return [];
        });
        mockReadFileSync.mockImplementation((p: string) => {
            if (String(p).endsWith('Package.resolved')) return makeResolved('pactswift');
            return packageSwift;
        });

        const detectDevPackages = await loadDetectDevPackages();
        const result = detectDevPackages('Package.resolved', '.');

        expect(result.has('pactswift')).toBe(true);
    });

    test('skips excluded directory names during Package.swift scan', async () => {
        mockReaddirSync.mockImplementation((dir: string) => {
            if (String(dir) === '.') return [makeEntry('node_modules', true), makeEntry('Package.swift', false)];
            return [];
        });
        mockReadFileSync.mockImplementation((p: string) => {
            if (String(p).endsWith('Package.resolved')) return makeResolved('pactswift');
            return `.testTarget(name: "T", dependencies: [.product(name: "PactSwift", package: "pactswift")])`;
        });

        const detectDevPackages = await loadDetectDevPackages();
        const result = detectDevPackages('Package.resolved', '.');

        expect(result.has('pactswift')).toBe(true);
    });

    test('handles readdirSync error in subdirectory scan gracefully', async () => {
        mockReaddirSync.mockImplementation((dir: string) => {
            if (String(dir) === '.') return [makeEntry('Subdir', true)];
            throw new Error('EPERM');
        });
        mockReadFileSync.mockReturnValue(makeResolved('firebase-ios-sdk'));

        const detectDevPackages = await loadDetectDevPackages();
        const result = detectDevPackages('Package.resolved', '.');

        expect(result.size).toBe(0);
    });

    test('handles readdirSync error at root gracefully', async () => {
        mockReaddirSync.mockImplementation(() => {
            throw new Error('EPERM');
        });
        mockReadFileSync.mockReturnValue(makeResolved('firebase-ios-sdk'));

        const detectDevPackages = await loadDetectDevPackages();
        const result = detectDevPackages('Package.resolved', '.');

        expect(result.size).toBe(0);
    });

    test('skips Package.swift that cannot be read', async () => {
        mockReaddirSync.mockReturnValue([makeEntry('Package.swift', false)]);
        mockReadFileSync.mockImplementation((p: string) => {
            if (String(p).endsWith('Package.resolved')) return makeResolved('pactswift');
            throw new Error('EACCES');
        });

        const detectDevPackages = await loadDetectDevPackages();
        const result = detectDevPackages('Package.resolved', '.');

        expect(result.size).toBe(0);
    });
});

describe('detectXcodeDevPackages', () => {
    async function loadDetectXcodeDevPackages(): Promise<typeof DetectXcodeDevPackagesFn> {
        const { detectXcodeDevPackages } = await import('../src/packages.js');
        return detectXcodeDevPackages;
    }

    const SNAPSHOT_REF_ID = 'AAAAAAAAAAAAAAAAAAAAAAAA';
    const SNAPSHOT_DEP_ID = 'BBBBBBBBBBBBBBBBBBBBBBBB';
    const SWIFTLINT_REF_ID = 'CCCCCCCCCCCCCCCCCCCCCCCC';
    const FIREBASE_REF_ID = 'DDDDDDDDDDDDDDDDDDDDDDDD';
    const FIREBASE_DEP_ID = 'EEEEEEEEEEEEEEEEEEEEEEEE';

    function makePbxproj({
        remoteRefs = [] as Array<{ id: string; name: string; url: string }>,
        productDeps = [] as Array<{ id: string; product: string; pkgRefId: string | null }>,
        targets = [] as Array<{ name: string; depIds: string[] }>
    } = {}): string {
        const refSection = remoteRefs
            .map(
                ({ id, name, url }) =>
                    `${id} /* XCRemoteSwiftPackageReference "${name}" */ = { repositoryURL = "${url}"; };`
            )
            .join('\n');

        const depSection = productDeps
            .map(({ id, product, pkgRefId }) =>
                pkgRefId
                    ? `${id} /* ${product} */ = {\n  isa = XCSwiftPackageProductDependency;\n  package = ${pkgRefId} /* ref */;\n  productName = ${product};\n};`
                    : `${id} /* ${product} */ = {\n  isa = XCSwiftPackageProductDependency;\n  productName = ${product};\n};`
            )
            .join('\n');

        const targetSection = targets
            .map(
                ({ name, depIds }) =>
                    `isa = PBXNativeTarget;\nname = ${name};\npackageProductDependencies = (\n${depIds.map((id) => `  ${id} /* dep */,`).join('\n')}\n);`
            )
            .join('\n');

        return [refSection, depSection, targetSection].join('\n\n');
    }

    test('classifies package linked only to test target as development', async () => {
        const pbxproj = makePbxproj({
            remoteRefs: [
                {
                    id: SNAPSHOT_REF_ID,
                    name: 'swift-snapshot-testing',
                    url: 'https://github.com/pointfreeco/swift-snapshot-testing'
                }
            ],
            productDeps: [{ id: SNAPSHOT_DEP_ID, product: 'SnapshotTesting', pkgRefId: SNAPSHOT_REF_ID }],
            targets: [{ name: 'FuturumTests', depIds: [SNAPSHOT_DEP_ID] }]
        });
        mockReadFileSync.mockReturnValue(pbxproj);

        const detectXcodeDevPackages = await loadDetectXcodeDevPackages();
        const { devRefs, appRefs } = detectXcodeDevPackages('project.pbxproj');

        expect(devRefs.has('swift-snapshot-testing')).toBe(true);
        expect(appRefs.has('swift-snapshot-testing')).toBe(false);
    });

    test('classifies project-level-only package (plugin) as development', async () => {
        const pbxproj = makePbxproj({
            remoteRefs: [
                {
                    id: SWIFTLINT_REF_ID,
                    name: 'SwiftLintPlugins',
                    url: 'https://github.com/SimplyDanny/SwiftLintPlugins'
                }
            ],
            productDeps: [],
            targets: []
        });
        mockReadFileSync.mockReturnValue(pbxproj);

        const detectXcodeDevPackages = await loadDetectXcodeDevPackages();
        const { devRefs, appRefs } = detectXcodeDevPackages('project.pbxproj');

        expect(devRefs.has('swiftlintplugins')).toBe(true);
        expect(appRefs.has('swiftlintplugins')).toBe(false);
    });

    test('classifies package linked to non-test target as app', async () => {
        const pbxproj = makePbxproj({
            remoteRefs: [
                { id: FIREBASE_REF_ID, name: 'firebase-ios-sdk', url: 'https://github.com/firebase/firebase-ios-sdk' }
            ],
            productDeps: [{ id: FIREBASE_DEP_ID, product: 'Firebase', pkgRefId: FIREBASE_REF_ID }],
            targets: [{ name: 'Futurum', depIds: [FIREBASE_DEP_ID] }]
        });
        mockReadFileSync.mockReturnValue(pbxproj);

        const detectXcodeDevPackages = await loadDetectXcodeDevPackages();
        const { devRefs, appRefs } = detectXcodeDevPackages('project.pbxproj');

        expect(appRefs.has('firebase-ios-sdk')).toBe(true);
        expect(devRefs.has('firebase-ios-sdk')).toBe(false);
    });

    test('does not classify as dev when package is linked to both test and non-test target', async () => {
        const DEP_ID_2 = 'FFFFFFFFFFFFFFFFFFFFFFFD';
        const pbxproj = makePbxproj({
            remoteRefs: [
                {
                    id: SNAPSHOT_REF_ID,
                    name: 'swift-snapshot-testing',
                    url: 'https://github.com/pointfreeco/swift-snapshot-testing'
                }
            ],
            productDeps: [
                { id: SNAPSHOT_DEP_ID, product: 'SnapshotTesting', pkgRefId: SNAPSHOT_REF_ID },
                { id: DEP_ID_2, product: 'SnapshotTesting', pkgRefId: SNAPSHOT_REF_ID }
            ],
            targets: [
                { name: 'Futurum', depIds: [SNAPSHOT_DEP_ID] },
                { name: 'FuturumTests', depIds: [DEP_ID_2] }
            ]
        });
        mockReadFileSync.mockReturnValue(pbxproj);

        const detectXcodeDevPackages = await loadDetectXcodeDevPackages();
        const { appRefs } = detectXcodeDevPackages('project.pbxproj');

        expect(appRefs.has('swift-snapshot-testing')).toBe(true);
    });

    test('returns empty sets when file cannot be read', async () => {
        mockReadFileSync.mockImplementation(() => {
            throw new Error('ENOENT');
        });

        const detectXcodeDevPackages = await loadDetectXcodeDevPackages();
        const { devRefs, appRefs } = detectXcodeDevPackages('missing.pbxproj');

        expect(devRefs.size).toBe(0);
        expect(appRefs.size).toBe(0);
    });

    test('derives identity as lowercase repo name from URL with .git suffix', async () => {
        const pbxproj = makePbxproj({
            remoteRefs: [
                {
                    id: SWIFTLINT_REF_ID,
                    name: 'SwiftLintPlugins',
                    url: 'https://github.com/SimplyDanny/SwiftLintPlugins.git'
                }
            ],
            productDeps: [],
            targets: []
        });
        mockReadFileSync.mockReturnValue(pbxproj);

        const detectXcodeDevPackages = await loadDetectXcodeDevPackages();
        const { devRefs } = detectXcodeDevPackages('project.pbxproj');

        expect(devRefs.has('swiftlintplugins')).toBe(true);
    });

    test('ignores product dep without a remote package reference (local dep)', async () => {
        const LOCAL_DEP_ID = 'FFFFFFFFFFFFFFFFFFFFFFFE';
        const pbxproj = makePbxproj({
            remoteRefs: [],
            productDeps: [{ id: LOCAL_DEP_ID, product: 'LocalLib', pkgRefId: null }],
            targets: [{ name: 'Futurum', depIds: [LOCAL_DEP_ID] }]
        });
        mockReadFileSync.mockReturnValue(pbxproj);

        const detectXcodeDevPackages = await loadDetectXcodeDevPackages();
        const { devRefs, appRefs } = detectXcodeDevPackages('project.pbxproj');

        expect(devRefs.size).toBe(0);
        expect(appRefs.size).toBe(0);
    });

    test('ignores target dep id that has no matching product dependency', async () => {
        const UNMAPPED_DEP_ID = 'FFFFFFFFFFFFFFFFFFFFFFFF';
        const pbxproj = makePbxproj({
            remoteRefs: [],
            productDeps: [],
            targets: [{ name: 'Futurum', depIds: [UNMAPPED_DEP_ID] }]
        });
        mockReadFileSync.mockReturnValue(pbxproj);

        const detectXcodeDevPackages = await loadDetectXcodeDevPackages();
        const { devRefs, appRefs } = detectXcodeDevPackages('project.pbxproj');

        expect(devRefs.size).toBe(0);
        expect(appRefs.size).toBe(0);
    });
});

describe('findPbxprojFiles existsSync true path', () => {
    const makeEntry = (name: string, isDir: boolean): fs.Dirent =>
        ({ name, isFile: () => !isDir, isDirectory: () => isDir }) as unknown as fs.Dirent;

    test('includes pbxproj path in detectDevPackages when existsSync returns true', async () => {
        const pbxproj = [
            `AAAAAAAAAAAAAAAAAAAAAAAA /* XCRemoteSwiftPackageReference "swift-snapshot-testing" */ = { repositoryURL = "https://github.com/pointfreeco/swift-snapshot-testing" }`,
            `BBBBBBBBBBBBBBBBBBBBBBBB /* SnapshotTesting */ = {`,
            `    isa = XCSwiftPackageProductDependency;`,
            `    package = AAAAAAAAAAAAAAAAAAAAAAAA /* ref */;`,
            `    productName = SnapshotTesting;`,
            `}`,
            `isa = PBXNativeTarget;`,
            `    name = FuturumTests;`,
            `    packageProductDependencies = (`,
            `        BBBBBBBBBBBBBBBBBBBBBBBB /* dep */,`,
            `    )`
        ].join('\n');

        mockReaddirSync.mockImplementation((dir: string) => {
            if (String(dir) === '.') return [makeEntry('Futurum.xcodeproj', true)];
            return [];
        });
        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockImplementation((p: string) => {
            if (String(p).endsWith('Package.resolved'))
                return JSON.stringify({
                    pins: [
                        {
                            identity: 'swift-snapshot-testing',
                            location: 'https://github.com/pointfreeco/swift-snapshot-testing',
                            state: { version: '1.0.0' }
                        }
                    ]
                });
            return pbxproj;
        });

        const { detectDevPackages } = await import('../src/packages.js');
        const result = detectDevPackages('Package.resolved', '.');

        expect(mockExistsSync).toHaveBeenCalled();
        expect(mockExistsSync).toHaveBeenCalledWith('Futurum.xcodeproj/project.pbxproj');
        expect(result.has('swift-snapshot-testing')).toBe(true);
    });

    test('excludes xcodeproj whose pbxproj does not exist when existsSync returns false', async () => {
        mockReaddirSync.mockImplementation((dir: string) => {
            if (String(dir) === '.') return [makeEntry('Futurum.xcodeproj', true)];
            return [];
        });
        mockExistsSync.mockReturnValue(false);
        mockReadFileSync.mockImplementation((p: string) => {
            if (String(p).endsWith('Package.resolved'))
                return JSON.stringify({
                    pins: [
                        {
                            identity: 'firebase-ios-sdk',
                            location: 'https://github.com/firebase/firebase-ios-sdk',
                            state: { version: '1.0.0' }
                        }
                    ]
                });
            return '';
        });

        const { detectDevPackages } = await import('../src/packages.js');
        const result = detectDevPackages('Package.resolved', '.');

        expect(mockExistsSync).toHaveBeenCalledWith('Futurum.xcodeproj/project.pbxproj');
        expect(result.size).toBe(0);
    });
});
