# ide-ruff

Ruff language-server adapter for Python.

Registers the language server built into [Ruff](https://github.com/astral-sh/ruff), started as `ruff server`, with `ide-client`.

## Features

- **Server discovery**: uses the Server Path setting, a checksum-verified copy the editor installed, or `ruff` on your PATH, in that order.
- **Python and IPython**: serves both grammars while masking line and cell magics, shell escapes, and help requests without changing editor text.
- **Diagnostics and policy**: reports lint and syntax findings while the settings page selects, extends, ignores, and controls autofix eligibility for rules.
- **Feature switches**: diagnostics, hover, formatting, and code actions can each be turned off, which hands them to another Python server on the same file. Turning diagnostics off also stops the server computing them.
- **Settings applied live**: Ruff reads its settings only when it starts, so changing one restarts the server for you rather than leaving the setting inert until the next reload.
- **Code actions**: fixes a single violation, fixes every fixable violation, or appends a `# noqa` comment.
- **Formatting**: formats documents with Ruff itself or a compatible uv backend and sorts imports on request.
- **Ruff configuration**: reads the discovered `ruff.toml` or `pyproject.toml`, overriding only the settings you set, and the Configuration Preference setting says which side wins.
- **Project sessions**: one server per project root, started lazily with the first Python editor.

## Installation

Install `ide-client` first, then search for `ide-ruff` in the Install pane of the Lumine settings, or run `lumine --install lumine-code/ide-ruff`. You can provide the `ruff` binary separately with `pip install ruff`, `uv tool install ruff`, or `pipx install ruff`, or let the editor fetch it from Manage Servers.

## Usage

`ide-ruff` and `linter-ruff` both report Ruff diagnostics, and they are meant to be installed together. `linter-ruff` watches for this adapter and reports nothing for editors where its diagnostics feature is enabled, including Jupyter notebook cells once jupyter-view syncs them to the server, so a violation still appears once. It keeps project-wide and tree-view scans, which cover files nobody opened, and its own fix and format commands. Turning adapter diagnostics off immediately hands those open editors back to `linter-ruff`.

## Services

- `ide-client`: consumed to register the Ruff adapter with the editor's language-server client.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
