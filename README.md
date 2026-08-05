# ide-ruff

Ruff language-server adapter for Python.

Registers the language server built into [Ruff](https://github.com/astral-sh/ruff), started as `ruff server`, with the bundled `ide-client` package.

## Features

- **PATH discovery**: finds `ruff` on your PATH, or uses the Server Path setting.
- **Python and IPython**: serves the Python grammar and its IPython dialect.
- **Diagnostics**: reports lint violations as you type, with syntax errors from the parser.
- **Global lint policy**: selects, ignores, and controls autofix eligibility for Ruff rules from the settings page.
- **Python directives**: honors or bypasses `# noqa` suppressions and automatically masks magic commands in IPython buffers without changing the editor text.
- **Code actions**: fixes a single violation, fixes every fixable violation, or appends a `# noqa` comment.
- **Formatting**: formats documents with the Ruff formatter and sorts imports on request.
- **Ruff configuration**: reads the discovered `ruff.toml` or `pyproject.toml`, overriding only the settings you set.
- **Project sessions**: one server per project root, started lazily with the first Python editor.

## Installation

To install `ide-ruff` search for _ide-ruff_ in the Install pane of the Lumine settings or run `lumine --install lumine-code/ide-ruff`. The `ruff` binary itself is installed separately, for example with `pip install ruff`, `uv tool install ruff`, or `pipx install ruff`.

## Usage

`ide-ruff` and `linter-ruff` both report Ruff diagnostics, and they are meant to be installed together. `linter-ruff` watches for this adapter and reports nothing for the editors it covers, so a violation still appears once; what it keeps is the ground the server does not cover — Jupyter notebooks, whose cells it lints and maps individually, project-wide and tree-view scans, and its own fix and format commands. Nothing has to be configured for that, and neither needs disabling.

## Services

- **ide-client** (`^1.0.0`): consumed to register the Ruff adapter with the editor's language-server client.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
