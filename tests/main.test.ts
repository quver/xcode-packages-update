import { vi, beforeEach, describe, test, expect } from 'vitest';
import type { run as RunFn } from '../src/main.js';

let mockGetInput: ReturnType<typeof vi.fn>;
let mockSaveState: ReturnType<typeof vi.fn>;
let mockSetOutput: ReturnType<typeof vi.fn>;
let mockInfo: ReturnType<typeof vi.fn>;
let mockSetFailed: ReturnType<typeof vi.fn>;
let mockExec: ReturnType<typeof vi.fn>;
let mockRmSync: ReturnType<typeof vi.fn>;
let mockCopyFileSync: ReturnType<typeof vi.fn>;
let mockMkdirSync: ReturnType<typeof vi.fn>;
let mockGetPackages: ReturnType<typeof vi.fn>;
let mockComparePackages: ReturnType<typeof vi.fn>;

beforeEach(() => {
    mockGetInput = vi.fn();
    mockSaveState = vi.fn();
    mockSetOutput = vi.fn();
    mockInfo = vi.fn();
    mockSetFailed = vi.fn();
    mockExec = vi.fn().mockResolvedValue(0);
    mockRmSync = vi.fn();
    mockCopyFileSync = vi.fn();
    mockMkdirSync = vi.fn();
    mockGetPackages = vi.fn().mockReturnValue(new Map());
    mockComparePackages = vi.fn().mockReturnValue({ removed: [], added: [], updated: [] });
    vi.resetModules();

    vi.doMock('@actions/core', () => ({
        getInput: mockGetInput,
        saveState: mockSaveState,
        setOutput: mockSetOutput,
        info: mockInfo,
        setFailed: mockSetFailed
    }));

    vi.doMock('@actions/exec', () => ({
        exec: mockExec
    }));

    vi.doMock('fs', () => ({
        default: {
            rmSync: mockRmSync,
            copyFileSync: mockCopyFileSync,
            mkdirSync: mockMkdirSync
        }
    }));

    vi.doMock('../src/packages.js', () => ({
        getPackages: mockGetPackages,
        comparePackages: mockComparePackages
    }));

    mockGetInput.mockImplementation((name: string) => {
        if (name === 'project_file') return 'MyApp.xcodeproj';
        return '.spm-tmp';
    });
});

async function loadRun(): Promise<typeof RunFn> {
    const { run } = await import('../src/main.js');
    return run;
}

describe('main', () => {
    test('cleans up tempDir at the start', async () => {
        const run = await loadRun();
        await run();

        expect(mockRmSync).toHaveBeenCalledWith('.spm-tmp', { recursive: true, force: true });
    });

    test('saves state for temp_dir and current_package', async () => {
        const run = await loadRun();
        await run();

        expect(mockSaveState).toHaveBeenCalledWith('temp_dir', '.spm-tmp');
        expect(mockSaveState).toHaveBeenCalledWith(
            'current_package',
            expect.stringContaining('CurrentPackage.resolved')
        );
    });

    test('copies Package.resolved to currentPackage', async () => {
        const run = await loadRun();
        await run();

        expect(mockCopyFileSync).toHaveBeenCalledWith(
            'MyApp.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved',
            expect.stringContaining('CurrentPackage.resolved')
        );
    });

    test('creates tempDir before xcodebuild', async () => {
        const run = await loadRun();
        await run();

        expect(mockMkdirSync).toHaveBeenCalledWith('.spm-tmp', { recursive: true });
    });

    test('runs xcodebuild with correct arguments', async () => {
        const run = await loadRun();
        await run();

        expect(mockExec).toHaveBeenCalledWith('xcodebuild', [
            '-resolvePackageDependencies',
            '-disablePackageRepositoryCache',
            '-clonedSourcePackagesDirPath',
            '.spm-tmp'
        ]);
    });

    test('no changes → dependenciesChanged false, empty summary', async () => {
        const run = await loadRun();
        await run();

        expect(mockSetOutput).toHaveBeenCalledWith('dependenciesChanged', 'false');
        expect(mockSetOutput).toHaveBeenCalledWith('summary', '');
    });

    test('removed package → dependenciesChanged true, summary contains removed', async () => {
        const before = new Map([['firebase', '11.0.0']]);
        const after = new Map<string, string>();
        mockGetPackages.mockReturnValueOnce(before).mockReturnValueOnce(after);
        mockComparePackages.mockReturnValue({ removed: ['firebase'], added: [], updated: [] });

        const run = await loadRun();
        await run();

        expect(mockSetOutput).toHaveBeenCalledWith('dependenciesChanged', 'true');
        expect(mockSetOutput).toHaveBeenCalledWith('summary', '- removed: firebase: 11.0.0');
    });

    test('added package → dependenciesChanged true, summary contains added', async () => {
        const before = new Map<string, string>();
        const after = new Map([['jwt', '3.0.0']]);
        mockGetPackages.mockReturnValueOnce(before).mockReturnValueOnce(after);
        mockComparePackages.mockReturnValue({ removed: [], added: ['jwt'], updated: [] });

        const run = await loadRun();
        await run();

        expect(mockSetOutput).toHaveBeenCalledWith('dependenciesChanged', 'true');
        expect(mockSetOutput).toHaveBeenCalledWith('summary', '- added:   jwt: 3.0.0');
    });

    test('updated package → dependenciesChanged true, summary contains updated', async () => {
        const before = new Map([['firebase', '11.0.0']]);
        const after = new Map([['firebase', '11.1.0']]);
        mockGetPackages.mockReturnValueOnce(before).mockReturnValueOnce(after);
        mockComparePackages.mockReturnValue({ removed: [], added: [], updated: ['firebase'] });

        const run = await loadRun();
        await run();

        expect(mockSetOutput).toHaveBeenCalledWith('dependenciesChanged', 'true');
        expect(mockSetOutput).toHaveBeenCalledWith('summary', '- updated: firebase: 11.0.0 → 11.1.0');
    });

    test('multiple changes → summary contains all lines', async () => {
        const before = new Map([
            ['firebase', '11.0.0'],
            ['jwt', '3.0.0']
        ]);
        const after = new Map([
            ['firebase', '11.1.0'],
            ['new-pkg', '1.0.0']
        ]);
        mockGetPackages.mockReturnValueOnce(before).mockReturnValueOnce(after);
        mockComparePackages.mockReturnValue({ removed: ['jwt'], added: ['new-pkg'], updated: ['firebase'] });

        const run = await loadRun();
        await run();

        const summary = (mockSetOutput.mock.calls.find((c) => c[0] === 'summary') ?? [])[1] as string;
        expect(summary).toContain('- removed: jwt: 3.0.0');
        expect(summary).toContain('- added:   new-pkg: 1.0.0');
        expect(summary).toContain('- updated: firebase: 11.0.0 → 11.1.0');
    });

    test('xcodebuild failure → throws', async () => {
        mockExec.mockRejectedValue(new Error('xcodebuild failed'));

        const run = await loadRun();
        await expect(run()).rejects.toThrow('xcodebuild failed');
    });
});
