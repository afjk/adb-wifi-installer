# Windows build and release flow

## Pull requests

Opening, updating or reopening a PR against `main` runs the Windows installer build.
Download the `windows-x64-unsigned-pr-...` artifact from that Actions run for testing.
It is an unsigned test installer, not a published distribution. PR jobs use read-only
repository permissions and receive no signing key. Release jobs never reuse PR artifacts.

## Publish a release

After the version-preparation PR and main checks pass, create and publish a GitHub Release
with the matching `vX.Y.Z` tag targeting the checked main commit. For this release, use
`v0.3.4` and the current checked `main` commit after the workflow change is merged.
The release notes are in `docs/releases/v0.3.4.md`.

Publishing the release starts the Windows distribution build automatically. The release
page will exist before its assets are ready. Actions validates the release ID, tag,
version and exact source commit (which must be on main), builds with the existing Tauri
signing secret, then attaches the installer, matching updater signature and `latest.json`.
It downloads the uploaded files and checks their bytes. It does not recreate the release,
change its publication state, delete tags or overwrite existing assets.

Identical existing assets are skipped on a retry. If an existing asset differs from the
new build, the job stops for review rather than replacing published bytes. A rebuilt
installer can differ, so a partial failed release may require an explicit maintainer
recovery decision. Do not delete or retag a published version automatically.

Tag pushes and ordinary main pushes do not start a distribution build. No manual CLI
kickoff or Run workflow button is needed: publish the GitHub Release instead.

## Limits

The distribution workflow currently builds Windows x64 only. It requires the existing
`TAURI_SIGNING_PRIVATE_KEY` secret to be usable. No key is created by this workflow.
Tauri updater signing is separate from Windows Authenticode signing.
macOS distribution still requires the existing Apple signing/notarization setup and is
not produced by this workflow. Native OS/device testing remains a separate check.
