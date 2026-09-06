#!/usr/bin/env python3
"""
Zip the Function app for a Flex Consumption publish: index.js, host.json, package.json, src/ and the
installed dependencies.

Flex does no remote build, so node_modules travels in the package. Run `yarn workspaces focus
--production` first: the extract phase is paid per file and dev dependencies are most of them.

    scripts/package-api.py [repo_root] [zip_path]
"""
import os
import sys
import zipfile

# What the app is. Missing any of these produces a package that deploys and 404s every route, which
# is why it fails here instead.
REQUIRED = ("index.js", "host.json", "package.json", "src", "node_modules")

# Excluded at the REPO ROOT ONLY: "test" and "dist" at every depth would also strip
# node_modules/**/test, and a dependency's own dist directory is its published code.
ROOT_EXCLUDE_DIRS = {
    ".git", ".github", ".claude", ".yarn", ".vscode", "azure", "client", "coverage",
    "dist", "docs", "scripts", "test", "tmp", "__pycache__",
}

# `.git` is in here as well as in the directory set: in a git worktree it is a FILE pointing at the
# real repository, and directory pruning does not see it.
ROOT_EXCLUDE_FILES = {".git", ".gitignore", ".yarnrc.yml", "eslint.config.js", "yarn.lock"}

# Operator files that must never reach the app. A packaged `.env` once carried live credentials into
# a readable path in another EPIC repository.
EXCLUDED_NAMES = {"local.settings.json", ".npmrc"}
EXCLUDED_PREFIXES = ("LICENSE", "CHANGELOG")

# `.d.ts` is types for a runtime that never reads them; `.mmdb` is the 60 MB GeoLite2 database, which
# the app fetches from the geoip container; the credential extensions are the `.env` hazard again.
EXCLUDED_EXTENSIONS = (".zip", ".tar.gz", ".map", ".md", ".d.ts", ".mmdb",
                       ".pem", ".key", ".p12", ".pfx")


def excluded_file(name):
    """Whether a file must never be packaged, wherever it was reached from."""
    if name == ".env" or name.startswith(".env."):
        return True
    if name in EXCLUDED_NAMES or name.startswith(EXCLUDED_PREFIXES):
        return True
    return name.endswith(EXCLUDED_EXTENSIONS)


def package_api(repo_root, zip_path):
    missing = [entry for entry in REQUIRED
               if not os.path.exists(os.path.join(repo_root, entry))]
    if missing:
        raise SystemExit(f"ERROR: nothing to package, missing: {', '.join(missing)}")

    print(f"Packaging {repo_root} -> {zip_path}...")
    count = 0

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as archive:
        for root, dirs, files in os.walk(repo_root):
            rel_root = os.path.relpath(root, repo_root)
            if rel_root == ".":
                # Pruned in place, which is what os.walk reads to decide where to go next.
                dirs[:] = [d for d in dirs if d not in ROOT_EXCLUDE_DIRS]

            for name in files:
                if rel_root == "." and name in ROOT_EXCLUDE_FILES:
                    continue
                if excluded_file(name):
                    continue
                full_path = os.path.join(root, name)
                archive.write(full_path, os.path.relpath(full_path, repo_root))
                count += 1

        # The deploy id goes IN the package: an app setting cannot do this job, because the old
        # worker serves for about two minutes and would report the new value. 0644 or the worker
        # cannot read it.
        stamp = zipfile.ZipInfo("build-id.txt")
        stamp.external_attr = 0o100644 << 16  # S_IFREG | 0644
        archive.writestr(stamp, os.environ.get("BUILD_ID", "unknown"))

    print(f"Packaged {count} files into {zip_path}")


if __name__ == "__main__":
    root = sys.argv[1] if len(sys.argv) > 1 else "."
    out = sys.argv[2] if len(sys.argv) > 2 else "/tmp/api-deploy.zip"
    package_api(os.path.abspath(root), out)
