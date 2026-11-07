# Development tools

Run these commands from the project root.

## Local preview

```bash
python3 tools/serve.py
```

Open <http://localhost:8137/>. The server listens on the local machine only and disables caching so source changes appear after a reload. To use another port:

```bash
python3 tools/serve.py 9000
```

## Rebuild the font subset

`build-fonts.py` requires Python, `fonttools`, and `brotli`. Download `SourceHanSerifCN-Medium.otf` from the Adobe URL documented in the script and place it next to the script, then run:

```bash
python3 tools/build-fonts.py
```

The script writes the renamed WOFF2 subset to `fonts/`. Original font files and the generated character list are excluded from version control. Preserve the OFL notice distributed with the font.
