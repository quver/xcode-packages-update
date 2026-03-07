import { vi, beforeEach, describe, test, expect } from 'vitest';
import type { run as RunFn } from '../src/main.js';

let mockGetInput: ReturnType<typeof vi.fn>;
let mockSaveState: ReturnType<typeof vi.fn>;
let mockSetOutput: ReturnType<typeof vi.fn>;
let mockInfo: ReturnType<typeof vi.fn>;
let mockWarning: ReturnType<typeof vi.fn>;
let mockSetFailed: ReturnType<typeof vi.fn>;
let mockExec: ReturnType<typeof vi.fn>;
let mockRmSync: ReturnType<typeof vi.fn>;
let mockRenameSync: ReturnType<typeof vi.fn>;
let mockMkdirSync: ReturnType<typeof vi.fn>;
let mockExistsSync: ReturnType<typeof vi.fn>;
let mockReadFileSync: ReturnType<typeof vi.fn>;
let mockGetPackages: ReturnType<typeof vi.fn>;
let mockComparePackages: ReturnType<typeof vi.fn>;

beforeEach(() => {
    mockGetInput = vi.fn();
    mockSaveState = vi.fn();
    mockSetOutput = vi.fn();
    mockInfo = vi.fn();
    mockWarning = vi.fn();
    mockSetFailed = vi.fn();
    mockExec = vi.fn().mockResolvedValue(0);
    mockRmSync = vi.fn();
    mockRenameSync = vi.fn();
    mockMkdirSync = vi.fn();
    mockExistsSync = vi.fn().mockReturnValue(true);
    mockReadFileSync = vi.fn().mockReturnValue('');
    mockGetPackages = vi.fn().mockReturnValue(new Map());
    mockComparePackages = vi.fn().mockReturnValue({ removed: [], added: [], updated: [] });
    vi.resetModules();

    vi.doMock('@actions/core', () => ({
        getInput: mockGetInput,
        saveState: mockSaveState,
        setOutput: mockSetOutput,
        info: mockInfo,
        warning: mockWarning,
        setFailed: mockSetFailed
    }));

    vi.doMock('@actions/exec', () => ({
        exec: mockExec
    }));

    vi.doMock('fs', () => ({
        default: {
            rmSync: mockRmSync,
            renameSync: mockRenameSync,
            mkdirSync: mockMkdirSync,
            existsSync: mockExistsSync,
            readFileSync: mockReadFileSync
        }
    }));

    vi.doMock('../src/packages.js', () => ({
        getPackages: mockGetPackages,
        comparePackages: mockComparePackages
    }));

    mockGetInput.mockImplementation((name: string) => {
        if (name === 'project_file') return 'MyApp.xcodeproj';
        if (name === 'temporary_packages_dir_path') return '.spm-tmp';
        return '';
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

    test('cleans up tempDir and currentPackage after resolve', async () => {
        const run = await loadRun();
        await run();

        // tempDir cleaned at start (1st call) and after resolve (2nd call)
        expect(mockRmSync).toHaveBeenCalledTimes(3);
        expect(mockRmSync).toHaveBeenNthCalledWith(2, '.spm-tmp', { recursive: true, force: true });
        expect(mockRmSync).toHaveBeenNthCalledWith(3, expect.stringContaining('CurrentPackage.resolved'), {
            force: true
        });
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

    test('moves Package.resolved to currentPackage', async () => {
        const run = await loadRun();
        await run();

        expect(mockRenameSync).toHaveBeenCalledWith(
            'MyApp.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved',
            expect.stringContaining('CurrentPackage.resolved')
        );
    });

    test('creates tempDir before xcodebuild', async () => {
        const run = await loadRun();
        await run();

        expect(mockMkdirSync).toHaveBeenCalledWith('.spm-tmp', { recursive: true });
    });

    test('runs xcodebuild with correct arguments for project', async () => {
        const run = await loadRun();
        await run();

        expect(mockExec).toHaveBeenCalledWith('xcodebuild', [
            '-project',
            'MyApp.xcodeproj',
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

describe('input validation', () => {
    test('neither project_file nor workspace_file → throws', async () => {
        mockGetInput.mockImplementation((name: string) => {
            if (name === 'temporary_packages_dir_path') return '.spm-tmp';
            return '';
        });

        const run = await loadRun();
        await expect(run()).rejects.toThrow('Either project_file or workspace_file must be provided.');
    });

    test('both project_file and workspace_file → throws', async () => {
        mockGetInput.mockImplementation((name: string) => {
            if (name === 'project_file') return 'MyApp.xcodeproj';
            if (name === 'workspace_file') return 'MyApp.xcworkspace';
            if (name === 'temporary_packages_dir_path') return '.spm-tmp';
            return '';
        });

        const run = await loadRun();
        await expect(run()).rejects.toThrow('Only one of project_file or workspace_file can be provided, not both.');
    });

    test('workspace_file without scheme → throws with helpful message', async () => {
        mockGetInput.mockImplementation((name: string) => {
            if (name === 'workspace_file') return 'MyApp.xcworkspace';
            if (name === 'temporary_packages_dir_path') return '.spm-tmp';
            return '';
        });

        const run = await loadRun();
        await expect(run()).rejects.toThrow('scheme is required when using workspace_file.');
    });

    test('scheme without workspace_file → warns and proceeds with project', async () => {
        mockGetInput.mockImplementation((name: string) => {
            if (name === 'project_file') return 'MyApp.xcodeproj';
            if (name === 'scheme') return 'MyScheme';
            if (name === 'temporary_packages_dir_path') return '.spm-tmp';
            return '';
        });

        const run = await loadRun();
        await run();

        expect(mockWarning).toHaveBeenCalledWith(
            'scheme input is ignored when project_file is used without workspace_file.'
        );
        expect(mockExec).toHaveBeenCalledWith('xcodebuild', expect.arrayContaining(['-project', 'MyApp.xcodeproj']));
    });

    test('workspace_file with scheme not found → throws with shared scheme hint', async () => {
        mockExistsSync.mockReturnValue(false);
        mockGetInput.mockImplementation((name: string) => {
            if (name === 'workspace_file') return 'MyApp.xcworkspace';
            if (name === 'scheme') return 'MyScheme';
            if (name === 'temporary_packages_dir_path') return '.spm-tmp';
            return '';
        });

        const run = await loadRun();
        await expect(run()).rejects.toThrow(
            'Scheme "MyScheme" was not found in "MyApp.xcworkspace" or any referenced project.'
        );
        await expect(run()).rejects.toThrow('marked as shared in Xcode');
    });

    test('workspace_file with scheme not in workspace nor referenced projects → throws', async () => {
        // contents.xcworkspacedata exists, project is referenced, but scheme not found in project either
        mockExistsSync.mockImplementation((p: string) => {
            if (p.endsWith('contents.xcworkspacedata')) return true;
            return false;
        });
        mockReadFileSync.mockReturnValue('<FileRef location = "container:MyApp.xcodeproj"></FileRef>');
        mockGetInput.mockImplementation((name: string) => {
            if (name === 'workspace_file') return 'MyApp.xcworkspace';
            if (name === 'scheme') return 'MyScheme';
            if (name === 'temporary_packages_dir_path') return '.spm-tmp';
            return '';
        });

        const run = await loadRun();
        await expect(run()).rejects.toThrow(
            'Scheme "MyScheme" was not found in "MyApp.xcworkspace" or any referenced project.'
        );
    });

    test('workspace_file with scheme in referenced project → finds scheme and proceeds', async () => {
        // workspace-level scheme not found, but contents.xcworkspacedata exists and references a project with the scheme
        mockExistsSync.mockImplementation((p: string) => {
            if (p.endsWith('MyApp.xcworkspace/xcshareddata/xcschemes/MyScheme.xcscheme')) return false;
            if (p.endsWith('contents.xcworkspacedata')) return true;
            if (p.endsWith('MyApp.xcodeproj/xcshareddata/xcschemes/MyScheme.xcscheme')) return true;
            return true; // allow other fs.existsSync calls (e.g. nothing else expected)
        });
        mockReadFileSync.mockReturnValue('<FileRef location = "container:MyApp.xcodeproj"></FileRef>');
        mockGetInput.mockImplementation((name: string) => {
            if (name === 'workspace_file') return 'MyApp.xcworkspace';
            if (name === 'scheme') return 'MyScheme';
            if (name === 'temporary_packages_dir_path') return '.spm-tmp';
            return '';
        });

        const run = await loadRun();
        await run();

        expect(mockExec).toHaveBeenCalledWith(
            'xcodebuild',
            expect.arrayContaining(['-workspace', 'MyApp.xcworkspace'])
        );
    });
});

describe('workspace support', () => {
    beforeEach(() => {
        mockGetInput.mockImplementation((name: string) => {
            if (name === 'workspace_file') return 'MyApp.xcworkspace';
            if (name === 'scheme') return 'MyApp';
            if (name === 'temporary_packages_dir_path') return '.spm-tmp';
            return '';
        });
    });

    test('runs xcodebuild with -workspace and -scheme', async () => {
        const run = await loadRun();
        await run();

        expect(mockExec).toHaveBeenCalledWith('xcodebuild', [
            '-workspace',
            'MyApp.xcworkspace',
            '-scheme',
            'MyApp',
            '-resolvePackageDependencies',
            '-disablePackageRepositoryCache',
            '-clonedSourcePackagesDirPath',
            '.spm-tmp'
        ]);
    });

    test('uses workspace Package.resolved path', async () => {
        const run = await loadRun();
        await run();

        expect(mockRenameSync).toHaveBeenCalledWith(
            'MyApp.xcworkspace/xcshareddata/swiftpm/Package.resolved',
            expect.stringContaining('CurrentPackage.resolved')
        );
    });

    test('validates scheme exists as shared scheme', async () => {
        const run = await loadRun();
        await run();

        expect(mockExistsSync).toHaveBeenCalledWith('MyApp.xcworkspace/xcshareddata/xcschemes/MyApp.xcscheme');
    });
});
