import { vi, beforeEach, describe, test, expect } from 'vitest';
import type { run as RunFn } from '../src/post.js';

let mockGetState: ReturnType<typeof vi.fn>;
let mockSetFailed: ReturnType<typeof vi.fn>;
let mockRmSync: ReturnType<typeof vi.fn>;
let mockRenameSync: ReturnType<typeof vi.fn>;
let mockExistsSync: ReturnType<typeof vi.fn>;

beforeEach(() => {
    mockGetState = vi.fn().mockReturnValue('');
    mockSetFailed = vi.fn();
    mockRmSync = vi.fn();
    mockRenameSync = vi.fn();
    mockExistsSync = vi.fn().mockReturnValue(true);
    vi.resetModules();

    vi.doMock('@actions/core', () => ({
        getState: mockGetState,
        setFailed: mockSetFailed
    }));

    vi.doMock('fs', () => ({
        default: {
            rmSync: mockRmSync,
            renameSync: mockRenameSync,
            existsSync: mockExistsSync
        }
    }));
});

async function loadRun(): Promise<typeof RunFn> {
    const { run } = await import('../src/post.js');
    return run;
}

describe('post', () => {
    test('removes tempDir when set', async () => {
        mockGetState.mockImplementation((key: string) => (key === 'temp_dir' ? '.spm-tmp' : ''));

        const run = await loadRun();
        await run();

        expect(mockRmSync).toHaveBeenCalledWith('.spm-tmp', { recursive: true, force: true });
    });

    test('deletes the snapshot when packageResolvedPath already exists (successful resolve)', async () => {
        mockGetState.mockImplementation((key: string) =>
            key === 'current_package' ? '/tmp/CurrentPackage.resolved' : ''
        );
        mockExistsSync.mockReturnValue(true);

        const run = await loadRun();
        await run();

        expect(mockRmSync).toHaveBeenCalledWith('/tmp/CurrentPackage.resolved', { force: true });
        expect(mockRenameSync).not.toHaveBeenCalled();
    });

    test('removes both tempDir and the snapshot when both are set', async () => {
        mockGetState.mockImplementation((key: string) => {
            if (key === 'temp_dir') return '.spm-tmp';
            if (key === 'current_package') return '/tmp/CurrentPackage.resolved';
            return '';
        });
        mockExistsSync.mockReturnValue(true);

        const run = await loadRun();
        await run();

        expect(mockRmSync).toHaveBeenCalledTimes(2);
    });

    test('does not call rmSync or renameSync when no state is set', async () => {
        mockGetState.mockReturnValue('');

        const run = await loadRun();
        await run();

        expect(mockRmSync).not.toHaveBeenCalled();
        expect(mockRenameSync).not.toHaveBeenCalled();
    });

    test('restores the snapshot to packageResolvedPath when xcodebuild never regenerated it', async () => {
        mockGetState.mockImplementation((key: string) => {
            if (key === 'current_package') return '/tmp/CurrentPackage.resolved';
            if (key === 'package_resolved_path') return 'MyApp.xcodeproj/.../Package.resolved';
            return '';
        });
        mockExistsSync.mockImplementation((p: string) => p === '/tmp/CurrentPackage.resolved');

        const run = await loadRun();
        await run();

        expect(mockRenameSync).toHaveBeenCalledWith(
            '/tmp/CurrentPackage.resolved',
            'MyApp.xcodeproj/.../Package.resolved'
        );
        expect(mockRmSync).not.toHaveBeenCalledWith('/tmp/CurrentPackage.resolved', { force: true });
    });

    test('deletes the snapshot instead of restoring when packageResolvedPath exists again', async () => {
        mockGetState.mockImplementation((key: string) => {
            if (key === 'current_package') return '/tmp/CurrentPackage.resolved';
            if (key === 'package_resolved_path') return 'MyApp.xcodeproj/.../Package.resolved';
            return '';
        });
        mockExistsSync.mockReturnValue(true);

        const run = await loadRun();
        await run();

        expect(mockRmSync).toHaveBeenCalledWith('/tmp/CurrentPackage.resolved', { force: true });
        expect(mockRenameSync).not.toHaveBeenCalled();
    });

    test('does nothing for the snapshot when it no longer exists (main already cleaned it up)', async () => {
        mockGetState.mockImplementation((key: string) =>
            key === 'current_package' ? '/tmp/CurrentPackage.resolved' : ''
        );
        mockExistsSync.mockReturnValue(false);

        const run = await loadRun();
        await run();

        expect(mockRenameSync).not.toHaveBeenCalled();
        expect(mockRmSync).not.toHaveBeenCalledWith('/tmp/CurrentPackage.resolved', { force: true });
    });
});
