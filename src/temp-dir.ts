import fs from 'fs';
import path from 'path';

/** Resolve the temporary directory without allowing an ancestor symlink to escape the workspace. */
export function resolveSafeTempDir(tempDir: string, workspaceDir = process.cwd()): string {
    const workspacePath = path.resolve(workspaceDir);
    const workspaceRealPath = fs.realpathSync(workspacePath);
    const resolved = path.resolve(workspacePath, tempDir);

    const insideWorkspace = (candidate: string, root: string): boolean => {
        const relative = path.relative(root, candidate);
        return (
            relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
        );
    };

    const unsafePath = (): Error =>
        new Error(`temporary_packages_dir_path ("${tempDir}") must resolve to a subdirectory inside the workspace.`);

    if (!insideWorkspace(resolved, workspacePath)) throw unsafePath();

    // The directory and some of its parents may not exist yet. Resolve the nearest
    // existing ancestor, then append the missing components to its real path.
    let existing = resolved;
    while (true) {
        try {
            const entry = fs.lstatSync(existing);
            // rmSync unlinks a symlink at the leaf. Resolve its parent so cleanup
            // keeps that behavior instead of deleting the symlink's referent.
            if (existing === resolved && entry.isSymbolicLink()) existing = path.dirname(existing);
            break;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            existing = path.dirname(existing);
        }
    }

    const realPath = path.resolve(fs.realpathSync(existing), path.relative(existing, resolved));
    if (!insideWorkspace(realPath, workspaceRealPath)) throw unsafePath();
    return realPath;
}
