# ide-ruff

Ruff language-server adapter for Python.

Registers the language server built into [Ruff](https://github.com/astral-sh/ruff), started as `ruff server`, with `ide-client`.

## Features

- **Server discovery**: uses the Server Path setting, a checksum-verified copy the editor installed, or `ruff` on your PATH, in that order.
- **Python and IPython**: serves Python and uses language-ipython's shared AST projection for `.ipy`, retaining Python under Python cell magics while hiding literal Markdown, raw and foreign-language bodies from the server.
- **Diagnostics, fixes and policy**: reports lint and syntax findings, offers single fixes, fix-all and noqa actions, and lets the settings page select, extend, ignore and control autofix eligibility for rules.
- **Feature switches**: diagnostics, hover, formatting, and code actions can each be turned off, which hands them to another Python server on the same file. Turning diagnostics off also stops the server computing them.
- **Settings applied live**: Ruff reads its settings only when it starts, so changing one restarts the server for you rather than leaving the setting inert until the next reload.
- **Formatting**: formats ordinary Python through the server; eligible Python-only `.ipy` documents reuse their existing server document, while other `.ipy` requests batch safe Python bodies into one temporary document in the same session.
- **Ruff configuration**: reads the discovered `ruff.toml` or `pyproject.toml`, overriding only the settings you set, and the Configuration Preference setting says which side wins.
- **Project sessions**: one server per project root, started lazily with the first Python editor.
- **Project scans**: checks whole project folders or files and folders selected in the tree view, including notebooks and safely projected IPython documents, without rewriting files.

## Installation

To install `ide-ruff` search for it in the Install pane of the Lumine settings, or run the command `lumine --install lumine-code/ide-ruff`.

Install `ide-client` first. You can provide the `ruff` binary separately with `pip install ruff`, `uv tool install ruff`, or `pipx install ruff`, or let the editor fetch it from Manage Servers.

## Commands

Commands available in `lumine-workspace`:

- `ide-ruff:lint-projects`: scan every project folder with Ruff,
- `ide-ruff:lint-selected`: scan the files or folders selected in the tree view.

## Usage

Install `linter` to display both server diagnostics and manual project scan results. Project scans use the same Ruff executable as the server: the configured path, a managed installation, or PATH. They load the selected Configuration File or discover Ruff configuration files, then apply the adapter's explicit rule lists, exclusions, line length, preview and noqa policy. Configuration Preference controls language-server configuration; manual scans follow Ruff's CLI precedence. Scan results remain available for open files until the server actually publishes diagnostics for them, and return when server diagnostics are disabled or the session ends. Notebook results are matched per cell. The scanner keeps the complete result of its latest run while the IDE client decides which messages to show.

IPython scans discover `.ipy` files through Ruff's configuration rules and never lint their raw mixed content. Open IPython files use their buffer snapshot; closed files use a disposable shared AST projection and are checked again for changes before results are published. Ordinary Python files and notebooks are scanned from disk. Scans do not fix files, even when the Ruff configuration enables automatic fixes.

IPython support requires the passive `ipython.source` service from language-ipython. If it is unavailable, the adapter refuses to send a mixed document as Python. Projection maps preserve source coordinates, reject stale edits and protect non-Python content. Complete Python-only formatting requests reuse the existing server document when its text matches the validated batch, including documents without cell markers. Original canonical headers must retain their exact text, count and order. Mixed documents, magics, partial requests and ambiguous or empty cells use a temporary document with a unique URI query on the original pathname, retaining project and per-file settings. Comment delimiters keep its Python bodies identifiable without introducing statements before docstrings or future imports. Every body must restore successfully, and source, path, selection and cancellation checks must still pass before edits apply. Temporary documents close after the request; no temporary files or editor models are created.

## Services

- `ide-client`: consumed to register the Ruff adapter with the editor's language-server client.
- `ipython.source`: consumed for shared AST projection, coordinate maps and protected formatting blocks in `.ipy` documents.
- `linter.registry`: consumed to report manual project and tree-view scans.
- `busy-signal`: consumed to show progress while project scans run.
- `tree-view.selection`: consumed to resolve the selected files or folders for a scan.
- `background-tips.provider`: provided to background-tips to explain project-wide Ruff scans.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
